import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWrite, countWords, DocumentStore } from '../src/main/documents'
import { defaultNamingRule } from '../src/shared/chapterNaming'

async function fixture(store = new DocumentStore()) {
  const root = resolve('.test-artifacts')
  await fs.mkdir(root, { recursive: true })
  const parent = await fs.mkdtemp(join(root, 'workspace-'))
  const book = await store.createBook(parent, '功能测试')
  return { store, book }
}
async function ids(store: DocumentStore, book: string, kind = 'chapters') {
  return (await store.orderedList(book))
    .filter((doc) => doc.kind === kind && !doc.trashedAt)
    .sort((a, b) => a.order - b.order)
    .map((doc) => doc.id)
}

test('batch insertion preserves stable IDs, content and actual saved order', async () => {
  const { store, book } = await fixture()
  const a = (await store.create(book.id, 'chapters', '第一章')).document
  const b = (await store.create(book.id, 'chapters', '第三章')).document
  const created = await store.createBatch({
    bookId: book.id,
    kind: 'chapters',
    items: [{ title: '第二章', content: '\r\n\t原文　🙂\r\n' }, { title: '插曲' }],
    placement: { position: 'before', anchorId: b.id },
    expectedOrder: [a.id, b.id]
  })
  assert.equal(created[0].document.content, '\r\n\t原文　🙂\r\n')
  assert.equal(created[0].draft, null)
  assert.equal(new Set(created.map((doc) => doc.document.id)).size, 2)
  const expected = [a.id, ...created.map((doc) => doc.document.id), b.id]
  assert.deepEqual(await ids(store, book.id), expected)
  const reopened = new DocumentStore()
  await reopened.openBook(book.root)
  assert.deepEqual(await ids(reopened, book.id), expected)
  assert.equal((await reopened.read(book.id, a.id)).document.version, a.version)
})

test('invalid batch title, obsolete order and missing anchor create nothing', async () => {
  const { store, book } = await fixture()
  const a = (await store.create(book.id, 'chapters', '原章')).document
  await assert.rejects(
    store.createBatch({
      bookId: book.id,
      kind: 'chapters',
      items: [{ title: '有效' }, { title: '坏\n标题' }],
      placement: { position: 'end' }
    }),
    { code: 'TITLE' }
  )
  await assert.rejects(
    store.createBatch({
      bookId: book.id,
      kind: 'chapters',
      items: [{ title: '新章' }],
      placement: { position: 'start' },
      expectedOrder: []
    }),
    { code: 'CONFLICT' }
  )
  await assert.rejects(
    store.createBatch({
      bookId: book.id,
      kind: 'chapters',
      items: [{ title: '新章' }],
      placement: { position: 'after', anchorId: `doc_${randomUUID()}` }
    }),
    { code: 'CONFLICT' }
  )
  assert.deepEqual(await ids(store, book.id), [a.id])
})

test('batch creation interrupted halfway recovers all items and insertion after restart', async () => {
  let armed = false,
    writes = 0
  const store = new DocumentStore(async (path, value) => {
    if (armed && path.endsWith('content.txt') && ++writes === 2) {
      armed = false
      throw new Error('模拟第二章写入中断')
    }
    await atomicWrite(path, value)
  })
  const { book } = await fixture(store)
  const before = (await store.create(book.id, 'chapters', '原章')).document
  armed = true
  await assert.rejects(
    store.createBatch({
      bookId: book.id,
      kind: 'chapters',
      items: [
        { title: '甲', content: '内容甲' },
        { title: '乙', content: '内容乙' }
      ],
      placement: { position: 'start' },
      expectedOrder: [before.id]
    }),
    /模拟第二章写入中断/
  )
  const reopened = new DocumentStore()
  await reopened.openBook(book.root)
  const list = (await reopened.orderedList(book.id)).sort((a, b) => a.order - b.order)
  assert.deepEqual(
    list.map((doc) => doc.title),
    ['甲', '乙', '原章']
  )
  assert.equal((await reopened.read(book.id, list[1].id)).document.content, '内容乙')
  await assert.rejects(fs.access(join(book.root, '.workspace', 'batch-pending.json')))
})

test('external edits during interrupted batch block replay without overwriting the changed file', async () => {
  let armed = false,
    writes = 0
  const store = new DocumentStore(async (path, value) => {
    if (armed && path.endsWith('content.txt') && ++writes === 2) throw new Error('中断')
    await atomicWrite(path, value)
  })
  const { book } = await fixture(store)
  armed = true
  await assert.rejects(
    store.createBatch({
      bookId: book.id,
      kind: 'chapters',
      items: [{ title: '甲', content: '原文' }, { title: '乙' }],
      placement: { position: 'end' }
    })
  )
  const manifest = JSON.parse(
    await fs.readFile(join(book.root, '.workspace', 'batch-pending.json'), 'utf8')
  )
  const first = manifest.documents[0].meta.id
  const path = join(book.root, 'chapters', first, 'content.txt')
  await fs.writeFile(path, '外部新正文', 'utf8')
  const reopened = new DocumentStore()
  await reopened.openBook(book.root)
  await assert.rejects(reopened.orderedList(book.id), { code: 'RECOVERY_CONFLICT' })
  assert.equal(await fs.readFile(path, 'utf8'), '外部新正文')
  await assert.rejects(fs.access(join(book.root, 'chapters', manifest.documents[1].meta.id)))
})

