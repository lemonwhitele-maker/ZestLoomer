import { proposalDiff, inlineDiff } from '../../shared/proposalDiff'
export function proposalPreview(before: string, after: string, unified: boolean) {
  const result = proposalDiff(before, after, unified)
  const hunks = result.hunks.slice(0, 80)
  return {
    ...result,
    coarse: result.coarse || hunks.some((hunk) => hunk.before.length + hunk.after.length > 100000),
    hunks,
    truncated: result.hunks.length > hunks.length,
    highlighted: hunks.map((hunk) =>
      hunk.before.length + hunk.after.length > 100000
        ? {
            before: [{ text: hunk.before, changed: true }],
            after: [{ text: hunk.after, changed: true }]
          }
        : inlineDiff(hunk.before, hunk.after)
    )
  }
}
