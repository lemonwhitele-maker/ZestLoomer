import type { ModelPolicy } from '../../shared/agent'
import { fail } from './documents'

export const defaultPolicy: ModelPolicy = {
  contextTokens: 32768,
  outputTokens: 4096,
  retryOutputTokens: 8192
}
export const executionBudget = {
  modelRounds: 24,
  readRounds: 18,
  readConcurrency: 3,
  toolCalls: 60,
  readCalls: 48,
  toolTimeoutMs: 30000,
  turnTimeoutMs: 180000
}
export function modelPolicy(input: Partial<ModelPolicy> = {}): ModelPolicy {
  const policy: ModelPolicy = {
    contextTokens: input.contextTokens ?? defaultPolicy.contextTokens,
    outputTokens: input.outputTokens ?? defaultPolicy.outputTokens,
    retryOutputTokens: input.retryOutputTokens ?? defaultPolicy.retryOutputTokens,
    ...(input.reasoning ? { reasoning: input.reasoning } : {})
  }
  for (const key of ['contextTokens', 'outputTokens', 'retryOutputTokens'] as const) {
    if (!Number.isInteger(policy[key]) || policy[key] < 256 || policy[key] > 2000000)
      fail('CONFIG', '模型容量与生成预算必须是 256–2000000 之间的整数')
  }
  if (Math.max(policy.outputTokens, policy.retryOutputTokens) + 1024 >= policy.contextTokens)
    fail('CONFIG', '上下文容量须大于输出预算并预留至少 1024 tokens')
  if (
    policy.reasoning &&
    !['minimal', 'low', 'medium', 'high', 'xhigh', 'none'].includes(policy.reasoning)
  )
    fail('CONFIG', '思考强度选项无效')
  return policy
}
// Conservative multilingual estimate, not a tokenizer or a billing measurement.
export function estimateTokens(text: string): number {
  let ascii = 0,
    other = 0
  for (const char of text) {
    if (char.charCodeAt(0) < 128) ascii++
    else other++
  }
  return Math.ceil((ascii / 3 + other * 1.5) * 1.1)
}
export function inputLimit(policy: ModelPolicy): number {
  return policy.contextTokens - Math.max(policy.outputTokens, policy.retryOutputTokens) - 1024
}
