import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DocumentStore } from '../src/main/documents'
import { AgentService } from '../src/main/agent/service'
import { BookDocumentAdapter, documentPath } from '../src/main/agent/documents'
import {
  ScriptedRuntime,
  type ModelRuntime,
  type CompletionOptions
} from '../src/main/agent/runtime'
import { documentAliases, relatedContext } from '../src/main/agent/related'
import { executionBudget } from '../src/main/agent/budgets'

async function fixture() {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const store = new DocumentStore()
  const root = await fs.mkdtemp(resolve('.test-artifacts/priorities-'))
  return { store, book: await store.createBook(root, '优先项验收') }
}
const call = (id: string, name: string, args: unknown) => ({
  id,
  name,
  arguments: JSON.stringify(args)
})

test('reading rounds reserve proposal and final-answer capacity even if the model keeps reading', async () => {
  const { store, book } = await fixture()
  let step = 0
  const modes: CompletionOptions['tools'][] = []
  const runtime: ModelRuntime = {
    async complete(messages, _signal, delta, options) {
      modes.push(options?.tools)
      const n = step++
      if (n < executionBudget.readRounds + 1)
        return { text: '', calls: [call(`read-${n}`, 'list_files', { path: 'book/' })] }
      if (n === executionBudget.readRounds + 1) {
        assert.equal(
          JSON.parse(messages.filter((m) => m.role === 'tool').at(-1)!.content!).code,
          'READ_BUDGET'
        )
        return {
          text: '',
          calls: [
            call('proposal', 'create', {
              directory: 'book/notes',
              title: '创作建议',
              content: '新构想'
            })
          ]
        }
      }
      delta('已经提出建议')
      return { text: '已经提出建议', calls: [] }
    }
  }
  const service = new AgentService(store, () => runtime)
  const c = await service.create(book.id, '讨论')
  await service.start(book.id, c.id, '提出一个新构想', {})
  await service.idle()
  const state = await service.snapshot(book.id)
  assert.equal(modes[executionBudget.readRounds], 'write')
  assert.equal(state.conversations[0].lastTurn?.state, 'completed')
  assert.equal(state.proposals.length, 1)
  assert.equal(state.proposals[0].state, 'pending')
  assert.equal(
    state.conversations[0].diagnostics?.filter(
      (d) => d.phase === 'tool.completed' && d.tool === 'list_files' && !d.code
    ).length,
    executionBudget.readRounds
  )
})

test('the last model round closes tools; a compliant model can finish after repeated proposals', async () => {
  const { store, book } = await fixture()
  let requests = 0
  const runtime: ModelRuntime = {
    async complete(_messages, _signal, delta, options) {
      requests++
      if (options?.tools === 'none') {
        delta('已完成收尾')
        return { text: '已完成收尾', calls: [] }
      }
      return {
        text: '',
        calls: [
          call(`write-${requests}`, 'create', {
            directory: 'book/notes',
            title: '构想',
            content: '构想内容'
          })
        ]
      }
    }
  }
  const service = new AgentService(store, () => runtime)
  const c = await service.create(book.id, '讨论')
  await service.start(book.id, c.id, '自由创作', {})
  await service.idle()
  const state = await service.snapshot(book.id)
  assert.equal(requests, executionBudget.modelRounds)
  assert.equal(state.conversations[0].lastTurn?.state, 'completed')
  assert.equal(state.proposals.length, 1)
  assert.equal(state.proposals[0].state, 'pending')
})

test('tool-call exhaustion returns results for the whole batch and leaves a final answer opportunity', async () => {
  const { store, book } = await fixture()
  let step = 0
  let rejected = 0
  const runtime: ModelRuntime = {
    async complete(messages, _signal, delta, options) {
      if (options?.tools === 'none') {
        const results = messages.filter((m) => m.role === 'tool')
        rejected = results.filter((m) => JSON.parse(m.content!).code === 'BUDGET').length
        assert.equal(results.length, 79)
        delta('已完成')
        return { text: '已完成', calls: [] }
      }
      // 19 + 20 + 20 + 20 exceeds the budget inside the fourth batch.
      const count = step === 0 ? 19 : 20
      step++
      return {
        text: '',
        calls: Array.from({ length: count }, (_, n) =>
          call(`call-${step}-${n}`, 'create', {
            directory: 'book/notes',
            title: '建议',
            content: '相同建议'
          })
        )
      }
    }
  }
  const service = new AgentService(store, () => runtime)
  const c = await service.create(book.id, '讨论')
  await service.start(book.id, c.id, '自由构想', {})
  await service.idle()
  const state = await service.snapshot(book.id)
  assert.equal(state.conversations[0].lastTurn?.state, 'completed')
  assert.equal(rejected, 19)
  assert.equal(state.proposals.length, 1)
})

