import { createHash } from 'node:crypto'
import type { Proposal } from '../../shared/agent'

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
export function proposalCandidateHash(
  proposal: Pick<
    Proposal,
    'targetId' | 'title' | 'content' | 'operation' | 'before' | 'sources' | 'bindingDependencies'
  >
): string {
  return digest(
    JSON.stringify([
      proposal.targetId,
      proposal.title,
      proposal.content,
      proposal.operation,
      proposal.before ? digest(JSON.stringify(proposal.before)) : null,
      proposal.sources,
      ...(proposal.bindingDependencies ? [proposal.bindingDependencies] : [])
    ])
  )
}
