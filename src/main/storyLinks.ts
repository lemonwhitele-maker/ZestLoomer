import type { ChapterOutlineBindings, ForeshadowContent } from '../shared/storyLinks'

export class StoryLinkError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
  }
}
const fail = (code: string, message: string): never => {
  throw new StoryLinkError(code, message)
}
export const isDocumentId = (value: unknown): value is string =>
  typeof value === 'string' && /^doc_[a-f0-9-]{36}$/.test(value)

/** Parse flat, fixed-field JSON without losing duplicate (including escaped) keys. */
export function parseForeshadow(text: string): ForeshadowContent {
  if (typeof text !== 'string' || text.length > 1000000)
    return fail('FORESHADOW_SIZE', '单条伏笔须为不超过 1000000 个字符的文本')
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return fail('FORESHADOW_JSON', '伏笔内容必须是一个合法 JSON 对象')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail('FORESHADOW_SCHEMA', '伏笔内容必须是一个对象')
  // JSON syntax was checked above. For this flat schema every key is a string
  // token followed by a colon; string values are consumed as whole tokens.
  const seen = new Set<string>()
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"\s*:?/gs)) {
    if (!match[0].endsWith(':')) continue
    const key = JSON.parse(match[0].slice(0, -1).trim()) as string
    if (seen.has(key)) return fail('FORESHADOW_DUPLICATE_KEY', `伏笔字段重复：${key}`)
    seen.add(key)
  }
  const record = value as Record<string, unknown>
  const fields = ['content', 'startChapterId', 'endChapterId']
  if (Object.keys(record).length !== 3 || fields.some((key) => !Object.hasOwn(record, key)))
    return fail('FORESHADOW_SCHEMA', '伏笔必须且只能包含 content、startChapterId、endChapterId')
  if (
    typeof record.content !== 'string' ||
    [record.startChapterId, record.endChapterId].some((id) => id !== null && !isDocumentId(id))
  )
    return fail('FORESHADOW_SCHEMA', '伏笔内容必须为字符串，章节必须为正文 ID 或 null')
  return record as unknown as ForeshadowContent
}

/** Call inside the book queue immediately before publishing a candidate/write.
 * Invalid old JSON is not trusted as evidence for retaining historical references.
 */
export async function validateForeshadow(
  text: string,
  chapter: (id: string) => Promise<{ kind: string; state: 'active' | 'trashed' | 'missing' }>,
  previous?: string
): Promise<ForeshadowContent> {
  const candidate = parseForeshadow(text)
  let before: ForeshadowContent | undefined
  if (previous !== undefined) {
    try {
      before = parseForeshadow(previous)
    } catch {
      /* Repair requires valid new references. */
    }
  }
  for (const field of ['startChapterId', 'endChapterId'] as const) {
    const id = candidate[field]
    if (id === null || id === before?.[field]) continue
    const target = await chapter(id)
    if (target.kind !== 'chapters' || target.state !== 'active')
      fail('FORESHADOW_REFERENCE', '新增或更换的章节引用必须是当前作品未回收的正文')
  }
  return candidate
}

export function parseBindings(text: string): ChapterOutlineBindings {
  let value: ChapterOutlineBindings
  try {
    value = JSON.parse(text)
  } catch {
    return fail('BINDING_FORMAT', '正文大纲关系文件不是合法 JSON，原文件已保留')
  }
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !Array.isArray(value.bindings) ||
    Object.keys(value).sort().join(',') !== 'bindings,revision,schemaVersion'
  )
    return fail('BINDING_FORMAT', '正文大纲关系文件结构无效，原文件已保留')
  const chapters = new Set<string>(),
    outlines = new Set<string>()
  for (const pair of value.bindings) {
    if (
      !pair ||
      !isDocumentId(pair.chapterId) ||
      !isDocumentId(pair.outlineId) ||
      pair.chapterId === pair.outlineId ||
      Object.keys(pair).sort().join(',') !== 'chapterId,outlineId'
    )
      return fail('BINDING_FORMAT', '正文大纲关系包含无效文档 ID')
    if (chapters.has(pair.chapterId) || outlines.has(pair.outlineId))
      return fail('BINDING_DUPLICATE', '正文或大纲被重复绑定，原文件已保留')
    chapters.add(pair.chapterId)
    outlines.add(pair.outlineId)
  }
  return value
}
