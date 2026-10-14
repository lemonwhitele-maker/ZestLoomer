import type { AgentConfig, AgentDiagnostic, ModelPolicy } from '../../shared/agent'
import { fail, toolDefinitions } from './documents'
import { modelPolicy, estimateTokens, inputLimit } from './budgets'

export interface ToolCallMetadata {
  extra_content?: Record<string, unknown>
}
export interface RuntimeToolCall extends ToolCallMetadata {
  id: string
  name: string
  arguments: string
}
export interface RuntimeMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: (ToolCallMetadata & {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  })[]
}
export interface Completion {
  text: string
  calls: RuntimeToolCall[]
  usage?: { inputTokens: number; outputTokens: number }
}
export interface ModelRuntime {
  policy?: ModelPolicy
  model?: string
  provider?: string
  profileId?: string
  complete(
    messages: RuntimeMessage[],
    signal: AbortSignal,
    delta: (text: string) => void,
    options?: CompletionOptions
  ): Promise<Completion>
}
export interface CompletionOptions {
  tools?: 'all' | 'write' | 'none'
  diagnostic?: (event: Omit<AgentDiagnostic, 'at' | 'turnId'>) => Promise<void>
  trace?: (event: RuntimeTraceEvent) => Promise<void>
}
export type RuntimeTraceEvent =
  | { type: 'request'; attempt: number; body: Record<string, unknown> }
  | { type: 'response'; attempt: number; completion: Completion }
  | { type: 'error'; attempt: number; code: string; message: string }
