import type { ChangeSet } from '@codemirror/state'
import { lineSeparator } from '../../shared/lineEndings'

// Editor positions count every line ending as one; disk text may mix CRLF, LF and CR.
export class SourceOffsets {
  private breaks: number[] = []
  constructor(source: string) {
    let at = source.indexOf('\r\n')
    while (at !== -1) {
      this.breaks.push(at - this.breaks.length)
      at = source.indexOf('\r\n', at + 2)
    }
  }
  offset(position: number): number {
    let low = 0
    let high = this.breaks.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.breaks[middle] < position) low = middle + 1
      else high = middle
    }
    return position + low
  }
}

export function sourceOffset(source: string, position: number): number {
  return new SourceOffsets(source).offset(position)
}

export function changedSource(
  source: string,
  changes: ChangeSet,
  offsets = new SourceOffsets(source)
): string {
  let result = ''
  let end = 0
  const separator = lineSeparator(source)
  changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    const start = offsets.offset(from)
    result += source.slice(end, start) + inserted.sliceString(0, inserted.length, separator)
    end = offsets.offset(to)
  })
  return result + source.slice(end)
}
