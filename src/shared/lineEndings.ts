export function lineSeparator(text: string): string {
  return /\r\n|\r|\n/.exec(text)?.[0] ?? '\n'
}

export function normalizeLineEndings(text: string, separator: string): string {
  return text.replace(/\r\n|\r|\n/g, separator)
}

/** Finalize a new chapter edit candidate; never apply to persisted source or other writes. */
export function normalizeChapterCandidate(text: string, separator = '\n'): string {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => !/^[\t ]*$/.test(line))
    .join(separator.repeat(2))
}

/** Add only missing boundary separators; retain all existing and explicit whitespace. */
export function separateInsertion(
  source: string,
  at: number,
  text: string,
  minimum: number
): string {
  if (!text.trim()) return text
  const separator = lineSeparator(source)
  const left = source.slice(0, at),
    right = source.slice(at)
  const leading = (value: string) => /^[\r\n\t ]*/.exec(value)![0]
  const trailing = (value: string) => /[\r\n\t ]*$/.exec(value)![0]
  const breaks = (value: string) => (value.match(/\r\n|\r|\n/g) || []).length
  const before = left.trim()
    ? Math.max(0, minimum - breaks(trailing(left)) - breaks(leading(text)))
    : 0
  const after = right.trim()
    ? Math.max(0, minimum - breaks(trailing(text)) - breaks(leading(right)))
    : 0
  return separator.repeat(before) + text + separator.repeat(after)
}

// Repair model prose at the write boundary, never persisted source or JSON itself.
// Code, links and path-like tokens may intentionally contain these spellings.
export function normalizeModelText(text: string, separator = '\n'): string {
  const protectedText =
    /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`+[^`\r\n]*`+|https?:\/\/[^\s<>]+|[A-Za-z]:[\\/][^\s<>]+|(?<![\w])\/(?!n\/n)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)/g
  return text
    .split(protectedText)
    .map((part, index) => {
      if (index % 2) return normalizeLineEndings(part, separator)
      return normalizeLineEndings(
        part.replace(/(?:\/n){2,}|(?:\\r\\n|\\n|\\r){2,}/g, (token) =>
          '\n'.repeat(token.match(/\/n|\\r\\n|\\n|\\r/g)!.length)
        ),
        separator
      )
    })
    .join('')
}
