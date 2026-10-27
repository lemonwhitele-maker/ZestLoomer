/** Stored logical lines; a terminal separator belongs to its preceding line. */
export interface LogicalLine {
  line: number
  start: number
  end: number
  after: number
}

export function logicalLines(text: string): LogicalLine[] {
  const lines: LogicalLine[] = []
  let start = 0
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    lines.push({
      line: lines.length + 1,
      start,
      end: match.index!,
      after: match.index! + match[0].length
    })
    start = match.index! + match[0].length
  }
  if (start < text.length)
    lines.push({ line: lines.length + 1, start, end: text.length, after: text.length })
  return lines
}

export interface NumberedLine {
  line: number
  text: string
  complete: boolean
  /** UTF-16 offsets within this line, only present for fragments. */
  fragment?: { start: number; end: number; total: number }
  /** Original separator, delivered only with the final fragment. */
  eol?: string
}

/** One copy of manuscript text, shared by read pages and verified caches. */
export function numberedLines(text: string): NumberedLine[] {
  return logicalLines(text).map((line) => ({
    line: line.line,
    text: text.slice(line.start, line.end),
    complete: true,
    eol: text.slice(line.end, line.after)
  }))
}
