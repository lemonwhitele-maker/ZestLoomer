import fs from 'node:fs/promises'
import { countWords } from '../shared/wordCount'
import { join, resolve, relative, isAbsolute, dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { SourceRef } from '../shared/agent'
import { defaultNamingRule, validateNamingRule } from '../shared/chapterNaming'
import { BookCatalog } from './catalog'
import { counters } from '../shared/perf'
import { parseBindings, isDocumentId, validateForeshadow, parseForeshadow } from './storyLinks'
import { initialContent } from '../shared/templates'
import { bookExamples } from '../shared/examples'
import { chapterOutlineMatches } from '../shared/chapterOutlineMatching'
import type {
  BindingDependency,
  ChapterOutlineBinding,
  ChapterOutlineBindings,
  ChapterOutlineMatchResult,
  StoryTarget,
  StoryRead
} from '../shared/storyLinks'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import type {
  BookPreferences,
  BookStats,
  CreateBatchInput,
  HistoryEntry,
  Placement,
  RenameBatchInput,
  SearchHit
} from '../shared/workspace'
import {
  kinds,
  type Book,
  type DocumentKind,
  type DocumentMeta,
  type DocumentSnapshot,
  type Draft,
  type SaveInput
} from '../shared/documents'

export class DocumentError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message)
  }
}
const fail = (code: string, message: string): never => {
  throw new DocumentError(code, message)
}
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const validId = (id: string) => typeof id === 'string' && /^[a-z]+_[a-f0-9-]{36}$/.test(id)
const titleOf = (title: string) => {
  if (typeof title !== 'string' || !title.trim() || title.length > 200 || /[\r\n\0]/.test(title))
    fail('TITLE', '标题须为 1–200 个字符，不能包含换行')
  return title.trim()
}
export async function atomicWrite(path: string, value: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  const handle = await fs.open(temp, 'wx')
  try {
    await handle.writeFile(value, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temp, path)
  } catch (error) {
    await fs.unlink(temp).catch(() => {})
    throw error
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
interface Transaction {
  beforeHash: string
  content: string
  meta: DocumentMeta
  before?: DocumentSnapshot
  referenceBaseline?: string
}
interface CreateBatchTransaction {
  type: 'create'
  kind: DocumentKind
  documents: { meta: DocumentMeta; content: string }[]
  beforeOrder: string[]
  afterOrder: string[]
  operationId?: string
  inputHash?: string
  placement?: Placement
}
interface CompletedCreate {
  operationId: string
  bookId: string
  kind: DocumentKind
  ids: string[]
  inputHash: string
}
interface RenameBatchTransaction {
  type: 'rename'
  changes: { before: DocumentSnapshot; meta: DocumentMeta }[]
}
type BatchTransaction = CreateBatchTransaction | RenameBatchTransaction
interface OrderState {
  ids: string[]
  undo: { before: string[]; after: string[] } | null
}
const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i])
const validOperationId = (id: string) =>
  typeof id === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
const normalizedPlacement = (placement: Placement): Placement => {
  if (!placement || !['start', 'end', 'before', 'after'].includes(placement.position))
    return fail('ORDER', '新建位置无效')
  if (placement.position === 'before' || placement.position === 'after') {
    if (!validId(placement.anchorId || '') || !placement.anchorId?.startsWith('doc_'))
      return fail('ID', '参照章节标识无效')
    return { position: placement.position, anchorId: placement.anchorId }
  }
  return { position: placement.position }
}
/** Matches the editor's existing 字 count: Unicode characters excluding whitespace. */
export { countWords } from '../shared/wordCount'

