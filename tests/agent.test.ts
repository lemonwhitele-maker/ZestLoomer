import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import { DocumentStore, atomicWrite } from '../src/main/documents'
import { AgentService } from '../src/main/agent/service'
import { BookDocumentAdapter, documentPath } from '../src/main/agent/documents'
import { ApiRuntime, ScriptedRuntime, endpoint, type Completion } from '../src/main/agent/runtime'
import { initialContent } from '../src/shared/templates'
import { validateTemplate } from '../src/shared/templates'
import { createServer } from 'node:http'
import { BookSearchIndex } from '../src/main/agent/search'
import type { DocumentSnapshot } from '../src/shared/documents'

async function fixture(store = new DocumentStore()) {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const parent = await fs.mkdtemp(resolve('.test-artifacts/agent-'))
  const book = await store.createBook(parent, 'Agent 合成测试')
  return { store, book, parent }
}
const call = (name: string, args: unknown, n = '1'): Completion => ({
  text: '',
  calls: [{ id: n, name, arguments: JSON.stringify(args) }]
})
const done = { text: '提案已准备，等待作者审阅。', calls: [] }
test('full writes repair paragraph markers and retain the target line separator', async () => {
  const { store, book } = await fixture()
  const d = (await store.create(book.id, 'chapters', '章节', { content: '甲\r\n乙' })).document
  const service = new AgentService(
    store,
    () =>
      new ScriptedRuntime((_messages, step) => {
        if (step === 0) return call('read', { path: documentPath(d) })
        if (step === 1)
          return call('write', { path: documentPath(d), content: '新甲/n/n新乙' }, '2')
        return done
      })
  )
  const c = await service.create(book.id, '重写')
  await service.start(book.id, c.id, '重写章节', {})
  await service.idle()
  const p = (await service.snapshot(book.id)).proposals[0]
  assert.equal(p.content, '新甲\r\n\r\n新乙')
  await service.action(book.id, p.id, 'apply', p.candidateHash)
  assert.equal((await store.read(book.id, d.id)).document.content, p.content)
})
test('create normalizes model paragraphs and templates before hashing, apply and undo', async () => {
  const { store, book } = await fixture()
  for (const kind of ['characters', 'settings', 'chapters'] as const) {
    const service = new AgentService(
      store,
      () =>
        new ScriptedRuntime((_messages, step) =>
          step === 0
            ? call('create', {
                directory: `book/${kind}/`,
                title: '新资料',
                content: '甲/n/n乙\\n\\n丙'
              })
            : done
        )
    )
    const c = await service.create(book.id, '创建')
    await service.start(book.id, c.id, '创建资料', {})
    await service.idle()
    const p = (await service.snapshot(book.id)).proposals.find((p) => p.conversationId === c.id)!
    assert.ok(p)
    assert.ok(p.content.includes('甲\n\n乙\n\n丙'))
    assert.ok(validateTemplate(kind, p.content))
    await service.action(book.id, p.id, 'apply', p.candidateHash)
    assert.equal((await store.read(book.id, p.targetId)).document.content, p.content)
    await service.action(book.id, p.id, 'undo', p.candidateHash)
    assert.ok((await store.read(book.id, p.targetId)).document.trashedAt)
  }
})
test('proposal edits preserve surrounding CRLF and normalize only inserted line endings through apply and undo', async () => {
  const { store, book } = await fixture()
  for (const selected of [false, true]) {
    const original = '前文\r\n\r\n待修改\r\n后文\r\n'
    const d = (await store.create(book.id, 'chapters', '换行回归', { content: original })).document
    const service = new AgentService(
      store,
      () =>
        new ScriptedRuntime((_messages, step) => {
          if (step === 0) return call('read', { path: documentPath(d) })
          if (step === 1)
            return call(
              'edit',
              {
                path: documentPath(d),
                baseVersion: d.version,
                edits: [
                  {
                    mode: 'replace',
                    target: selected
                      ? { kind: 'selection' }
                      : { kind: 'lines', startLine: 3, endLine: 3 },
                    newText: '新段/n/n续段\r末段'
                  }
                ]
              },
              '2'
            )
          return done
        })
    )
    const c = await service.create(book.id, '换行')
    const from = original.indexOf('待修改')
    await service.start(book.id, c.id, '修改正文', {
      documentId: d.id,
      savedVersion: d.version,
      ...(selected ? { selection: { from, to: from + 3, text: '待修改' } } : {})
    })
    await service.idle()
    const p = (await service.snapshot(book.id)).proposals.find(
      (proposal) => proposal.targetId === d.id
    )!
    assert.ok(p)
    assert.equal(p.content, '前文\r\n\r\n新段\r\n\r\n续段\r\n末段\r\n后文\r\n')
    await service.action(book.id, p.id, 'apply', p.candidateHash)
    assert.equal((await store.read(book.id, d.id)).document.content, p.content)
    await service.action(book.id, p.id, 'undo', p.candidateHash)
    assert.equal((await store.read(book.id, d.id)).document.content, original)
  }
})
test('sent context and truthful progress survive restart without counting failed reads as success', async () => {
  const { store, book } = await fixture()
  const d = (await store.create(book.id, 'chapters', '冻结章节', { content: '选中原文' })).document
  const phases: string[] = []
  let workspace: any
  const service = new AgentService(
    store,
    () =>
      new ScriptedRuntime((messages, step) => {
        if (step === 0) {
          workspace = JSON.parse(messages.at(-2)!.content!.split('：').slice(1).join('：'))
          return call('read', { path: 'C:/outside' })
        }
        if (step === 1) return call('read', { path: documentPath(d) }, '2')
        return done
      }),
    (event) => {
      if (event.diagnostic) phases.push(event.diagnostic.phase)
    }
  )
  const c = await service.create(book.id, '上下文')
  const frozen = {
    documentId: d.id,
    savedVersion: d.version,
    selection: { from: 0, to: 4, text: d.content }
  }
  await service.start(book.id, c.id, '请分析选区', frozen)
  frozen.selection.text = '发送后改变'
  await service.idle()
  assert.equal(workspace.selection.text, d.content)
  const restarted = new AgentService(store, () => new ScriptedRuntime(() => done))
  const restored = (await restarted.snapshot(book.id)).conversations.find(
    (item) => item.id === c.id
  )!
  assert.equal(restored.messages[0].context?.document?.title, d.title)
  assert.equal(restored.messages[0].context?.workspace.selection?.text, d.content)
  assert.ok(restored.lastTurn?.startedAt)
  assert.ok(restored.lastTurn?.finishedAt)
  assert.equal(
    restored.diagnostics?.filter((r) => r.phase === 'tool.completed' && !r.code).length,
    1
  )
  assert.deepEqual(phases, [
    'turn.started',
    'model.started',
    'evidence.delivered',
    'model.completed',
    'tool.started',
    'tool.completed',
    'model.started',
    'evidence.delivered',
    'model.completed',
    'tool.started',
    'tool.completed',
    'model.started',
    'evidence.delivered',
    'model.completed',
    'turn.completed'
  ])
})
test('templates are optional, stored atomically and never force sections or content status', async () => {
  const { store, book } = await fixture()
  for (const kind of ['characters', 'settings'] as const) {
    const { document: d } = await store.create(book.id, kind, '模板测试', {
      content: initialContent(kind, 'basic')
    })
    assert.match(d.content, /^### /)
    assert.equal('status' in d, false)
    const saved = await store.save({
      bookId: book.id,
      id: d.id,
      expectedVersion: d.version,
      title: '改名',
      content: '自由结构，无必要区块'
    })
    assert.equal((await store.read(book.id, d.id)).document.content, saved.content)
    assert.equal(initialContent(kind, 'blank'), '')
  }
})
test('read coverage excludes summaries, missing middle pages, stale cursors and trash; batch preserves item errors', async () => {
  const { store, book } = await fixture()
  const d = (await store.create(book.id, 'notes', '长速记', { content: '甲'.repeat(1800) }))
    .document
  const adapter = new BookDocumentAdapter(store, book.id, {}, '', () => [])
  const path = documentPath(d)
  await adapter.read({ path: 'book/', query: '甲', maxChars: 500 })
  assert.equal(adapter.reads.size, 0)
  const first: any = await adapter.read({ path, maxChars: 500 })
  let page = first
  while (page.nextCursor) page = await adapter.read({ cursor: page.nextCursor, maxChars: 500 })
  assert.equal(page.complete, true)
  await store.save({
    bookId: book.id,
    id: d.id,
    expectedVersion: d.version,
    title: d.title,
    content: '新版本'
  })
  await assert.rejects(adapter.read({ cursor: first.nextCursor, maxChars: 500 }), /文档变化/)
  const batch: any = await adapter.read({ paths: [path, 'C:/secret'], maxChars: 1000 })
  assert.equal(batch.items[0].lines[0].text, '新版本')
  assert.ok(batch.items[1].error)
  const fresh = (await store.read(book.id, d.id)).document
  await store.trash(book.id, d.id, fresh.version)
  await assert.rejects(adapter.read({ path }), /回收站/)
  const explicit = new BookDocumentAdapter(store, book.id, {}, `[[note:${d.id}|旧速记]]`, () => [])
  const historical: any = await explicit.read({ path })
  assert.equal(historical.trashed, true)
  assert.equal(explicit.reads.size, 0)
  assert.equal((await store.agentDocuments(book.id)).length, 0)
  await assert.rejects(adapter.read({ path: 'book/../.workspace/recovery/x' }), /路径/)
})
test('read ranges merge without treating the final page alone as a full read', async () => {
  const { store, book } = await fixture()
  const d = (await store.create(book.id, 'notes', '覆盖', { content: 'a'.repeat(1500) })).document
  const a = new BookDocumentAdapter(store, book.id, {}, '', () => [])
  const first: any = await a.read({ path: documentPath(d), maxChars: 500 })
  const middle: any = await a.read({ cursor: first.nextCursor, maxChars: 500 })
  a.reads.get(d.id)!.ranges = [{ start: 0, end: 500 }]
  let final: any = middle
  while (final.nextCursor) final = await a.read({ cursor: final.nextCursor, maxChars: 500 })
  assert.equal(final.complete, false)
  assert.equal(a.covers(d.id, 0, 1500), false)
})
test('note-to-setting creation is a proposal, duplicates do not create two, apply and conditional undo preserve identity', async () => {
  const { store, book } = await fixture()
  const note = (await store.create(book.id, 'notes', '灵感', { content: '水门每天开启两次。' }))
    .document
  const runtime = new ScriptedRuntime((_messages, step) =>
    step === 0
      ? call('read', { path: documentPath(note) })
      : step === 1 || step === 2
        ? call(
            'create',
            {
              directory: 'book/settings/',
              title: '水门',
              content: '### 定义\n\n城市水门\n\n### 规则与边界\n\n每天开启两次。',
              sources: [documentPath(note)]
            },
            String(step)
          )
        : done
  )
  const service = new AgentService(store, () => runtime)
  const c = await service.create(book.id, '速记整理')
  await service.start(book.id, c.id, '依据速记整理成设定', {})
  await service.idle()
  let snap = await service.snapshot(book.id)
  assert.equal(snap.proposals.length, 1)
  assert.equal((await store.agentDocuments(book.id)).filter((d) => d.kind === 'settings').length, 0)
  const p = snap.proposals[0]
  await service.action(book.id, p.id, 'apply', p.candidateHash)
  const d = await store.agentRead(book.id, p.targetId)
  assert.equal(d.content, p.content)
  await assert.rejects(service.action(book.id, p.id, 'apply', p.candidateHash), /重复应用/)
  await service.action(book.id, p.id, 'undo', p.candidateHash)
  snap = await service.snapshot(book.id)
  assert.equal(snap.proposals[0].state, 'undone')
  assert.ok((await store.read(book.id, p.targetId)).document.trashedAt)
  assert.equal((await store.agentRead(book.id, note.id)).content, note.content)
  const restarted = new AgentService(new DocumentStore(), () => runtime)
  await restarted.documents.openBook(book.root)
  assert.equal((await restarted.snapshot(book.id)).proposals[0].state, 'undone')
})
async function editProposal(store: DocumentStore, bookId: string, d: DocumentSnapshot) {
  const runtime = new ScriptedRuntime((_m, step) =>
    step === 0
      ? call('read', { path: documentPath(d) })
      : step === 1
        ? call('edit', {
            path: documentPath(d),
            baseVersion: d.version,
            edits: [
              {
                mode: 'replace',
                target: { kind: 'lines', startLine: 1, endLine: 1 },
                newText: '新句子'
              }
            ]
          })
        : done
  )
  const service = new AgentService(store, () => runtime),
    c = await service.create(bookId, '润色')
  await service.start(bookId, c.id, '润色一句', {})
  await service.idle()
  return { service, p: (await service.snapshot(bookId)).proposals[0] }
}
test('pending proposals cannot overwrite manual edits, dirty drafts, source changes or recycled-and-restored targets', async () => {
  for (const scenario of ['manual', 'draft', 'trash', 'source'] as const) {
    const { store, book } = await fixture()
    const d = (await store.create(book.id, 'chapters', '第一章', { content: '旧句子' })).document
    const { service, p } = await editProposal(store, book.id, d)
    if (scenario === 'manual')
      await store.save({
        bookId: book.id,
        id: d.id,
        expectedVersion: d.version,
        title: d.title,
        content: '人的新输入'
      })
    if (scenario === 'draft') {
      service.editor(book.id, [{ id: d.id, dirty: true, revision: 1 }])
      await store.writeDraft(book.id, d.id, {
        baseVersion: d.version,
        title: d.title,
        content: '未保存输入',
        savedAt: new Date().toISOString()
      })
    }
    if (scenario === 'trash') {
      const recycled = await store.trash(book.id, d.id, d.version)
      await store.restore(book.id, d.id, recycled.version)
    }
    if (scenario === 'source') {
      const other = (await store.create(book.id, 'notes', '依据', { content: '旧来源' })).document
      // Exercise source revision checking at the storage transaction boundary.
      await store.save({
        bookId: book.id,
        id: other.id,
        expectedVersion: other.version,
        title: other.title,
        content: '来源变化'
      })
      await assert.rejects(
        store.applyAgent(
          {
            bookId: book.id,
            id: d.id,
            kind: d.kind,
            title: d.title,
            content: '新句子',
            expectedVersion: d.version,
            operationId: p.id,
            sources: [
              { id: other.id, kind: other.kind, title: other.title, version: other.version }
            ]
          },
          () => {}
        ),
        /来源已变化/
      )
      continue
    }
    await assert.rejects(service.action(book.id, p.id, 'apply', p.candidateHash))
    assert.notEqual((await store.read(book.id, d.id)).document.content, '新句子')
  }
})
test('selection never edits outside frozen bounds and later manual edits prevent undo', async () => {
  const { store, book } = await fixture()
  const d = (await store.create(book.id, 'chapters', '选区', { content: '前面。旧句子。后面。' }))
    .document
  const runtime = new ScriptedRuntime((_m, step) =>
    step === 0
      ? call('read', { path: documentPath(d) })
      : step === 1
        ? call('edit', {
            path: documentPath(d),
            baseVersion: d.version,
            edits: [{ mode: 'replace', target: { kind: 'selection' }, newText: '新句子' }]
          })
        : done
  )
  const service = new AgentService(store, () => runtime),
    c = await service.create(book.id, '选区任务')
  await service.start(book.id, c.id, '修改选区', {
    documentId: d.id,
    savedVersion: d.version,
    selection: { from: 3, to: 6, text: '旧句子' }
  })
  await service.idle()
  const p = (await service.snapshot(book.id)).proposals[0]
  assert.equal(p.content, '前面。新句子。后面。')
  await service.action(book.id, p.id, 'apply', p.candidateHash)
  const applied = await store.agentRead(book.id, d.id)
  await store.save({
    bookId: book.id,
    id: d.id,
    expectedVersion: applied.version,
    title: d.title,
    content: '后续手动修改'
  })
  await assert.rejects(service.action(book.id, p.id, 'undo', p.candidateHash), /不能覆盖撤销/)
  assert.equal((await store.agentRead(book.id, d.id)).content, '后续手动修改')
})

test('whole write and ambiguous edits are rejected before any proposal exists', async () => {
  const { store, book } = await fixture()
  const d = (
    await store.create(book.id, 'chapters', '不完整读取', { content: '旧句子。'.repeat(400) })
  ).document
  const runtime = new ScriptedRuntime((messages, step) => {
    if (step === 0) return call('read', { path: documentPath(d), maxChars: 500 })
    if (step === 1) return call('write', { path: documentPath(d), content: '不能写入' })
    if (step === 2) {
      assert.equal(JSON.parse(messages.at(-1)!.content!).code, 'FULL_READ_REQUIRED')
      return call('edit', {
        path: documentPath(d),
        edits: [{ oldText: '旧句子', newText: '不能改' }]
      })
    }
    assert.equal(JSON.parse(messages.at(-1)!.content!).code, 'ARGUMENT')
    return { text: '需要补读并缩小修改范围。', calls: [] }
  })
  const service = new AgentService(store, () => runtime),
    c = await service.create(book.id, '修改边界')
  await service.start(book.id, c.id, '修改文字', {})
  await service.idle()
  assert.equal((await service.snapshot(book.id)).proposals.length, 0)
  assert.equal((await store.agentRead(book.id, d.id)).version, d.version)
})

test('cancellation does not depend on a runtime cooperating; a 4000-character current request is not truncated', async () => {
  const { store, book } = await fixture()
  let actual = ''
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const runtime = new ScriptedRuntime((messages) => {
    actual = messages.at(-1)!.content!
    started()
    return new Promise<Completion>(() => {})
  })
  const service = new AgentService(store, () => runtime),
    c = await service.create(book.id, '取消挂起')
  const text = '甲'.repeat(3999) + '乙'
  await service.start(book.id, c.id, text, {})
  await ready
  assert.equal(actual, text)
  await service.cancel(book.id)
  assert.equal((await service.snapshot(book.id)).active, null)
})

test('new candidate interrupted before content exists can be retried without an empty published file', async () => {
  let interrupt = false
  const store = new DocumentStore(async (path, text) => {
    await atomicWrite(path, text)
    if (interrupt && path.includes('.new-') && path.endsWith('meta.json')) {
      interrupt = false
      throw new Error('创建中断')
    }
  })
  const { book } = await fixture(store)
  const runtime = new ScriptedRuntime((_m, step) =>
    step === 0
      ? call('create', { directory: 'book/notes/', title: '完整速记', content: '应一次建立的内容' })
      : done
  )
  const service = new AgentService(store, () => runtime),
    c = await service.create(book.id, '新建恢复')
  await service.start(book.id, c.id, '记下灵感', {})
  await service.idle()
  const p = (await service.snapshot(book.id)).proposals[0]
  interrupt = true
  await assert.rejects(service.action(book.id, p.id, 'apply', p.candidateHash), /创建中断/)
  assert.equal((await store.agentDocuments(book.id)).length, 0)
  // A failed write has an explicit review outcome. Reopening its applying intent recovers to pending.
  const record = (await service.snapshot(book.id)).proposals[0]
  record.state = 'applying'
  await store.writeAgentRecord(book.id, 'proposals', record.id, record)
  const fresh = new AgentService(store, () => runtime)
  await fresh.snapshot(book.id)
  await fresh.action(book.id, p.id, 'apply', p.candidateHash)
  assert.equal((await store.agentRead(book.id, p.targetId)).content, p.content)
  assert.equal((await store.agentDocuments(book.id)).length, 1)
})
test('cancelled rounds invalidate proposals, foreign tools are denied, and a failed runtime never writes', async () => {
  const { store, book } = await fixture()
  const runtime = new ScriptedRuntime(async (_m, step, signal) => {
    if (step === 0)
      return call('create', { directory: 'book/notes/', title: '未完成', content: '草案' })
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    )
    return done
  })
  const service = new AgentService(store, () => runtime),
    c = await service.create(book.id, '取消')
  await service.start(book.id, c.id, '保存灵感', {})
  for (let n = 0; n < 50 && !(await service.snapshot(book.id)).proposals.length; n++)
    await new Promise((r) => setTimeout(r, 10))
  await service.cancel(book.id)
  const snap = await service.snapshot(book.id)
  assert.equal(snap.proposals[0].state, 'stale')
  assert.equal(snap.active, null)
  assert.equal((await store.agentDocuments(book.id)).length, 0)
  const foreign = new AgentService(
    store,
    () =>
      new ScriptedRuntime((_m, step) =>
        step === 0 ? call('shell', { command: 'anything' }) : done
      )
  )
  const c2 = await foreign.create(book.id, '权限')
  await foreign.start(book.id, c2.id, '读文件', {})
  await foreign.idle()
  assert.equal((await foreign.snapshot(book.id)).proposals.length, 1) // persisted stale proposal only
})
test('applied record recovery uses operation identity and never replays writes or loses the undo baseline', async () => {
  const { store, book } = await fixture()
  const d = (await store.create(book.id, 'chapters', '恢复', { content: '旧句子' })).document
  const { service, p } = await editProposal(store, book.id, d)
  await service.action(book.id, p.id, 'apply', p.candidateHash)
  const record = (await service.snapshot(book.id)).proposals[0]
  record.state = 'applying'
  delete record.appliedVersion
  await store.writeAgentRecord(book.id, 'proposals', record.id, record)
  const fresh = new AgentService(store, () => new ScriptedRuntime(() => done))
  const recovered = (await fresh.snapshot(book.id)).proposals[0]
  assert.equal(recovered.state, 'applied')
  assert.ok(recovered.appliedVersion)
  await fresh.action(book.id, recovered.id, 'undo', recovered.candidateHash)
  assert.equal((await store.agentRead(book.id, d.id)).content, '旧句子')
})
test('interrupted candidate write rolls forward once after a simulated power failure', async () => {
  let interrupt = false
  const store = new DocumentStore(async (path, text) => {
    await atomicWrite(path, text)
    if (interrupt && path.endsWith('pending.json')) {
      interrupt = false
      throw new Error('模拟断电')
    }
  })
  const { book } = await fixture(store)
  const d = (await store.create(book.id, 'chapters', '事务', { content: '旧句子' })).document
  const { service, p } = await editProposal(store, book.id, d)
  interrupt = true
  await assert.rejects(service.action(book.id, p.id, 'apply', p.candidateHash), /模拟断电/)
  assert.equal((await service.snapshot(book.id)).proposals[0].state, 'applied')
  assert.equal((await store.agentRead(book.id, d.id)).content, '新句子')
})

