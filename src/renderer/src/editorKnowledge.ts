import type { DocumentMeta } from '../../shared/documents'
import { parseKnowledgeAliases } from '../../shared/knowledge'

export interface KnowledgeEntry {
  name: string
  title: string
  kind: 'characters' | 'settings'
}

export const knowledgeAliases = parseKnowledgeAliases

export function knowledgeEntries(
  documents: DocumentMeta[],
  content: Record<string, string>
): KnowledgeEntry[] {
  const entries = new Map<string, KnowledgeEntry>()
  // Characters take precedence when two entries share a name.
  for (const kind of ['characters', 'settings'] as const) {
    for (const document of documents) {
      if (document.kind !== kind || document.trashedAt || document.readonlyExample) continue
      for (const value of [document.title, ...knowledgeAliases(content[document.id] || '')]) {
        const name = value.trim()
        if (!name || /[\r\n]/.test(name)) continue
        const key = name.toLowerCase()
        if (!entries.has(key)) entries.set(key, { name, title: document.title, kind })
      }
    }
  }
  return [...entries.values()].sort((a, b) => b.name.length - a.name.length)
}
