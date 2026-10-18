import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DocumentStore, atomicWrite } from '../src/main/documents'
import { parseForeshadow, validateForeshadow } from '../src/main/storyLinks'
import { BookDocumentAdapter, documentPath } from '../src/main/agent/documents'
import { AgentService } from '../src/main/agent/service'
import { ScriptedRuntime } from '../src/main/agent/runtime'

async function fixture(writer = atomicWrite) {
  const parent = resolve('.test-artifacts')
  await fs.mkdir(parent, { recursive: true })
  const root = await fs.mkdtemp(join(parent, 'story-links-'))
  const store = new DocumentStore(writer)
  const book = await store.createBook(root, '映射合成测试作品')
  const a = (await store.create(book.id, 'chapters', '甲')).document
  const b = (await store.create(book.id, 'chapters', '乙')).document
  const x = (await store.create(book.id, 'outlines', '甲纲')).document
  const y = (await store.create(book.id, 'outlines', '乙纲')).document
  const bind = (chapterId: string, outlineId: string | null, expectedRevision: number) =>
    store.setChapterOutlineBinding({ bookId: book.id, chapterId, outlineId, expectedRevision })
  return {
    store,
    book,
    a,
    b,
    x,
    y,
    bind,
    path: join(book.root, '.workspace', 'chapter-outline-bindings.json')
  }
}

test('binding is unique, idempotent, bidirectional and independent of content versions', async () => {
  const { store, book, a, b, x, y, bind } = await fixture()
  assert.equal((await store.chapterOutlineBindings(book.id)).revision, 0)
  assert.equal((await bind(a.id, x.id, 0)).revision, 1)
  assert.equal((await bind(a.id, x.id, 1)).revision, 1)
  await assert.rejects(bind(b.id, x.id, 1), { code: 'BINDING_OCCUPIED' })
  await assert.rejects(bind(a.id, y.id, 0), { code: 'BINDING_CONFLICT' })
  const result = await store.readWithBindings(book.id, [a.id, x.id, b.id])
  assert.equal(result[0].document.version, a.version)
  assert.deepEqual(result[0].chapterOutlineBinding, {
    state: 'bound',
    revision: 1,
    target: {
      id: x.id,
      kind: 'outlines',
      path: `book/outlines/${x.id}.md`,
      title: x.title,
      state: 'active'
    }
  })
  const reverse = result[1].chapterOutlineBinding
  assert.equal(reverse?.state === 'bound' && reverse.target.id, a.id)
  assert.deepEqual(result[2].chapterOutlineBinding, { state: 'unbound', revision: 1 })
  const next = await bind(a.id, y.id, 1)
  assert.deepEqual(next.bindings, [{ chapterId: a.id, outlineId: y.id }])
  assert.equal((await bind(b.id, x.id, 2)).bindings.length, 2)
})

test('concurrent requests serialize and failed atomic rebind keeps original relation', async () => {
  let broken = false
  const { store, book, a, b, x, y, bind } = await fixture(async (path, value) => {
    if (broken && path.endsWith('chapter-outline-bindings.json'))
      throw new Error('injected failure')
    await atomicWrite(path, value)
  })
  const results = await Promise.allSettled([bind(a.id, x.id, 0), bind(b.id, y.id, 0)])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(results[1].status === 'rejected' && results[1].reason.code, 'BINDING_CONFLICT')
  broken = true
  await assert.rejects(bind(a.id, y.id, 1), /injected failure/)
  assert.deepEqual((await store.chapterOutlineBindings(book.id)).bindings, [
    { chapterId: a.id, outlineId: x.id }
  ])
})

