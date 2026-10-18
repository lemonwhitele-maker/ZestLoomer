import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DocumentStore, atomicWrite } from '../src/main/documents'
import { kinds } from '../src/shared/documents'

async function fixture(store = new DocumentStore()) {
  const root = resolve('.test-artifacts')
  await fs.mkdir(root, { recursive: true })
  const parent = await fs.mkdtemp(join(root, 'storage-'))
  const book = await store.createBook(parent, '合成测试作品')
  return { store, book, parent }
}
test('book rename persists without moving documents and rejects invalid titles or failed writes', async () => {
  let failWrite = false
  const { store, book } = await fixture(
    new DocumentStore(async (path, text) => {
      if (failWrite && path.endsWith('book.json')) throw new Error('write failed')
      await atomicWrite(path, text)
    })
  )
  const doc = (await store.create(book.id, 'chapters', '第一章')).document
  const renamed = await store.renameBook(book.id, '  新作品名称  ')
  assert.deepEqual(renamed, { ...book, title: '新作品名称' })
  const reopened = new DocumentStore()
  assert.deepEqual(await reopened.openBook(book.root), renamed)
  assert.equal((await reopened.read(book.id, doc.id)).document.version, doc.version)
  await assert.rejects(store.renameBook(book.id, '  '), { code: 'TITLE' })
  failWrite = true
  await assert.rejects(store.renameBook(book.id, '不能保存'), /write failed/)
  assert.equal(store.books.get(book.id)?.title, renamed.title)
  assert.equal(
    JSON.parse(await fs.readFile(join(book.root, 'book.json'), 'utf8')).title,
    renamed.title
  )
})

