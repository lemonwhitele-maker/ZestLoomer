import type { AgentMessage, AgentWorkspace, Conversation, ModelPolicy } from '../../shared/agent'
import type { Completion, RuntimeMessage, RuntimeToolCall, RuntimeTraceEvent } from './runtime'

export interface AgentTurnLog {
  format: 1
  bookId: string
  conversationId: string
  turnId: string
  state: NonNullable<Conversation['lastTurn']>['state']
  startedAt?: string
  finishedAt?: string
  workspace: AgentWorkspace
  model?: string
  provider?: string
  policy?: ModelPolicy
  user: AgentMessage
  response?: AgentMessage
  error?: string
  persistenceError?: string
  rounds: {
    round: number
    // Used by injected runtimes which do not expose an HTTP request body.
    input?: { messages: RuntimeMessage[]; tools: unknown[] }
    requests: (RuntimeTraceEvent & { at: string })[]
    response?: Completion
    partialText: string
  }[]
  preprocessing?: {
    stage: 'check' | 'target'
    input: RuntimeMessage[]
    response?: Completion
    requests: (RuntimeTraceEvent & { at: string })[]
  }[]
  tools: { round: number; call: RuntimeToolCall; result: unknown }[]
}
