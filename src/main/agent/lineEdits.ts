import type { DocumentSnapshot } from '../../shared/documents'
import { logicalLines } from '../../shared/logicalLines'
import {
  lineSeparator,
  normalizeLineEndings,
  normalizeModelText,
  separateInsertion
} from '../../shared/lineEndings'
import { BookDocumentAdapter, checkKeys, fail, object, textArg } from './documents'

/** Resolve every operation against the same saved version before changing any text. */
export function applyLineEdits(
  adapter: BookDocumentAdapter,
  before: DocumentSnapshot,
  args: Record<string, unknown>
): string {
  if (!Array.isArray(args.edits) || !args.edits.length || args.edits.length > 20)
    fail('ARGUMENT', 'edits 应包含 1–20 项')
  const selection =
    adapter.workspace.documentId === before.id ? adapter.workspace.selection : undefined
  if (!selection && args.edits.some((value) => 'oldText' in object(value)))
    fail(
      'ARGUMENT',
      '无有效选区不允许 oldText 定位；请 read 后使用 baseVersion、mode 和行号或文档边界 target'
    )
  if (textArg(args, 'baseVersion', 200) !== before.version)
    fail('VERSION', 'baseVersion 与已读取目标版本不一致，请重新 read')
  const separator = lineSeparator(before.content)
  // Chapters already using blank-line paragraphs must keep that spacing at both new joins.
  // Markdown and single-spaced chapters retain their existing one-break convention.
  const insertionBreaks =
    before.kind === 'chapters' && /\n[\t ]*\n/.test(normalizeLineEndings(before.content, '\n'))
      ? 2
      : 1
  const index = logicalLines(before.content)
  const ranges: { from: number; to: number; text: string }[] = []
  const covered = (from: number, to: number) => {
    if (!adapter.deliveredCovers(before.id, from, to))
      fail('READ_REQUIRED', '先 read 同版本完整目标行或选区；超长行须继续 nextCursor 直到覆盖整行')
  }
  const lineAt = (value: unknown) => {
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > index.length)
      fail('ARGUMENT', '行号必须为 totalLines 范围内的正整数')
    return index[Number(value) - 1]
  }
  if (selection && args.edits.length !== 1) fail('SELECTION', '选区只能提出一次完整替换')
  for (const value of args.edits) {
    const edit = object(value)
    checkKeys(edit, ['mode', 'target', 'newText', 'oldText'])
    const target = object(edit.target)
    const mode = edit.mode
    const kind = target.kind
    let text =
      before.kind === 'foreshadows'
        ? normalizeLineEndings(textArg(edit, 'newText'), separator)
        : normalizeModelText(textArg(edit, 'newText'), separator)
    if (selection) {
      if (mode !== 'replace' || kind !== 'selection')
        fail(
          'SELECTION',
          '当前有选区，只能 mode:replace、target:{kind:selection} 替换完整冻结选区，不允许行范围或插入'
        )
      checkKeys(target, ['kind'])
      if (edit.oldText !== undefined && textArg(edit, 'oldText') !== selection.text)
        fail('SELECTION', 'oldText 必须与完整冻结选区原文一致，请重新核对选区')
      covered(selection.from, selection.to)
      ranges.push({ from: selection.from, to: selection.to, text })
      continue
    }
    if (mode === 'replace' && kind === 'lines') {
      checkKeys(target, ['kind', 'startLine', 'endLine'])
      const first = lineAt(target.startLine),
        last = lineAt(target.endLine)
      if (first.line > last.line) fail('ARGUMENT', 'startLine 不得大于 endLine')
      covered(first.start, last.after)
      ranges.push({ from: first.start, to: text === '' ? last.after : last.end, text })
    } else if (
      mode === 'insert' &&
      ['before_line', 'after_line', 'document_start', 'document_end'].includes(String(kind))
    ) {
      if (text === '') fail('ARGUMENT', 'insert 的 newText 不能为空')
      let at: number
      if (kind === 'before_line' || kind === 'after_line') {
        checkKeys(target, ['kind', 'line'])
        const line = lineAt(target.line)
        covered(line.start, line.after)
        at = kind === 'before_line' ? line.start : line.after
      } else {
        checkKeys(target, ['kind'])
        const anchor = kind === 'document_start' ? index[0] : index.at(-1)
        if (anchor) covered(anchor.start, anchor.after)
        else covered(0, 0)
        at = kind === 'document_start' ? 0 : before.content.length
      }
      text = separateInsertion(before.content, at, text, insertionBreaks)
      ranges.push({ from: at, to: at, text })
    } else
      fail(
        'ARGUMENT',
        '无选区使用 replace/lines 或 insert/before_line、after_line、document_start、document_end；selection 仅适用于有效冻结选区'
      )
  }
  ranges.sort((a, b) => a.from - b.from)
  for (let i = 0; i < ranges.length; i++) {
    for (const b of ranges.slice(i + 1)) {
      const a = ranges[i]
      const conflict =
        a.from === a.to || b.from === b.to
          ? a.from <= b.to && b.from <= a.to
          : a.from < b.to && b.from < a.to
      if (conflict) fail('OVERLAP', '替换不能重叠；同点插入或插入与替换内部、边界冲突，请合并表达')
    }
  }
  let content = before.content
  for (const range of ranges.reverse())
    content = content.slice(0, range.from) + range.text + content.slice(range.to)
  return content
}
