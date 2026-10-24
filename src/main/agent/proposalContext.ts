import { proposalDiff } from '../../shared/proposalDiff'
import type { Proposal, ProposalContext } from '../../shared/agent'
import { historyDigest } from './historyProjection'

export const proposalNotice =
  '提案采纳后可能被作者人工润色；这里记录的是当时提案，当前作品内容以重新读取的文档为准。'
const statuses: Record<string, string> = {
  pending: '待审阅',
  applying: '应用中',
  applied: '已采纳',
  rejected: '已拒绝',
  undone: '已撤销',
  stale: '已失效',
  conflicted: '冲突',
  failed: '应用失败'
}
export function proposalContext(proposals: Proposal[], prompt: string): ProposalContext {
  proposals = [...proposals].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  )
  const latest = /(?:刚才|上个|上一|这个|该).{0,6}提案|提案.{0,6}(?:继续|采纳|修改|内容)/.test(
    prompt
  )
    ? proposals.at(-1)?.id
    : undefined
  const diffs = new Map(
    proposals
      .filter((p) => p.operation === 'edit' && p.before)
      .map((p) => [p.id, proposalDiff(p.before!.content, p.content)])
  )
  return {
    revision: historyDigest(proposals),
    index: proposals.map((p) => ({
      id: p.id,
      title: `${p.title}${p.operation === 'create' ? '（新建）' : ''}`,
      turnId: p.turnId,
      status: statuses[p.state] || '未知',
      path: `book/proposals/${p.id}.json`,
      locations:
        diffs.get(p.id)?.coarse === false
          ? diffs.get(p.id)!.hunks.map((h) => ({ oldLine: h.oldLine, newLine: h.newLine }))
          : undefined
    })),
    // Exact line blocks include normalization changes; coarse comparisons retain full before/content.
    contents: proposals.map((p) => ({
      id: p.id,
      old_text:
        diffs.get(p.id)?.coarse === false
          ? diffs.get(p.id)!.hunks.map((h) => h.before)
          : p.before?.content || '',
      new_text:
        diffs.get(p.id)?.coarse === false ? diffs.get(p.id)!.hunks.map((h) => h.after) : p.content,
      status: statuses[p.state] || '未知'
    })),
    requiredIds: proposals
      .filter(
        (p) =>
          p.id === latest ||
          prompt.includes(p.id) ||
          (p.title.length > 1 && prompt.includes(p.title))
      )
      .map((p) => p.id)
  }
}