test('adjacent reads run with bounded concurrency, preserve result order and produce a trace without manuscript text', async (t) => {
  const { store, book } = await fixture()
  const doc = (
    await store.create(book.id, 'notes', '私密标题', { content: '不能进入诊断的私密原文' })
  ).document
  let running = 0,
    peak = 0
  const read = BookDocumentAdapter.prototype.read
  t.mock.method(
    BookDocumentAdapter.prototype,
    'read',
    async function (this: BookDocumentAdapter, args: Record<string, unknown>) {
      running++
      peak = Math.max(peak, running)
      try {
        await new Promise((resolve) => setTimeout(resolve, 15))
        return await read.call(this, args)
      } finally {
        running--
      }
    }
  )
  const runtime = new ScriptedRuntime((messages, step) => {
    if (!step)
      return {
        text: '',
        calls: Array.from({ length: 5 }, (_, n) =>
          call(`r${n}`, 'read', { path: documentPath(doc) })
        )
      }
    assert.deepEqual(
      messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
      ['r0', 'r1', 'r2', 'r3', 'r4']
    )
    return { text: '完成', calls: [] }
  })
  const service = new AgentService(store, () => runtime)
  const c = await service.create(book.id, '测试')
  await service.start(book.id, c.id, '私密用户请求', {})
  await service.idle()
  assert.equal(peak, executionBudget.readConcurrency)
  const raw = await fs.readFile(join(book.root, '.workspace/diagnostics', `${c.id}.jsonl`), 'utf8')
  const records = raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  const snapshot = records.find((r) => r.phase === 'turn.started')
  assert.equal(snapshot.snapshot.execution.readRounds, 18)
  assert.ok(
    records
      .filter((r) => r.phase === 'tool.completed')
      .every((r) => r.argsDigest && r.resultDigest && r.snapshotDigest === snapshot.snapshotDigest)
  )
  const delivered = records.find((r) => r.phase === 'evidence.delivered' && r.round === 2)
  assert.deepEqual(delivered.deliveredCallIds, ['r0', 'r1', 'r2', 'r3', 'r4'])
  assert.equal(delivered.evidence[0].version, doc.version)
  assert.equal(records.at(-1).phase, 'turn.completed')
  for (const secret of ['私密标题', '不能进入诊断的私密原文', '私密用户请求'])
    assert.equal(raw.includes(secret), false)
})

test('related context expands chapter to outline to aliases, bounds depth and never grants reading evidence', async () => {
  const { store, book } = await fixture()
  const chapter = (await store.create(book.id, 'chapters', '第一章', { content: '城门开启' }))
    .document
  const character = (
    await store.create(book.id, 'characters', '陆行舟', { content: '别名：白衣客、陆先生' })
  ).document
  const setting = (await store.create(book.id, 'settings', '城门规则', { content: '只在夜晚开启' }))
    .document
  const outline = (
    await store.create(book.id, 'outlines', '夜探安排', {
      content: `[[chapter:${chapter.id}|第一章]] 白衣客前来。[[setting:${setting.id}|城门规则]]`
    })
  ).document
  const distant = (
    await store.create(book.id, 'notes', '旁支', {
      content: `[[character:${character.id}|陆行舟]]`
    })
  ).document
  const docs = [chapter, character, setting, outline, distant]
  const context = relatedContext(docs, chapter.id)
  assert.equal(context.related.find((r) => r.id === outline.id)?.depth, 1)
  const hit = context.related.find((r) => r.id === character.id)!
  assert.equal(hit.depth, 2)
  assert.ok(hit.reasons.includes('alias') && hit.candidate)
  assert.equal(context.related.find((r) => r.id === setting.id)?.candidate, false)
  assert.equal(
    context.related.some((r) => r.id === distant.id),
    false
  )
  assert.equal(relatedContext(docs, chapter.id, 1).truncated, true)
  assert.deepEqual(
    documentAliases('```\n别名：伪造称呼\n```\n### 别名\n- 白衣客\n- 陆先生\n### 外貌\n- 高个子'),
    ['白衣客', '陆先生']
  )
  const adapter = new BookDocumentAdapter(
    store,
    book.id,
    { documentId: chapter.id },
    '',
    () => [],
    undefined,
    true
  )
  const view = (await adapter.read({ path: 'book/views/outline.md' })) as { text: string }
  assert.ok(JSON.parse(view.text).related.some((r: { id: string }) => r.id === character.id))
  adapter.acknowledgeDelivery()
  assert.equal(adapter.evidence.size, 0)
  await assert.rejects(adapter.target(documentPath(character), true), /先 read/)
})
