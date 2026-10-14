import test from 'node:test'
import assert from 'node:assert/strict'
import { ApiRuntime } from '../src/main/agent/runtime'

test('DeepSeek non-thinking uses the native switch without changing other providers', async (t) => {
  const bodies: any[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options?: RequestInit) => {
    bodies.push(JSON.parse(String(options?.body)))
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  })
  for (const baseUrl of ['https://api.deepseek.com', 'https://compatible.example/v1']) {
    await new ApiRuntime({ baseUrl, model: 'test', hasKey: false, reasoning: 'none' }, '').complete(
      [{ role: 'user', content: 'hello' }],
      new AbortController().signal,
      () => {}
    )
  }
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' })
  assert.equal(bodies[0].reasoning_effort, undefined)
  assert.equal(bodies[1].thinking, undefined)
  assert.equal(bodies[1].reasoning_effort, 'none')
})
