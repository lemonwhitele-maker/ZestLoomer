import { rankText } from './relevance'
import { randomUUID, createHash } from 'node:crypto'
import { DocumentStore, DocumentError } from '../documents'
import { kinds, type DocumentKind, type DocumentSnapshot } from '../../shared/documents'
import type { AgentWorkspace, SourceRef, ToolName } from '../../shared/agent'
import { templates } from '../../shared/templates'
import { BookSearchIndex } from './search'
import { relatedContext } from './related'
import { assembleReadContext, type ReadRelatedDocuments } from './readContext'

export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export const referenceType = {
  chapters: 'chapter',
  characters: 'character',
  settings: 'setting',
  outlines: 'outline',
  notes: 'note'
} as const
export const documentPath = (doc: { kind: DocumentKind; id: string }) =>
  `book/${doc.kind}/${doc.id}.${doc.kind === 'chapters' ? 'txt' : 'md'}`
export const sourceRef = (doc: DocumentSnapshot): SourceRef => ({
  id: doc.id,
  kind: doc.kind,
  title: doc.title,
  version: doc.version
})
export function fail(code: string, message: string): never {
  throw new DocumentError(code, message)
}
export function textArg(args: Record<string, unknown>, key: string, max = 1000000): string {
  const text = args[key]
  if (typeof text !== 'string' || text.length > max)
    fail('ARGUMENT', `${key} 必须是文本，且不超过 ${max} 字符`)
  return text as string
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('ARGUMENT', '工具参数必须是对象')
  return value as Record<string, unknown>
}
export function checkKeys(args: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(args).some((key) => !keys.includes(key)))
    fail('ARGUMENT', '存在不支持的工具参数，请参照工具说明')
}
const descriptions = {
  chapters: '正文：已写出的故事文本；人物说法不自动等于客观事实。',
  characters: '人物：作者当前采用的资料；背景和未来经历不自动等于正文已发生事件。',
  settings: '设定：作者当前采用的规则及背景。',
  outlines: '大纲：情节安排，不是已经发生的事件。',
  notes: '速记：构想与讨论材料；只有用户要求整理时才提出人物或设定修改。'
}
export const help = {
  'help/index.md':
    'Loom 使用 list_files/read/create/write/edit。书内路径由工具返回，所有写工具只创建待审阅提案。read({path:目录,query:文字}) 检索；摘要不是原文读取，长文用 nextCursor 续读。全文替换必须完整读取目标。未确定的构想建议保存速记，人物和设定没有内容状态。',
  'help/characters.md': `${descriptions.characters}\n新建时后端统一模板区块，缺失内容留空；不需要 YAML 元数据。名称在标题栏。当前状态写明故事阶段。无来源的信息留空。\n${templates.characters}`,
  'help/settings.md': `${descriptions.settings}\n新建时后端统一模板区块，缺失内容留空；不需要 YAML 元数据。\n${templates.settings}`,
  'help/outlines.md': `${descriptions.outlines}\n独立平铺 Markdown 条目，不提供分卷、父子层级和 Agent 排序工具。`,
  'help/notes.md': `${descriptions.notes}\n多份独立 Markdown 文档。明确要求依据速记整理人物、设定或大纲时，可以直接提出目标资料提案，不增加内容状态确认。`,
  'help/references.md':
    '关联使用 [[character:doc_<uuid>|人物名]]，同理 chapter/setting/outline/note。引用由稳定 ID 定位，读取结果附版本。可选写“别名：称呼一、称呼二”或“### 别名”列表，不强制改变模板。读取正文时，relatedDocuments 附带本次返回页面命中的人物、设定名称和别名及其路径，只是定位线索，不代表已读取详情；truncated 时可按需读取关联视图。book/views/{文档ID}.md 展开两层引用、标题及别名关联，candidate 表示文字匹配候选，via/reasons 标出依据；truncated 表示需缩小范围。视图不算读原文，使用前须 read 对应路径。回收资料只有沿用户或已读取文档中的明确引用才能只读访问，不能修改或作为现行资料。'
}
export const toolDefinitions = [
  {
    name: 'list_files',
    description:
      '列出当前作品文档。path="book/" 为文档清单及历史对话入口；path="book/conversations/" 列出所有已保存对话（含归档），再 read 返回路径读取历史。返回清单不算读原文。',
    properties: {
      path: { type: 'string' },
      cursor: { type: 'string' },
      maxChars: { type: 'integer', minimum: 500, maximum: 16000 }
    }
  },
  {
    name: 'read',
    description:
      '读取原文、批量读取、分页续读，或目录加 query 文字检索。历史对话：read({path:"book/conversations/",query:"关键词"}) 检索，read({path:"book/conversations/conversation_<uuid>.md"}) 读取清单返回的完整对话；空的会话摘录不代表没有历史。正文返回 relatedDocuments，列出本次页面命中的人物、设定名称及别名和资料路径，仅供定位，详情须另行 read。book/views/outline.md 有当前文档时展开关联章节、大纲、人物与设定，否则为章节大纲目录；book/views/{文档ID}.md 展开两层引用、标题和可选别名关联，仅供定位。path/paths/cursor 三选一。检查 complete，按 nextCursor 续读。',
    properties: {
      path: { type: 'string' },
      paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 12 },
      cursor: { type: 'string' },
      query: { type: 'string' },
      maxChars: { type: 'integer', minimum: 500, maximum: 16000 }
    }
  },
  {
    name: 'create',
    description: '新建文档提案，尚不写文件；需 directory/title/content，可附 reason/sources。',
    properties: {
      directory: { type: 'string' },
      title: { type: 'string' },
      content: { type: 'string' },
      reason: { type: 'string' },
      sources: { type: 'array', items: { type: 'string' } }
    },
    required: ['directory', 'title', 'content']
  },
  {
    name: 'write',
    description: '全文替换提案；必须完整读过同版本目标。有选区时用 edit。',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
      reason: { type: 'string' },
      sources: { type: 'array', items: { type: 'string' } }
    },
    required: ['path', 'content']
  },
  {
    name: 'edit',
    description:
      '局部修改提案；无选区用唯一匹配 oldText/newText，多个编辑互不重叠。有选区调用示例：edit({path:"目标路径",edits:[{newText:"完整选区替换文本"}]} )；不要传 oldText、from 或 to，不要取消选区或改用 write。',
    properties: {
      path: { type: 'string' },
      edits: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: {
          type: 'object',
          properties: {
            oldText: { type: 'string', description: '仅无选区时必填；有选区时省略。' },
            newText: { type: 'string', description: '替换文本；有选区时替换整个选区。' }
          },
          required: ['newText'],
          additionalProperties: false
        }
      },
      reason: { type: 'string' },
      sources: { type: 'array', items: { type: 'string' } }
    },
    required: ['path', 'edits']
  }
].map((tool) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      properties: tool.properties,
      required: 'required' in tool ? tool.required : [],
      additionalProperties: false
    }
  }
}))

