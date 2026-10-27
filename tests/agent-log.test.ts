import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DocumentStore } from '../src/main/documents'
import { AgentService } from '../src/main/agent/service'
import {
  ApiRuntime,
  ScriptedRuntime,
  type ModelRuntime,
  type RuntimeTraceEvent
} from '../src/main/agent/runtime'

async function fixture() {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const root = await fs.mkdtemp(resolve('.test-artifacts/agent-log-'))
  const store = new DocumentStore()
  const book = await store.createBook(root, '日志测试')
  return { store, book }
}
function response(delta: unknown, finish = 'stop'): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
    {
      headers: { 'Content-Type': 'text/event-stream' }
    }
  )
}

test('export persists exact API requests, full tool results and responses across restart without auth secrets', async (t) => {
  const { store, book } = await fixture()
  const d = (
    await store.create(book.id, 'notes', '旧资料', { content: '完整上下文\n' + '原文'.repeat(900) })
  ).document
  const bodies: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    bodies.push(JSON.parse(String(options?.body)))
    if (bodies.length === 1)
      return response(
        {
          content: '先读资料。',
          tool_calls: [
            {
              index: 0,
              id: 'read-1',
              type: 'function',
              function: {
                name: 'read',
                arguments: JSON.stringify({ path: `book/notes/${d.id}.md` })
              }
            }
          ]
        },
        'tool_calls'
      )
    return response({ content: '完整回复：已分析选区。' })
  })
  const service = new AgentService(
    store,
    () =>
      new ApiRuntime(
        {
          baseUrl: 'http://127.0.0.1:1234/v1',
          model: 'test-model',
          hasKey: true
        },
        'never-export-api-secret'
      )
  )
  const c = await service.create(book.id, '日志会话')
  await assert.rejects(service.exportTurnLog(book.id, c.id), /尚无/)
  const turn = await service.start(book.id, c.id, '分析选区并参考资料', {
    documentId: d.id,
    savedVersion: d.version,
    selection: { from: 0, to: 5, text: '完整上下文' }
  })
  await service.idle()
  const exported = await service.exportTurnLog(book.id, c.id)
  assert.equal(exported.complete, true)
  assert.equal(exported.log!.turnId, turn)
  assert.equal(exported.log!.rounds.length, 2)
  const requests = exported
    .log!.rounds.flatMap((r) => r.requests)
    .filter((r) => r.type === 'request')
  assert.deepEqual(
    requests.map((r) => r.body),
    bodies
  )
  assert.equal(exported.log!.tools.length, 1)
  assert.equal(
    (exported.log!.tools[0].result as { lines: { text: string; eol?: string }[] }).lines
      .map((line) => line.text + (line.eol ?? ''))
      .join(''),
    d.content
  )
  assert.equal(exported.log!.response!.text, '先读资料。完整回复：已分析选区。')
  assert.equal(exported.log!.rounds[1].response!.text, '完整回复：已分析选区。')
  assert.ok(
    bodies[1].messages.some(
      (m: any) =>
        m.role === 'tool' &&
        JSON.parse(m.content)
          .lines.map((line: { text: string; eol?: string }) => line.text + (line.eol ?? ''))
          .join('') === d.content
    )
  )
  assert.equal(JSON.stringify(exported).includes('never-export-api-secret'), false)
  await store.save({
    bookId: book.id,
    id: d.id,
    expectedVersion: d.version,
    title: d.title,
    content: '发送后改动，不应冒充原始上下文'
  })
  const reopened = new DocumentStore()
  await reopened.openBook(book.root)
  const restarted = new AgentService(
    reopened,
    () => new ScriptedRuntime(() => ({ text: '第二轮回复', calls: [] }))
  )
  const restored = await restarted.exportTurnLog(book.id, c.id)
  assert.deepEqual(restored.log, exported.log)
  assert.equal(JSON.stringify(restored.log).includes('发送后改动'), false)
  const next = await restarted.start(book.id, c.id, '第二轮消息', {})
  await restarted.idle()
  const latest = await restarted.exportTurnLog(book.id, c.id)
  assert.equal(latest.log!.turnId, next)
  assert.equal(latest.log!.rounds.length, 1)
  assert.equal(latest.log!.user.text, '第二轮消息')
  const files = await fs.readdir(join(book.root, '.workspace', 'agent-turn-logs'))
  assert.deepEqual(files, [`${c.id}.json`])
  await assert.rejects(restarted.exportTurnLog(book.id, 'conversation_other'), /会话不存在/)
})

