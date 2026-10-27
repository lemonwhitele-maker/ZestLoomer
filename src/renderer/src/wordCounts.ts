import type { DocumentSession } from './session'
import { countWords } from '../../shared/wordCount'

/** A new session is a new cache namespace, even when its edit revision starts at zero. */
export class SessionWordCounts {
  private entries = new WeakMap<
    DocumentSession,
    { revision: number; version: string; count: number }
  >()
  count(session: DocumentSession): number {
    const cached = this.entries.get(session)
    if (cached?.revision === session.revision && cached.version === session.document.version)
      return cached.count
    const count = countWords(session.content)
    this.entries.set(session, {
      revision: session.revision,
      version: session.document.version,
      count
    })
    return count
  }
}