test('rename, trash, restore, copy and reopen preserve stable relation identity', async () => {
  const { store, book, a, b, x, bind } = await fixture()
  await bind(a.id, x.id, 0)
  const renamed = await store.save({
    bookId: book.id,
    id: x.id,
    expectedVersion: x.version,
    title: '新的大纲名',
    content: x.content
  })
  const trash = await store.trash(book.id, x.id, renamed.version)
  const target = (await store.readWithBindings(book.id, [a.id]))[0].chapterOutlineBinding
  assert.equal(target?.state === 'bound' && target.target.state, 'trashed')
  assert.equal(target?.state === 'bound' && target.target.title, '新的大纲名')
  await assert.rejects(bind(b.id, x.id, 1), { code: 'BINDING_OCCUPIED' })
  await store.restore(book.id, x.id, trash.version)
  const copy = (await store.create(book.id, 'chapters', '甲副本', { content: a.content })).document
  const reopened = new DocumentStore()
  await reopened.openBook(book.root)
  assert.deepEqual((await reopened.readWithBindings(book.id, [copy.id]))[0].chapterOutlineBinding, {
    state: 'unbound',
    revision: 1
  })
  const restored = (await reopened.readWithBindings(book.id, [a.id]))[0].chapterOutlineBinding
  assert.equal(restored?.state === 'bound' && restored.target.state, 'active')
})

test('missing target remains occupied and can explicitly be unbound', async () => {
  const { store, book, a, b, x, bind } = await fixture()
  await bind(a.id, x.id, 0)
  // Rename within this synthetic book instead of deleting test content.
  await fs.rename(
    join(book.root, 'outlines', x.id),
    join(book.root, 'outlines', `.missing-${x.id}`)
  )
  const binding = (await store.readWithBindings(book.id, [a.id]))[0].chapterOutlineBinding
  assert.equal(binding?.state === 'bound' && binding.target.state, 'missing')
  await assert.rejects(bind(b.id, x.id, 1), { code: 'BINDING_OCCUPIED' })
  assert.deepEqual((await bind(a.id, null, 1)).bindings, [])
})

test('damaged/duplicate/illegal-kind relations are errors and never overwritten', async () => {
  const { store, book, a, b, x, path, bind } = await fixture()
  for (const [raw, code] of [
    ['{bad', 'BINDING_FORMAT'],
    [
      JSON.stringify({
        schemaVersion: 1,
        revision: 2,
        bindings: [
          { chapterId: a.id, outlineId: x.id },
          { chapterId: b.id, outlineId: x.id }
        ]
      }),
      'BINDING_DUPLICATE'
    ],
    [
      JSON.stringify({
        schemaVersion: 1,
        revision: 2,
        bindings: [{ chapterId: a.id, outlineId: b.id }]
      }),
      'BINDING_KIND'
    ]
  ]) {
    await fs.writeFile(path, raw)
    await assert.rejects(bind(a.id, x.id, 2), { code })
    assert.equal(await fs.readFile(path, 'utf8'), raw)
    const binding = (await store.readWithBindings(book.id, [a.id]))[0].chapterOutlineBinding
    assert.equal(binding?.state, 'error')
    assert.equal(binding?.state === 'error' && binding.code, code)
  }
})

test('new bindings reject wrong kind, unknown and trashed targets', async () => {
  const { a, b, x, bind, store, book } = await fixture()
  await assert.rejects(bind(a.id, b.id, 0), { code: 'BINDING_KIND' })
  await assert.rejects(bind(a.id, `doc_${randomUUID()}`, 0), { code: 'BINDING_TARGET' })
  await store.trash(book.id, x.id, x.version)
  await assert.rejects(bind(a.id, x.id, 0), { code: 'BINDING_TARGET' })
})

test('proposal dependencies reject relevant rebind but permit unrelated relation updates', async () => {
  const { store, book, a, b, x, y, bind } = await fixture()
  await bind(a.id, x.id, 0)
  await bind(b.id, y.id, 1)
  const apply = (version: string) =>
    store.applyAgent(
      {
        bookId: book.id,
        id: a.id,
        kind: a.kind,
        title: a.title,
        content: '候选',
        expectedVersion: version,
        operationId: `proposal_${randomUUID()}`,
        sources: [],
        bindingDependencies: [{ id: a.id, targetId: x.id }]
      },
      () => {}
    )
  const applied = await apply(a.version)
  await bind(a.id, null, 2)
  await assert.rejects(apply(applied.version), { code: 'BINDING_STALE' })
  assert.equal((await store.read(book.id, a.id)).document.version, applied.version)
})

