import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DocumentStore, atomicWrite } from '../src/main/documents'
import { matchingChapterNumber } from '../src/shared/chapterOutlineMatching'

async function fixture(writer = atomicWrite) {
  const root = resolve('.test-artifacts')
  await fs.mkdir(root, { recursive: true })
  const parent = await fs.mkdtemp(join(root, 'auto-bind-'))
  const store = new DocumentStore(writer)
  const book = await store.createBook(parent, '章号匹配合成作品')
  return { store, book }
}

test('chapter matching normalizes numeric/Hanzi labels but excludes volumes, ranges and dates', () => {
  for (const title of ['第十二章 铜钥匙', '第012章大纲', '１２. 铜钥匙', '大纲：第12章', '12'])
    assert.equal(matchingChapterNumber(title), 12, title)
  for (const title of [
    '总纲',
    '第12卷大纲',
    '第十二部',
    '第12章至第15章',
    '12-15 大纲',
    '2026-10-18',
    '12.5 提纲',
    '序章',
    '第一卷 第十二章'
  ])
    assert.equal(matchingChapterNumber(title), null, title)
})

test('new documents automatically bind once and subsequent renames preserve stable IDs', async () => {
  const { store, book } = await fixture()
  const chapter = (await store.create(book.id, 'chapters', '第十二章 铜钥匙')).document
  const outline = (await store.create(book.id, 'outlines', '第012章大纲')).document
  assert.deepEqual((await store.chapterOutlineBindings(book.id)).bindings, [
    { chapterId: chapter.id, outlineId: outline.id }
  ])
  const renamed = await store.save({
    bookId: book.id,
    id: chapter.id,
    title: '第13章 新标题',
    content: chapter.content,
    expectedVersion: chapter.version
  })
  assert.equal((await store.chapterOutlineBindings(book.id)).revision, 1)
  assert.deepEqual((await store.chapterOutlineBindings(book.id)).bindings, [
    { chapterId: chapter.id, outlineId: outline.id }
  ])
  await store.setChapterOutlineBinding({
    bookId: book.id,
    chapterId: chapter.id,
    outlineId: null,
    expectedRevision: 1
  })
  await store.save({
    bookId: book.id,
    id: chapter.id,
    title: renamed.title,
    content: '仅更新正文',
    expectedVersion: renamed.version
  })
  assert.equal((await store.chapterOutlineBindings(book.id)).bindings.length, 0)
})

test('saving a new chapter number binds its unique free outline; old unrelated documents require matching button', async () => {
  const { store, book } = await fixture()
  const chapter = (await store.create(book.id, 'chapters', '暂定标题')).document
  const outline = (await store.create(book.id, 'outlines', '第三章大纲')).document
  await store.save({
    bookId: book.id,
    id: chapter.id,
    title: '第003章 风声',
    content: '',
    expectedVersion: chapter.version
  })
  assert.deepEqual((await store.chapterOutlineBindings(book.id)).bindings, [
    { chapterId: chapter.id, outlineId: outline.id }
  ])
  await store.setChapterOutlineBinding({
    bookId: book.id,
    chapterId: chapter.id,
    outlineId: null,
    expectedRevision: 1
  })
  await store.create(book.id, 'chapters', '第4章 不相关')
  assert.equal((await store.chapterOutlineBindings(book.id)).bindings.length, 0)
  const result = await store.matchChapterOutlines(book.id, 2)
  assert.deepEqual(result.added, [{ chapterId: chapter.id, outlineId: outline.id }])
  assert.equal((await store.matchChapterOutlines(book.id, 3)).added.length, 0)
  await assert.rejects(store.matchChapterOutlines(book.id, 2), { code: 'BINDING_CONFLICT' })
})

test('batch matching waits for the final set and skips duplicate numbers and volume outlines', async () => {
  const { store, book } = await fixture()
  await store.create(book.id, 'outlines', '第一章大纲')
  await store.createBatch({
    bookId: book.id,
    kind: 'chapters',
    placement: { position: 'end' },
    items: [{ title: '第一章 甲' }, { title: '第01章 乙' }]
  })
  assert.equal((await store.chapterOutlineBindings(book.id)).bindings.length, 0)
  const result = await store.matchChapterOutlines(book.id, 0)
  assert.deepEqual(result.ambiguousNumbers, [1])
  const chapter = (await store.create(book.id, 'chapters', '第2章 甲')).document
  await store.create(book.id, 'outlines', '第2卷大纲')
  assert.equal((await store.chapterOutlineBindings(book.id)).bindings.length, 0)
  const outline = (await store.create(book.id, 'outlines', '大纲：第02章')).document
  assert.deepEqual((await store.chapterOutlineBindings(book.id)).bindings, [
    { chapterId: chapter.id, outlineId: outline.id }
  ])
})

