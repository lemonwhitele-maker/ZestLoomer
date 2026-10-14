import {
  Decoration,
  MatchDecorator,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate
} from '@codemirror/view'
import type { KnowledgeEntry } from './editorKnowledge'

/** Viewport decorations never alter saved text, selection, or undo history. */
export function knowledgeHighlights(entries: KnowledgeEntry[]) {
  if (!entries.length) return []
  const byName = new Map(entries.map((entry) => [entry.name.toLowerCase(), entry]))
  const matcher = new MatchDecorator({
    regexp: new RegExp(
      entries.map((entry) => entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
      'gi'
    ),
    decoration: (match) => {
      const entry = byName.get(match[0].toLowerCase())!
      return Decoration.mark({
        class: entry.kind === 'characters' ? 'cm-knowledge-character' : 'cm-knowledge-setting',
        attributes: { title: `${entry.kind === 'characters' ? '人物' : '设定'}：${entry.title}` }
      })
    }
  })
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view)
      }
      update(update: ViewUpdate): void {
        this.decorations = matcher.updateDeco(update, this.decorations)
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )
}
