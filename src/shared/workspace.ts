import type { DocumentKind, DocumentSnapshot, OpenDocument, Result } from './documents'
import type { NamingRule } from './chapterNaming'

export interface BookPreferences {
  naming: NamingRule
  targetWords: number
}
export interface Placement {
  position: 'start' | 'end' | 'before' | 'after'
  anchorId?: string
}
export interface CreateBatchInput {
  /** Reuse the same UUID when retrying the same creation plan after an interruption. */
  operationId?: string
  bookId: string
  kind: DocumentKind
  items: { title: string; content?: string }[]
  placement: Placement
  expectedOrder?: string[]
}
export interface RenameBatchInput {
  bookId: string
  changes: { id: string; title: string; version: string }[]
}
export interface BookStats {
  totalWords: number
  words: Record<string, number>
}
export interface HistoryEntry {
  entryId: string
  id: string
  title: string
  savedAt: string
  version: string
  words: number
  content?: string
}
export interface SearchHit {
  id: string
  kind: DocumentKind
  title: string
  line: number
  excerpt: string
}
export interface WorkspaceAPI {
  refresh(bookId: string): Promise<Result<void>>
  getPreferences(bookId: string): Promise<Result<BookPreferences>>
  setPreferences(bookId: string, value: BookPreferences): Promise<Result<void>>
  createBatch(input: CreateBatchInput): Promise<Result<OpenDocument[]>>
  reorder(
    bookId: string,
    kind: DocumentKind,
    ids: string[],
    expectedIds: string[]
  ): Promise<Result<void>>
  undoOrder(bookId: string, kind: DocumentKind): Promise<Result<void>>
  renameBatch(input: RenameBatchInput): Promise<Result<DocumentSnapshot[]>>
  stats(bookId: string): Promise<Result<BookStats>>
  history(bookId: string, id: string): Promise<Result<HistoryEntry[]>>
  historyRead(bookId: string, id: string, entryId: string): Promise<Result<HistoryEntry>>
  restoreHistory(
    bookId: string,
    id: string,
    entryId: string,
    expectedVersion: string
  ): Promise<Result<DocumentSnapshot>>
  search(bookId: string, query: string): Promise<Result<SearchHit[]>>
  cancelSearch(bookId: string): Promise<Result<void>>
}
