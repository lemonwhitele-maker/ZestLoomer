import type { DocumentKind, DocumentMeta, DocumentSnapshot } from '../shared/documents'
import type { BookStats } from '../shared/workspace'
import { countWords } from './documents'

export interface CatalogEntry {
  meta: DocumentMeta
  version: string
  words: number
  folder: string
  kind: DocumentKind
  trashed: boolean
}

/**
 * Rebuildable metadata catalog with incremental totals and O(N) list/stat projections.
 * Does not store document full content to preserve memory.
 */
export class BookCatalog {
  private entries = new Map<string, CatalogEntry>()
  private initialized = false
  private totalChapterWords = 0
  private wordCounts: Record<string, number> = {}

  get isInitialized(): boolean {
    return this.initialized
  }

  initialize(
    snapshots: DocumentSnapshot[],
    folderLookup: (id: string) => { folder: string; kind: DocumentKind; trashed: boolean }
  ): void {
    this.entries.clear()
    this.totalChapterWords = 0
    this.wordCounts = {}

    for (const snap of snapshots) {
      const words = countWords(snap.content)
      const loc = folderLookup(snap.id)
      const { content: _content, version, ...meta } = snap
      const entry: CatalogEntry = {
        meta,
        version,
        words,
        folder: loc.folder,
        kind: snap.kind,
        trashed: Boolean(snap.trashedAt)
      }
      this.entries.set(snap.id, entry)
      if (!entry.trashed) {
        this.wordCounts[snap.id] = words
        if (snap.kind === 'chapters') {
          this.totalChapterWords += words
        }
      }
    }
    this.initialized = true
  }

  invalidate(): void {
    this.initialized = false
    this.entries.clear()
    this.totalChapterWords = 0
    this.wordCounts = {}
  }

  list(): DocumentMeta[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e.meta }))
  }

  stats(): BookStats {
    return {
      totalWords: this.totalChapterWords,
      words: { ...this.wordCounts }
    }
  }

  getEntry(id: string): CatalogEntry | undefined {
    return this.entries.get(id)
  }

  add(snapshot: DocumentSnapshot, folder: string): void {
    if (!this.initialized) return
    this.update(snapshot)
    this.entries.get(snapshot.id)!.folder = folder
  }

  remove(id: string): void {
    const old = this.entries.get(id)
    if (old && !old.trashed && old.kind === 'chapters') this.totalChapterWords -= old.words
    delete this.wordCounts[id]
    this.entries.delete(id)
  }

  update(snapshot: DocumentSnapshot): void {
    if (!this.initialized) return
    const old = this.entries.get(snapshot.id)
    if (old?.version === snapshot.version) return
    const oldWords = old?.words ?? 0
    const wasCounted = old && !old.trashed

    const words = countWords(snapshot.content)
    const { content: _content, version, ...meta } = snapshot
    const entry: CatalogEntry = {
      meta,
      version,
      words,
      folder: old?.folder ?? '',
      kind: snapshot.kind,
      trashed: Boolean(snapshot.trashedAt)
    }
    this.entries.set(snapshot.id, entry)

    if (wasCounted && old.kind === 'chapters') {
      this.totalChapterWords -= oldWords
    }

    if (!entry.trashed) {
      this.wordCounts[snapshot.id] = words
      if (snapshot.kind === 'chapters') {
        this.totalChapterWords += words
      }
    } else {
      delete this.wordCounts[snapshot.id]
    }
  }

  updateMeta(meta: DocumentMeta): void {
    if (!this.initialized) return
    const old = this.entries.get(meta.id)
    if (!old) return
    old.meta = { ...meta }
  }

  setTrashed(id: string, trashed: boolean, snapshot: DocumentSnapshot, newFolder: string): void {
    if (!this.initialized) return
    const old = this.entries.get(id)
    if (old) {
      if (!old.trashed && old.kind === 'chapters') {
        this.totalChapterWords -= old.words
      }
      delete this.wordCounts[id]
    }

    const words = countWords(snapshot.content)
    const { content: _content, version, ...meta } = snapshot
    const entry: CatalogEntry = {
      meta,
      version,
      words,
      folder: newFolder,
      kind: snapshot.kind,
      trashed
    }
    this.entries.set(id, entry)

    if (!trashed) {
      this.wordCounts[id] = words
      if (snapshot.kind === 'chapters') {
        this.totalChapterWords += words
      }
    }
  }
}
