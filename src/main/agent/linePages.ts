import { DocumentError } from '../documents'
import { logicalLines, type NumberedLine } from '../../shared/logicalLines'

/** maxChars includes serialized line records (escaping, numbering and fragment metadata). */
export function linePage(text: string, start: number, limit: number, maxChars: number) {
  const index = logicalLines(text)
  const lines: NumberedLine[] = []
  let end = start
  let size = 2 // JSON array brackets
  for (const line of index) {
    if (line.after <= start || line.start >= limit) continue
    const from = Math.max(start, line.start)
    const row: NumberedLine = {
      line: line.line,
      text: text.slice(from, line.end),
      complete: from === line.start,
      ...(from > line.start
        ? {
            fragment: {
              start: from - line.start,
              end: line.end - line.start,
              total: line.end - line.start
            }
          }
        : {}),
      eol: text.slice(line.end, line.after)
    }
    const cost = JSON.stringify(row).length + (lines.length ? 1 : 0)
    if (size + cost <= maxChars) {
      lines.push(row)
      size += cost
      end = line.after
      continue
    }
    // Never split an ordinary line to fill the remainder of a page.
    if (lines.length) break
    let lo = from,
      hi = line.end
    const fragment = (to: number): NumberedLine => ({
      line: line.line,
      text: text.slice(from, to),
      complete: false,
      fragment: { start: from - line.start, end: to - line.start, total: line.end - line.start }
    })
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (JSON.stringify(fragment(mid)).length + 2 <= maxChars) lo = mid
      else hi = mid - 1
    }
    // Keep Unicode surrogate pairs together. Separators are never fragmented.
    if (lo > from && /[\uD800-\uDBFF]/.test(text[lo - 1]) && /[\uDC00-\uDFFF]/.test(text[lo] || ''))
      lo--
    if (lo === from)
      throw new DocumentError('BUDGET', '行号结构超出本页额度，请增大 maxChars 或减少 paths')
    lines.push(fragment(lo))
    end = lo
    break
  }
  return {
    lines,
    end,
    lineRange: {
      startLine: lines[0]?.line ?? null,
      endLine: lines.at(-1)?.line ?? null,
      totalLines: index.length
    }
  }
}
