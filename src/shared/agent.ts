import type { BindingDependency } from './storyLinks'
import type { DocumentKind, DocumentSnapshot, Result } from './documents'

export type ToolName = 'list_files' | 'read' | 'create' | 'write' | 'edit'
export interface SourceRef {
  id: string
  version: string
  title: string
  kind: DocumentKind
}
export interface AgentWorkspace {
  cursor?: number
  editorContent?: string
  heavySnapshot?: import('./heavyAgent').HeavyTurnSnapshot
  targetRewrite?: boolean
  documentId?: string
  savedVersion?: string
  selection?: {
    /** Zero-based UTF-16 offsets; to is exclusive. */
    from: number
    to: number
    text: string
    /** Backend-derived absolute logical lines (1-based, inclusive), not whole-line edit targets. */
    startLine?: number
    endLine?: number
  }
}
export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  sources: SourceRef[]
  createdAt?: string
  turnId?: string
  outcome?: 'completed' | 'cancelled' | 'failed'
  finalResponse?: string
  visibility?: 'visible' | 'withdrawn'
  contextVisibility?: 'active' | 'excluded' | 'withdrawn' | 'superseded'
  failureProgress?: {
    completedModelRounds: number
    executedToolCalls: number
    createdProposalIds: string[]
  }
  supersededBy?: string
  rewrite?: TargetRewriteResult
  context?: { workspace: AgentWorkspace; document?: SourceRef; model: string }
}
export interface TargetRewriteResult {
  status: 'rewritten' | 'skipped' | 'fallback'
  reason: string
  historyTurnIds: string[]
  omittedTurns: number
  target: { target: string; constraints: string[]; unresolved: string[] } | null
}
export interface MemoryItem {
  text: string
  messageId: string
  role: 'user' | 'assistant'
}
export interface ConversationMemory {
  format: 1 | 2
  revision?: string
  objective: MemoryItem | null
  preferences: MemoryItem[]
  discussion: MemoryItem[]
  todos: MemoryItem[]
  sources: SourceRef[]
  coveredThroughMessageId: string | null
  updatedAt: string
}
export interface ModelPolicy {
  contextTokens: number
  outputTokens: number
  retryOutputTokens: number
  reasoning?: string
}
export interface AgentProfile extends ModelPolicy {
  id: string
  label: string
  baseUrl: string
  model: string
  hasKey: boolean
}
export interface AgentDiagnostic {
  at: string
  turnId: string
  phase: string
  tool?: string
  code?: string
  elapsedMs?: number
  inputTokens?: number
  outputTokens?: number
  model?: string
  round?: number
  attempt?: number
  outputBudget?: number
  toolCallId?: string
  argsDigest?: string
  resultDigest?: string
  resultType?: string
  previousCallId?: string
  proposalId?: string
  readResults?: {
    path: string
    version: string
    complete?: boolean
    range?: { start: number; end: number; total: number }
  }[]
  snapshotDigest?: string
  toolVersion?: number
  deliveredCallIds?: string[]
  evidence?: { id: string; version: string; ranges: { start: number; end: number }[] }[]
  snapshot?: {
    profileId?: string
    provider?: string
    model: string
    policy: ModelPolicy
    execution: Record<string, number>
    instructionsDigest: string
    toolsDigest: string
    workspaceDigest: string
  }
}
export interface Conversation {
  historySummaries?: Record<string, HistorySummary>
  historyDiagnostic?: Record<string, unknown>
  heavySettings?: import('./heavyAgent').HeavyAgentSettings
  format: 1
  id: string
  bookId: string
  title: string
  updatedAt: string
  titleMode?: 'automatic' | 'manual'
  autoTitleDone?: boolean
  messages: AgentMessage[]
  summary: string
  coveredMessages: number
  memory?: ConversationMemory
  profileId?: string
  archived?: boolean
  diagnostics?: AgentDiagnostic[]
  lastTurn?: {
    id: string
    state: 'running' | 'completed' | 'cancelled' | 'failed'
    startedAt?: string
    finishedAt?: string
  }
  events?: { turnId: string; type: string; text: string }[]
}
export interface HistorySummary {
  key: string
  summaryVersion: 1
  request: string
  response: string
  mode: 'excerpt'
}
export interface HistoryTurn {
  turnId: string
  request: AgentMessage
  answer?: AgentMessage
  legacy: boolean
  completed: boolean
  path: string
}
export interface HistoryProjection {
  revision: string
  recentTurns: HistoryTurn[]
  olderTurns: HistoryTurn[]
  excludedEvents: { turnId: string; reason: string; request?: string; path: string }[]
}
export interface ProposalContext {
  revision: string
  index: {
    id: string
    title: string
    turnId: string
    status: string
    path: string
    locations?: { oldLine: number; newLine: number }[]
  }[]
  contents: {
    id: string
    old_text: string | string[]
    new_text: string | string[]
    status: string
  }[]
  requiredIds: string[]
}
export type ProposalState =
  | 'pending'
  | 'applying'
  | 'applied'
  | 'rejected'
  | 'stale'
  | 'conflicted'
  | 'failed'
  | 'undone'
