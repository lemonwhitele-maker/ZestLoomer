// Serialized state retains undo/selection without retaining a destroyed Vue view's callbacks.
export const editorCache = new Map<
  string,
  {
    source: string
    json: ReturnType<import('@codemirror/state').EditorState['toJSON']>
    scrollTop: number
  }
>()

export interface EditorPosition {
  anchor: number
  head: number
  scrollTop: number
  topAnchor?: number
}
const positions = new Map<string, EditorPosition>()
export function readPosition(key: string): EditorPosition | undefined {
  if (positions.has(key)) return positions.get(key)
  try {
    // Existing Loom profiles retain their positions; subsequent writes use the new key.
    const value = JSON.parse(
      localStorage.getItem(`zestloomer.editor-position:${key}`) ??
        localStorage.getItem(`loom.editor-position:${key}`) ??
        'null'
    )
    if (
      value &&
      ['anchor', 'head', 'scrollTop'].every(
        (field) => Number.isFinite(value[field]) && value[field] >= 0
      )
    ) {
      if (!Number.isFinite(value.topAnchor) || value.topAnchor < 0) delete value.topAnchor
      positions.set(key, value)
      return value
    }
  } catch {
    /* A damaged or unavailable local cache must not prevent opening a document. */
  }
  return undefined
}
export function writePosition(key: string, value: EditorPosition): void {
  positions.set(key, value)
  try {
    localStorage.setItem(`zestloomer.editor-position:${key}`, JSON.stringify(value))
  } catch {
    /* Keep the in-memory position when storage is unavailable. */
  }
}
