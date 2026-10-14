import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import { ApiRuntime } from '../src/main/agent/runtime'
import { AgentService } from '../src/main/agent/service'
import { DocumentStore } from '../src/main/documents'

const googleUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/'
const complete = (runtime: ApiRuntime) =>
  runtime.complete([{ role: 'user', content: '协议测试' }], new AbortController().signal, () => {})
const tool = (id: string, args = '{"path":"book/"}') => ({
  id,
  type: 'function',
  function: { name: 'list_files', arguments: args }
})
function stream(chunks: unknown[]): Response {
  return new Response(
    chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n',
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}
const chunk = (calls: unknown[], finish?: string) => ({
  choices: [{ delta: { tool_calls: calls }, finish_reason: finish }]
})

test('retry diagnostics retain each attempt usage and final-answer mode sends no tools', async (t) => {
  const bodies: any[] = []
  const events: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    bodies.push(JSON.parse(String(options?.body)))
    return stream([
      {
        choices: [{ delta: {}, finish_reason: bodies.length === 1 ? 'length' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: bodies.length === 1 ? 20 : 5 }
      }
    ])
  })
  const runtime = new ApiRuntime(
    {
      baseUrl: googleUrl,
      model: 'test',
      hasKey: false,
      outputTokens: 512,
      retryOutputTokens: 1024
    },
    'private-api-key'
  )
  await runtime.complete(
    [{ role: 'user', content: 'private-manuscript' }],
    new AbortController().signal,
    () => {},
    {
      tools: 'none',
      diagnostic: async (event) => {
        events.push(event)
      }
    }
  )
  assert.ok(bodies.every((b) => !b.tools && !b.tool_choice))
  assert.deepEqual(
    events.map((e) => e.phase),
    ['request.started', 'request.failed', 'request.started', 'request.completed']
  )
  assert.equal(events[1].outputTokens, 20)
  assert.equal(events[1].code, 'OUTPUT_TRUNCATED')
  assert.equal(events[3].attempt, 2)
  assert.equal(events[3].outputTokens, 5)
  assert.equal(JSON.stringify(events).includes('private'), false)
})

test('write-only requests exclude reading tools', async (t) => {
  let names: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    names = JSON.parse(String(options?.body)).tools.map((tool: any) => tool.function.name)
    return stream([{ choices: [{ delta: { content: '完成' }, finish_reason: 'stop' }] }])
  })
  await new ApiRuntime({ baseUrl: googleUrl, model: 'test', hasKey: false }, '').complete(
    [],
    new AbortController().signal,
    () => {},
    { tools: 'write' }
  )
  assert.deepEqual(names, ['create', 'write', 'edit'])
})

test('truncated tool arguments retry once with a larger limit, never returning partial calls', async (t) => {
  const limits: number[] = []
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string | URL | Request, options?: RequestInit) => {
      limits.push(JSON.parse(String(options?.body)).max_tokens)
      return limits.length === 1
        ? stream([chunk([{ ...tool('retry', '{"path":'), index: 0 }], 'length')])
        : stream([chunk([{ ...tool('complete'), index: 0 }], 'tool_calls')])
    }
  )
  const result = await complete(
    new ApiRuntime(
      {
        baseUrl: googleUrl,
        model: 'test',
        hasKey: false,
        outputTokens: 512,
        retryOutputTokens: 1024
      },
      ''
    )
  )
  assert.deepEqual(limits, [512, 1024])
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].id, 'complete')
})

test('Gemini indexless parallel calls remain separate and retain thought signatures', async (t) => {
  const extra = { google: { thought_signature: 'synthetic-signature' } }
  t.mock.method(globalThis, 'fetch', async () =>
    stream([
      chunk([{ ...tool('a'), extra_content: extra }]),
      chunk([tool('b', '{"path":"book/notes/"}')], 'stop')
    ])
  )
  const result = await complete(
    new ApiRuntime({ baseUrl: googleUrl, model: 'test', hasKey: false }, '')
  )
  assert.deepEqual(
    result.calls.map((c) => c.id),
    ['a', 'b']
  )
  assert.deepEqual(
    result.calls.map((c) => JSON.parse(c.arguments).path),
    ['book/', 'book/notes/']
  )
  assert.deepEqual(result.calls[0].extra_content, extra)
})