test('backup contains bindings and reopening preserves them', async () => {
  const { store, book, a, x, bind } = await fixture()
  await bind(a.id, x.id, 0)
  const destination = `${book.root}-backup`
  await store.backup(book.id, destination)
  const reopened = new DocumentStore()
  await reopened.openBook(destination)
  assert.deepEqual(
    await reopened.chapterOutlineBindings(book.id),
    await store.chapterOutlineBindings(book.id)
  )
})

test('a deleted established relation file is an error after restart, not an empty legacy book', async () => {
  const { store, book, a, x, bind, path } = await fixture()
  await bind(a.id, x.id, 0)
  await fs.rename(path, `${path}.held`)
  const reopened = new DocumentStore()
  await reopened.openBook(book.root)
  await assert.rejects(reopened.chapterOutlineBindings(book.id), { code: 'BINDING_MISSING' })
  const item = (await store.readWithBindings(book.id, [a.id]))[0]
  assert.equal(item.chapterOutlineBinding?.state, 'error')
})

test('unrelated binding changes do not invalidate already-read proposal targets', async () => {
  const { store, book, a, b, x, y, bind } = await fixture()
  await bind(a.id, x.id, 0)
  const adapter = new BookDocumentAdapter(store, book.id, {}, '', () => [])
  await adapter.read({ path: documentPath(a) })
  await bind(b.id, y.id, 1)
  assert.equal((await adapter.target(documentPath(a), true)).id, a.id)
  assert.deepEqual(adapter.bindingDependencies(), [{ id: a.id, targetId: x.id }])
  await bind(a.id, null, 2)
  await assert.rejects(adapter.target(documentPath(a), true), { code: 'READ_REQUIRED' })
})

test('foreshadow parser rejects duplicate/escaped duplicate keys, wrong fields and invalid shapes', () => {
  const valid = '{"content":"铜钥匙\\n纹路","startChapterId":null,"endChapterId":null}'
  assert.equal(parseForeshadow(valid).content, '铜钥匙\n纹路')
  for (const raw of [
    '[]',
    '{}',
    valid + '\n说明',
    '```json\n' + valid + '\n```',
    valid.replace('null', '123'),
    valid.replace('null', '"chapter title"'),
    valid.replace('"content":', '"extra":1,"content":'),
    valid.replace('"content":', '"content":"first","content":'),
    valid.replace('"content":', '"cont\\u0065nt":"first","content":')
  ])
    assert.throws(() => parseForeshadow(raw))
})

test('foreshadow references allow unchanged broken IDs but reject new invalid ones', async () => {
  const old = `doc_${randomUUID()}`,
    next = `doc_${randomUUID()}`
  const raw = (id: string | null, end: string | null = null) =>
    JSON.stringify({ content: '', startChapterId: id, endChapterId: end })
  const missing = async () => ({ kind: 'chapters', state: 'missing' as const })
  await validateForeshadow(raw(old), missing, raw(old))
  await validateForeshadow(raw(null), missing, raw(old))
  await assert.rejects(validateForeshadow(raw(next), missing, raw(old)), {
    code: 'FORESHADOW_REFERENCE'
  })
  await assert.rejects(validateForeshadow(raw(old), missing, '{bad'), {
    code: 'FORESHADOW_REFERENCE'
  })
  await assert.rejects(
    validateForeshadow(raw(next), async () => ({ kind: 'outlines', state: 'active' })),
    { code: 'FORESHADOW_REFERENCE' }
  )
  // Same chapter on both ends is allowed; no chronology or completion semantics.
  await validateForeshadow(raw(next, next), async () => ({ kind: 'chapters', state: 'active' }))
})