test('five kinds preserve arbitrary source, stable identity, recovery and read-only trash', async () => {
  const { store, book } = await fixture()
  for (const kind of kinds.filter((kind) => kind !== 'foreshadows')) {
    const first = (await store.create(book.id, kind, `自由${kind}`)).document
    const content = '\t　 中文 <tag> & **源码**\r\n\r\n# 标题\r\n尾行  \r\n'
    const saved = await store.save({
      bookId: book.id,
      id: first.id,
      content,
      title: '新标题',
      expectedVersion: first.version
    })
    assert.equal(saved.content, content)
    assert.equal(saved.id, first.id)
    await store.writeDraft(book.id, first.id, {
      content: content + '草稿',
      title: saved.title,
      baseVersion: saved.version,
      savedAt: new Date().toISOString()
    })
    const reopened = new DocumentStore()
    await reopened.openBook(book.root)
    assert.equal((await reopened.read(book.id, first.id)).draft?.content, content + '草稿')
    const trashed = await store.trash(book.id, first.id, saved.version)
    assert.ok(trashed.trashedAt)
    await assert.rejects(
      store.save({
        bookId: book.id,
        id: first.id,
        content: '不该覆盖',
        title: '标题',
        expectedVersion: saved.version
      }),
      { code: 'TRASHED' }
    )
    await assert.rejects(
      store.writeDraft(book.id, first.id, {
        content: '旧保存',
        title: '标题',
        baseVersion: saved.version,
        savedAt: ''
      }),
      { code: 'TRASHED' }
    )
    assert.ok(!(await store.agentDocuments(book.id)).some((doc) => doc.id === first.id))
    await assert.rejects(store.agentRead(book.id, first.id), { code: 'TRASHED' })
    assert.equal((await store.agentRead(book.id, first.id, true)).content, content)
    const restored = await store.restore(book.id, first.id, trashed.version)
    assert.equal(restored.id, first.id)
    assert.equal(restored.trashedAt, null)
    assert.notEqual(restored.version, saved.version)
    await assert.rejects(
      store.save({
        bookId: book.id,
        id: first.id,
        content: '过期提案',
        title: '标题',
        expectedVersion: saved.version
      }),
      { code: 'CONFLICT' }
    )
  }
})
test('queued save cannot resurrect a trashed document', async () => {
  const { store, book } = await fixture()
  const doc = (await store.create(book.id, 'characters', '人物')).document
  const outcomes = await Promise.allSettled([
    store.trash(book.id, doc.id, doc.version),
    store.save({
      bookId: book.id,
      id: doc.id,
      content: '迟到写入',
      title: doc.title,
      expectedVersion: doc.version
    })
  ])
  assert.equal(outcomes[0].status, 'fulfilled')
  assert.equal(outcomes[1].status, 'rejected')
  assert.ok((await store.read(book.id, doc.id)).document.trashedAt)
  await assert.rejects(fs.access(join(book.root, 'characters', doc.id)))
})
test('external edits cause conflict and remain intact', async () => {
  const { store, book } = await fixture()
  const doc = (await store.create(book.id, 'chapters', '章')).document
  await fs.writeFile(join(book.root, 'chapters', doc.id, 'content.txt'), '外部修改', 'utf8')
  await assert.rejects(
    store.save({
      bookId: book.id,
      id: doc.id,
      title: doc.title,
      content: '本地输入',
      expectedVersion: doc.version
    }),
    { code: 'CONFLICT' }
  )
  assert.equal((await store.read(book.id, doc.id)).document.content, '外部修改')
})
test('an interrupted content/meta transaction recovers after reopening', async () => {
  let armed = false
  const store = new DocumentStore(async (path, value) => {
    if (armed && path.endsWith('meta.json')) {
      armed = false
      throw new Error('模拟磁盘失败')
    }
    await atomicWrite(path, value)
  })
  const { book } = await fixture(store)
  const doc = (await store.create(book.id, 'settings', '设定')).document
  armed = true
  await assert.rejects(
    store.save({
      bookId: book.id,
      id: doc.id,
      title: '新设定',
      content: '完整内容',
      expectedVersion: doc.version
    }),
    /模拟磁盘失败/
  )
  const next = new DocumentStore()
  await next.openBook(book.root)
  const recovered = (await next.read(book.id, doc.id)).document
  assert.equal(recovered.content, '完整内容')
  assert.equal(recovered.title, '新设定')
  await assert.rejects(fs.access(join(book.root, 'settings', doc.id, 'pending.json')))
})
test('failed write before journaling leaves old content intact', async () => {
  let armed = false
  const store = new DocumentStore(async (path, value) => {
    if (armed && path.endsWith('pending.json')) throw new Error('模拟只读磁盘')
    await atomicWrite(path, value)
  })
  const { book } = await fixture(store)
  const doc = (await store.create(book.id, 'notes', '速记')).document
  armed = true
  await assert.rejects(
    store.save({
      bookId: book.id,
      id: doc.id,
      content: '未提交',
      title: doc.title,
      expectedVersion: doc.version
    })
  )
  assert.equal((await store.read(book.id, doc.id)).document.content, '')
})
test('order persists atomically, restoration is deterministic, backup verifies all bytes', async () => {
  const { store, book, parent } = await fixture()
  const a = (await store.create(book.id, 'outlines', '甲')).document
  const b = (await store.create(book.id, 'outlines', '乙')).document
  await store.reorder(book.id, 'outlines', [b.id, a.id])
  const removed = await store.trash(book.id, a.id, a.version)
  const reopened = new DocumentStore()
  await reopened.openBook(book.root)
  assert.deepEqual(
    (await reopened.orderedList(book.id)).sort((a, b) => a.order - b.order).map((doc) => doc.id),
    [b.id, a.id]
  )
  await store.restore(book.id, a.id, removed.version)
  const target = join(parent, 'verified-backup')
  await store.backup(book.id, target)
  const backupStore = new DocumentStore()
  const backup = await backupStore.openBook(target)
  assert.equal(backup.id, book.id)
  assert.equal((await backupStore.read(book.id, a.id)).document.title, '甲')
  await assert.rejects(store.backup(book.id, join(book.root, 'recursive-backup')), { code: 'PATH' })
})
test('identities and registered books bound all document operations', async () => {
  const { store, book } = await fixture()
  await assert.rejects(store.read(book.id, '../book.json'), { code: 'ID' })
  await assert.rejects(store.read('unknown', 'doc_00000000-0000-0000-0000-000000000000'), {
    code: 'BOOK'
  })
  await assert.rejects(store.create(book.id, 'notes', '   '), { code: 'TITLE' })
  const other = await store.createBook(book.root, '另一本')
  const doc = (await store.create(book.id, 'notes', '不可串书')).document
  await assert.rejects(store.read(other.id, doc.id), { code: 'NOT_FOUND' })
})
