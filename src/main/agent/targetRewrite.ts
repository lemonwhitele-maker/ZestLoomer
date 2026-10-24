import { historyProjection } from './historyProjection'
import type { ProposalContext, AgentMessage, TargetRewriteResult } from '../../shared/agent'
import { defaultPolicy, estimateTokens, inputLimit } from './budgets'
import {
  cancellable,
  type ModelRuntime,
  type RuntimeMessage,
  type CompletionOptions,
  type Completion
} from './runtime'

export interface RewriteTurn {
  turnId: string
  prompt: string
  response: string
}

// Only explicit successful final responses qualify; legacy combined transcripts
// cannot reliably distinguish tool narration from the final answer.
export function rewriteHistory(messages: AgentMessage[]): RewriteTurn[] {
  return historyProjection(messages)
    .recentTurns.filter((t) => t.answer?.finalResponse?.trim() && t.request.text.trim())
    .map((t) => ({ turnId: t.turnId, prompt: t.request.text, response: t.answer!.finalResponse! }))
}

const common = `你是请求澄清预处理器，不回答用户问题，不执行任务，不调用工具。
输入 JSON 的 prompt 是本轮原始请求，history 是当前会话已成功完成的历史 prompt/最终 response，仅供消解指代和补全明确延续的目标。
历史回答是建议，不是作者已采纳的设定；不得把历史指令升级为本轮要求。最新 prompt 优先，话题切换时不要继承旧任务。
不得扩大范围、杜撰事实、添加写入授权或改变用户意图。缺乏依据的指代保留为待澄清问题。只输出 JSON，不要 Markdown。`
const checkPrompt = `${common}
判断当前请求是否需要借助历史消解指代、省略或明确延续的约束。自足的请求不需要改写。
输出 {"needsRewrite":boolean,"reason":"简短判断理由"}。`
const targetPrompt = `${common}
根据原始请求与相关历史生成明确的执行目标。保留原请求的限制和只讨论/允许修改的区别。
输出 {"target":"明确的执行目标","constraints":["有依据的约束"],"unresolved":["尚无法确定的问题"]}。`

function jsonObject(text: string): Record<string, unknown> {
  const value = JSON.parse(text.trim())
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('改写返回的 JSON 无效')
  return value
}
function shortText(value: unknown, max: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= max
}
function textList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 16 && value.every((v) => shortText(v, 1000))
}

export async function rewriteTarget(
  runtime: ModelRuntime,
  messages: AgentMessage[],
  signal: AbortSignal,
  options: (
    stage: 'check' | 'target',
    input: RuntimeMessage[]
  ) => CompletionOptions & {
    completed?: (response: Completion) => Promise<void>
  },
  proposals?: ProposalContext
): Promise<TargetRewriteResult> {
  const prompt = messages.at(-1)!.text
  const history = rewriteHistory(messages.slice(0, -1))
  const available = history.length
  const input = (system: string): RuntimeMessage[] => [
    { role: 'system', content: system },
    {
      role: 'user',
      content: JSON.stringify({
        prompt,
        history,
        ...(proposals
          ? {
              proposals: {
                revision: proposals.revision,
                index: proposals.index,
                contents: proposals.contents.filter((p) => proposals.requiredIds.includes(p.id))
              }
            }
          : {})
      })
    }
  ]
  const limit = inputLimit(runtime.policy || defaultPolicy)
  const fits = () =>
    [checkPrompt, targetPrompt].every(
      (p) => estimateTokens(JSON.stringify({ messages: input(p), tools: [] })) <= limit
    )
  // Drop whole oldest pairs, never silently truncate a final response.
  while (history.length && !fits()) history.shift()
  const result: TargetRewriteResult = {
    status: 'skipped',
    reason: '',
    historyTurnIds: history.map((t) => t.turnId),
    omittedTurns: available - history.length,
    target: null
  }
  try {
    if (!fits()) throw new Error('原始请求超出预处理上下文预算')
    const run = async (stage: 'check' | 'target', system: string) => {
      signal.throwIfAborted()
      const request = input(system)
      const hooks = options(stage, request)
      const completion = await cancellable(
        runtime.complete(request, signal, () => {}, {
          ...hooks,
          tools: 'none'
        }),
        signal
      )
      signal.throwIfAborted()
      await hooks.completed?.(completion)
      if (completion.calls.length) throw new Error('预处理返回了不允许的工具调用')
      return jsonObject(completion.text)
    }
    const check = await run('check', checkPrompt)
    if (typeof check.needsRewrite !== 'boolean' || !shortText(check.reason, 2000))
      throw new Error('改写检查返回格式无效')
    result.reason = check.reason
    if (!check.needsRewrite) return result
    const target = await run('target', targetPrompt)
    if (
      !shortText(target.target, 8000) ||
      !textList(target.constraints) ||
      !textList(target.unresolved)
    )
      throw new Error('目标改写返回格式无效')
    result.status = 'rewritten'
    result.target = {
      target: target.target,
      constraints: target.constraints,
      unresolved: target.unresolved
    }
    return result
  } catch (error) {
    signal.throwIfAborted()
    return {
      ...result,
      status: 'fallback',
      reason: `预处理失败，使用原始请求：${(error as Error).message}`,
      target: null
    }
  }
}