interface ReadEntry {
  doc: DocumentSnapshot
  ranges: { start: number; end: number }[]
}
interface Cursor {
  path: string
  version: string
  offset: number
  result?: string
}
export class BookDocumentAdapter {
  readonly reads = new Map<string, ReadEntry>()
  private delivered = new Map<string, ReadEntry>()
  private cursors = new Map<string, Cursor>()
  private explicitReferences = new Set<string>()
  private knowledgeLoading?: Promise<{ documents: DocumentSnapshot[]; incomplete: boolean }>
  constructor(
    readonly store: DocumentStore,
    readonly bookId: string,
    readonly workspace: AgentWorkspace,
    userText: string,
    private histories: () => {
      id: string
      title: string
      text: string
      messages?: { id: string; turnId?: string; text: string }[]
    }[],
    private signal?: AbortSignal,
    private deferredDelivery = false
  ) {
    this.captureReferences(userText)
  }
  seedRead(doc: DocumentSnapshot): void {
    this.reads.set(doc.id, {
      doc: structuredClone(doc),
      ranges: [{ start: 0, end: doc.content.length }]
    })
    this.captureReferences(doc.content)
  }
  acknowledgeDelivery(): void {
    this.delivered = structuredClone(this.reads)
  }
  get evidence(): Map<string, ReadEntry> {
    return this.deferredDelivery ? this.delivered : this.reads
  }
  deliveredCovers(id: string, start: number, end: number): boolean {
    return this.rangeCovered(this.evidence.get(id), start, end)
  }
  private captureReferences(text: string): void {
    for (const match of text.matchAll(
      /\[\[(chapter|character|setting|outline|note):(doc_[a-f0-9-]{36})(?:\|[^\]\r\n]*)?\]\]/g
    ))
      this.explicitReferences.add(`${match[1]}:${match[2]}`)
  }
  path(path: string): { kind: DocumentKind; id: string } {
    const match =
      /^book\/(chapters|characters|settings|outlines|notes)\/(doc_[a-f0-9-]{36})\.(txt|md)$/.exec(
        path
      )
    if (!match || (match[1] === 'chapters' ? match[3] !== 'txt' : match[3] !== 'md'))
      fail('PATH', '使用 list_files 返回的书内文档路径')
    return { kind: match![1] as DocumentKind, id: match![2] }
  }
  directory(path: string): DocumentKind | 'all' | 'conversations' {
    if (path === 'book/' || path === 'book') return 'all'
    const match = /^book\/(chapters|characters|settings|outlines|notes|conversations)\/?$/.exec(
      path
    )
    if (!match) fail('PATH', '只接受当前作品的五类文档目录或历史对话目录')
    return match![1] as DocumentKind | 'conversations'
  }
  private budget(args: Record<string, unknown>): number {
    const n = args.maxChars ?? 8000
    if (!Number.isInteger(n) || Number(n) < 500 || Number(n) > 16000)
      fail('ARGUMENT', 'maxChars 应在 500–16000 之间')
    return Number(n)
  }
  private token(cursor: Cursor): string {
    if (this.cursors.size > 2000) fail('BUDGET', '续读游标过多，请缩小任务范围')
    const id = randomUUID()
    this.cursors.set(id, cursor)
    return id
  }
  private resultPage(path: string, text: string, offset: number, max: number): unknown {
    const end = Math.min(text.length, offset + max)
    return {
      resultType: 'listing',
      text: text.slice(offset, end),
      complete: end === text.length,
      nextCursor:
        end < text.length ? this.token({ path, version: '', offset: end, result: text }) : null
    }
  }
  async list(args: Record<string, unknown>): Promise<unknown> {
    this.signal?.throwIfAborted()
    checkKeys(args, ['path', 'cursor', 'maxChars'])
    const max = this.budget(args)
    if (args.cursor) {
      if (args.path) fail('ARGUMENT', '续读只传 cursor')
      const c = this.cursors.get(textArg(args, 'cursor', 100))
      if (!c || c.result === undefined) fail('CURSOR', '清单游标失效，重新列出')
      return this.resultPage(c!.path, c!.result!, c!.offset, max)
    }
    const path = args.path === undefined ? 'book/' : textArg(args, 'path', 200)
    const kind = this.directory(path)
    const rows =
      kind === 'conversations'
        ? this.histories().map((c) => ({
            path: `book/conversations/${c.id}.md`,
            title: c.title,
            sourceKind: 'conversation'
          }))
        : (await this.store.agentDocuments(this.bookId))
            .filter((d) => kind === 'all' || d.kind === kind)
            .map((d) => ({ path: documentPath(d), title: d.title, id: d.id, sourceKind: d.kind }))
    if (kind === 'all')
      rows.unshift({
        path: 'book/conversations/',
        title: '历史对话（含归档；列出或检索后读取）',
        sourceKind: 'directory'
      })
    return this.resultPage(path, JSON.stringify(rows), 0, max)
  }
  async read(args: Record<string, unknown>): Promise<unknown> {
    const result = (await this.readResult(args)) as {
      resultType: string
      sourceKind?: DocumentKind
      trashed?: boolean
      text?: string
      items?: { sourceKind?: DocumentKind; trashed?: boolean; text?: string }[]
    }
    const fragments = (result.resultType === 'batch' ? result.items || [] : [result])
      .filter((page) => page.sourceKind === 'chapters' && !page.trashed)
      .flatMap((page) => (typeof page.text === 'string' ? [page.text] : []))
    return fragments.length
      ? {
          ...result,
          relatedDocuments: await this.readContext(fragments, JSON.stringify(result).length)
        }
      : result
  }
  async readContext(fragments: string[], resultChars = 0): Promise<ReadRelatedDocuments> {
    this.signal?.throwIfAborted()
    // Adjacent reads share this load, but subsequent requests revalidate current saved sources.
    if (!this.knowledgeLoading) {
      const loading = (async () => {
        const documents: DocumentSnapshot[] = []
        let incomplete = false
        try {
          for (const meta of await this.store.agentDocuments(this.bookId)) {
            if (meta.kind !== 'characters' && meta.kind !== 'settings') continue
            this.signal?.throwIfAborted()
            try {
              // A concurrent recycle may occur after the manifest was loaded; filter it below.
              const document = await this.store.agentRead(this.bookId, meta.id, true)
              if (!document.trashedAt) documents.push(document)
            } catch {
              this.signal?.throwIfAborted()
              incomplete = true
            }
          }
        } catch {
          this.signal?.throwIfAborted()
          incomplete = true
        }
        // An unavailable locator must not turn a successful manuscript read into a failed delivery.
        return { documents, incomplete }
      })()
      this.knowledgeLoading = loading
      const clear = () => {
        if (this.knowledgeLoading === loading) this.knowledgeLoading = undefined
      }
      void loading.then(clear, clear)
    }
    const { documents, incomplete } = await this.knowledgeLoading
    this.signal?.throwIfAborted()
    const related = assembleReadContext(documents, fragments, resultChars)
    if (incomplete) {
      related.truncated = true
      related.notice += '部分人物或设定资料无法索引，total 仅统计已匹配资料。'
    }
    return related
  }
  private async readResult(args: Record<string, unknown>): Promise<unknown> {
    this.signal?.throwIfAborted()
    checkKeys(args, ['path', 'paths', 'cursor', 'query', 'maxChars'])
    const max = this.budget(args)
    if ([args.path, args.paths, args.cursor].filter((v) => v !== undefined).length !== 1)
      fail('ARGUMENT', 'path/paths/cursor 必须三选一')
    if (args.cursor) {
      if (args.query) fail('ARGUMENT', '续读不能更改搜索条件')
      const c = this.cursors.get(textArg(args, 'cursor', 100))
      if (!c) fail('CURSOR', '游标不属于本轮，请重新读取')
      return c!.result !== undefined
        ? this.resultPage(c!.path, c!.result, c!.offset, max)
        : this.page(c!.path, max, c!.offset, c!.version)
    }
    if (args.paths !== undefined) {
      if (
        args.query ||
        !Array.isArray(args.paths) ||
        args.paths.length < 1 ||
        args.paths.length > 12 ||
        args.paths.some((p) => typeof p !== 'string')
      )
        fail('ARGUMENT', 'paths 应包含 1–12 个文档路径，不与 query 合用')
      return {
        resultType: 'batch',
        items: await Promise.all(
          (args.paths as string[]).map(async (path) => {
            try {
              return await this.page(
                path,
                Math.max(1, Math.floor(max / (args.paths as string[]).length))
              )
            } catch (error) {
              return { path, error: (error as Error).message }
            }
          })
        )
      }
    }
    const path = textArg(args, 'path', 250)
    if (args.query !== undefined) {
      const kind = this.directory(path)
      const query = textArg(args, 'query', 200).trim().toLocaleLowerCase()
      if (!query) fail('ARGUMENT', '搜索文字不能为空')
      const hits: { path: string; title: string; excerpt: string; sourceKind: string }[] = []
      if (kind === 'conversations') {
        for (const c of this.histories()) {
          const hit = rankText(c.title, c.text, query)
          if (hit)
            hits.push({
              path: `book/conversations/${c.id}.md`,
              title: c.title,
              ...hit,
              ...{
                messageHits: (c.messages || [])
                  .flatMap((m) => {
                    const match = rankText('', m.text, query)
                    return match ? [{ messageId: m.id, turnId: m.turnId, ...match }] : []
                  })
                  .sort((a, b) => b.score - a.score)
                  .slice(0, 5)
              },
              sourceKind: 'conversation'
            })
        }
      } else {
        hits.push(
          ...(await new BookSearchIndex(this.store, this.bookId).search(kind, query, this.signal))
        )
      }
      return this.resultPage(
        path,
        JSON.stringify({ readingNotice: '搜索摘要不是原文读取，引用或修改前请 read 原文。', hits }),
        0,
        max
      )
    }
    if (
      /^book\/?$/.test(path) ||
      /^book\/(chapters|characters|settings|outlines|notes|conversations)\/?$/.test(path)
    )
      return this.list({ path, maxChars: max })
    return this.page(path, max)
  }
  private async page(path: string, max: number, start = 0, expected?: string): Promise<unknown> {
    if (path in help) {
      const text = help[path as keyof typeof help]
      return this.resultPage(path, text, start, max)
    }
    if (path === 'book/views/outline.md' || /^book\/views\/(doc_[a-f0-9-]{36})\.md$/.test(path)) {
      const docs = await this.store.agentDocuments(this.bookId)
      const targetId =
        /^book\/views\/(doc_[a-f0-9-]{36})\.md$/.exec(path)?.[1] || this.workspace.documentId
      if (targetId) {
        await this.store.agentRead(this.bookId, targetId)
        const snapshots: DocumentSnapshot[] = []
        for (const meta of docs) {
          this.signal?.throwIfAborted()
          snapshots.push(await this.store.agentRead(this.bookId, meta.id))
        }
        return this.resultPage(
          path,
          JSON.stringify({
            readingNotice:
              '关联视图仅供定位，不算原文读取。文字匹配为候选，须读原文核对；最多展开两层、40份资料。',
            ...relatedContext(snapshots, targetId)
          }),
          start,
          max
        )
      }
      const related: unknown[] = []
      for (const meta of docs) {
        this.signal?.throwIfAborted()
        if (meta.kind === 'outlines' || meta.kind === 'chapters')
          related.push({
            path: documentPath(meta),
            title: meta.title,
            kind: meta.kind,
            order: meta.order
          })
      }
      return this.resultPage(
        path,
        JSON.stringify({ readingNotice: '关联视图仅供定位，不算原文读取。', related }),
        start,
        max
      )
    }
    const historyMatch = /^book\/conversations\/(conversation_[a-f0-9-]{36})\.md$/.exec(path)
    if (historyMatch) {
      const history = this.histories().find((c) => c.id === historyMatch[1])
      if (!history) fail('NOT_FOUND', '对话不存在')
      return this.resultPage(path, `历史讨论，不是现行设定。\n${history!.text}`, start, max)
    }
    const { id, kind } = this.path(path)
    const d = await this.store.agentRead(
      this.bookId,
      id,
      this.explicitReferences.has(`${referenceType[kind]}:${id}`)
    )
    if (d.kind !== kind) fail('PATH', '文档路径类型不匹配')
    if (expected && d.version !== expected) fail('VERSION', '分页期间文档变化，重新读取原文')
    const end = Math.min(d.content.length, start + max)
    if (!d.trashedAt) {
      const prev = this.reads.get(id)
      const entry = prev?.doc.version === d.version ? prev : { doc: d, ranges: [] }
      entry.ranges.push({ start, end })
      this.reads.set(id, entry)
      this.captureReferences(d.content.slice(start, end))
      if (this.covers(id, 0, d.content.length)) this.captureReferences(d.content)
    }
    return {
      resultType: 'document',
      path,
      title: d.title,
      id,
      sourceKind: kind,
      version: d.version,
      readingNotice: d.trashedAt ? '已回收，仅供历史核对，不是当前有效资料。' : descriptions[kind],
      trashed: Boolean(d.trashedAt),
      text: d.content.slice(start, end),
      range: { start, end, total: d.content.length },
      complete: !d.trashedAt && this.covers(id, 0, d.content.length),
      nextCursor:
        end < d.content.length ? this.token({ path, version: d.version, offset: end }) : null
    }
  }
  covers(id: string, start: number, end: number): boolean {
    return this.rangeCovered(this.reads.get(id), start, end)
  }
  private rangeCovered(entry: ReadEntry | undefined, start: number, end: number): boolean {
    if (!entry) return false
    let pos = start
    for (const range of [...entry.ranges].sort((a, b) => a.start - b.start)) {
      if (range.start > pos) break
      pos = Math.max(pos, range.end)
    }
    return pos >= end
  }
  async target(path: string, full: boolean): Promise<DocumentSnapshot> {
    const { id, kind } = this.path(path)
    const d = await this.store.agentRead(this.bookId, id)
    if (d.kind !== kind || this.evidence.get(id)?.doc.version !== d.version)
      fail('READ_REQUIRED', '先 read 同版本目标原文')
    if (full && !this.deliveredCovers(id, 0, d.content.length))
      fail('FULL_READ_REQUIRED', '全文替换前必须完整续读目标')
    return d
  }
  async sources(args: Record<string, unknown>): Promise<SourceRef[]> {
    if (args.sources === undefined) return []
    if (
      !Array.isArray(args.sources) ||
      args.sources.length > 30 ||
      args.sources.some((p) => typeof p !== 'string')
    )
      fail('ARGUMENT', 'sources 应为书内文档路径数组')
    const refs: SourceRef[] = []
    for (const path of args.sources as string[]) refs.push(sourceRef(await this.target(path, true)))
    return refs
  }
}
export const allowedTools: ToolName[] = ['list_files', 'read', 'create', 'write', 'edit']
export { kinds }
