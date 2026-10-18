import type { AgentWorkspace } from '../../shared/agent'
import type { DocumentSnapshot } from '../../shared/documents'
import {
  defaultHeavySettings,
  type HeavyAgentSettings,
  type HeavyContextBlock,
  type HeavyTurnSnapshot
} from '../../shared/heavyAgent'
import type { DocumentStore } from '../documents'

// Editor coordinates are UTF-16; sampling coordinates are Unicode code points.
export function chapterRange(
  text: string,
  workspace: AgentWorkspace
): { start: number; end: number } {
  const total = Array.from(text).length
  const point = (offset: number) => Array.from(text.slice(0, offset)).length
  const center = workspace.selection
    ? Math.floor((point(workspace.selection.from) + point(workspace.selection.to)) / 2)
    : workspace.cursor !== undefined
      ? point(workspace.cursor)
      : total
  const start = Math.max(0, Math.min(total - 8000, center - 4000))
  return { start, end: Math.min(total, start + 8000) }
}
export async function freezeHeavyContext(
  store: DocumentStore,
  bookId: string,
  workspace: AgentWorkspace,
  config?: HeavyAgentSettings
): Promise<HeavyTurnSnapshot> {
  const settings = structuredClone(config || defaultHeavySettings)
  const result: HeavyTurnSnapshot = { settings, prefix: [], current: [], notices: [] }
  if (!settings.chapterOutline && !settings.chapterContext && !settings.previousContext)
    return result
  if (!workspace.documentId) {
    result.notices.push('未确定当前正文章节，资料追加不适用')
    return result
  }
  const data = await store.heavyContextSources(bookId, workspace.documentId, settings)
  if (!data) {
    result.notices.push('当前文档不是有效正文章节，资料追加不适用')
    return result
  }
  if (workspace.savedVersion && data.chapter.version !== workspace.savedVersion)
    throw new Error('冻结章节资料时正文版本已变化，请刷新后重新发送')
  result.notices.push(...data.notices)
  result.chapterOrder = data.chapterOrder
  result.bindings = data.bindings
  const block = (
    d: DocumentSnapshot,
    purpose: string,
    start = 0,
    end = Array.from(d.content).length,
    draft = false
  ): HeavyContextBlock => {
    const chars = Array.from(d.content)
    return {
      purpose,
      id: d.id,
      title: d.title,
      version: d.version,
      draft,
      start,
      end,
      total: chars.length,
      complete: start === 0 && end === chars.length,
      content: chars.slice(start, end).join('')
    }
  }
  for (const d of data.previousOutlines) result.prefix.push(block(d, '前文章节大纲'))
  if (data.previous) {
    const total = Array.from(data.previous.content).length
    result.prefix.push(
      block(data.previous, '上一章结尾', Math.max(0, total - settings.previousTailChars), total)
    )
  }
  if (data.outline) result.prefix.push(block(data.outline, '本章大纲'))
  if (settings.chapterContext) {
    const d = { ...data.chapter, content: workspace.editorContent ?? data.chapter.content }
    const range = chapterRange(d.content, workspace)
    result.automaticWindow = range
    const ranges = [range]
    if (workspace.selection)
      ranges.push({
        start: Array.from(d.content.slice(0, workspace.selection.from)).length,
        end: Array.from(d.content.slice(0, workspace.selection.to)).length
      })
    // Selection and window always overlap; send their union once, including long explicit selections.
    result.current.push(
      block(
        d,
        '本章正文窗口与显式选区（合并去重）',
        Math.min(...ranges.map((r) => r.start)),
        Math.max(...ranges.map((r) => r.end)),
        d.content !== data.chapter.content
      )
    )
  }
  return result
}
