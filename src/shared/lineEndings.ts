export function lineSeparator(text: string): string {
  return /\r\n|\r|\n/.exec(text)?.[0] ?? '\n'
}

export function normalizeLineEndings(text: string, separator: string): string {
  return text.replace(/\r\n|\r|\n/g, separator)
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