test('indexless fragments use IDs even when parallel calls arrive in reversed order', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    stream([
      chunk([tool('a', '{"path":'), tool('b', '{"path":')]),
      chunk([tool('b', '"book/notes/"}'), tool('a', '"book/"}')], 'tool_calls')
    ])
  )
  const result = await complete(
    new ApiRuntime({ baseUrl: googleUrl, model: 'test', hasKey: false }, '')
  )
  assert.deepEqual(
    result.calls.map((c) => c.name),
    ['list_files', 'list_files']
  )
  assert.deepEqual(
    result.calls.map((c) => JSON.parse(c.arguments).path),
    ['book/', 'book/notes/']
  )
})

test('ambiguous, conflicting, malformed and truncated calls remain non-executable', async (t) => {
  const cases = [
    {
      chunks: [chunk([{ function: { name: 'read', arguments: '{}' } }], 'stop')],
      error: /缺少序号和标识/
    },
    { chunks: [chunk([{ ...tool('a'), index: -1 }], 'stop')], error: /序号无效/ },
    {
      chunks: [chunk([{ ...tool('a'), index: 0 }]), chunk([{ ...tool('b'), index: 0 }], 'stop')],
      error: /冲突/
    },
    { chunks: [chunk([tool('a', '{"path":')], 'stop')], error: /完整 JSON/ },
    { chunks: [chunk([tool('a', '[]')], 'stop')], error: /JSON 对象/ },
    { chunks: [chunk([tool('a')], 'length')], error: /截断/ },
    { chunks: [chunk([tool('a')])], error: /截断/ }
  ]
  for (const scenario of cases) {
    const mock = t.mock.method(globalThis, 'fetch', async () => stream(scenario.chunks))
    await assert.rejects(
      complete(new ApiRuntime({ baseUrl: googleUrl, model: 'test', hasKey: false }, '')),
      scenario.error
    )
    mock.mock.restore()
  }
})

test('stop normalization is scoped to Google; ordinary indexed streaming is unchanged', async (t) => {
  let finish = 'stop'
  t.mock.method(globalThis, 'fetch', async () =>
    stream([chunk([{ ...tool('a'), index: 0 }], finish)])
  )
  const runtime = new ApiRuntime(
    { baseUrl: 'https://example.test/v1', model: 'test', hasKey: false },
    ''
  )
  await assert.rejects(complete(runtime), /没有完整结束/)
  finish = 'tool_calls'
  assert.equal((await complete(runtime)).calls[0].id, 'a')
})

test('Agent sends Gemini tool signatures back with results and completes without manuscript writes', async (t) => {
  let requests = 0
  const extra = { google: { thought_signature: 'synthetic-round-trip-signature' } }
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    requests++
    const body = JSON.parse(String(options?.body))
    if (requests === 1) return stream([chunk([{ ...tool('a'), extra_content: extra }], 'stop')])
    const callMessage = body.messages.find((m: { tool_calls?: unknown[] }) => m.tool_calls)
    assert.deepEqual(callMessage.tool_calls[0].extra_content, extra)
    assert.equal(callMessage.tool_calls[0].id, 'a')
    assert.equal(body.messages.at(-1).role, 'tool')
    assert.equal(body.messages.at(-1).tool_call_id, 'a')
    return stream([
      { choices: [{ delta: { content: '测试书库为空，可以讨论构想。' }, finish_reason: 'stop' }] }
    ])
  })
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const parent = await fs.mkdtemp(resolve('.test-artifacts/gemini-'))
  const store = new DocumentStore()
  const book = await store.createBook(parent, '协议测试作品')
  const service = new AgentService(
    store,
    () => new ApiRuntime({ baseUrl: googleUrl, model: 'test', hasKey: false }, '')
  )
  const c = await service.create(book.id, '协议验证')
  await service.start(book.id, c.id, '请查看书内资料再讨论构想', {})
  await service.idle()
  const snapshot = await service.snapshot(book.id)
  assert.equal(snapshot.conversations[0].lastTurn?.state, 'completed')
  assert.equal(snapshot.conversations[0].messages.at(-1)?.text, '测试书库为空，可以讨论构想。')
  assert.equal(requests, 2)
  assert.equal((await store.agentDocuments(book.id)).length, 0)
  assert.equal(JSON.stringify(snapshot).includes('synthetic-round-trip-signature'), false)
})

test('non-streaming compatible responses retain signatures too', async (t) => {
  const extra = { google: { thought_signature: 'synthetic-json-signature' } }
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      choices: [
        {
          message: { tool_calls: [{ ...tool('a'), extra_content: extra }] },
          finish_reason: 'tool_calls'
        }
      ]
    })
  )
  const result = await complete(
    new ApiRuntime({ baseUrl: googleUrl, model: 'test', hasKey: false }, '')
  )
  assert.deepEqual(result.calls[0].extra_content, extra)
})