test('ordering detects a stale preview and undo is persistent and conditional', async () => {
  const { store, book } = await fixture()
  const a = (await store.create(book.id, 'chapters', 'A')).document
  const b = (await store.create(book.id, 'chapters', 'B')).document
  await store.reorder(book.id, 'chapters', [b.id, a.id], [a.id, b.id])
  await assert.rejects(store.reorder(book.id, 'chapters', [a.id, b.id], [a.id, b.id]), {
    code: 'CONFLICT'
  })
  const reopened = new DocumentStore()
  await reopened.openBook(book.root)
  await reopened.undoOrder(book.id, 'chapters')
  assert.deepEqual(await ids(reopened, book.id), [a.id, b.id])
  assert.equal((await reopened.read(book.id, a.id)).document.version, a.version)
  await assert.rejects(reopened.undoOrder(book.id, 'chapters'), { code: 'UNDO' })
  await reopened.reorder(book.id, 'chapters', [b.id, a.id], [a.id, b.id])
  await reopened.create(book.id, 'chapters', 'C')
  await assert.rejects(reopened.undoOrder(book.id, 'chapters'), { code: 'CONFLICT' })
})

test('batch rename prevalidates every version and draft before changing any title', async () => {
  const { store, book } = await fixture()
  const a = (await store.create(book.id, 'chapters', 'A', { content: '甲原文' })).document
  const b = (await store.create(book.id, 'chapters', 'B', { content: '乙原文' })).document
  await assert.rejects(
    store.renameBatch({
      bookId: book.id,
      changes: [
        { id: a.id, title: '第1章', version: a.version },
        { id: b.id, title: '第2章', version: 'stale' }
      ]
    }),
    { code: 'CONFLICT' }
  )
  assert.equal((await store.read(book.id, a.id)).document.title, 'A')
  await store.writeDraft(book.id, b.id, {
    title: 'B',
    content: '未保存输入',
    baseVersion: b.version,
    savedAt: ''
  })
  await assert.rejects(
    store.renameBatch({
      bookId: book.id,
      changes: [
        { id: a.id, title: '第1章', version: a.version },
        { id: b.id, title: '第2章', version: b.version }
      ]
    }),
    { code: 'DIRTY' }
  )
  assert.equal((await store.read(book.id, a.id)).document.title, 'A')
  await store.writeDraft(book.id, b.id, null)
  const renamed = await store.renameBatch({
    bookId: book.id,
    changes: [
      { id: a.id, title: '第1章', version: a.version },
      { id: b.id, title: '第2章', version: b.version }
    ]
  })
  assert.deepEqual(
    renamed.map((doc) => [doc.id, doc.title, doc.content]),
    [
      [a.id, '第1章', '甲原文'],
      [b.id, '第2章', '乙原文']
    ]
  )
})

test('batch rename recovers a half-finished operation without changing stable identities', async () => {
  let armed = false,
    writes = 0
  const store = new DocumentStore(async (path, value) => {
    if (armed && path.endsWith('meta.json') && ++writes === 2) {
      armed = false
      throw new Error('批量改名中断')
    }
    await atomicWrite(path, value)
  })
  const { book } = await fixture(store)
  const a = (await store.create(book.id, 'chapters', 'A')).document
  const b = (await store.create(book.id, 'chapters', 'B')).document
  armed = true
  await assert.rejects(
    store.renameBatch({
      bookId: book.id,
      changes: [
        { id: a.id, title: '第1章', version: a.version },
        { id: b.id, title: '第2章', version: b.version }
      ]
    }),
    /批量改名中断/
  )
  const reopened = new DocumentStore()
  await reopened.openBook(book.root)
  assert.equal((await reopened.read(book.id, a.id)).document.title, '第1章')
  assert.equal((await reopened.read(book.id, b.id)).document.title, '第2章')
  assert.equal((await reopened.read(book.id, b.id)).document.content, '')
  await assert.rejects(fs.access(join(book.root, '.workspace', 'batch-pending.json')))
})

