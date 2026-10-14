import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DocumentStore } from '../src/main/documents'
import { counters } from '../src/shared/perf'
import { SessionWordCounts } from '../src/renderer/src/wordCounts'
import { DocumentSession } from '../src/renderer/src/session'
import { AgentService } from '../src/main/agent/service'
import { generateFixtures } from '../scripts/perf/generate-fixtures'

async function fixture() {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const parent = await fs.mkdtemp(resolve('.test-artifacts/optimization-fix-'))
  const store = new DocumentStore()
  const book = await store.createBook(parent, '优化回归')
  return { store, book }
}

test('catalog revalidates external edits, additions, deletion and reads only changed text', async () => {
  const { store, book } = await fixture()
  const docs = await store.createBatch({
    bookId: book.id,
    kind: 'chapters',
    placement: { position: 'end' },
    items: Array.from({ length: 5 }, (_, i) => ({ title: `章节${i}`, content: 'old' }))
  })
  await store.stats(book.id)
  const enabled = counters.enabled
  counters.enabled = true
  try {
    counters.reset()
    await store.list(book.id)
    await store.stats(book.id)
    assert.equal(counters.documentReads, 0)
    const doc = docs[0].document
    const file = join(book.root, 'chapters', doc.id, 'content.txt')
    await fs.writeFile(file, '外部修改后的正文')
    assert.equal((await store.stats(book.id)).words[doc.id], 8)
    assert.equal(counters.documentReads, 1)
    // A normal authoritative read also corrects the cached value.
    await fs.writeFile(file, '新的磁盘内容')
    assert.equal((await store.read(book.id, doc.id)).document.content, '新的磁盘内容')
    assert.equal((await store.stats(book.id)).words[doc.id], 6)
    const id = `doc_${randomUUID()}`
    const folder = join(book.root, 'chapters', id)
    await fs.mkdir(folder)
    const { content: _content, version: _version, ...meta } = doc
    await fs.writeFile(
      join(folder, 'meta.json'),
      JSON.stringify({ ...meta, id, title: '外部新增' })
    )
    await fs.writeFile(join(folder, 'content.txt'), '新增')
    assert.ok((await store.list(book.id)).some((item) => item.id === id))
    // Move within the isolated fixture, avoiding destructive cleanup.
    await fs.rename(folder, join(book.root, 'removed-fixture'))
    assert.ok(!(await store.list(book.id)).some((item) => item.id === id))
    const saved = await store.read(book.id, docs[1].document.id)
    await store.save({
      bookId: book.id,
      id: saved.document.id,
      expectedVersion: saved.document.version,
      title: saved.document.title,
      content: '保存新正文'
    })
    counters.reset()
    await store.stats(book.id)
    assert.ok(counters.documentReads <= 1, 'saving one document must not reread unrelated chapters')
  } finally {
    counters.enabled = enabled
  }
})

test('cancelling during the first search read stops subsequent reads and permits a queued save', async () => {
  const { store, book } = await fixture()
  const docs = await store.createBatch({
    bookId: book.id,
    kind: 'chapters',
    placement: { position: 'end' },
    items: Array.from({ length: 20 }, (_, i) => ({ title: `章${i}`, content: 'search text' }))
  })
  const controller = new AbortController()
  let reads = 0
  let saving: ReturnType<DocumentStore['save']> | undefined
  const originalCounter = counters.countDocumentRead
  counters.countDocumentRead = () => {
    reads++
    if (reads === 1) {
      controller.abort()
      const doc = docs[0].document
      saving = store.save({
        bookId: book.id,
        id: doc.id,
        title: doc.title,
        content: 'saved',
        expectedVersion: doc.version
      })
    }
  }
  try {
    assert.deepEqual(await store.search(book.id, 'text', controller.signal), [])
    // The queued save itself reads its target; it must complete without the rest of the search.
    assert.equal((await saving)?.content, 'saved')
    assert.ok(reads < 10, `cancelled search continued reading: ${reads}`)
  } finally {
    counters.countDocumentRead = originalCounter
  }
})

test('word counts do not reuse a previous session revision after restoring content', async () => {
  const { store, book } = await fixture()
  const opened = await store.create(book.id, 'chapters', '计数', { content: '旧文' })
  const api = {
    save: async () => ({ ok: true as const, value: opened.document }),
    draft: async () => ({ ok: true as const, value: undefined })
  }
  const old = new DocumentSession(book.id, opened, api)
  const next = new DocumentSession(
    book.id,
    { ...opened, document: { ...opened.document, version: 'restored', content: '恢复后的文字🙂' } },
    api
  )
  const cache = new SessionWordCounts()
  assert.equal(cache.count(old), 2)
  assert.equal(cache.count(next), 7)
  old.useDisk({ ...opened.document, version: 'external', content: '新正文' })
  assert.equal(cache.count(old), 3)
  old.stop()
  next.stop()
})

test('generated M fixture loads real conversations, before snapshots and valid proposals', async () => {
  const root = await generateFixtures('M')
  const store = new DocumentStore()
  const book = await store.openBook(root)
  const service = new AgentService(store, () => {
    throw new Error('fixture validation never calls a model')
  })
  const snapshot = await service.safeSnapshot(book.id)
  assert.deepEqual(snapshot.warnings, [])
  assert.equal(snapshot.conversations.length, 1)
  assert.equal(snapshot.conversations[0].messages.length, 400)
  assert.equal(snapshot.proposals.length, 20)
  assert.ok(
    snapshot.proposals.every(
      (p) => p.before && p.state === 'pending' && p.conversationId === snapshot.conversations[0].id
    )
  )
  const docs = await store.list(book.id)
  assert.equal(docs.filter((d) => d.kind === 'chapters').length, 1000)
  assert.equal(docs.filter((d) => d.kind === 'characters' || d.kind === 'settings').length, 500)
})
