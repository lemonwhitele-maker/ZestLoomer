import type { DocumentSnapshot } from '../../shared/documents'
import { parseKnowledgeAliases } from '../../shared/knowledge'

const kinds = {
  chapters: 'chapter',
  characters: 'character',
  settings: 'setting',
  outlines: 'outline',
  notes: 'note',
  foreshadows: 'foreshadow'
}
const path = (doc: DocumentSnapshot) =>
  `book/${doc.kind}/${doc.id}.${doc.kind === 'chapters' ? 'txt' : 'md'}`

/** Optional author-written labels, never inferred aliases or mandatory metadata. */
export function documentAliases(content: string): string[] {
  return parseKnowledgeAliases(content)
    .filter((name) => name.length >= 2 && name.length <= 80)
    .slice(0, 20)
}

export function relatedContext(documents: DocumentSnapshot[], targetId: string, maxNodes = 40) {
  const docs = documents.filter((d) => !d.trashedAt && !d.readonlyExample)
  const target = docs.find((d) => d.id === targetId)
  if (!target) return { related: [], truncated: false, maxDepth: 2 }
  const names = new Map(docs.map((d) => [d.id, documentAliases(d.content)]))
  const references = new Map(
    docs.map((d) => [
      d.id,
      new Set(
        [
          ...d.content.matchAll(
            /\[\[(chapter|character|setting|outline|note|foreshadow):(doc_[a-f0-9-]{36})(?:\|[^\]\r\n]*)?\]\]/g
          )
        ].map((m) => `${m[1]}:${m[2]}`)
      )
    ])
  )
  const related: {
    path: string
    id: string
    title: string
    kind: string
    version: string
    depth: number
    via: string
    reasons: string[]
    candidate: boolean
  }[] = []
  const visited = new Set([targetId])
  const queue = [{ doc: target, depth: 0 }]
  let truncated = false
  for (let index = 0; index < queue.length; index++) {
    const { doc: from, depth } = queue[index]
    if (depth >= 2) continue
    const matches = docs
      .filter((d) => !visited.has(d.id))
      .map((to) => {
        const reasons: string[] = []
        if (references.get(from.id)!.has(`${kinds[to.kind]}:${to.id}`)) reasons.push('outgoing')
        if (references.get(to.id)!.has(`${kinds[from.kind]}:${from.id}`)) reasons.push('backlink')
        if (to.title.length > 1 && from.content.includes(to.title)) reasons.push('title')
        if (from.title.length > 1 && to.content.includes(from.title)) reasons.push('title-backlink')
        if (names.get(to.id)!.some((alias) => from.content.includes(alias))) reasons.push('alias')
        if (names.get(from.id)!.some((alias) => to.content.includes(alias)))
          reasons.push('alias-backlink')
        const explicit = reasons.includes('outgoing') || reasons.includes('backlink')
        return { doc: to, reasons, explicit }
      })
      .filter((m) => m.reasons.length)
      .sort((a, b) => Number(b.explicit) - Number(a.explicit))
    for (const match of matches) {
      if (related.length >= maxNodes) {
        truncated = true
        break
      }
      visited.add(match.doc.id)
      related.push({
        path: path(match.doc),
        id: match.doc.id,
        title: match.doc.title,
        kind: match.doc.kind,
        version: match.doc.version,
        depth: depth + 1,
        via: path(from),
        reasons: match.reasons,
        candidate: !match.explicit
      })
      queue.push({ doc: match.doc, depth: depth + 1 })
    }
  }
  return {
    target: { path: path(target), version: target.version },
    related,
    truncated,
    maxDepth: 2
  }
}
