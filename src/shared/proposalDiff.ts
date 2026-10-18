import { logicalLines } from './logicalLines'

export interface DiffHunk {
  before: string
  after: string
  oldLine: number
  newLine: number
}

export interface DiffSpan {
  text: string
  changed: boolean
  newline?: boolean
}
/** Bounded Unicode character comparison within a changed hunk. */
export function inlineDiff(
  before: string,
  after: string
): { before: DiffSpan[]; after: DiffSpan[] } {
  const a = Array.from(before),
    b = Array.from(after)
  let start = 0,
    oldEnd = a.length,
    newEnd = b.length
  while (start < oldEnd && start < newEnd && a[start] === b[start]) start++
  while (oldEnd > start && newEnd > start && a[oldEnd - 1] === b[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  const left: DiffSpan[] = [],
    right: DiffSpan[] = []
  const push = (spans: DiffSpan[], text: string, changed: boolean) => {
    if (!text) return
    if (spans.at(-1)?.changed === changed) spans[spans.length - 1].text += text
    else spans.push({ text, changed })
  }
  push(left, a.slice(0, start).join(''), false)
  push(right, b.slice(0, start).join(''), false)
  const x = a.slice(start, oldEnd),
    y = b.slice(start, newEnd)
  if (x.length * y.length > 200000 || x.length + y.length > 20000) {
    push(left, x.join(''), true)
    push(right, y.join(''), true)
  } else {
    const rows = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1))
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--)
        rows[i][j] =
          x[i] === y[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1])
    let i = 0,
      j = 0
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) {
        push(left, x[i++], false)
        push(right, y[j++], false)
      } else if (i < x.length && (j === y.length || rows[i + 1][j] >= rows[i][j + 1]))
        push(left, x[i++], true)
      else push(right, y[j++], true)
    }
  }
  push(left, a.slice(oldEnd).join(''), false)
  push(right, b.slice(newEnd).join(''), false)
  const endings = (spans: DiffSpan[]) =>
    spans.flatMap((span) =>
      span.changed
        ? span.text
            .split(/(\r\n|\r|\n)/)
            .filter(Boolean)
            .map((text) => ({ text, changed: true, newline: /^(\r\n|\r|\n)$/.test(text) }))
        : [span]
    )
  return { before: endings(left), after: endings(right) }
}
/** Bounded line LCS. Large documents use a clearly labelled coarse preview. */
export function proposalDiff(
  before: string,
  after: string,
  unified = false
): { hunks: DiffHunk[]; coarse: boolean } {
  // Keep real separators in the comparison: an EOF continuation must show its added newline.
  const a = logicalLines(before).map((line) => before.slice(line.start, line.after)),
    b = logicalLines(after).map((line) => after.slice(line.start, line.after))
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
          before: a.slice(start, oldEnd).join(''),
          after: b.slice(start, newEnd).join(''),
          oldLine: start + 1,
          newLine: start + 1
        }
      ],
      coarse: false
    }
  }
  if (a.length * b.length > 500000 || a.length + b.length > 20000)
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
      active.before += a[i++]
    else active.after += b[j++]
  }
  return { hunks, coarse: false }
}
