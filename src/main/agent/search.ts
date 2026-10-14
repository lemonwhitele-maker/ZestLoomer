import { rankText } from './relevance'
import { DocumentStore } from '../documents'
import type { DocumentKind } from '../../shared/documents'
import { documentPath } from './documents'

interface IndexEntry {
  id: string
  kind: DocumentKind
  version: string
  title: string
  text: string
  folded: string
}
interface Index {
  format: 1
  entries: IndexEntry[]
}
/** A disposable local index. Every search revalidates source versions, including external edits. */
export class BookSearchIndex {
  constructor(
    private store: DocumentStore,
    private bookId: string
  ) {}
  async search(
    kind: DocumentKind | 'all',
    query: string,
    signal?: AbortSignal
  ): Promise<{ path: string; title: string; excerpt: string; sourceKind: DocumentKind }[]> {
    let old: Index | undefined
    try {
      old = (await this.store.agentRecords<Index>(this.bookId, 'indexes')).find(
        (i) => i.format === 1 && Array.isArray(i.entries)
      )
    } catch {
      /* Index corruption is repaired from source files, never used as authority. */
    }
    const oldMap = new Map<string, IndexEntry>()
    if (old?.entries) {
      for (const e of old.entries) {
        oldMap.set(e.id, e)
      }
    }
    let dirty = oldMap.size === 0
    const entries: IndexEntry[] = []
    for (const meta of await this.store.agentDocuments(this.bookId)) {
      signal?.throwIfAborted()
      const d = await this.store.agentRead(this.bookId, meta.id)
      const cached = oldMap.get(d.id)
      if (
        cached &&
        cached.kind === d.kind &&
        cached.version === d.version &&
        cached.title === d.title &&
        cached.text === d.content
      ) {
        entries.push(cached)
      } else {
        dirty = true
        entries.push({
          id: d.id,
          kind: d.kind,
          version: d.version,
          title: d.title,
          text: d.content,
          folded: d.content.toLocaleLowerCase()
        })
      }
    }
    if (old?.entries?.length !== entries.length) {
      dirty = true
    }
    signal?.throwIfAborted()
    if (dirty) {
      try {
        await this.store.writeAgentRecord(this.bookId, 'indexes', `index_${this.bookId.slice(5)}`, {
          format: 1,
          entries
        })
      } catch {
        /* A cache write failure does not make a successful source search fail. */
      }
    }
    return entries
      .filter((e) => kind === 'all' || e.kind === kind)
      .flatMap((e) => {
        const hit = rankText(e.title, e.text, query)
        return hit
          ? [
              {
                path: documentPath(e),
                title: e.title,
                sourceKind: e.kind,
                version: e.version,
                ...hit
              }
            ]
          : []
      })
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  }
}
