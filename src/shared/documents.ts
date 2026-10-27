import type { AgentAPI } from './agent'
import type { WorkspaceAPI } from './workspace'
import type { ImportAPI } from './imports'
import type { ToolAPI } from './toolApi'
export const kinds = [
  'chapters',
  'notes',
  'characters',
  'settings',
  'outlines',
  'foreshadows'
] as const
export type DocumentKind = (typeof kinds)[number]
export const labels: Record<DocumentKind, string> = {
  chapters: '正文',
  notes: '速记',
  characters: '人物',
  settings: '设定',
  outlines: '大纲',
  foreshadows: '伏笔'
}
export interface Book {
  id: string
  title: string
  root: string
  format: 1
}
export interface DocumentMeta {
  readonlyExample?: boolean
  id: string
  kind: DocumentKind
  title: string
  order: number
  createdAt: string
  updatedAt: string
  generation: string
  trashedAt: string | null
}
export interface DocumentSnapshot extends DocumentMeta {
  content: string
  version: string
}
export interface Draft {
  content: string
  title: string
  baseVersion: string
  savedAt: string
}
export interface OpenDocument {
  document: DocumentSnapshot
  draft: Draft | null
}
export interface WorkspacePreferences {
  theme?: 'light' | 'dark' | 'system'
  font: string
  size: number
  lineHeight: number
  lastBookId?: string
  lastDocuments: Record<string, string>
  agentVisible: boolean
  listVisible: boolean
  focusMode: boolean
  agentWidths: Record<string, number>
  knowledgeHighlight?: Record<string, boolean>
  targetRewrite?: boolean
  unifiedProposalPreview?: boolean
  lastDocumentsByKind?: Record<string, Partial<Record<DocumentKind, string>>>
}
export interface SaveInput {
  bookId: string
  id: string
  content: string
  title: string
  expectedVersion: string
}
export type Result<T> =
  | { ok: true; value: T }
  | {
      ok: false
      code: string
      message: string
      binding?: import('./storyLinks').ChapterOutlinePair
    }
export interface ZestLoomerAPI {
  story: import('./storyLinks').StoryAPI
  tools: ToolAPI
  agent: AgentAPI
  workspace: WorkspaceAPI
  imports: ImportAPI
  bootstrap(): Promise<
    Result<{
      books: Book[]
      preferences: WorkspacePreferences
      errors: string[]
      performanceEnabled?: boolean
      performanceCounters?: Record<string, number>
    }>
  >
  createBook(title: string): Promise<Result<Book | null>>
  renameBook(bookId: string, title: string): Promise<Result<Book>>
  openBook(): Promise<Result<Book | null>>
  list(bookId: string): Promise<Result<DocumentMeta[]>>
  create(
    bookId: string,
    kind: DocumentKind,
    title: string,
    template?: 'basic' | 'blank'
  ): Promise<Result<OpenDocument>>
  read(bookId: string, id: string): Promise<Result<OpenDocument>>
  save(input: SaveInput): Promise<Result<DocumentSnapshot>>
  draft(bookId: string, id: string, draft: Draft | null): Promise<Result<void>>
  trash(bookId: string, id: string, version: string): Promise<Result<DocumentSnapshot>>
  restore(bookId: string, id: string, version: string): Promise<Result<DocumentSnapshot>>
  reorder(bookId: string, kind: DocumentKind, ids: string[]): Promise<Result<void>>
  preferences(value: WorkspacePreferences): Promise<Result<void>>
  exportDocument(bookId: string, id: string): Promise<Result<boolean>>
  exportBook(bookId: string): Promise<Result<boolean>>
  backup(bookId: string): Promise<Result<boolean>>
  onClose(handler: () => Promise<boolean>): () => void
}
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value
  throw Object.assign(new Error(result.message), { code: result.code })
}
export const defaultPreferences: WorkspacePreferences = {
  theme: 'system',
  font: 'Microsoft YaHei',
  size: 18,
  lineHeight: 1.9,
  lastDocuments: {},
  agentVisible: false,
  listVisible: true,
  focusMode: false,
  agentWidths: {}
}
