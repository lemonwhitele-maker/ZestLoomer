export interface DiffHunk {
  before: string
  after: string
  oldLine: number
  newLine: number
}
/** Bounded line LCS. Large documents use a clearly labelled coarse preview. */
export function proposalDiff(
  before: string,
  after: string,
  unified = false
): { hunks: DiffHunk[]; coarse: boolean } {
  const a = before.split('\n'),
    b = after.split('\n')
  if (before === after) return { hunks: [], coarse: false }
  if (unified) {
    // Keep unchanged paragraphs between the first and last changes in one comparison.
    let start = 0
    while (start < a.length && start < b.length && a[start] === b[start]) start++
    let oldEnd = a.length,
      newEnd = b.length
    while (oldEnd > start && newEnd > start && a[oldEnd - 1] === b[newEnd - 1]) {
      oldEnd--
      newEnd--
    }
    return {
      hunks: [
        {
          before: a.slice(start, oldEnd).join('\n'),
          after: b.slice(start, newEnd).join('\n'),
          oldLine: start + 1,
          newLine: start + 1
        }
      ],
      coarse: false
    }
  }
  if (a.length * b.length > 500000)
    return { hunks: [{ before, after, oldLine: 1, newLine: 1 }], coarse: true }
  const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1])
  const hunks: DiffHunk[] = []
  let i = 0,
    j = 0,
    active: DiffHunk | undefined
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      active = undefined
      i++
      j++
      continue
    }
    if (!active) {
      active = { before: '', after: '', oldLine: i + 1, newLine: j + 1 }
      hunks.push(active)
    }
    if (i < a.length && (j === b.length || rows[i + 1][j] >= rows[i][j + 1]))
      active.before += a[i++] + '\n'
    else active.after += b[j++] + '\n'
  }
  return { hunks, coarse: false }
}
