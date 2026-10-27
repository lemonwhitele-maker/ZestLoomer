import type { DocumentSession } from './session'

export function sessionBytes(session: DocumentSession): number {
  return 2 * (session.content.length + session.document.content.length + session.title.length)
}

/** Insertion order is LRU; unsafe sessions may exceed the budget until saved. */
export async function trimSessions(
  sessions: Map<string, DocumentSession>,
  active: DocumentSession | null,
  maxCount = 50,
  maxBytes = 24 * 1024 * 1024
): Promise<void> {
  let bytes = [...sessions.values()].reduce((sum, item) => sum + sessionBytes(item), 0)
  for (const [key, item] of sessions) {
    if (sessions.size <= maxCount && bytes <= maxBytes) break
    if (item === active || !item.isIdle) continue
    if (await item.disposeAfterSettled()) {
      sessions.delete(key)
      bytes -= sessionBytes(item)
    }
  }
}
