import type { AgentMessage, AgentWorkspace } from '../../shared/agent'
import type { DocumentMeta } from '../../shared/documents'

export function taskRequest(messages: AgentMessage[]): string {
  const last = messages.at(-1)?.text.trim() || ''
  if (/^(继续|接着做|接着|继续整理|继续完成)[。！!\s]*$/.test(last)) {
    return (
      [...messages.slice(0, -1)]
        .reverse()
        .find((m) => m.role === 'user' && !/^(继续|接着)/.test(m.text.trim()))?.text || last
    )
  }
  return last
}
export function requiredDocuments(
  request: string,
  workspace: AgentWorkspace,
  docs: DocumentMeta[]
): string[] {
  const notes = docs.filter((d) => d.kind === 'notes')
  if (/(?:依据|根据|整理|通读).*(?:速记)/.test(request)) {
    if (/所有|全部|全书/.test(request)) return notes.map((d) => d.id)
    const explicit = notes.filter(
      (d) => request.includes(`:${d.id}`) || (d.title.length > 1 && request.includes(d.title))
    )
    if (explicit.length) return explicit.map((d) => d.id)
    if (workspace.documentId && notes.some((d) => d.id === workspace.documentId))
      return [workspace.documentId]
    return notes.map((d) => d.id)
  }
  if (/全文|整篇|整章|通读/.test(request) && workspace.documentId && !workspace.selection)
    return [workspace.documentId]
  return []
}