test('manual and Agent commits retain historical source and restoring protects newer edits and drafts', async () => {
  const { store, book } = await fixture()
  const initial = (await store.create(book.id, 'chapters', '原标题', { content: '初稿\r\n' }))
    .document
  const saved = await store.save({
    bookId: book.id,
    id: initial.id,
    title: '修订',
    content: '第二稿',
    expectedVersion: initial.version
  })
  const agent = await store.applyAgent(
    {
      bookId: book.id,
      id: initial.id,
      kind: 'chapters',
      title: 'AI 修订',
      content: '第三稿',
      expectedVersion: saved.version,
      operationId: '测试操作',
      sources: []
    },
    () => {}
  )
  const reopened = new DocumentStore()
  await reopened.openBook(book.root)
  const history = await reopened.history(book.id, initial.id)
  assert.equal(history.length, 3)
  assert.ok(history.every((entry) => entry.content === undefined))
  const entry = history.find((entry) => entry.version === initial.version)!
  assert.equal((await reopened.historyRead(book.id, initial.id, entry.entryId)).content, '初稿\r\n')
  await assert.rejects(reopened.restoreHistory(book.id, initial.id, entry.entryId, saved.version), {
    code: 'CONFLICT'
  })
  await reopened.writeDraft(book.id, initial.id, {
    content: '未保存第四稿',
    title: agent.title,
    baseVersion: agent.version,
    savedAt: ''
  })
  await assert.rejects(reopened.restoreHistory(book.id, initial.id, entry.entryId, agent.version), {
    code: 'DIRTY'
  })
  assert.equal((await reopened.read(book.id, initial.id)).draft?.content, '未保存第四稿')
  await reopened.writeDraft(book.id, initial.id, null)
  const restored = await reopened.restoreHistory(book.id, initial.id, entry.entryId, agent.version)
  assert.equal(restored.content, '初稿\r\n')
  assert.equal(restored.title, '原标题')
  assert.equal(restored.id, initial.id)
  assert.notEqual(restored.version, initial.version)
  assert.equal((await reopened.history(book.id, initial.id)).length, 4)
  await assert.rejects(reopened.historyRead(book.id, initial.id, '../preferences'), { code: 'ID' })
})

test('preferences are book-scoped and persisted, stats and whole-book search exclude trash', async () => {
  const { store, book } = await fixture()
  const one = (
    await store.create(book.id, 'chapters', '月色', { content: ' 第一行\r\n月光🙂\r\nMoon light' })
  ).document
  const two = (await store.create(book.id, 'chapters', '回收', { content: '月亮' })).document
  const note = (await store.create(book.id, 'notes', '月光笔记', { content: '独立笔记' })).document
  await store.trash(book.id, two.id, two.version)
  assert.equal(countWords(' 月 光\n🙂 ABC '), 6)
  const stats = await store.stats(book.id)
  assert.equal(stats.totalWords, countWords(one.content))
  assert.equal(stats.words[note.id], 4)
  assert.ok(!(two.id in stats.words))
  assert.deepEqual(
    (await store.search(book.id, '月')).map((hit) => [hit.id, hit.line]),
    [
      [one.id, 2],
      [note.id, 1]
    ]
  )
  assert.equal((await store.search(book.id, 'moon'))[0].line, 3)
  const prefs = {
    naming: { ...defaultNamingRule, mode: 'hanzi' as const, start: 9 },
    targetWords: 50000
  }
  await store.setPreferences(book.id, prefs)
  const reopened = new DocumentStore()
  await reopened.openBook(book.root)
  assert.deepEqual(await reopened.getPreferences(book.id), prefs)
  await assert.rejects(reopened.setPreferences(book.id, { ...prefs, targetWords: -1 }), {
    code: 'PREFERENCES'
  })
  await assert.rejects(reopened.search(book.id, ''), { code: 'SEARCH' })
})

test('history stays bounded, retains the latest save, and rejects damaged historical source', async () => {
  const { store, book } = await fixture()
  let current = (await store.create(book.id, 'notes', '记录')).document
  for (let i = 0; i < 102; i++)
    current = await store.save({
      bookId: book.id,
      id: current.id,
      title: current.title,
      content: `版本 ${i}`,
      expectedVersion: current.version
    })
  const history = await store.history(book.id, current.id)
  assert.equal(history.length, 100)
  const entry = history.find((entry) => entry.version === current.version)!
  assert.ok(entry)
  const path = join(book.root, '.workspace', 'history', current.id, `${entry.entryId}.json`)
  const damaged = JSON.parse(await fs.readFile(path, 'utf8'))
  damaged.content = '被外部篡改的历史正文'
  await fs.writeFile(path, JSON.stringify(damaged), 'utf8')
  await assert.rejects(store.historyRead(book.id, current.id, entry.entryId), { code: 'FORMAT' })
  assert.equal((await store.read(book.id, current.id)).document.content, '版本 101')
})