/** All mutations, including recovery, are serialized per book, never per active UI page. */
export class DocumentStore {
  readonly books = new Map<string, Book>()
  private queues = new Map<string, Promise<unknown>>()
  private automaticBindingIds = new Map<string, Set<string>>()
  private automaticBindingNotices = new Map<string, string>()
  private catalogs = new Map<string, BookCatalog>()
  private fingerprints = new Map<string, Map<string, string>>()
  constructor(private writer = atomicWrite) {}
  private catalog(bookId: string): BookCatalog {
    let cat = this.catalogs.get(bookId)
    if (!cat) {
      cat = new BookCatalog()
      this.catalogs.set(bookId, cat)
    }
    return cat
  }
  private async queue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const requestedAt = performance.now()
    const previous = this.queues.get(key) || Promise.resolve()
    const current = previous
      .catch(() => {})
      .then(async () => {
        const started = performance.now()
        counters.recordQueueWait(started - requestedAt)
        try {
          const book = this.books.get(key)
          if (book) {
            await this.recoverBatch(book)
            await this.flushAutomaticBindings(book)
          }
          const result = await operation()
          if (book) await this.flushAutomaticBindings(book)
          return result
        } finally {
          this.automaticBindingIds.delete(key)
          counters.recordQueueExec(performance.now() - started)
        }
      })
    this.queues.set(key, current)
    try {
      return await current
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key)
    }
  }
  async idle(): Promise<void> {
    await Promise.allSettled([...this.queues.values()])
  }
  private book(id: string): Book {
    return this.books.get(id) || fail('BOOK', '作品尚未打开，请重新选择作品目录')
  }
  private async safe(book: Book, path: string): Promise<string> {
    const target = resolve(path)
    const rel = relative(book.root, target)
    if (rel.startsWith('..') || isAbsolute(rel)) fail('PATH', '路径不在当前作品中')
    let current = book.root
    for (const part of ['', ...rel.split(/[\\/]/).filter(Boolean)]) {
      current = part ? join(current, part) : current
      try {
        if ((await fs.lstat(current)).isSymbolicLink())
          fail('PATH', '作品内不允许符号链接或目录联接')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
    }
    return target
  }
  async createBook(parent: string, title: string, examples = false): Promise<Book> {
    const id = `book_${randomUUID()}`
    const root = join(await fs.realpath(parent), `ZestLoomer-${id.slice(5, 13)}`)
    await fs.mkdir(root)
    const book: Book = { id, title: titleOf(title), root, format: 1 }
    await this.writer(join(root, 'book.json'), json({ id, title: book.title, format: 1 }))
    await this.initialize(book)
    this.books.set(id, book)
    if (examples) {
      for (const example of bookExamples)
        await this.createAt(book, example.kind, example.title, {
          content: example.content,
          readonlyExample: true
        })
    }
    return book
  }
  renameBook(bookId: string, title: string): Promise<Book> {
    return this.queue(bookId, async () => {
      const book = this.book(bookId)
      const next = { ...book, title: titleOf(title) }
      await this.writer(
        await this.safe(book, join(book.root, 'book.json')),
        json({ id: next.id, title: next.title, format: next.format })
      )
      this.books.set(bookId, next)
      return next
    })
  }
  async openBook(root: string): Promise<Book> {
    root = await fs.realpath(root)
    if ((await fs.lstat(join(root, 'book.json'))).isSymbolicLink())
      fail('PATH', '作品清单不能是符号链接')
    const meta = JSON.parse(await fs.readFile(join(root, 'book.json'), 'utf8'))
    if (meta.format !== 1 || !validId(meta.id) || !meta.id.startsWith('book_'))
      fail('FORMAT', '不是支持的 ZestLoomer 作品；请选择包含有效 book.json 的作品目录')
    const book: Book = { id: meta.id, title: titleOf(meta.title), format: 1, root }
    const previous = this.books.get(book.id)
    if (previous && previous.root !== root)
      fail('DUPLICATE_BOOK', '这部作品的另一份副本已经打开，请在另一应用会话中打开备份')
    await this.initialize(book)
    this.catalog(book.id).invalidate()
    this.fingerprints.delete(book.id)
    this.books.set(book.id, book)
    return book
  }
  private async initialize(book: Book): Promise<void> {
    for (const path of [
      ...kinds,
      '.workspace/recovery',
      '.workspace/history',
      ...kinds.map((kind) => `.workspace/trash/${kind}`)
    ]) {
      await fs.mkdir(await this.safe(book, join(book.root, path)), { recursive: true })
    }
  }
  private contentPath(folder: string, kind: DocumentKind): string {
    return join(folder, kind === 'chapters' ? 'content.txt' : 'content.md')
  }
  private validateMeta(meta: DocumentMeta, id: string, kind: DocumentKind): void {
    if (
      !meta ||
      meta.id !== id ||
      meta.kind !== kind ||
      !validId(id) ||
      !Number.isFinite(meta.order) ||
      !meta.generation
    )
      fail('FORMAT', '文档元数据损坏，原文件已保留')
    titleOf(meta.title)
  }
  private async locate(
    book: Book,
    id: string
  ): Promise<{ folder: string; kind: DocumentKind; trashed: boolean }> {
    if (!validId(id) || !id.startsWith('doc_')) fail('ID', '文档标识无效')
    const found: { folder: string; kind: DocumentKind; trashed: boolean }[] = []
    for (const kind of kinds)
      for (const trashed of [false, true]) {
        const folder = await this.safe(
          book,
          join(book.root, ...(trashed ? ['.workspace', 'trash'] : []), kind, id)
        )
        if (await exists(folder)) found.push({ folder, kind, trashed })
      }
    if (found.length > 1) fail('DUPLICATE_DOCUMENT', '发现重复文档 ID，请先处理作品副本冲突')
    return found[0] || fail('NOT_FOUND', '文档不存在，引用目标可能尚未导入')
  }
  private async readAt(
    book: Book,
    located: { folder: string; kind: DocumentKind; trashed: boolean },
    id: string,
    observedStamp?: string
  ): Promise<DocumentSnapshot> {
    const { folder, kind, trashed } = located
    const stamp = observedStamp ?? (await this.fingerprint(book, located))
    const metaPath = await this.safe(book, join(folder, 'meta.json'))
    const contentPath = await this.safe(book, this.contentPath(folder, kind))
    const journalPath = await this.safe(book, join(folder, 'pending.json'))
    if (await exists(journalPath)) {
      const pending: Transaction = JSON.parse(await fs.readFile(journalPath, 'utf8'))
      this.validateMeta(pending.meta, id, kind)
      if (typeof pending.content !== 'string') fail('FORMAT', '保存恢复正文无效')
      if (kind === 'foreshadows')
        await this.validateForeshadowInternal(
          book,
          pending.content,
          pending.referenceBaseline ?? pending.before?.content
        )
      if (pending.before) {
        this.validateMeta(pending.before, id, kind)
        const { content: _content, version: _version, ...beforeMeta } = pending.before
        const currentMeta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
        const locatedMeta = {
          ...currentMeta,
          trashedAt: trashed ? currentMeta.trashedAt || currentMeta.updatedAt : null
        }
        if (json(locatedMeta) !== json(beforeMeta) && json(currentMeta) !== json(pending.meta))
          fail('RECOVERY_CONFLICT', '保存中断后元数据又被修改，请保留文件并核对')
      }
      const currentHash = hash(await fs.readFile(contentPath, 'utf8'))
      if (currentHash !== pending.beforeHash && currentHash !== hash(pending.content))
        fail('RECOVERY_CONFLICT', '保存中断后文件又被外部修改，请保留文件并人工核对')
      if (pending.before) await this.recordHistory(book, pending.before)
      await this.writer(contentPath, pending.content)
      await this.writer(metaPath, json(pending.meta))
      const document = { ...pending.meta, content: pending.content }
      await this.recordHistory(book, { ...document, version: hash(json(document)) })
      await fs.unlink(journalPath)
    }
    const meta: DocumentMeta = JSON.parse(await fs.readFile(metaPath, 'utf8'))
    this.validateMeta(meta, id, kind)
    counters.countDocumentRead()
    const content = await fs.readFile(contentPath, 'utf8')
    // Folder location is authoritative if the process stopped around an atomic move.
    const document = {
      ...meta,
      trashedAt: trashed ? meta.trashedAt || meta.updatedAt : null,
      content
    }
    const snapshot = { ...document, version: hash(json(document)) }
    this.catalog(book.id).add(snapshot, folder)
    this.fingerprints.get(book.id)?.set(id, stamp)
    return snapshot
  }
  private async snapshot(book: Book, id: string): Promise<DocumentSnapshot> {
    return this.readAt(book, await this.locate(book, id), id)
  }
  private async locations(book: Book, signal?: AbortSignal) {
    const found = new Map<string, { folder: string; kind: DocumentKind; trashed: boolean }>()
    for (const kind of kinds)
      for (const trashed of [false, true]) {
        signal?.throwIfAborted()
        const root = await this.safe(
          book,
          join(book.root, ...(trashed ? ['.workspace', 'trash'] : []), kind)
        )
        for (const entry of await fs.readdir(root, { withFileTypes: true })) {
          signal?.throwIfAborted()
          if (!entry.name.startsWith('doc_')) continue
          if (found.has(entry.name))
            fail('DUPLICATE_DOCUMENT', '发现重复文档 ID，请先处理作品副本冲突')
          found.set(entry.name, {
            folder: await this.safe(book, join(root, entry.name)),
            kind,
            trashed
          })
        }
      }
    return found
  }

  private async fingerprint(
    book: Book,
    loc: { folder: string; kind: DocumentKind }
  ): Promise<string> {
    const parts = [loc.folder]
    for (const name of [
      'meta.json',
      loc.kind === 'chapters' ? 'content.txt' : 'content.md',
      'pending.json'
    ]) {
      const path = await this.safe(book, join(loc.folder, name))
      try {
        const stat = await fs.stat(path, { bigint: true })
        parts.push(`${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`)
      } catch (error) {
        if (name !== 'pending.json' || (error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error
        parts.push('none')
      }
    }
    return parts.join('|')
  }

  /** Recheck file identities/metadata; only changed content is read. Force is the
   * fallback for external tools/filesystems that preserve all metadata. */
  private async ensureCatalog(book: Book, force = false): Promise<void> {
    const cat = this.catalog(book.id)
    const stamps = this.fingerprints.get(book.id) || new Map<string, string>()
    this.fingerprints.set(book.id, stamps)
    try {
      const locations = await this.locations(book)
      if (!cat.isInitialized) {
        stamps.clear()
        cat.initialize([], () => {
          throw new Error('empty catalog')
        })
      }
      for (const [id, loc] of locations) {
        const stamp = await this.fingerprint(book, loc)
        if (force || stamp !== stamps.get(id)) {
          await this.readAt(book, loc, id, stamp)
          // Use the pre-read stamp: a concurrent external change must be checked again.
          stamps.set(id, stamp)
        }
      }
      for (const meta of cat.list())
        if (!locations.has(meta.id)) {
          cat.remove(meta.id)
          stamps.delete(meta.id)
        }
    } catch (error) {
      cat.invalidate()
      stamps.clear()
      throw error
    }
  }

  refreshCatalog(bookId: string): Promise<void> {
    return this.queue(bookId, () => this.ensureCatalog(this.book(bookId), true))
  }

  private async scanInternal(book: Book, signal?: AbortSignal): Promise<DocumentSnapshot[]> {
    const result: DocumentSnapshot[] = []
    const locations = await this.locations(book, signal)
    const stamps = new Map<string, string>()
    for (const [id, loc] of locations) {
      signal?.throwIfAborted()
      const stamp = await this.fingerprint(book, loc)
      result.push(await this.readAt(book, loc, id, stamp))
      stamps.set(id, stamp)
    }
    signal?.throwIfAborted()
    this.catalog(book.id).initialize(result, (id) => locations.get(id)!)
    this.fingerprints.set(book.id, stamps)
    return result
  }
  private async listInternal(book: Book): Promise<DocumentMeta[]> {
    await this.ensureCatalog(book)
    return this.catalog(book.id).list()
  }
  private async bindingTarget(
    book: Book,
    id: string,
    kind: 'chapters' | 'outlines'
  ): Promise<StoryTarget> {
    const path = `book/${kind}/${id}.${kind === 'chapters' ? 'txt' : 'md'}`
    try {
      const location = await this.locate(book, id)
      if (location.kind !== kind) fail('BINDING_KIND', '关系两端必须分别为当前作品的正文和大纲')
      // Only metadata is needed: relation attachments never read target content.
      const meta = JSON.parse(
        await fs.readFile(await this.safe(book, join(location.folder, 'meta.json')), 'utf8')
      )
      this.validateMeta(meta, id, kind)
      const contentPath = await this.safe(book, this.contentPath(location.folder, kind))
      return {
        id,
        kind,
        path,
        title: meta.title,
        state: !(await exists(contentPath)) ? 'missing' : location.trashed ? 'trashed' : 'active'
      }
    } catch (error) {
      if (
        (error as { code?: string }).code === 'NOT_FOUND' ||
        (error as { code?: string }).code === 'ENOENT'
      )
        return { id, kind, path, title: null, state: 'missing' }
      throw error
    }
  }
  private async validateForeshadowInternal(book: Book, content: string, previous?: string) {
    return validateForeshadow(
      content,
      async (id) => {
        try {
          const location = await this.locate(book, id)
          if (location.kind !== 'chapters') return { kind: location.kind, state: 'active' }
          return this.bindingTarget(book, id, 'chapters')
        } catch (error) {
          if ((error as { code?: string }).code === 'NOT_FOUND')
            return { kind: 'chapters', state: 'missing' }
          throw error
        }
      },
      previous
    )
  }
  validateForeshadowCandidate(
    bookId: string,
    content: string,
    before?: { id: string; version: string }
  ): Promise<void> {
    return this.queue(bookId, async () => {
      const book = this.book(bookId)
      const current = before ? await this.snapshot(book, before.id) : undefined
      if (current && (current.kind !== 'foreshadows' || current.version !== before!.version))
        fail('CONFLICT', '伏笔版本已变化')
      await this.validateForeshadowInternal(book, content, current?.content)
    })
  }
  foreshadowRows(bookId: string, offset = 0, limit = 100) {
    return this.queue(bookId, async () => {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 200
      )
        fail('ARGUMENT', '伏笔列表分页参数无效')
      const book = this.book(bookId)
      const docs = (await this.orderedInternal(book)).filter(
        (doc) => doc.kind === 'foreshadows' && !doc.trashedAt
      )
      const rows = []
      for (const meta of docs.slice(offset, offset + limit)) {
        const document = await this.snapshot(book, meta.id)
        try {
          const fields = parseForeshadow(document.content)
          rows.push({
            document,
            fields,
            startChapter: fields.startChapterId
              ? await this.bindingTarget(book, fields.startChapterId, 'chapters')
              : null,
            endChapter: fields.endChapterId
              ? await this.bindingTarget(book, fields.endChapterId, 'chapters')
              : null
          })
        } catch (error) {
          rows.push({ document, error: (error as Error).message })
        }
      }
      return {
        rows,
        total: docs.length,
        nextOffset: offset + rows.length < docs.length ? offset + rows.length : null
      }
    })
  }
  private async bindingsInternal(book: Book): Promise<ChapterOutlineBindings> {
    const path = await this.safe(
      book,
      join(book.root, '.workspace', 'chapter-outline-bindings.json')
    )
    let raw: string
    try {
      raw = await fs.readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const marker = await this.safe(
          book,
          join(book.root, '.workspace', 'chapter-outline-bindings.initialized')
        )
        if (await exists(marker))
          fail('BINDING_MISSING', '曾建立的正文大纲关系文件缺失，请从备份恢复，不能当作未绑定')
        return { schemaVersion: 1, revision: 0, bindings: [] }
      }
      throw error
    }
    const state = parseBindings(raw)
    for (const pair of state.bindings) {
      await this.bindingTarget(book, pair.chapterId, 'chapters')
      await this.bindingTarget(book, pair.outlineId, 'outlines')
    }
    return state
  }
  chapterOutlineBindings(bookId: string): Promise<ChapterOutlineBindings> {
    return this.queue(bookId, () => this.bindingsInternal(this.book(bookId)))
  }
  /** One atomic replacement handles bind, unbind and explicit rebind. */
  setChapterOutlineBinding(input: {
    bookId: string
    chapterId: string
    outlineId: string | null
    expectedRevision: number
  }): Promise<ChapterOutlineBindings> {
    return this.queue(input.bookId, async () => {
      if (
        !isDocumentId(input.chapterId) ||
        (input.outlineId !== null && !isDocumentId(input.outlineId))
      )
        fail('ID', '关系文档标识无效')
      const book = this.book(input.bookId)
      const state = await this.bindingsInternal(book)
      if (input.expectedRevision !== state.revision)
        fail('BINDING_CONFLICT', '关系已变化，请刷新后重试')
      const previous = state.bindings.find((pair) => pair.chapterId === input.chapterId)
      if ((previous?.outlineId ?? null) === input.outlineId) return state
      if (input.outlineId !== null) {
        const occupied = state.bindings.find((pair) => pair.outlineId === input.outlineId)
        if (occupied) {
          const owner = await this.bindingTarget(book, occupied.chapterId, 'chapters')
          throw Object.assign(
            new DocumentError(
              'BINDING_OCCUPIED',
              `大纲已绑定「${owner.title || owner.id}」，不能自动抢占`
            ),
            {
              binding: occupied
            }
          )
        }
        const chapter = await this.bindingTarget(book, input.chapterId, 'chapters')
        const outline = await this.bindingTarget(book, input.outlineId, 'outlines')
        if (chapter.state !== 'active' || outline.state !== 'active')
          fail('BINDING_TARGET', '建立关系时正文和大纲必须存在且未回收')
      }
      if (state.revision === Number.MAX_SAFE_INTEGER)
        fail('BINDING_REVISION', '关系版本已超出安全范围')
      const next: ChapterOutlineBindings = {
        schemaVersion: 1,
        revision: state.revision + 1,
        bindings: [
          ...state.bindings.filter((pair) => pair.chapterId !== input.chapterId),
          ...(input.outlineId === null
            ? []
            : [{ chapterId: input.chapterId, outlineId: input.outlineId }])
        ]
      }
      await this.writeBindings(book, next)
      return next
    })
  }
  private async writeBindings(book: Book, next: ChapterOutlineBindings): Promise<void> {
    parseBindings(json(next))
    const marker = await this.safe(
      book,
      join(book.root, '.workspace', 'chapter-outline-bindings.initialized')
    )
    const newMarker = !(await exists(marker))
    if (newMarker) await this.writer(marker, '1\n')
    try {
      await this.writer(
        await this.safe(book, join(book.root, '.workspace', 'chapter-outline-bindings.json')),
        json(next)
      )
    } catch (error) {
      if (newMarker) await fs.unlink(marker).catch(() => {})
      throw error
    }
  }
  private requestAutomaticBinding(book: Book, doc: DocumentMeta): void {
    if (doc.kind !== 'chapters' && doc.kind !== 'outlines') return
    const ids = this.automaticBindingIds.get(book.id) ?? new Set<string>()
    ids.add(doc.id)
    this.automaticBindingIds.set(book.id, ids)
  }
  private async flushAutomaticBindings(book: Book): Promise<void> {
    const ids = this.automaticBindingIds.get(book.id)
    if (!ids?.size) return
    this.automaticBindingIds.delete(book.id)
    try {
      const result = await this.matchBindingsInternal(book, undefined, ids)
      if (result.ambiguousNumbers.length)
        this.automaticBindingNotices.set(
          book.id,
          `章号 ${result.ambiguousNumbers.join('、')} 重复，未自动绑定；请手动选择。`
        )
      else this.automaticBindingNotices.delete(book.id)
    } catch (error) {
      // The document has already been saved. Do not report a false manuscript
      // save failure or retry its write because the independent binding failed.
      this.automaticBindingNotices.set(
        book.id,
        `文档已保存，但自动绑定未完成：${(error as Error).message}。可修复后点击“自动匹配”重试。`
      )
    }
  }
  private async matchBindingsInternal(
    book: Book,
    expectedRevision?: number,
    ids?: ReadonlySet<string>
  ): Promise<ChapterOutlineMatchResult> {
    const state = await this.bindingsInternal(book)
    if (expectedRevision !== undefined && expectedRevision !== state.revision)
      fail('BINDING_CONFLICT', '关系已变化，请刷新后重试')
    const matches = chapterOutlineMatches(await this.listInternal(book), state.bindings, ids)
    for (const pair of matches.pairs) {
      const chapter = await this.bindingTarget(book, pair.chapterId, 'chapters')
      const outline = await this.bindingTarget(book, pair.outlineId, 'outlines')
      if (chapter.state !== 'active' || outline.state !== 'active')
        fail('BINDING_TARGET', '匹配目标已变化，请刷新重试')
    }
    if (matches.pairs.length) {
      if (state.revision === Number.MAX_SAFE_INTEGER)
        fail('BINDING_REVISION', '关系版本已超出安全范围')
      state.revision++
      state.bindings.push(...matches.pairs)
      await this.writeBindings(book, state)
    }
    return {
      revision: state.revision,
      added: matches.pairs,
      ambiguousNumbers: matches.ambiguousNumbers,
      occupiedNumbers: matches.occupiedNumbers
    }
  }
  matchChapterOutlines(
    bookId: string,
    expectedRevision: number
  ): Promise<ChapterOutlineMatchResult> {
    return this.queue(bookId, async () => {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
        fail('BINDING_CONFLICT', '缺少有效关系版本，请刷新后重试')
      const result = await this.matchBindingsInternal(this.book(bookId), expectedRevision)
      this.automaticBindingNotices.delete(bookId)
      return result
    })
  }
  private async resolveBinding(
    book: Book,
    doc: DocumentSnapshot,
    state: ChapterOutlineBindings
  ): Promise<ChapterOutlineBinding | undefined> {
    if (doc.kind !== 'chapters' && doc.kind !== 'outlines') return undefined
    const pair = state.bindings.find(
      (pair) => pair.chapterId === doc.id || pair.outlineId === doc.id
    )
    if (!pair) return { state: 'unbound', revision: state.revision }
    const target =
      doc.kind === 'chapters'
        ? await this.bindingTarget(book, pair.outlineId, 'outlines')
        : await this.bindingTarget(book, pair.chapterId, 'chapters')
    return { state: 'bound', revision: state.revision, target }
  }
  /** A single queue operation supplies a consistent document/relation batch. */
  readWithBindings(
    bookId: string,
    ids: string[],
    explicitReference = false,
    errors?: Map<string, string>
  ): Promise<StoryRead[]> {
    return this.queue(bookId, async () => {
      const book = this.book(bookId)
      const documents: DocumentSnapshot[] = []
      for (const id of ids) {
        try {
          const doc = await this.snapshot(book, id)
          if (doc.trashedAt && !explicitReference) fail('TRASHED', '回收文档只允许沿明确引用读取')
          documents.push(doc)
        } catch (error) {
          if (!errors) throw error
          errors.set(id, (error as Error).message)
        }
      }
      let state: ChapterOutlineBindings
      let bindingError: ChapterOutlineBinding | undefined
      try {
        state = await this.bindingsInternal(book)
      } catch (error) {
        const failure = {
          state: 'error' as const,
          code: (error as { code?: string }).code || 'BINDING_READ',
          message: (error as Error).message
        }
        bindingError = failure
        state = { schemaVersion: 1, revision: 0, bindings: [] }
      }
      const result: StoryRead[] = []
      for (const document of documents) {
        const item: StoryRead = {
          document,
          chapterOutlineBinding: ['chapters', 'outlines'].includes(document.kind)
            ? (bindingError ?? (await this.resolveBinding(book, document, state)))
            : undefined
        }
        if (document.kind === 'foreshadows') {
          try {
            const fields = parseForeshadow(document.content)
            item.foreshadowChapters = {
              start: fields.startChapterId
                ? await this.bindingTarget(book, fields.startChapterId, 'chapters')
                : null,
              end: fields.endChapterId
                ? await this.bindingTarget(book, fields.endChapterId, 'chapters')
                : null
            }
          } catch (error) {
            item.foreshadowChapters = { error: (error as Error).message }
          }
        }
        const notice = this.automaticBindingNotices.get(book.id)
        if (notice && ['chapters', 'outlines'].includes(document.kind))
          item.automaticBindingNotice = notice
        result.push(item)
      }
      return result
    })
  }
  private async assertBindingDependencies(
    book: Book,
    dependencies: BindingDependency[]
  ): Promise<void> {
    if (!dependencies.length) return
    const state = await this.bindingsInternal(book)
    for (const dependency of dependencies) {
      if (
        !isDocumentId(dependency.id) ||
        (dependency.targetId !== null && !isDocumentId(dependency.targetId))
      )
        fail('BINDING_DEPENDENCY', '关系依赖无效')
      const pair = state.bindings.find(
        (pair) => pair.chapterId === dependency.id || pair.outlineId === dependency.id
      )
      const targetId = pair
        ? pair.chapterId === dependency.id
          ? pair.outlineId
          : pair.chapterId
        : null
      if (targetId !== dependency.targetId)
        fail('BINDING_STALE', '提案依赖的正文大纲关系已变化，请重新生成')
    }
  }
  heavyContextSources(
    bookId: string,
    chapterId: string,
    settings: import('../shared/heavyAgent').HeavyAgentSettings
  ) {
    return this.queue(bookId, async () => {
      const book = this.book(bookId)
      const chapter = await this.snapshot(book, chapterId)
      if (chapter.kind !== 'chapters' || chapter.trashedAt) return null
      const chapters = (await this.listInternal(book))
        .filter((d) => d.kind === 'chapters' && !d.trashedAt)
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      const index = chapters.findIndex((d) => d.id === chapterId)
      const notices: string[] = []
      const bindings =
        settings.chapterOutline || settings.previousContext
          ? await this.bindingsInternal(book)
          : undefined
      const outline = async (id: string): Promise<DocumentSnapshot | null> => {
        const pair = bindings?.bindings.find((p) => p.chapterId === id)
        if (!pair) {
          notices.push(`${chapters.find((d) => d.id === id)?.title || id}：未绑定大纲`)
          return null
        }
        const target = await this.bindingTarget(book, pair.outlineId, 'outlines')
        if (target.state !== 'active') {
          notices.push(`${id}：大纲${target.state === 'trashed' ? '已回收' : '缺失'}`)
          return null
        }
        try {
          return await this.snapshot(book, pair.outlineId)
        } catch (e) {
          throw new Error(`大纲 ${pair.outlineId} 读取失败：${(e as Error).message}`)
        }
      }
      const previousOutlines: DocumentSnapshot[] = []
      if (settings.previousContext)
        for (const d of chapters.slice(Math.max(0, index - 3), index)) {
          const item = await outline(d.id)
          if (item) previousOutlines.push(item)
        }
      if (settings.previousContext && index === 0) notices.push('首章没有前文，前文资料不适用')
      return {
        chapter,
        notices,
        previousOutlines,
        chapterOrder: chapters.map((d) => d.id),
        bindings,
        previous:
          settings.previousContext && index > 0
            ? await this.snapshot(book, chapters[index - 1].id)
            : null,
        outline: settings.chapterOutline ? await outline(chapterId) : null
      }
    })
  }
  list(bookId: string): Promise<DocumentMeta[]> {
    return this.queue(bookId, () => this.listInternal(this.book(bookId)))
  }
  read(bookId: string, id: string): Promise<{ document: DocumentSnapshot; draft: Draft | null }> {
    return this.queue(bookId, async () => {
      const book = this.book(bookId)
      const document = await this.snapshot(book, id)
      const path = await this.safe(book, join(book.root, '.workspace', 'recovery', `${id}.json`))
      let draft: Draft | null = null
      if (!document.trashedAt && (await exists(path))) {
        draft = JSON.parse(await fs.readFile(path, 'utf8'))
        if (draft && draft.content === document.content && draft.title === document.title)
          draft = null
      }
      return { document, draft }
    })
  }
  create(
    bookId: string,
    kind: DocumentKind,
    title: string,
    options: { content?: string; id?: string; operationId?: string } = {}
  ): Promise<{ document: DocumentSnapshot; draft: null }> {
    return this.queue(bookId, async () => {
      return { document: await this.createAt(this.book(bookId), kind, title, options), draft: null }
    })
  }
  private async createAt(
    book: Book,
    kind: DocumentKind,
    title: string,
    options: { content?: string; id?: string; operationId?: string; readonlyExample?: boolean }
  ): Promise<DocumentSnapshot> {
    if (!kinds.includes(kind)) fail('KIND', '文档类型无效')
    if (kind === 'foreshadows' && options.content === undefined)
      options = { ...options, content: initialContent(kind, 'blank') }
    if (kind === 'foreshadows') await this.validateForeshadowInternal(book, options.content!)
    const id = options.id || `doc_${randomUUID()}`
    if (!validId(id) || !id.startsWith('doc_')) fail('ID', '文档标识无效')
    if (typeof (options.content ?? '') !== 'string') fail('CONTENT', '文档内容必须为文本')
    if ((await this.listInternal(book)).some((doc) => doc.id === id)) fail('EXISTS', '文档已经存在')
    const time = new Date().toISOString()
    const order =
      Math.max(
        -1,
        ...(await this.listInternal(book))
          .filter((doc) => doc.kind === kind)
          .map((doc) => doc.order)
      ) + 1
    const meta: DocumentMeta = {
      ...(options.readonlyExample ? { readonlyExample: true } : {}),
      id,
      kind,
      title: titleOf(title),
      order,
      createdAt: time,
      updatedAt: time,
      generation: options.operationId || randomUUID(),
      trashedAt: null
    }
    const folder = await this.safe(book, join(book.root, kind, id))
    const staging = await this.safe(book, join(book.root, kind, `.new-${id}`))
    if (await exists(staging)) {
      if (!options.operationId) fail('RECOVERY_CONFLICT', '新建暂存文件已存在，请保留文件并核对')
      const stagedMeta = await this.safe(book, join(staging, 'meta.json'))
      const stagedContent = await this.safe(book, this.contentPath(staging, kind))
      if (!(await exists(stagedMeta))) await this.writer(stagedMeta, json(meta))
      const staged = JSON.parse(await fs.readFile(stagedMeta, 'utf8'))
      if (
        staged.generation !== options.operationId ||
        staged.id !== id ||
        staged.kind !== kind ||
        staged.title !== meta.title
      )
        fail('RECOVERY_CONFLICT', '新建暂存元数据与提案不一致')
      if (!(await exists(stagedContent))) await this.writer(stagedContent, options.content ?? '')
      const text = await fs.readFile(stagedContent, 'utf8')
      if (
        !options.operationId ||
        staged.generation !== options.operationId ||
        staged.title !== meta.title ||
        text !== (options.content ?? '')
      )
        fail('RECOVERY_CONFLICT', '新建暂存文件与提案不一致，请保留文件并核对')
    } else {
      await fs.mkdir(staging)
      await this.writer(join(staging, 'meta.json'), json(meta))
      await this.writer(this.contentPath(staging, kind), options.content ?? '')
    }
    await fs.rename(staging, folder)
    const doc = await this.snapshot(book, id)
    this.catalog(book.id).add(doc, folder)
    this.requestAutomaticBinding(book, doc)
    return doc
  }
  private async commit(
    book: Book,
    before: DocumentSnapshot,
    content: string,
    meta: DocumentMeta,
    referenceBaseline?: string
  ): Promise<DocumentSnapshot> {
    if (before.readonlyExample) fail('READ_ONLY', '示例资料不可修改，请复制为普通资料后编辑')
    if (before.kind === 'foreshadows')
      await this.validateForeshadowInternal(book, content, referenceBaseline ?? before.content)
    const { folder } = await this.locate(book, before.id)
    const journal = await this.safe(book, join(folder, 'pending.json'))
    await this.writer(
      journal,
      json({
        beforeHash: hash(before.content),
        content,
        meta,
        before,
        referenceBaseline
      } satisfies Transaction)
    )
    // readAt replays the transaction, including after a process restart.
    const committed = await this.snapshot(book, before.id)
    this.catalog(book.id).update(committed)
    return committed
  }
  save(input: SaveInput): Promise<DocumentSnapshot> {
    return this.queue(input.bookId, async () => {
      const book = this.book(input.bookId)
      const before = await this.snapshot(book, input.id)
      if (before.trashedAt) fail('TRASHED', '文档已移入回收站，请先恢复')
      if (!input.expectedVersion || input.expectedVersion !== before.version)
        fail('CONFLICT', '磁盘版本已变化，当前输入已保留，请比较后处理')
      if (typeof input.content !== 'string') fail('CONTENT', '文档内容必须为文本')
      const title = titleOf(input.title)
      if (before.content === input.content && before.title === title) return before
      const { content: _content, version: _version, ...meta } = before
      const saved = await this.commit(book, before, input.content, {
        ...meta,
        title,
        updatedAt: new Date().toISOString(),
        generation: randomUUID()
      })
      if (title !== before.title) this.requestAutomaticBinding(book, saved)
      return saved
    })
  }
  writeDraft(bookId: string, id: string, draft: Draft | null): Promise<void> {
    return this.queue(bookId, async () => {
      const book = this.book(bookId)
      const document = await this.snapshot(book, id)
      const path = await this.safe(book, join(book.root, '.workspace', 'recovery', `${id}.json`))
      if (draft === null) {
        await fs.unlink(path).catch((error) => {
          if (error.code !== 'ENOENT') throw error
        })
        return
      }
      if (document.readonlyExample) fail('READ_ONLY', '示例资料不可修改，请复制后编辑')
      if (document.trashedAt) fail('TRASHED', '回收站文档不可写入草稿')
      if (
        typeof draft.content !== 'string' ||
        typeof draft.title !== 'string' ||
        typeof draft.baseVersion !== 'string'
      )
        fail('DRAFT', '草稿无效')
      counters.countDraftWrite(Buffer.byteLength(json(draft)))
      await this.writer(path, json(draft))
    })
  }
  private move(
    bookId: string,
    id: string,
    version: string,
    toTrash: boolean
  ): Promise<DocumentSnapshot> {
    return this.queue(bookId, async () => {
      const book = this.book(bookId)
      const before = await this.snapshot(book, id)
      if (before.version !== version) fail('CONFLICT', '文档已变化，请重新读取后再操作')
      if (Boolean(before.trashedAt) === toTrash) fail('STATE', '文档状态已改变')
      const { content: _content, version: _version, ...meta } = before
      const time = new Date().toISOString()
      await this.commit(book, before, before.content, {
        ...meta,
        generation: randomUUID(),
        updatedAt: time,
        trashedAt: toTrash ? time : null
      })
      const { folder } = await this.locate(book, id)
      const target = await this.safe(
        book,
        join(book.root, ...(toTrash ? ['.workspace', 'trash'] : []), before.kind, id)
      )
      if (await exists(target)) fail('EXISTS', '目标位置已有同 ID 文档，操作已停止')
      await fs.rename(folder, target)
      const after = await this.snapshot(book, id)
      this.catalog(bookId).setTrashed(id, toTrash, after, target)
      return after
    })
  }
  trash(bookId: string, id: string, version: string): Promise<DocumentSnapshot> {
    return this.move(bookId, id, version, true)
  }
  restore(bookId: string, id: string, version: string): Promise<DocumentSnapshot> {
    return this.move(bookId, id, version, false)
  }
  reorder(
    bookId: string,
    kind: DocumentKind,
    ids: string[],
    expectedIds?: string[]
  ): Promise<void> {
    return this.queue(bookId, async () => {
      if (!['chapters', 'outlines'].includes(kind)) fail('ORDER', '此类文档不支持手动排序')
      const book = this.book(bookId)
      const before = await this.activeOrder(book, kind)
      if (
        !Array.isArray(ids) ||
        new Set(ids).size !== before.length ||
        ids.length !== before.length ||
        before.some((id) => !ids.includes(id)) ||
        (expectedIds !== undefined &&
          (!Array.isArray(expectedIds) || !sameIds(before, expectedIds)))
      )
        fail('CONFLICT', '文档列表已变化，请刷新后重新排序')
      if (sameIds(before, ids)) return
      // Publish undo first: a failed order write cannot undo an unapplied operation.
      await this.writer(
        await this.safe(book, join(book.root, '.workspace', `order-${kind}.json`)),
        json({ ids, undo: { before, after: ids } } satisfies OrderState)
      )
      await this.writer(await this.safe(book, join(book.root, kind, 'order.json')), json(ids))
    })
  }
  undoOrder(bookId: string, kind: DocumentKind): Promise<void> {
    return this.queue(bookId, async () => {
      if (!['chapters', 'outlines'].includes(kind)) fail('ORDER', '此类文档不支持手动排序')
      const book = this.book(bookId)
      const path = await this.safe(book, join(book.root, '.workspace', `order-${kind}.json`))
      if (!(await exists(path))) fail('UNDO', '没有可以恢复的排序')
      const state: OrderState = JSON.parse(await fs.readFile(path, 'utf8'))
      if (!state.undo || !Array.isArray(state.undo.before) || !Array.isArray(state.undo.after))
        fail('UNDO', '没有可以恢复的排序')
      const undo = state.undo!
      const current = await this.activeOrder(book, kind)
      if (!sameIds(current, undo.after)) fail('CONFLICT', '排序后列表已有变化，不能覆盖恢复')
      if (
        new Set(undo.before).size !== current.length ||
        undo.before.some((id) => !current.includes(id))
      )
        fail('FORMAT', '排序恢复记录无效')
      await this.writer(
        await this.safe(book, join(book.root, kind, 'order.json')),
        json(undo.before)
      )
      await this.writer(path, json({ ids: undo.before, undo: null } satisfies OrderState))
    })
  }
  private async orderedInternal(book: Book): Promise<DocumentMeta[]> {
    return this.applyOrder(book, await this.listInternal(book))
  }
  private async applyOrder<T extends DocumentMeta>(book: Book, list: T[]): Promise<T[]> {
    for (const kind of kinds) {
      const path = await this.safe(book, join(book.root, kind, 'order.json'))
      if (!(await exists(path))) continue
      const ids: string[] = JSON.parse(await fs.readFile(path, 'utf8'))
      if (
        !Array.isArray(ids) ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !validId(id) || !id.startsWith('doc_'))
      )
        fail('FORMAT', '排序清单损坏，原文件已保留')
      for (const doc of list.filter((doc) => doc.kind === kind)) {
        const index = ids.indexOf(doc.id)
        doc.order = index < 0 ? ids.length + doc.order : index
      }
    }
    return list
  }
  private async activeOrder(book: Book, kind: DocumentKind): Promise<string[]> {
    return (await this.orderedInternal(book))
      .filter((doc) => doc.kind === kind && !doc.trashedAt)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((doc) => doc.id)
  }
  async orderedList(bookId: string): Promise<DocumentMeta[]> {
    return this.queue(bookId, () => this.orderedInternal(this.book(bookId)))
  }
  private preferenceValue(value: BookPreferences): BookPreferences {
    if (!value || typeof value !== 'object' || !value.naming) fail('PREFERENCES', '作品设置无效')
    const message = validateNamingRule(value.naming)
    if (message) fail('PREFERENCES', message)
    if (
      !Number.isSafeInteger(value.targetWords) ||
      value.targetWords < 0 ||
      value.targetWords > 100000000
    )
      fail('PREFERENCES', '字数目标须为 0–100000000 的整数')
    const { mode, suffix, start, padding, template } = value.naming
    return { naming: { mode, suffix, start, padding, template }, targetWords: value.targetWords }
  }
  getPreferences(bookId: string): Promise<BookPreferences> {
    return this.queue(bookId, async () => {
      const book = this.book(bookId)
      const path = await this.safe(book, join(book.root, '.workspace', 'preferences.json'))
      if (!(await exists(path))) return { naming: { ...defaultNamingRule }, targetWords: 0 }
      return this.preferenceValue(JSON.parse(await fs.readFile(path, 'utf8')))
    })
  }
  setPreferences(bookId: string, value: BookPreferences): Promise<void> {
    return this.queue(bookId, async () => {
      const book = this.book(bookId)
      const preferences = this.preferenceValue(value)
      await this.writer(
        await this.safe(book, join(book.root, '.workspace', 'preferences.json')),
        json(preferences)
      )
    })
  }
  createBatch(input: CreateBatchInput): Promise<{ document: DocumentSnapshot; draft: null }[]> {
    return this.queue(input.bookId, async () => {
      const book = this.book(input.bookId)
      if (!kinds.includes(input.kind)) fail('KIND', '文档类型无效')
      if (!Array.isArray(input.items) || !input.items.length || input.items.length > 5000)
        fail('BATCH', '每次可创建 1–5000 篇文档')
      const items = input.items.map((item) => {
        if (!item || typeof (item.content ?? '') !== 'string') fail('CONTENT', '文档内容必须为文本')
        return {
          title: titleOf(item.title),
          content: item.content ?? initialContent(input.kind, 'blank')
        }
      })
      if (input.kind === 'foreshadows')
        for (const item of items) await this.validateForeshadowInternal(book, item.content)
      if (
        items.reduce((total, item) => total + Buffer.byteLength(item.content, 'utf8'), 0) >
        100 * 1024 * 1024
      )
        fail('BATCH', '单批正文不能超过 100 MB，请分批导入')
      const placement = normalizedPlacement(input.placement)
      const inputHash = hash(json({ bookId: book.id, kind: input.kind, items, placement }))
      if (input.operationId !== undefined) {
        if (!validOperationId(input.operationId)) fail('ID', '创建操作标识须为小写 UUID')
        const completed = await this.completedCreate(book, input.operationId, inputHash, input.kind)
        if (completed) return this.openCreated(book, completed.ids, input.kind)
      }
      const beforeOrder = await this.activeOrder(book, input.kind)
      if (
        input.expectedOrder !== undefined &&
        (!Array.isArray(input.expectedOrder) || !sameIds(beforeOrder, input.expectedOrder))
      )
        fail('CONFLICT', '文档顺序已变化，请刷新预览')
      let index = placement.position === 'start' ? 0 : beforeOrder.length
      if (placement.position === 'before' || placement.position === 'after') {
        index = beforeOrder.indexOf(placement.anchorId || '')
        if (index < 0) fail('CONFLICT', '插入位置已变化，请重新选择')
        if (placement.position === 'after') index++
      }
      const list = await this.listInternal(book)
      const startOrder =
        Math.max(-1, ...list.filter((doc) => doc.kind === input.kind).map((doc) => doc.order)) + 1
      const time = new Date().toISOString()
      const generation = randomUUID()
      const documents = items.map((item, offset) => ({
        content: item.content,
        meta: {
          id: `doc_${randomUUID()}`,
          kind: input.kind,
          title: item.title,
          order: startOrder + offset,
          createdAt: time,
          updatedAt: time,
          generation,
          trashedAt: null
        } satisfies DocumentMeta
      }))
      const afterOrder = [...beforeOrder]
      afterOrder.splice(index, 0, ...documents.map((doc) => doc.meta.id))
      const transaction: CreateBatchTransaction = {
        type: 'create',
        kind: input.kind,
        documents,
        beforeOrder,
        afterOrder,
        ...(input.operationId ? { operationId: input.operationId, inputHash, placement } : {})
      }
      await this.writer(await this.batchPath(book), json(transaction))
      await this.recoverBatch(book)
      return this.openCreated(
        book,
        documents.map(({ meta }) => meta.id),
        input.kind
      )
    })
  }
  renameBatch(input: RenameBatchInput): Promise<DocumentSnapshot[]> {
    return this.queue(input.bookId, async () => {
      const book = this.book(input.bookId)
      if (!Array.isArray(input.changes) || !input.changes.length || input.changes.length > 5000)
        fail('BATCH', '每次可重命名 1–5000 篇文档')
      if (new Set(input.changes.map((change) => change.id)).size !== input.changes.length)
        fail('ID', '重命名列表含重复文档')
      const changes: RenameBatchTransaction['changes'] = []
      const time = new Date().toISOString(),
        generation = randomUUID()
      for (const change of input.changes) {
        const before = await this.snapshot(book, change.id)
        if (before.readonlyExample) fail('READ_ONLY', '示例资料不可重命名')
        if (before.trashedAt) fail('TRASHED', '回收站文档不能批量重命名')
        if (!change.version || change.version !== before.version)
          fail('CONFLICT', '文档已变化，请重新生成命名预览')
        const title = titleOf(change.title)
        await this.assertNoDraft(book, before)
        if (title === before.title) continue
        const { content: _content, version: _version, ...meta } = before
        changes.push({ before, meta: { ...meta, title, updatedAt: time, generation } })
      }
      if (changes.length) {
        await this.writer(
          await this.batchPath(book),
          json({ type: 'rename', changes } satisfies RenameBatchTransaction)
        )
        await this.recoverBatch(book)
      }
      return Promise.all(input.changes.map((change) => this.snapshot(book, change.id)))
    })
  }
  private batchPath(book: Book): Promise<string> {
    return this.safe(book, join(book.root, '.workspace', 'batch-pending.json'))
  }
  private async openCreated(
    book: Book,
    ids: string[],
    kind: DocumentKind
  ): Promise<{ document: DocumentSnapshot; draft: null }[]> {
    return Promise.all(
      ids.map(async (id) => {
        const document = await this.snapshot(book, id)
        if (document.kind !== kind) fail('RECOVERY_CONFLICT', '创建记录的文档类型已被修改')
        return { document, draft: null }
      })
    )
  }
  private operationPath(book: Book, operationId: string): Promise<string> {
    if (!validOperationId(operationId)) return fail('ID', '创建操作标识须为小写 UUID')
    return this.safe(book, join(book.root, '.workspace', 'operations', `${operationId}.json`))
  }
  private async completedCreate(
    book: Book,
    operationId: string,
    inputHash: string,
    kind: DocumentKind
  ): Promise<CompletedCreate | null> {
    const path = await this.operationPath(book, operationId)
    if (!(await exists(path))) return null
    const { checksum, ...marker } = JSON.parse(
      await fs.readFile(path, 'utf8')
    ) as CompletedCreate & { checksum: string }
    if (
      checksum !== hash(json(marker)) ||
      marker.operationId !== operationId ||
      marker.bookId !== book.id ||
      !kinds.includes(marker.kind) ||
      !Array.isArray(marker.ids) ||
      !marker.ids.length ||
      marker.ids.length > 5000 ||
      new Set(marker.ids).size !== marker.ids.length ||
      marker.ids.some((id) => !validId(id) || !id.startsWith('doc_')) ||
      !/^[a-f0-9]{64}$/.test(marker.inputHash)
    )
      fail('FORMAT', '创建完成记录损坏，原文件已保留')
    if (marker.inputHash !== inputHash || marker.kind !== kind)
      fail('OPERATION_CONFLICT', '同一创建操作标识不能用于不同的标题、正文或位置；请重新发起创建')
    return marker
  }
  private async recoverBatch(book: Book): Promise<void> {
    const path = await this.batchPath(book)
    if (!(await exists(path))) return
    const transaction: BatchTransaction = JSON.parse(await fs.readFile(path, 'utf8'))
    if (transaction.type === 'create') {
      const { documents, kind, beforeOrder, afterOrder } = transaction
      if (
        !kinds.includes(kind) ||
        !Array.isArray(documents) ||
        !documents.length ||
        documents.length > 5000 ||
        !Array.isArray(beforeOrder) ||
        !Array.isArray(afterOrder)
      )
        fail('FORMAT', '新建恢复记录损坏，原文件已保留')
      if (kind === 'foreshadows')
        for (const doc of documents) await this.validateForeshadowInternal(book, doc.content)
      const ids = documents.map((doc) => doc?.meta?.id)
      if (
        new Set(ids).size !== ids.length ||
        new Set(afterOrder).size !== afterOrder.length ||
        afterOrder.length !== beforeOrder.length + ids.length ||
        [...beforeOrder, ...ids].some((id) => !validId(id) || !afterOrder.includes(id))
      )
        fail('FORMAT', '新建恢复顺序无效')
      if (transaction.operationId !== undefined) {
        if (
          !validOperationId(transaction.operationId) ||
          !transaction.placement ||
          !/^[a-f0-9]{64}$/.test(transaction.inputHash || '')
        )
          fail('FORMAT', '创建恢复操作标识无效')
        const normalized = normalizedPlacement(transaction.placement!)
        const actualHash = hash(
          json({
            bookId: book.id,
            kind,
            items: documents.map((doc) => ({
              title: doc.meta.title,
              content: doc.content
            })),
            placement: normalized
          })
        )
        if (actualHash !== transaction.inputHash)
          fail('FORMAT', '创建恢复内容校验失败，原文件已保留')
        const completed = await this.completedCreate(
          book,
          transaction.operationId,
          actualHash,
          kind
        )
        if (completed && !sameIds(completed.ids, ids))
          fail('RECOVERY_CONFLICT', '创建完成记录与恢复文档不一致')
      }
      // Validate every target before replaying any writes, including interrupted staging folders.
      const locations = await this.listInternal(book)
      for (const doc of documents) {
        this.validateMeta(doc.meta, doc.meta.id, kind)
        if (typeof doc.content !== 'string' || doc.meta.trashedAt)
          fail('FORMAT', '新建恢复内容无效')
        const folder = await this.safe(book, join(book.root, kind, doc.meta.id))
        const staging = await this.safe(book, join(book.root, kind, `.new-${doc.meta.id}`))
        if (
          locations.some(
            (other) => other.id === doc.meta.id && (other.kind !== kind || other.trashedAt)
          )
        )
          fail('RECOVERY_CONFLICT', '新建恢复目标位置已变化')
        for (const target of [folder, staging]) {
          if (!(await exists(target))) continue
          const metaPath = await this.safe(book, join(target, 'meta.json'))
          const contentPath = await this.safe(book, this.contentPath(target, kind))
          if (await exists(metaPath)) {
            if (json(JSON.parse(await fs.readFile(metaPath, 'utf8'))) !== json(doc.meta))
              fail('RECOVERY_CONFLICT', '新建中断后元数据又被修改，请保留文件并核对')
          } else if (target === folder) fail('RECOVERY_CONFLICT', '新建目标缺少元数据')
          if (await exists(contentPath)) {
            if ((await fs.readFile(contentPath, 'utf8')) !== doc.content)
              fail('RECOVERY_CONFLICT', '新建中断后正文又被修改，请保留文件并核对')
          } else if (target === folder) fail('RECOVERY_CONFLICT', '新建目标缺少正文')
        }
        if ((await exists(folder)) && (await exists(staging)))
          fail('RECOVERY_CONFLICT', '新建目标与暂存重复')
      }
      const current = await this.activeOrder(book, kind)
      if (
        !sameIds(current, afterOrder) &&
        !sameIds(
          current.filter((id) => !ids.includes(id)),
          beforeOrder
        )
      )
        fail('RECOVERY_CONFLICT', '新建中断后原列表排序已变化，请保留文件并核对')
      for (const doc of documents) {
        const folder = await this.safe(book, join(book.root, kind, doc.meta.id))
        if (await exists(folder)) continue
        const staging = await this.safe(book, join(book.root, kind, `.new-${doc.meta.id}`))
        await fs.mkdir(staging, { recursive: true })
        await this.writer(await this.safe(book, join(staging, 'meta.json')), json(doc.meta))
        await this.writer(await this.safe(book, this.contentPath(staging, kind)), doc.content)
        await fs.rename(staging, folder)
      }
      await this.writer(
        await this.safe(book, join(book.root, kind, 'order.json')),
        json(afterOrder)
      )
      if (transaction.operationId) {
        const marker: CompletedCreate = {
          operationId: transaction.operationId,
          bookId: book.id,
          kind,
          ids,
          inputHash: transaction.inputHash!
        }
        const folder = await this.safe(book, join(book.root, '.workspace', 'operations'))
        await fs.mkdir(folder, { recursive: true })
        await this.writer(
          await this.operationPath(book, marker.operationId),
          json({ ...marker, checksum: hash(json(marker)) })
        )
      }
    } else if (transaction.type === 'rename') {
      if (
        !Array.isArray(transaction.changes) ||
        !transaction.changes.length ||
        transaction.changes.length > 5000
      )
        fail('FORMAT', '重命名恢复记录损坏，原文件已保留')
      const ready: { before: DocumentSnapshot; meta: DocumentMeta }[] = []
      for (const change of transaction.changes) {
        if (!change?.before || !change.meta) fail('FORMAT', '重命名恢复记录无效')
        this.validateMeta(change.meta, change.before.id, change.before.kind)
        const current = await this.snapshot(book, change.before.id)
        const desired = { ...change.meta, content: change.before.content }
        if (current.version === hash(json(desired))) continue
        if (current.trashedAt || current.version !== change.before.version)
          fail('RECOVERY_CONFLICT', '批量命名中断后文档又有变化，请保留文件并核对')
        await this.assertNoDraft(book, current)
        ready.push(change)
      }
      for (const change of ready)
        await this.commit(book, change.before, change.before.content, change.meta)
    } else fail('FORMAT', '未知的批量恢复记录，原文件已保留')
    this.catalog(book.id).invalidate()
    await fs.unlink(path)
    const changed =
      transaction.type === 'create'
        ? transaction.documents.map((doc) => doc.meta)
        : transaction.changes.map((change) => change.meta)
    for (const doc of changed) this.requestAutomaticBinding(book, doc)
  }
  private async recordHistory(book: Book, snapshot: DocumentSnapshot): Promise<void> {
    if (
      !validId(snapshot.id) ||
      !snapshot.id.startsWith('doc_') ||
      !/^[a-f0-9]{64}$/.test(snapshot.version)
    )
      fail('FORMAT', '历史版本快照无效')
    const folder = await this.safe(book, join(book.root, '.workspace', 'history', snapshot.id))
    await fs.mkdir(folder, { recursive: true })
    const entry: HistoryEntry = {
      entryId: `history_${snapshot.version}`,
      id: snapshot.id,
      title: snapshot.title,
      savedAt: snapshot.updatedAt,
      version: snapshot.version,
      words: countWords(snapshot.content),
      content: snapshot.content
    }
    const path = await this.safe(book, join(folder, `${entry.entryId}.json`))
    if (!(await exists(path)))
      await this.writer(path, json({ ...entry, checksum: hash(json(entry)) }))
    const records = await Promise.all(
      (await fs.readdir(folder))
        .filter((name) => /^history_[a-f0-9]{64}\.json$/.test(name))
        .map(async (name) => {
          const recordPath = await this.safe(book, join(folder, name))
          const stat = await fs.stat(recordPath)
          return { path: recordPath, time: stat.mtimeMs, size: stat.size }
        })
    )
    records.sort((a, b) => a.time - b.time || a.path.localeCompare(b.path))
    let size = records.reduce((total, record) => total + record.size, 0)
    while (records.length > 100 || (size > 20 * 1024 * 1024 && records.length > 1)) {
      // Millisecond timestamps may tie during bulk operations; retain the just-committed snapshot.
      const oldest = records.splice(
        records.findIndex((record) => record.path !== path),
        1
      )[0]
      size -= oldest.size
      await fs.unlink(oldest.path)
    }
  }
  private async historyEntry(book: Book, id: string, entryId: string): Promise<HistoryEntry> {
    if (!validId(id) || !id.startsWith('doc_') || !/^history_[a-f0-9]{64}$/.test(entryId))
      fail('ID', '历史版本标识无效')
    const path = await this.safe(
      book,
      join(book.root, '.workspace', 'history', id, `${entryId}.json`)
    )
    if (!(await exists(path))) fail('NOT_FOUND', '历史版本不存在或已超过保留范围')
    const { checksum, ...entry } = JSON.parse(await fs.readFile(path, 'utf8')) as HistoryEntry & {
      checksum: string
    }
    if (
      entry.id !== id ||
      entry.entryId !== entryId ||
      typeof entry.content !== 'string' ||
      typeof entry.title !== 'string' ||
      typeof entry.savedAt !== 'string' ||
      checksum !== hash(json(entry))
    )
      fail('FORMAT', '历史版本损坏，原文件已保留')
    titleOf(entry.title)
    return entry
  }
  history(bookId: string, id: string): Promise<HistoryEntry[]> {
    return this.queue(bookId, async () => {
      const book = this.book(bookId)
      await this.snapshot(book, id)
      const folder = await this.safe(book, join(book.root, '.workspace', 'history', id))
      if (!(await exists(folder))) return []
      const entries: HistoryEntry[] = []
      for (const name of await fs.readdir(folder)) {
        if (!/^history_[a-f0-9]{64}\.json$/.test(name)) continue
        const { content: _content, ...entry } = await this.historyEntry(book, id, name.slice(0, -5))
        entries.push(entry)
      }
      return entries.sort(
        (a, b) => b.savedAt.localeCompare(a.savedAt) || b.entryId.localeCompare(a.entryId)
      )
    })
  }
  historyRead(bookId: string, id: string, entryId: string): Promise<HistoryEntry> {
    return this.queue(bookId, async () => {
      const book = this.book(bookId)
      await this.snapshot(book, id)
      return this.historyEntry(book, id, entryId)
    })
  }
  restoreHistory(
    bookId: string,
    id: string,
    entryId: string,
    expectedVersion: string
  ): Promise<DocumentSnapshot> {
    return this.queue(bookId, async () => {
      const book = this.book(bookId),
        before = await this.snapshot(book, id)
      if (before.trashedAt) fail('TRASHED', '请先从回收站恢复文档')
      if (!expectedVersion || before.version !== expectedVersion)
        fail('CONFLICT', '文档已变化，请重新比较历史版本')
      await this.assertNoDraft(book, before)
      const entry = await this.historyEntry(book, id, entryId)
      const { content: _content, version: _version, ...meta } = before
      return this.commit(
        book,
        before,
        entry.content!,
        {
          ...meta,
          title: titleOf(entry.title),
          updatedAt: new Date().toISOString(),
          generation: randomUUID()
        },
        entry.content
      )
    })
  }
  stats(bookId: string): Promise<BookStats> {
    return this.queue(bookId, async () => {
      await this.ensureCatalog(this.book(bookId))
      return this.catalog(bookId).stats()
    })
  }
  async search(bookId: string, query: string, signal?: AbortSignal): Promise<SearchHit[]> {
    if (typeof query !== 'string' || !query.trim() || query.length > 200)
      fail('SEARCH', '搜索词须为 1–200 个字符')
    const needle = query.trim().toLocaleLowerCase(),
      book = this.book(bookId)
    try {
      signal?.throwIfAborted()
      const locations = await this.queue(bookId, () => this.locations(book, signal))
      const snapshots: DocumentSnapshot[] = []
      // Each read retains recovery/write serialization, but releases the queue
      // between documents so cancellation and saves need not wait for the book.
      for (const [id, loc] of locations) {
        signal?.throwIfAborted()
        if (loc.trashed) continue
        const doc = await this.queue(bookId, async () => {
          signal?.throwIfAborted()
          try {
            return await this.readAt(book, loc, id)
          } catch (error) {
            if (['NOT_FOUND', 'ENOENT'].includes((error as { code?: string }).code || ''))
              return null
            throw error
          }
        })
        if (doc && !doc.trashedAt) snapshots.push(doc)
      }
      signal?.throwIfAborted()
      const list = await this.queue(bookId, () => this.applyOrder(book, snapshots))
      list.sort(
        (a, b) =>
          kinds.indexOf(a.kind) - kinds.indexOf(b.kind) ||
          a.order - b.order ||
          a.id.localeCompare(b.id)
      )
      const result: SearchHit[] = []
      for (const doc of list) {
        await yieldTurn()
        signal?.throwIfAborted()
        const lines = doc.content.split(/\r\n|\n|\r/)
        let found = false
        for (let i = 0; i < lines.length; i++) {
          if (i % 256 === 0) {
            await yieldTurn()
            signal?.throwIfAborted()
          }
          const index = lines[i].toLocaleLowerCase().indexOf(needle)
          if (index < 0) continue
          result.push({
            id: doc.id,
            kind: doc.kind,
            title: doc.title,
            line: i + 1,
            excerpt: lines[i].slice(Math.max(0, index - 50), index + needle.length + 100)
          })
          found = true
          if (result.length >= 500) return result
        }
        if (!found && doc.title.toLocaleLowerCase().includes(needle))
          result.push({ id: doc.id, kind: doc.kind, title: doc.title, line: 1, excerpt: doc.title })
        if (result.length >= 500) return result
      }
      return result
    } catch (error) {
      if (signal?.aborted) return []
      throw error
    }
  }
  agentRead(bookId: string, id: string, explicitReference = false): Promise<DocumentSnapshot> {
    return this.queue(bookId, async () => {
      const doc = await this.snapshot(this.book(bookId), id)
      if (doc.trashedAt && !explicitReference)
        fail('TRASHED', '默认 Agent 读取排除回收站；只能沿明确引用只读访问')
      return doc
    })
  }
  async agentDocuments(bookId: string): Promise<DocumentMeta[]> {
    return (await this.orderedList(bookId)).filter((doc) => !doc.trashedAt)
  }
  /** Internal records use the same book queue and path checks as manuscript writes and backups. */
  writeAgentTurnLog(bookId: string, conversationId: string, value: unknown): Promise<void> {
    const text = json(value)
    return this.queue(bookId, async () => {
      if (!/^conversation_[a-f0-9-]{36}$/.test(conversationId)) fail('ID', '会话标识无效')
      const book = this.book(bookId)
      const folder = await this.safe(book, join(book.root, '.workspace', 'agent-turn-logs'))
      await fs.mkdir(folder, { recursive: true })
      await this.writer(await this.safe(book, join(folder, `${conversationId}.json`)), text)
    })
  }
  readAgentTurnLog<T>(bookId: string, conversationId: string): Promise<T | null> {
    return this.queue(bookId, async () => {
      if (!/^conversation_[a-f0-9-]{36}$/.test(conversationId)) fail('ID', '会话标识无效')
      const book = this.book(bookId)
      const path = await this.safe(
        book,
        join(book.root, '.workspace', 'agent-turn-logs', `${conversationId}.json`)
      )
      if (!(await exists(path))) return null
      return JSON.parse(await fs.readFile(path, 'utf8')) as T
    })
  }
  agentRecords<T>(
    bookId: string,
    category: 'conversations' | 'proposals' | 'indexes',
    damaged?: (name: string) => void
  ): Promise<T[]> {
    return this.queue(bookId, async () => {
      const book = this.book(bookId)
      const folder = await this.safe(book, join(book.root, '.workspace', category))
      await fs.mkdir(folder, { recursive: true })
      const result: T[] = []
      for (const name of await fs.readdir(folder)) {
        if (!/^(conversation|proposal|index)_[a-f0-9-]{36}\.json$/.test(name)) continue
        try {
          const record = JSON.parse(
            await fs.readFile(await this.safe(book, join(folder, name)), 'utf8')
          )
          if (category === 'conversations' && Array.isArray(record?.messageFiles)) {
            const messages = []
            for (const file of record.messageFiles) {
              if (
                typeof file !== 'string' ||
                !/^message_[a-f0-9-]{36}_[a-f0-9]{64}\.json$/.test(file)
              )
                fail('RECORD', '消息索引无效')
              const path = await this.safe(
                book,
                join(book.root, '.workspace', 'transcripts', name.slice(0, -5), file)
              )
              const raw = await fs.readFile(path, 'utf8')
              if (!file.endsWith(`_${hash(raw)}.json`)) fail('RECORD', '消息校验失败')
              messages.push(JSON.parse(raw))
            }
            record.messages = messages
            delete record.messageFiles
          }
          result.push(record)
        } catch (error) {
          if (!damaged) throw error
          damaged(name)
        }
      }
      return result
    })
  }
  appendAgentDiagnostic(bookId: string, conversationId: string, value: unknown): Promise<void> {
    return this.queue(bookId, async () => {
      if (!validId(conversationId) || !conversationId.startsWith('conversation_'))
        fail('ID', '会话标识无效')
      const book = this.book(bookId)
      const folder = await this.safe(book, join(book.root, '.workspace', 'diagnostics'))
      await fs.mkdir(folder, { recursive: true })
      const path = await this.safe(book, join(folder, `${conversationId}.jsonl`))
      // Bound each diagnostic file; the previous segment remains inspectable.
      if ((await exists(path)) && (await fs.stat(path)).size > 2000000)
        await fs.rename(path, await this.safe(book, `${path}.previous`))
      await fs.appendFile(path, JSON.stringify(value) + '\n', 'utf8')
    })
  }
  writeAgentRecord(
    bookId: string,
    category: 'conversations' | 'proposals' | 'indexes',
    id: string,
    value: unknown
  ): Promise<void> {
    let text = json(value)
    return this.queue(bookId, async () => {
      if (
        !validId(id) ||
        !id.startsWith(
          category === 'conversations'
            ? 'conversation_'
            : category === 'proposals'
              ? 'proposal_'
              : 'index_'
        )
      )
        fail('ID', '内部记录标识无效')
      const book = this.book(bookId)
      const folder = await this.safe(book, join(book.root, '.workspace', category))
      await fs.mkdir(folder, { recursive: true })
      if (category === 'conversations') {
        const record = JSON.parse(text)
        if (Array.isArray(record.messages)) {
          const transcript = await this.safe(book, join(book.root, '.workspace', 'transcripts', id))
          await fs.mkdir(transcript, { recursive: true })
          const messageFiles: string[] = []
          for (const message of record.messages) {
            if (!message || !/^message_[a-f0-9-]{36}$/.test(message.id))
              fail('RECORD', '消息标识无效')
            const raw = json(message),
              file = `${message.id}_${hash(raw)}.json`
            const path = await this.safe(book, join(transcript, file))
            if (!(await exists(path))) await this.writer(path, raw)
            messageFiles.push(file)
          }
          // Publish the manifest last. Interrupted writes leave harmless unreferenced messages.
          text = json({ ...record, messages: [], messageFiles })
        }
      }
      await this.writer(await this.safe(book, join(folder, `${id}.json`)), text)
    })
  }
  private async assertNoDraft(book: Book, doc: DocumentSnapshot): Promise<void> {
    const path = await this.safe(book, join(book.root, '.workspace', 'recovery', `${doc.id}.json`))
    if (await exists(path)) {
      const draft: Draft = JSON.parse(await fs.readFile(path, 'utf8'))
      if (draft && (draft.content !== doc.content || draft.title !== doc.title))
        fail('DIRTY', '目标有未保存的编辑草稿，请先处理后再审阅')
    }
  }
  applyAgent(
    input: {
      bookId: string
      id: string
      kind: DocumentKind
      title: string
      content: string
      expectedVersion: string | null
      operationId: string
      sources: SourceRef[]
      bindingDependencies?: BindingDependency[]
    },
    guard: () => void
  ): Promise<DocumentSnapshot> {
    return this.queue(input.bookId, async () => {
      const book = this.book(input.bookId)
      await this.assertBindingDependencies(book, input.bindingDependencies ?? [])
      for (const source of input.sources) {
        const current = await this.snapshot(book, source.id)
        if (current.trashedAt || current.version !== source.version)
          fail('SOURCE_CONFLICT', '来源已变化，请重新读取并生成提案')
      }
      if (input.expectedVersion === null) {
        guard()
        return this.createAt(book, input.kind, input.title, {
          content: input.content,
          id: input.id,
          operationId: input.operationId
        })
      }
      const before = await this.snapshot(book, input.id)
      if (before.trashedAt) fail('TRASHED', '目标已回收，提案不能应用')
      if (before.version !== input.expectedVersion)
        fail('CONFLICT', '目标版本已变化，请重新生成提案')
      await this.assertNoDraft(book, before)
      guard()
      const { content: _content, version: _version, ...meta } = before
      return this.commit(book, before, input.content, {
        ...meta,
        title: titleOf(input.title),
        generation: input.operationId,
        updatedAt: new Date().toISOString()
      })
    })
  }
  undoAgent(
    bookId: string,
    id: string,
    appliedVersion: string,
    before: DocumentSnapshot | null,
    operationId: string,
    guard: () => void
  ): Promise<DocumentSnapshot> {
    return this.queue(bookId, async () => {
      const book = this.book(bookId)
      const current = await this.snapshot(book, id)
      if (current.readonlyExample) fail('READ_ONLY', '示例资料不可撤销修改')
      if (current.generation === operationId) {
        if (
          current.content !== (before?.content ?? current.content) ||
          current.title !== (before?.title ?? current.title)
        )
          fail('CONFLICT', '撤销候选已被外部修改')
        if (!before && !current.trashedAt) {
          const { folder } = await this.locate(book, id)
          const target = await this.safe(
            book,
            join(book.root, '.workspace', 'trash', current.kind, id)
          )
          if (await exists(target)) fail('EXISTS', '回收站目标已存在')
          await fs.rename(folder, target)
        }
        return this.snapshot(book, id)
      }
      if (current.trashedAt || current.version !== appliedVersion)
        fail('CONFLICT', '应用后文档又有变化，不能覆盖撤销')
      await this.assertNoDraft(book, current)
      guard()
      const { content: _content, version: _version, ...meta } = current
      const time = new Date().toISOString()
      await this.commit(
        book,
        current,
        before?.content ?? current.content,
        {
          ...meta,
          title: before?.title ?? current.title,
          generation: operationId,
          updatedAt: time,
          trashedAt: before ? null : time
        },
        before?.content
      )
      if (!before) {
        const { folder } = await this.locate(book, id)
        const target = await this.safe(
          book,
          join(book.root, '.workspace', 'trash', current.kind, id)
        )
        if (await exists(target)) fail('EXISTS', '回收站目标已存在')
        await fs.rename(folder, target)
      }
      return this.snapshot(book, id)
    })
  }
  async backup(bookId: string, destination: string): Promise<void> {
    await this.queue(bookId, async () => {
      const book = this.book(bookId)
      const rel = relative(book.root, resolve(destination))
      if (!rel || (!rel.startsWith('..') && !isAbsolute(rel)))
        fail('PATH', '备份目录必须位于作品之外')
      await this.listInternal(book)
      if (await exists(destination)) fail('EXISTS', '备份目标已存在，请选择新目录')
      const verify = async (path: string): Promise<void> => {
        await this.safe(book, path)
        for (const entry of await fs.readdir(path, { withFileTypes: true })) {
          const child = await this.safe(book, join(path, entry.name))
          if (entry.isDirectory()) await verify(child)
        }
      }
      await verify(book.root)
      await fs.mkdir(dirname(destination), { recursive: true })
      await fs.cp(book.root, destination, { recursive: true, errorOnExist: true, force: false })
      const compare = async (source: string, target: string): Promise<void> => {
        for (const entry of await fs.readdir(source, { withFileTypes: true })) {
          if (entry.isDirectory()) await compare(join(source, entry.name), join(target, entry.name))
          else if (
            !(await fs.readFile(join(source, entry.name))).equals(
              await fs.readFile(join(target, entry.name))
            )
          )
            fail('BACKUP', '备份校验失败，请保留原作品')
        }
      }
      await compare(book.root, destination)
    })
  }
}