test('retry trace captures each request budget and records failed attempts without headers', async (t) => {
  const traces: RuntimeTraceEvent[] = []
  let n = 0
  t.mock.method(globalThis, 'fetch', async () => response({}, ++n === 1 ? 'length' : 'stop'))
  const runtime = new ApiRuntime(
    {
      baseUrl: 'http://127.0.0.1:1234/v1',
      model: 'test',
      hasKey: true,
      outputTokens: 512,
      retryOutputTokens: 1024
    },
    'secret'
  )
  await runtime.complete(
    [{ role: 'user', content: '完整输入' }],
    new AbortController().signal,
    () => {},
    {
      tools: 'none',
      trace: async (event) => {
        traces.push(event)
      }
    }
  )
  assert.deepEqual(
    traces.map((e) => e.type),
    ['request', 'error', 'request', 'response']
  )
  assert.deepEqual(
    traces.filter((e) => e.type === 'request').map((e) => e.body.max_tokens),
    [512, 1024]
  )
  assert.equal(JSON.stringify(traces).includes('secret'), false)
})

test('cancelled turns export partial response and inputs; active turns cannot export early', async () => {
  const { store, book } = await fixture()
  let entered!: () => void
  const ready = new Promise<void>((r) => {
    entered = r
  })
  const runtime: ModelRuntime = {
    complete: async (_messages, signal, delta) => {
      delta('已收到的部分回复')
      entered()
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      )
    }
  }
  const service = new AgentService(store, () => runtime)
  const c = await service.create(book.id, '取消日志')
  await service.start(book.id, c.id, '等待取消', {})
  await ready
  await assert.rejects(service.exportTurnLog(book.id, c.id), /等待本轮结束/)
  await service.cancel(book.id)
  await service.idle()
  const exported = await service.exportTurnLog(book.id, c.id)
  assert.equal(exported.complete, true)
  assert.equal(exported.log!.state, 'cancelled')
  assert.equal(exported.log!.rounds[0].partialText, '已收到的部分回复')
  assert.match(exported.log!.response!.text, /已收到的部分回复.*任务已取消/s)
  assert.equal(exported.log!.rounds[0].input!.messages.at(-1)!.content, '等待取消')
})

test('legacy or corrupted full logs export available records and explicitly mark missing context', async () => {
  const { store, book } = await fixture()
  const service = new AgentService(
    store,
    () => new ScriptedRuntime(() => ({ text: '回复', calls: [] }))
  )
  const c = await service.create(book.id, '旧日志')
  await service.start(book.id, c.id, '旧消息', {})
  await service.idle()
  const logPath = join(book.root, '.workspace', 'agent-turn-logs', `${c.id}.json`)
  for (const content of [
    '{broken',
    JSON.stringify({ format: 1, bookId: book.id, conversationId: c.id, turnId: 'older-turn' })
  ]) {
    await fs.writeFile(logPath, content)
    const restarted = new AgentService(
      store,
      () => new ScriptedRuntime(() => ({ text: '', calls: [] }))
    )
    const exported = await restarted.exportTurnLog(book.id, c.id)
    assert.equal(exported.complete, false)
    assert.equal(exported.log, null)
    assert.match(exported.notice, /未保存完整运行日志/)
    assert.deepEqual(
      exported.messages.map((m) => m.text),
      ['旧消息', '回复']
    )
  }
})