test('search index repairs corruption, catches external content edits and excludes recycled documents', async () => {
  const { store, book } = await fixture()
  const d = (await store.create(book.id, 'settings', '城门', { content: '旧水门' })).document
  const search = new BookSearchIndex(store, book.id)
  assert.equal((await search.search('all', '水门')).length, 1)
  const file = resolve(book.root, 'settings', d.id, 'content.md')
  await fs.writeFile(file, '外部改成城墙', 'utf8')
  assert.equal((await search.search('all', '水门')).length, 0)
  assert.equal((await search.search('settings', '城墙')).length, 1)
  const cache = resolve(book.root, '.workspace', 'indexes', `index_${book.id.slice(5)}.json`)
  await fs.writeFile(cache, '损坏的可重建索引', 'utf8')
  assert.equal((await search.search('settings', '城墙')).length, 1)
  const current = await store.agentRead(book.id, d.id)
  await store.trash(book.id, d.id, current.version)
  assert.equal((await search.search('all', '城墙')).length, 0)
  assert.deepEqual(JSON.parse(await fs.readFile(cache, 'utf8')).entries, [])
})

test('conversation persistence failure still ends the active task and emits a visible failure', async () => {
  let unwritable = false
  const store = new DocumentStore(async (path, text) => {
    if (unwritable && path.includes('conversations')) throw new Error('模拟会话目录不可写')
    await atomicWrite(path, text)
  })
  const { book } = await fixture(store)
  const events: string[] = []
  const service = new AgentService(
    store,
    () =>
      new ScriptedRuntime(() => {
        unwritable = true
        return { text: '回复完成', calls: [] }
      }),
    (event) => events.push(event.type)
  )
  const c = await service.create(book.id, '保存失败')
  await service.start(book.id, c.id, '讨论情节', {})
  await service.idle()
  assert.equal((await service.snapshot(book.id)).active, null)
  assert.equal(events.at(-1), 'failed')
  assert.equal((await service.snapshot(book.id)).conversations[0].lastTurn?.state, 'failed')
  assert.equal((await store.agentDocuments(book.id)).length, 0)
})
test('incomplete or truncated model output never returns executable calls; fragmented SSE is parsed correctly', async () => {
  let mode = 'good'
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    assert.equal(JSON.parse(body).stream, true)
    response.setHeader('Content-Type', 'text/event-stream')
    const data =
      mode === 'good'
        ? [
            { choices: [{ delta: { content: '你好' } }] },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 't1', function: { name: 'read', arguments: '{"path":' } }
                    ]
                  }
                }
              ]
            },
            {
              choices: [
                {
                  delta: { tool_calls: [{ index: 0, function: { arguments: '"book/"}' } }] },
                  finish_reason: 'tool_calls'
                }
              ]
            }
          ]
        : [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 't1',
                        function: {
                          name: 'create',
                          arguments: '{"directory":"book/notes/","title":"x","content":"y"}'
                        }
                      }
                    ]
                  },
                  finish_reason: 'length'
                }
              ]
            }
          ]
    const events =
      data.map((d) => `data: ${JSON.stringify(d)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n'
    const bytes = Buffer.from(events)
    for (let at = 0; at < bytes.length; at += 7) response.write(bytes.subarray(at, at + 7))
    response.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    const runtime = new ApiRuntime(
      { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'synthetic', hasKey: false },
      ''
    )
    const result = await runtime.complete(
      [{ role: 'user', content: '测试' }],
      new AbortController().signal,
      () => {}
    )
    assert.equal(result.text, '你好')
    assert.equal(result.calls[0].arguments, '{"path":"book/"}')
    mode = 'bad'
    await assert.rejects(
      runtime.complete([{ role: 'user', content: '测试' }], new AbortController().signal, () => {}),
      /截断/
    )
    assert.throws(() => endpoint('http://remote.test/v1'), /HTTPS/)
    assert.throws(() => endpoint('https://example.test/v1?key=secret'), /查询参数/)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})