test('batch rename uses final titles and history restoration does not rebind', async () => {
  const { store, book } = await fixture()
  const first = (await store.create(book.id, 'chapters', '暂定甲')).document
  const second = (await store.create(book.id, 'chapters', '暂定乙')).document
  await store.create(book.id, 'outlines', '第5章大纲')
  const saved = await store.renameBatch({
    bookId: book.id,
    changes: [
      { id: first.id, version: first.version, title: '第五章 甲' },
      { id: second.id, version: second.version, title: '第05章 乙' }
    ]
  })
  assert.equal((await store.chapterOutlineBindings(book.id)).bindings.length, 0)
  await store.restoreHistory(book.id, second.id, `history_${second.version}`, saved[1].version)
  assert.equal((await store.chapterOutlineBindings(book.id)).bindings.length, 0)
})

test('occupied and trashed binding endpoints are never taken over', async () => {
  const { store, book } = await fixture()
  const chapter = (await store.create(book.id, 'chapters', '第1章')).document
  const outline = (await store.create(book.id, 'outlines', '第1章大纲')).document
  await store.trash(book.id, chapter.id, chapter.version)
  await store.create(book.id, 'chapters', '第1章 替代正文')
  const result = await store.matchChapterOutlines(book.id, 1)
  assert.deepEqual(result.occupiedNumbers, [1])
  assert.deepEqual((await store.chapterOutlineBindings(book.id)).bindings, [
    { chapterId: chapter.id, outlineId: outline.id }
  ])
})

test('automatic binding failure preserves document save and exposes a retry notice', async () => {
  let failBinding = false
  const { store, book } = await fixture(async (path, text) => {
    if (failBinding && path.endsWith('chapter-outline-bindings.json'))
      throw new Error('模拟磁盘写入失败')
    await atomicWrite(path, text)
  })
  const chapter = (await store.create(book.id, 'chapters', '第1章')).document
  failBinding = true
  const outline = (await store.create(book.id, 'outlines', '第1章大纲')).document
  assert.equal((await store.read(book.id, outline.id)).document.version, outline.version)
  const read = (await store.readWithBindings(book.id, [outline.id]))[0]
  assert.match(read.automaticBindingNotice!, /文档已保存.*自动绑定未完成/)
  assert.equal((await store.chapterOutlineBindings(book.id)).revision, 0)
  failBinding = false
  assert.deepEqual((await store.matchChapterOutlines(book.id, 0)).added, [
    { chapterId: chapter.id, outlineId: outline.id }
  ])
  assert.equal(
    (await store.readWithBindings(book.id, [outline.id]))[0].automaticBindingNotice,
    undefined
  )
})

test('manual bulk match preserves corrupted relationship files', async () => {
  const { store, book } = await fixture()
  const chapter = (await store.create(book.id, 'chapters', '第1章')).document
  await store.create(book.id, 'outlines', '第1章大纲')
  await store.setChapterOutlineBinding({
    bookId: book.id,
    chapterId: chapter.id,
    outlineId: null,
    expectedRevision: 1
  })
  const path = join(book.root, '.workspace', 'chapter-outline-bindings.json')
  await fs.writeFile(path, '{损坏')
  await assert.rejects(store.matchChapterOutlines(book.id, 2), { code: 'BINDING_FORMAT' })
  assert.equal(await fs.readFile(path, 'utf8'), '{损坏')
})

test('matching existing documents publishes all pairs once or leaves the old relation intact', async () => {
  let failBinding = false
  const { store, book } = await fixture(async (path, value) => {
    if (failBinding && path.endsWith('chapter-outline-bindings.json'))
      throw new Error('匹配写入失败')
    await atomicWrite(path, value)
  })
  for (const number of [1, 2]) {
    const chapter = (await store.create(book.id, 'chapters', `第${number}章`)).document
    await store.create(book.id, 'outlines', `第${number}章大纲`)
    const state = await store.chapterOutlineBindings(book.id)
    await store.setChapterOutlineBinding({
      bookId: book.id,
      chapterId: chapter.id,
      outlineId: null,
      expectedRevision: state.revision
    })
  }
  const before = await store.chapterOutlineBindings(book.id)
  failBinding = true
  await assert.rejects(store.matchChapterOutlines(book.id, before.revision), /匹配写入失败/)
  assert.deepEqual(await store.chapterOutlineBindings(book.id), before)
  failBinding = false
  const matched = await store.matchChapterOutlines(book.id, before.revision)
  assert.equal(matched.added.length, 2)
  assert.equal(matched.revision, before.revision + 1)
})