test('append and insert are supported for every document kind without prior order files', async () => {
  const { store, book } = await fixture()
  for (const kind of ['notes', 'characters', 'settings', 'outlines'] as const) {
    const first = await store.createBatch({
      bookId: book.id,
      kind,
      items: [{ title: '原文', content: '源内容' }],
      placement: { position: 'end' },
      expectedOrder: []
    })
    const second = await store.createBatch({
      bookId: book.id,
      kind,
      items: [{ title: '前置' }],
      placement: { position: 'before', anchorId: first[0].document.id },
      expectedOrder: [first[0].document.id]
    })
    assert.deepEqual(await ids(store, book.id, kind), [second[0].document.id, first[0].document.id])
    assert.equal((await store.read(book.id, first[0].document.id)).document.content, '源内容')
  }
})

test('creation tokens make retries idempotent and reject reuse with a different plan', async () => {
  const { store, book } = await fixture()
  const operationId = randomUUID()
  const plan = {
    bookId: book.id,
    kind: 'chapters' as const,
    operationId,
    items: [{ title: ' 第一章 ', content: '首稿' }],
    placement: { position: 'end' as const },
    expectedOrder: []
  }
  const first = await store.createBatch(plan)
  const document = first[0].document
  const saved = await store.save({
    bookId: book.id,
    id: document.id,
    title: '人工改名',
    content: '人工新稿',
    expectedVersion: document.version
  })
  const retry = await store.createBatch({ ...plan, expectedOrder: [document.id] })
  assert.equal(retry[0].document.id, document.id)
  assert.equal(retry[0].document.version, saved.version)
  assert.equal(retry[0].document.content, '人工新稿')
  assert.deepEqual(await ids(store, book.id), [document.id])
  await assert.rejects(
    store.createBatch({ ...plan, items: [{ title: '第二章', content: '首稿' }] }),
    { code: 'OPERATION_CONFLICT' }
  )
  await assert.rejects(store.createBatch({ ...plan, operationId: '../../book.json' }), {
    code: 'ID'
  })
  const removed = await store.trash(book.id, document.id, saved.version)
  const trashedRetry = await store.createBatch(plan)
  assert.equal(trashedRetry[0].document.trashedAt, removed.trashedAt)
  assert.deepEqual(await ids(store, book.id), [])
})

test('interrupted tokenized creation records completion before clearing the journal and cannot duplicate on retry', async () => {
  const operationId = randomUUID()
  let armed = false
  const store = new DocumentStore(async (path, value) => {
    if (armed && path.endsWith(`${operationId}.json`)) {
      armed = false
      throw new Error('完成记录写入中断')
    }
    await atomicWrite(path, value)
  })
  const { book } = await fixture(store)
  const plan = {
    bookId: book.id,
    kind: 'chapters' as const,
    operationId,
    items: [
      { title: '甲', content: '内容甲' },
      { title: '乙', content: '内容乙' }
    ],
    placement: { position: 'start' as const },
    expectedOrder: []
  }
  armed = true
  await assert.rejects(store.createBatch(plan), /完成记录写入中断/)
  const journal = JSON.parse(
    await fs.readFile(join(book.root, '.workspace', 'batch-pending.json'), 'utf8')
  )
  const originalIds = journal.documents.map((doc: { meta: { id: string } }) => doc.meta.id)
  const reopened = new DocumentStore()
  await reopened.openBook(book.root)
  const retry = await reopened.createBatch(plan)
  assert.deepEqual(
    retry.map((doc) => doc.document.id),
    originalIds
  )
  assert.deepEqual(await ids(reopened, book.id), originalIds)
  const marker = JSON.parse(
    await fs.readFile(join(book.root, '.workspace', 'operations', `${operationId}.json`), 'utf8')
  )
  assert.equal(marker.bookId, book.id)
  assert.equal(marker.operationId, operationId)
  assert.deepEqual(marker.ids, originalIds)
  await assert.rejects(fs.access(join(book.root, '.workspace', 'batch-pending.json')))
})

test('creation token records are isolated by book and damaged markers cannot create another copy', async () => {
  const { store, book } = await fixture()
  const second = await store.createBook(book.root, '独立作品')
  const operationId = randomUUID()
  const plan = {
    kind: 'notes' as const,
    operationId,
    items: [{ title: '记录' }],
    placement: { position: 'end' as const }
  }
  const first = await store.createBatch({ ...plan, bookId: book.id })
  const other = await store.createBatch({ ...plan, bookId: second.id })
  assert.notEqual(first[0].document.id, other[0].document.id)
  const path = join(book.root, '.workspace', 'operations', `${operationId}.json`)
  const marker = JSON.parse(await fs.readFile(path, 'utf8'))
  marker.bookId = second.id
  await fs.writeFile(path, JSON.stringify(marker), 'utf8')
  await assert.rejects(store.createBatch({ ...plan, bookId: book.id }), { code: 'FORMAT' })
  assert.deepEqual(await ids(store, book.id, 'notes'), [first[0].document.id])
})
