import { createHash } from 'node:crypto'
import type {
  AgentMessage,
  Conversation,
  HistoryProjection,
  HistorySummary,
  HistoryTurn
} from '../../shared/agent'

export const historyDigest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function historyProjection(
  messages: AgentMessage[],
  conversationId = '',
  currentId?: string
): HistoryProjection {
  const turns: HistoryTurn[] = []
  const excludedEvents: HistoryProjection['excludedEvents'] = []
  const used = new Set<string>()
  const groups = new Map<string, AgentMessage[]>()
  for (const m of messages) if (m.turnId) groups.set(m.turnId, [...(groups.get(m.turnId) || []), m])
  for (let i = 0; i < messages.length; i++) {
    const request = messages[i]
    if (request.role !== 'user' || request.id === currentId) continue
    const turnId = request.turnId || `legacy:${request.id}`
    const path = `book/conversations/${conversationId}.raw.md#${request.id}`
    const group = request.turnId
      ? groups.get(request.turnId)!
      : [request, messages[i + 1]].filter(Boolean)
    if (
      group.some(
        (m) =>
          m.visibility === 'withdrawn' ||
          m.supersededBy ||
          (m.contextVisibility && m.contextVisibility !== 'active')
      )
    ) {
      excludedEvents.push({ turnId, reason: '已撤回或被替代', path })
      continue
    }
    if (used.has(turnId)) continue
    used.add(turnId)
    const answer = request.turnId
      ? group.find((m) => m.role === 'assistant')
      : messages[i + 1]?.role === 'assistant' && !messages[i + 1].turnId
        ? messages[i + 1]
        : undefined
    if (
      answer?.outcome === 'failed' ||
      answer?.outcome === 'cancelled' ||
      request.outcome === 'failed' ||
      request.outcome === 'cancelled'
    ) {
      const progress = answer?.failureProgress
      const firstFailure =
        answer?.outcome === 'failed' &&
        progress &&
        progress.completedModelRounds === 0 &&
        progress.executedToolCalls === 0 &&
        !progress.createdProposalIds.length
      excludedEvents.push({
        turnId,
        reason: firstFailure
          ? '无进展首轮失败，原请求保留在诊断中'
          : answer?.outcome || request.outcome!,
        ...(firstFailure ? {} : { request: request.text }),
        path
      })
      continue
    }
    const completed = answer?.outcome === 'completed'
    if (!answer) {
      excludedEvents.push({ turnId, reason: '未完成请求，未自动撤销', request: request.text, path })
      continue
    }
    turns.push({ turnId, request, answer, completed, legacy: !request.turnId || !completed, path })
  }
  const recentTurns = turns.filter((t) => t.completed).slice(-8)
  const recentIds = new Set(recentTurns.map((t) => t.turnId))
  return {
    revision: historyDigest(messages),
    recentTurns,
    olderTurns: turns.filter((t) => !recentIds.has(t.turnId)),
    excludedEvents
  }
}

export function historyExcerpt(text: string, max = 140): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, Math.floor(max * 0.6)).join('')}\n[摘录省略，非语义总结；须读取原文核对否定、范围及未解决事项]\n${chars.slice(-Math.floor(max * 0.4)).join('')}`
}

export function summarizeTurn(
  c: Conversation,
  turn: HistoryTurn
): { summary: HistorySummary; hit: boolean } {
  const key = historyDigest([turn.turnId, turn.request.text, turn.answer?.finalResponse, 1])
  const cached = c.historySummaries?.[turn.turnId]
  if (cached?.key === key) return { summary: cached, hit: true }
  const summary: HistorySummary = {
    key,
    summaryVersion: 1,
    mode: 'excerpt',
    request: historyExcerpt(turn.request.text),
    response:
      turn.answer?.finalResponse === undefined
        ? '旧记录无可验证最终回答；请读取历史定位'
        : historyExcerpt(turn.answer.finalResponse)
  }
  ;(c.historySummaries ??= {})[turn.turnId] = summary
  return { summary, hit: false }
}

export function visibleHistory(
  messages: AgentMessage[],
  conversationId: string,
  currentId?: string
): { messages: AgentMessage[]; text: string; rawText: string } {
  const p = historyProjection(messages, conversationId, currentId)
  const visible = [...p.olderTurns, ...p.recentTurns].flatMap((t) => [
    t.request,
    ...(t.answer ? [{ ...t.answer, text: t.answer.finalResponse ?? '旧记录无可验证最终回答' }] : [])
  ])
  const order = new Map(messages.map((m, i) => [m.id, i]))
  visible.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
  return {
    messages: visible,
    rawText: visible
      .map((m) => {
        const original = messages[order.get(m.id)!]
        return `[${m.id} / ${m.turnId || 'legacy'}] ${m.role}（原始存档过程；${m.role === 'assistant' && original.finalResponse === undefined ? '旧记录无可验证最终回答' : '最终回答以 finalResponse 为准'}）：${original.text}`
      })
      .join('\n\n'),
    text:
      visible.map((m) => `[${m.id} / ${m.turnId || 'legacy'}] ${m.role}：${m.text}`).join('\n\n') +
      '\n失败／排除事件（不表示作者要求撤销）：' +
      JSON.stringify(p.excludedEvents)
  }
}