export async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let listener: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(signal.reason || new Error('任务已取消'))
    signal.addEventListener('abort', listener, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    if (listener) signal.removeEventListener('abort', listener)
  }
}
export function endpoint(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    fail('CONFIG', '请输入完整的 API 地址')
  }
  if (
    !['https:', 'http:'].includes(url!.protocol) ||
    url!.username ||
    url!.password ||
    url!.search ||
    url!.hash
  )
    fail('CONFIG', 'API 地址须为 HTTP(S)，不能包含密码、查询参数或片段')
  if (url!.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url!.hostname))
    fail('CONFIG', '远程 API 地址请使用 HTTPS')
  url!.pathname = url!.pathname.replace(/\/$/, '')
  if (!url!.pathname.endsWith('/chat/completions')) url!.pathname += '/chat/completions'
  return url!.toString()
}
export class ApiRuntime implements ModelRuntime {
  readonly policy: ModelPolicy
  readonly model: string
  readonly provider: string
  readonly profileId?: string
  constructor(
    private config: AgentConfig & Partial<ModelPolicy> & { id?: string },
    private apiKey: string,
    private options: { tools?: unknown[]; toolChoice?: unknown } = {}
  ) {
    this.policy = modelPolicy(config)
    this.model = config.model
    this.provider = new URL(endpoint(config.baseUrl)).origin
    this.profileId = config.id
  }
  async complete(
    messages: RuntimeMessage[],
    signal: AbortSignal,
    delta: (text: string) => void,
    options: CompletionOptions = {}
  ): Promise<Completion> {
    // Retry only a response that yielded no executable tool calls. Never replay a
    // document operation, and don't stream a retry over previously displayed text.
    let limit = this.policy.outputTokens
    let shown = false
    for (let attempt = 0; ; attempt++) {
      const started = Date.now()
      let usage: Completion['usage']
      await options.diagnostic?.({
        phase: 'request.started',
        attempt: attempt + 1,
        outputBudget: limit
      })
      try {
        const result = await this.request(
          messages,
          signal,
          (text) => {
            shown = true
            delta(text)
          },
          limit,
          options.tools || 'all',
          (value) => {
            usage = value
          },
          async (body) => options.trace?.({ type: 'request', attempt: attempt + 1, body })
        )
        await options.trace?.({ type: 'response', attempt: attempt + 1, completion: result })
        await options.diagnostic?.({
          phase: 'request.completed',
          attempt: attempt + 1,
          outputBudget: limit,
          elapsedMs: Date.now() - started,
          ...result.usage
        })
        return result
      } catch (error) {
        const code = (error as { code?: string }).code
        await options.trace?.({
          type: 'error',
          attempt: attempt + 1,
          code: code || (signal.aborted ? 'CANCELLED_OR_TIMEOUT' : 'NETWORK_OR_PROTOCOL'),
          message: (error as Error).message
        })
        await options.diagnostic?.({
          phase: 'request.failed',
          attempt: attempt + 1,
          code: code || (signal.aborted ? 'CANCELLED_OR_TIMEOUT' : 'NETWORK_OR_PROTOCOL'),
          outputBudget: limit,
          elapsedMs: Date.now() - started,
          ...usage
        })
        signal.throwIfAborted()
        if (attempt || shown) throw error
        if (code === 'OUTPUT_TRUNCATED' && this.policy.retryOutputTokens > limit) {
          limit = this.policy.retryOutputTokens
          continue
        }
        if (code !== 'API_TRANSIENT') throw error
        await cancellable(new Promise<void>((resolve) => setTimeout(resolve, 500)), signal)
      }
    }
  }
  private async request(
    messages: RuntimeMessage[],
    signal: AbortSignal,
    delta: (text: string) => void,
    outputTokens: number,
    toolMode: 'all' | 'write' | 'none',
    onUsage: (usage: Completion['usage']) => void,
    onRequest: (body: Record<string, unknown>) => Promise<void>
  ): Promise<Completion> {
    if (!this.config.baseUrl || !this.config.model)
      fail('CONFIG', '请先在设置中配置 Agent 接入地址和模型')
    // Conservative character budget, including Chinese text and tool schemas; never silently drop raw evidence.
    const tools =
      toolMode === 'none'
        ? []
        : toolMode === 'write'
          ? toolDefinitions.filter((tool) =>
              ['create', 'write', 'edit'].includes(tool.function.name)
            )
          : (this.options.tools ?? toolDefinitions)
    if (estimateTokens(JSON.stringify({ messages, tools })) > inputLimit(this.policy))
      fail('CONTEXT_BUDGET', '本轮上下文已达到预算，请缩小范围或新建对话；未完成的读取不算完整整理')
    const url = endpoint(this.config.baseUrl)
    const googleCompatibility = new URL(url).hostname === 'generativelanguage.googleapis.com'
    const deepseekNonThinking =
      new URL(url).hostname === 'api.deepseek.com' && this.policy.reasoning === 'none'
    const body = {
      model: this.config.model,
      messages,
      ...(tools.length ? { tools } : {}),
      ...(tools.length && this.options.toolChoice ? { tool_choice: this.options.toolChoice } : {}),
      ...(deepseekNonThinking
        ? { thinking: { type: 'disabled' } }
        : this.policy.reasoning
          ? { reasoning_effort: this.policy.reasoning }
          : {}),
      stream: true,
      max_tokens: outputTokens
    }
    // Capture only the JSON payload, never Authorization headers or API configuration secrets.
    await onRequest(structuredClone(body))
    signal.throwIfAborted()
    const response = await fetch(url, {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
      },
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      const code =
        response.status === 401 || response.status === 403
          ? 'API_AUTH'
          : response.status === 429 || response.status >= 500
            ? 'API_TRANSIENT'
            : 'API_CONFIG'
      fail(
        code,
        `模型请求失败（HTTP ${response.status}），${code === 'API_AUTH' ? '请检查密钥和访问权限' : code === 'API_TRANSIENT' ? '服务繁忙，请稍后重试' : '请检查地址、模型、思考强度及工具支持'}`
      )
    }
    if (!response.body) fail('API', '模型没有返回响应内容')
    let text = ''
    let finish: string | null = null
    const calls = new Map<number, RuntimeToolCall>()
    let usage: Completion['usage']
    const consume = (value: any, streaming: boolean) => {
      if (
        Number.isFinite(value.usage?.prompt_tokens) &&
        Number.isFinite(value.usage?.completion_tokens)
      ) {
        usage = {
          inputTokens: value.usage.prompt_tokens,
          outputTokens: value.usage.completion_tokens
        }
        onUsage(usage)
      }
      if (value.error) fail('API', '模型返回错误，请检查接入配置')
      const choice = value.choices?.[0]
      if (!choice) return
      if (choice.finish_reason) finish = choice.finish_reason
      const chunk = streaming ? choice.delta : choice.message
      if (!chunk) return
      if (typeof chunk.content === 'string') {
        text += chunk.content
        delta(chunk.content)
      }
      if (Array.isArray(chunk.tool_calls))
        chunk.tool_calls.forEach((call: any, index: number) => {
          // Some compatible APIs omit the stream index. Resolve by the stable call ID,
          // never by a chunk's array position (parallel calls can arrive separately).
          let n = streaming ? call.index : index
          if (streaming && n == null) {
            if (typeof call.id !== 'string' || !call.id)
              fail('PROTOCOL', '工具调用缺少序号和标识，无法安全关联流式片段')
            n = [...calls].find(([, c]) => c.id === call.id)?.[0]
            if (n === undefined) {
              n = 0
              while (calls.has(n)) n++
            }
          }
          if (!Number.isInteger(n) || n < 0 || n > 19) fail('PROTOCOL', '工具调用序号无效')
          const target = calls.get(n) || { id: '', name: '', arguments: '' }
          for (const [key, value] of [
            ['id', call.id],
            ['name', call.function?.name]
          ] as const) {
            if (value == null || value === '') continue
            if (typeof value !== 'string' || (target[key] && target[key] !== value))
              fail('PROTOCOL', '工具调用标识或名称在流式片段中冲突')
            target[key] = value
          }
          if (call.function?.arguments != null) {
            if (typeof call.function.arguments !== 'string')
              fail('PROTOCOL', '工具调用参数必须是 JSON 文本')
            target.arguments += call.function.arguments
          }
          // Gemini requires its opaque thought signature to be echoed on the next
          // request. Keep it on the call, outside tool arguments and document data.
          if (call.extra_content != null) {
            if (typeof call.extra_content !== 'object' || Array.isArray(call.extra_content))
              fail('PROTOCOL', '工具调用扩展信息格式无效')
            target.extra_content = { ...target.extra_content, ...call.extra_content }
          }
          calls.set(n, target)
        })
      if (text.length + JSON.stringify([...calls.values()]).length > 100000)
        fail('OUTPUT_BUDGET', '模型输出过长，本轮未执行未完成的工具请求')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const sse = response.headers.get('content-type')?.includes('text/event-stream')
    let buffer = ''
    let bytes = 0
    const consumeEvents = (final = false) => {
      buffer = buffer.replace(/\r\n/g, '\n')
      let at: number
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const data = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data && data !== '[DONE]') consume(JSON.parse(data), true)
      }
      if (final && buffer.trim()) {
        buffer += '\n\n'
        consumeEvents()
      }
    }
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > 2000000) fail('OUTPUT_BUDGET', '模型响应超过预算')
        buffer += decoder.decode(value, { stream: true })
        if (sse) consumeEvents()
      }
      buffer += decoder.decode()
      if (sse) consumeEvents(true)
      else consume(JSON.parse(buffer), false)
    } finally {
      await reader.cancel().catch(() => {})
    }
    signal.throwIfAborted()
    if (!['stop', 'tool_calls'].includes(finish || ''))
      fail(
        finish === 'length' ? 'OUTPUT_TRUNCATED' : 'INCOMPLETE',
        '模型响应中断或被截断，未执行本次工具请求'
      )
    if (calls.size && finish !== 'tool_calls' && !(googleCompatibility && finish === 'stop'))
      fail('PROTOCOL', '模型工具调用没有完整结束')
    const result = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call)
    if (
      result.some((c) => !c.id || !c.name || !c.arguments) ||
      new Set(result.map((c) => c.id)).size !== result.length
    )
      fail('PROTOCOL', '模型工具调用缺少完整标识或参数')
    for (const call of result) {
      let args: unknown
      try {
        args = JSON.parse(call.arguments)
      } catch {
        fail('PROTOCOL', '模型工具调用参数不是完整 JSON，未执行本次工具请求')
      }
      if (!args || typeof args !== 'object' || Array.isArray(args))
        fail('PROTOCOL', '模型工具调用参数必须是 JSON 对象')
    }
    return { text, calls: result, ...(usage ? { usage } : {}) }
  }
}

/** Explicitly injected in tests; it is never selected as a user-facing model or silent fallback. */
export class ScriptedRuntime implements ModelRuntime {
  private index = 0
  constructor(
    private script: (
      messages: RuntimeMessage[],
      step: number,
      signal: AbortSignal
    ) => Completion | Promise<Completion>
  ) {}
  async complete(
    messages: RuntimeMessage[],
    signal: AbortSignal,
    delta: (text: string) => void
  ): Promise<Completion> {
    signal.throwIfAborted()
    const result = await this.script(messages, this.index++, signal)
    signal.throwIfAborted()
    if (result.text) delta(result.text)
    return result
  }
}
