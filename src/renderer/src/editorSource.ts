import type { ChangeSet } from '@codemirror/state'
import { lineSeparator } from '../../shared/lineEndings'

// Editor positions count every line ending as one; disk text may mix CRLF, LF and CR.
export function sourceOffset(source: string, position: number): number {
  let extra = 0
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    if (match.index - extra >= position) break
    extra += match[0].length - 1
  }
  return position + extra
}

export function changedSource(source: string, changes: ChangeSet): string {
  let result = ''
  let end = 0
  const separator = lineSeparator(source)
  changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    const start = sourceOffset(source, from)
    result += source.slice(end, start) + inserted.sliceString(0, inserted.length, separator)
    end = sourceOffset(source, to)
  })
  return result + source.slice(end)
}
