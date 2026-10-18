export interface ChapterOutlinePair {
  chapterId: string
  outlineId: string
}
export interface ChapterOutlineBindings {
  schemaVersion: 1
  revision: number
  bindings: ChapterOutlinePair[]
}
export interface BindingDependency {
  id: string
  targetId: string | null
}
export interface StoryTarget {
  id: string
  kind: 'chapters' | 'outlines'
  state: 'active' | 'trashed' | 'missing'
  title: string | null
  path: string
}
export type ChapterOutlineBinding =
  | { state: 'unbound'; revision: number }
  | { state: 'bound'; revision: number; target: StoryTarget }
  | { state: 'error'; code: string; message: string }

export interface ForeshadowContent {
  content: string
  startChapterId: string | null
  endChapterId: string | null
}
import type { DocumentSnapshot } from './documents'

export interface StoryRead {
  automaticBindingNotice?: string
  document: DocumentSnapshot
  chapterOutlineBinding?: ChapterOutlineBinding
  foreshadowChapters?: { start: StoryTarget | null; end: StoryTarget | null } | { error: string }
}
export interface ForeshadowRow {
  document: DocumentSnapshot
  fields?: ForeshadowContent
  startChapter?: StoryTarget | null
  endChapter?: StoryTarget | null
  error?: string
}
export interface StoryAPI {
  match(
    bookId: string,
    expectedRevision: number
  ): Promise<import('./documents').Result<ChapterOutlineMatchResult>>
  bindings(bookId: string): Promise<import('./documents').Result<ChapterOutlineBindings>>
  bind(input: {
    bookId: string
    chapterId: string
    outlineId: string | null
    expectedRevision: number
  }): Promise<import('./documents').Result<ChapterOutlineBindings>>
  read(bookId: string, ids: string[]): Promise<import('./documents').Result<StoryRead[]>>
  foreshadows(
    bookId: string,
    offset?: number,
    limit?: number
  ): Promise<
    import('./documents').Result<{
      rows: ForeshadowRow[]
      total: number
      nextOffset: number | null
    }>
  >
}
export interface ChapterOutlineMatchResult {
  revision: number
  added: ChapterOutlinePair[]
  ambiguousNumbers: number[]
  occupiedNumbers: number[]
}
