import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { DocumentStore, atomicWrite } from '../src/main/documents'
import { AgentService } from '../src/main/agent/service'
import { documentPath } from '../src/main/agent/documents'
import { ScriptedRuntime, type Completion } from '../src/main/agent/runtime'

const call = (name: string, args: unknown): Completion => ({
  text: '',
  calls: [{ id: 'c', name, arguments: JSON.stringify(args) }]
})
const done: Completion = { text: '全部整理完成', calls: [] }
async function fixture() {
  const parent = await fs.mkdtemp(resolve('.test-artifacts/review-case-'))
  const store = new DocumentStore()
  const book = await store.createBook(parent, '独立复核合成作品')
  return { store, book }
}

test('partial reads automatically persist sources and enforce source version checks', async () => {
  const { store, book } = await fixture()
  const note = (
    await store.create(book.id, 'notes', '水门', { content: '每天开启两次\n'.repeat(500) })
  ).document
  const runtime = new ScriptedRuntime((_m, step) =>
    step === 0
      ? call('read', { path: documentPath(note), maxChars: 500 })
      : step === 1
        ? call('create', {
            directory: 'book/settings/',
            title: '水门',
            content: '每天开启两次'
          })
        : done
  )
  const service = new AgentService(store, () => runtime)
  const c = await service.create(book.id, '整理')
  await service.start(book.id, c.id, '参考已读片段，新建水门设定', {})
  await service.idle()
  const p = (await service.snapshot(book.id)).proposals[0]
  assert.ok(p)
  assert.equal(p.sources.length, 1)
  assert.equal(p.sources[0].version, note.version)
  await store.save({
    bookId: book.id,
    id: note.id,
    expectedVersion: note.version,
    title: note.title,
    content: '每天只开启一次'
  })
  await assert.rejects(service.action(book.id, p.id, 'apply', p.candidateHash), /来源已变化/)
  await assert.rejects(store.agentRead(book.id, p.targetId))
})

test('all-notes request requires unopened notes too', async () => {
  const { store, book } = await fixture()
  const a = (await store.create(book.id, 'notes', '甲', { content: '东门规则' })).document
  await store.create(book.id, 'notes', '乙', { content: '西门规则' })
  const runtime = new ScriptedRuntime((_m, step) =>
    step === 0
      ? call('read', { path: documentPath(a) })
      : step === 1
        ? call('create', { directory: 'book/settings/', title: '全部城门', content: a.content })
        : done
  )
  const service = new AgentService(store, () => runtime)
  const c = await service.create(book.id, '全部整理')
  await service.start(book.id, c.id, '整理全部速记为完整设定', {
    documentId: a.id,
    savedVersion: a.version
  })
  await service.idle()
  const snap = await service.snapshot(book.id)
  assert.equal(snap.proposals.length, 0)
  assert.notEqual(snap.conversations[0].messages.at(-1)?.text, '全部整理完成')
})

test('dirty undo can retry after editing returns clean', async () => {
  const { store, book } = await fixture()
  const d = (await store.create(book.id, 'chapters', '章', { content: '旧句子' })).document
  const runtime = new ScriptedRuntime((_m, step) =>
    step === 0
      ? call('read', { path: documentPath(d) })
      : step === 1
        ? call('write', { path: documentPath(d), content: '新句子' })
        : done
  )
  const service = new AgentService(store, () => runtime)
  const c = await service.create(book.id, '润色')
  await service.start(book.id, c.id, '润色', {})
  await service.idle()
  const p = (await service.snapshot(book.id)).proposals[0]
  await service.action(book.id, p.id, 'apply', p.candidateHash)
  service.editor(book.id, [{ id: d.id, dirty: true, revision: 1 }])
  await assert.rejects(service.action(book.id, p.id, 'undo', p.candidateHash), /编辑/)
  assert.equal((await service.snapshot(book.id)).proposals[0].state, 'applied')
  service.editor(book.id, [{ id: d.id, dirty: false, revision: 2 }])
  await service.action(book.id, p.id, 'undo', p.candidateHash)
  assert.equal((await store.agentRead(book.id, d.id)).content, '旧句子')
})

test('damaged conversation does not prevent healthy book access', async () => {
  const { store, book } = await fixture()
  const d = (await store.create(book.id, 'chapters', '正常书稿', { content: '正常内容' })).document
  const service = new AgentService(store, () => new ScriptedRuntime(() => done))
  const c = await service.create(book.id, '损坏会话')
  await fs.writeFile(
    join(book.root, '.workspace', 'conversations', `${c.id}.json`),
    '{broken',
    'utf8'
  )
  const restarted = new AgentService(store, () => new ScriptedRuntime(() => done))
  assert.equal((await restarted.snapshot(book.id)).warnings?.length, 1)
  assert.equal((await store.agentRead(book.id, d.id)).content, '正常内容')
})

test('temporary disk failure during undo retains retry', async () => {
  let failOnce = false
  const store = new DocumentStore(async (path, value) => {
    if (failOnce && path.endsWith('pending.json')) {
      failOnce = false
      throw new Error('simulated temporary disk failure before any manuscript write')
    }
    await atomicWrite(path, value)
  })
  const parent = await fs.mkdtemp(resolve('.test-artifacts/review-undo-'))
  const book = await store.createBook(parent, '撤销临时故障')
  const d = (await store.create(book.id, 'chapters', '章', { content: '原内容' })).document
  const runtime = new ScriptedRuntime((_m, step) =>
    step === 0
      ? call('read', { path: documentPath(d) })
      : step === 1
        ? call('write', { path: documentPath(d), content: '提案内容' })
        : done
  )
  const service = new AgentService(store, () => runtime)
  const c = await service.create(book.id, '修改')
  await service.start(book.id, c.id, '修改', {})
  await service.idle()
  const p = (await service.snapshot(book.id)).proposals[0]
  await service.action(book.id, p.id, 'apply', p.candidateHash)
  const applied = await store.agentRead(book.id, d.id)
  failOnce = true
  await assert.rejects(
    service.action(book.id, p.id, 'undo', p.candidateHash),
    /temporary disk failure/
  )
  assert.equal((await store.agentRead(book.id, d.id)).version, applied.version)
  assert.equal((await service.snapshot(book.id)).proposals[0].state, 'applied')
  await service.action(book.id, p.id, 'undo', p.candidateHash)
  assert.equal((await store.agentRead(book.id, d.id)).content, '原内容')
})
