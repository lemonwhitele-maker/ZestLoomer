import type { DocumentSnapshot } from '../../shared/documents'
import { parseKnowledgeAliases } from '../../shared/knowledge'

export interface ReadRelatedDocument {
  sourceType: 'character' | 'setting'
  title: string
  path: string
  matchedNames: string[]
}

export interface ReadRelatedDocuments {
  notice: string
  items: ReadRelatedDocument[]
  total: number
  truncated: boolean
}

/** Match each returned page independently; names must not span pages or files. */
export function matchReadDocuments(
  documents: DocumentSnapshot[],
  fragments: string[]
): ReadRelatedDocument[] {
  const matches = new Map<string, ReadRelatedDocument>()
  for (const kind of ['characters', 'settings'] as const) {
    for (const document of documents) {
      if (document.kind !== kind || document.trashedAt || document.readonlyExample) continue
      const path = `book/${kind}/${document.id}.md`
      const matchedNames = new Set<string>()
      for (const value of [document.title, ...parseKnowledgeAliases(document.content)]) {
        const name = value.trim()
        if (!name) continue
        const pattern = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
        for (const text of fragments) {
          for (const match of text.matchAll(pattern)) matchedNames.add(match[0])
        }
      }
      if (!matchedNames.size) continue
      matches.set(path, {
        sourceType: kind === 'characters' ? 'character' : 'setting',
        title: document.title,
        path,
        matchedNames: [...new Set([...(matches.get(path)?.matchedNames || []), ...matchedNames])]
      })
    }
  }
  return [...matches.values()]
}

/** The index is only a locator; its budget never shortens the returned manuscript. */
export function assembleReadContext(
  documents: DocumentSnapshot[],
  fragments: string[],
  resultChars = 0,
  maxResultChars = 20000
): ReadRelatedDocuments {
  const matches = matchReadDocuments(documents, fragments)
  const related: ReadRelatedDocuments = {
    notice:
      '仅按本次返回正文中的名称和别名匹配，已按文档去重；同名称可能对应多个文档。列表不代表已读取详情，可按需 read(path)。',
    items: [],
    total: matches.length,
    truncated: false
  }
  // Reserve space for the attachment key and the service's execution-budget metadata.
  let remaining = maxResultChars - resultChars - JSON.stringify(related).length - 512
  for (const match of matches) {
    const size = JSON.stringify(match).length + 1
    if (size > remaining) {
      related.truncated = true
      continue
    }
    related.items.push(match)
    remaining -= size
  }
  return related
}
