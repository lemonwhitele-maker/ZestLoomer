import type { EditorState } from '@codemirror/state'
import type { AgentWorkspace } from '../../shared/agent'
import { SourceOffsets } from './editorSource'

export function agentSelection(
  state: EditorState,
  source = state.sliceDoc(),
  offsets = new SourceOffsets(source)
): AgentWorkspace['selection'] {
  const range = state.selection.main
  if (range.empty) return undefined

  const from = offsets.offset(range.from)
  const to = offsets.offset(range.to)
  return { from, to, text: source.slice(from, to) }
}