test('foreshadow storage validates save/import/accept and restores traceable historical references', async () => {
  const { store, book, a, b } = await fixture()
  const raw = (chapter: string | null) =>
    JSON.stringify({ content: '铜钥匙', startChapterId: chapter, endChapterId: null }, null, 2)
  const d = (await store.create(book.id, 'foreshadows', '钥匙', { content: raw(a.id) })).document
  await assert.rejects(
    store.save({
      bookId: book.id,
      id: d.id,
      title: d.title,
      expectedVersion: d.version,
      content: '{}'
    }),
    { code: 'FORESHADOW_SCHEMA' }
  )
  await assert.rejects(
    store.createBatch({
      bookId: book.id,
      kind: 'foreshadows',
      items: [{ title: '坏导入', content: '{}' }],
      placement: { position: 'end' }
    }),
    { code: 'FORESHADOW_SCHEMA' }
  )
  const changed = await store.save({
    bookId: book.id,
    id: d.id,
    title: d.title,
    expectedVersion: d.version,
    content: raw(null)
  })
  await store.trash(book.id, a.id, a.version)
  const restored = await store.restoreHistory(
    book.id,
    d.id,
    `history_${d.version}`,
    changed.version
  )
  assert.equal(parseForeshadow(restored.content).startChapterId, a.id)
  await store.validateForeshadowCandidate(book.id, raw(b.id), {
    id: d.id,
    version: restored.version
  })
  await store.trash(book.id, b.id, b.version)
  await assert.rejects(
    store.applyAgent(
      {
        bookId: book.id,
        id: d.id,
        kind: d.kind,
        title: d.title,
        content: raw(b.id),
        expectedVersion: restored.version,
        operationId: `proposal_${randomUUID()}`,
        sources: []
      },
      () => {}
    ),
    { code: 'FORESHADOW_REFERENCE' }
  )
  const other = (await store.create(book.id, 'foreshadows', '有效记录')).document
  await fs.writeFile(join(book.root, 'foreshadows', d.id, 'content.md'), '{bad')
  const rows = await store.foreshadowRows(book.id)
  assert.ok(rows.rows.find((row) => row.document.id === d.id)?.error)
  assert.ok(rows.rows.find((row) => row.document.id === other.id)?.fields)
})

test('read attaches relations without target evidence; changed relations invalidate cursors', async () => {
  const { store, book, a, x, bind } = await fixture()
  const d = await store.save({
    bookId: book.id,
    id: a.id,
    title: a.title,
    expectedVersion: a.version,
    content: '很长的正文'.repeat(2000)
  })
  await bind(d.id, x.id, 0)
  const adapter = new BookDocumentAdapter(store, book.id, {}, '', () => [])
  const page = (await adapter.read({ path: documentPath(d), maxChars: 1000 })) as {
    nextCursor: string
    chapterOutlineBinding: { state: string }
  }
  assert.equal(page.chapterOutlineBinding.state, 'bound')
  assert.equal(adapter.evidence.has(x.id), false)
  await bind(d.id, null, 1)
  await assert.rejects(adapter.read({ cursor: page.nextCursor, maxChars: 1000 }), {
    code: 'BINDING_CHANGED'
  })
})

test('foreshadow search is not evidence, partial edit is refused, full proposal preserves escaped JSON', async () => {
  const { store, book, a } = await fixture()
  const raw = JSON.stringify(
    { content: '铜钥匙\n\n旧纹路', startChapterId: a.id, endChapterId: null },
    null,
    2
  )
  const d = (await store.create(book.id, 'foreshadows', '钥匙', { content: raw })).document
  const adapter = new BookDocumentAdapter(store, book.id, {}, '', () => [])
  await adapter.read({ path: 'book/', query: '铜钥匙' })
  assert.equal(adapter.evidence.size, 0)
  await adapter.read({ path: documentPath(d), startLine: 2, endLine: 2 })
  await assert.rejects(adapter.target(documentPath(d), false), { code: 'FULL_READ_REQUIRED' })
  const candidate = raw.replace('旧纹路', '新纹路')
  const service = new AgentService(
    store,
    () =>
      new ScriptedRuntime((_messages, step) => {
        const name = step === 0 ? 'read' : 'write'
        const args =
          step === 0 ? { path: documentPath(d) } : { path: documentPath(d), content: candidate }
        return step < 2
          ? { text: '', calls: [{ id: String(step), name, arguments: JSON.stringify(args) }] }
          : { text: '待审阅', calls: [] }
      })
  )
  const conversation = await service.create(book.id, '伏笔修改测试')
  await service.start(book.id, conversation.id, '修改铜钥匙纹路', {})
  await service.idle()
  const proposal = (await service.snapshot(book.id)).proposals[0]
  assert.ok(proposal)
  assert.equal(proposal.content, candidate)
  await service.action(book.id, proposal.id, 'apply', proposal.candidateHash)
  assert.equal((await store.read(book.id, d.id)).document.content, candidate)
})
