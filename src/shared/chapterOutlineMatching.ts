import { parseChapterTitle } from './chapterNaming'
import type { DocumentMeta } from './documents'
import type { ChapterOutlinePair } from './storyLinks'

/** Chapter labels only: volume/whole-book outlines and ranges are not chapters. */
export function matchingChapterNumber(title: string): number | null {
  if (/总纲|總綱|卷纲|卷綱|全书大纲|全書大綱|整书大纲/.test(title)) return null
  const normalized = title.trim().replace(/^(?:章节大纲|章節大綱|大纲|大綱)\s*[:：\-—]?\s*/, '')
  const number = '[0-9０-９零〇○一二两兩三四五六七八九十百千万]+'
  if (new RegExp(`^(?:第\\s*)?${number}\\s*(?:卷|部)`).test(normalized)) return null
  if (
    new RegExp(`(?:章|回|节|節|话|話|集|篇)?\\s*(?:至|到|~|～|—|–|-)\\s*(?:第\\s*)?${number}`).test(
      normalized
    )
  )
    return null
  if (/^[0-9０-９]+\s*[./／]\s*[0-9０-９]/.test(normalized)) return null
  return parseChapterTitle(/^[0-9０-９]+$/.test(normalized) ? `${normalized}章` : normalized).number
}

export interface ChapterOutlineMatches {
  pairs: ChapterOutlinePair[]
  ambiguousNumbers: number[]
  occupiedNumbers: number[]
}

export function chapterOutlineMatches(
  documents: readonly DocumentMeta[],
  bindings: readonly ChapterOutlinePair[],
  changedIds?: ReadonlySet<string>
): ChapterOutlineMatches {
  const groups = new Map<number, { chapters: DocumentMeta[]; outlines: DocumentMeta[] }>()
  for (const doc of documents) {
    if (doc.trashedAt || (doc.kind !== 'chapters' && doc.kind !== 'outlines')) continue
    const number = matchingChapterNumber(doc.title)
    if (number === null) continue
    const group = groups.get(number) ?? { chapters: [], outlines: [] }
    group[doc.kind].push(doc)
    groups.set(number, group)
  }
  const occupied = new Set(bindings.flatMap((pair) => [pair.chapterId, pair.outlineId]))
  const result: ChapterOutlineMatches = { pairs: [], ambiguousNumbers: [], occupiedNumbers: [] }
  for (const [number, group] of [...groups].sort(([a], [b]) => a - b)) {
    const docs = [...group.chapters, ...group.outlines]
    if (changedIds && !docs.some((doc) => changedIds.has(doc.id))) continue
    if (!group.chapters.length || !group.outlines.length) continue
    if (group.chapters.length !== 1 || group.outlines.length !== 1) {
      result.ambiguousNumbers.push(number)
      continue
    }
    const chapterId = group.chapters[0].id,
      outlineId = group.outlines[0].id
    if (bindings.some((pair) => pair.chapterId === chapterId && pair.outlineId === outlineId))
      continue
    if (occupied.has(chapterId) || occupied.has(outlineId)) {
      result.occupiedNumbers.push(number)
      continue
    }
    result.pairs.push({ chapterId, outlineId })
  }
  return result
}