export interface Proposal {
  bindingDependencies?: BindingDependency[]
  format: 1
  id: string
  bookId: string
  conversationId: string
  turnId: string
  operation: 'create' | 'write' | 'edit'
  targetId: string
  kind: DocumentKind
  title: string
  before: DocumentSnapshot | null
  content: string
  candidateHash: string
  /** New chapter edit candidates only; absent on legacy proposals. */
  paragraphNormalization?: boolean
  sources: SourceRef[]
  reason: string
  state: ProposalState
  createdAt: string
  appliedVersion?: string
  failure?: string
  undoing?: boolean
}
export interface AgentConfig {
  baseUrl: string
  model: string
  hasKey: boolean
  profiles?: AgentProfile[]
  defaultProfileId?: string
}
export interface AgentConfigInput {
  baseUrl: string
  model: string
  apiKey?: string
  id?: string
  label?: string
  contextTokens?: number
  outputTokens?: number
  retryOutputTokens?: number
  reasoning?: string
  makeDefault?: boolean
}
export interface ConnectionTestResult {
  mode: 'connection' | 'tools'
  elapsedMs: number
  model: string
  testedAt: string
  message: string
}
export interface AgentEvent {
  bookId: string
  conversationId: string
  turnId: string
  type:
    | 'started'
    | 'text'
    | 'tool'
    | 'progress'
    | 'proposal'
    | 'completed'
    | 'cancelled'
    | 'failed'
    | 'title'
  diagnostic?: AgentDiagnostic
  text?: string
  tool?: string
}
export interface AgentSnapshot {
  conversations: Conversation[]
  proposals: Proposal[]
  active: { conversationId: string; turnId: string } | null
  warnings?: string[]
}
export interface AgentAPI {
  heavySettings(): Promise<Result<import('./heavyAgent').HeavySettingsView>>
  saveHeavySettings(
    settings: import('./heavyAgent').HeavyAgentSettings
  ): Promise<Result<import('./heavyAgent').HeavySettingsView>>
  exportLog(bookId: string, id: string): Promise<Result<{ path: string; complete: boolean } | null>>
  bind(bookId: string): Promise<Result<AgentSnapshot>>
  snapshot(bookId: string): Promise<Result<AgentSnapshot>>
  create(bookId: string, title: string): Promise<Result<Conversation>>
  rename(bookId: string, id: string, title: string): Promise<Result<Conversation>>
  start(
    bookId: string,
    id: string,
    text: string,
    workspace: AgentWorkspace
  ): Promise<Result<string>>
  cancel(bookId: string): Promise<Result<void>>
  editor(
    bookId: string,
    states: { id: string; dirty: boolean; revision: number }[]
  ): Promise<Result<void>>
  action(
    bookId: string,
    id: string,
    action: 'apply' | 'reject' | 'undo',
    candidateHash: string
  ): Promise<Result<void>>
  config(): Promise<Result<AgentConfig>>
  configure(input: AgentConfigInput): Promise<Result<AgentConfig>>
  test(input: AgentConfigInput, mode: 'connection' | 'tools'): Promise<Result<ConnectionTestResult>>
  cancelTest(): Promise<Result<void>>
  models(input: AgentConfigInput): Promise<Result<string[]>>
  preferences(
    bookId: string,
    id: string,
    profileId: string,
    archived: boolean
  ): Promise<Result<void>>
  onEvent(listener: (event: AgentEvent) => void): () => void
}
