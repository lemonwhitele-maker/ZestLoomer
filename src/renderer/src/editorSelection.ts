import type { EditorState } from '@codemirror/state'
import type { AgentWorkspace } from '../../shared/agent'
import { sourceOffset } from './editorSource'

export function agentSelection(
  state: EditorState,
  source = state.sliceDoc()
): AgentWorkspace['selection'] {
  const range = state.selection.main
  if (range.empty) return undefined

  const from = sourceOffset(source, range.from)
  const to = sourceOffset(source, range.to)
  return { from, to, text: source.slice(from, to) }
}
