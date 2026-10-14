import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AgentMessage } from '../src/shared/agent'
import { rewriteHistory, rewriteTarget } from '../src/main/agent/targetRewrite'
import { AgentService } from '../src/main/agent/service'
import { DocumentStore } from '../src/main/documents'
import { type ModelRuntime, type RuntimeMessage, ScriptedRuntime } from '../src/main/agent/runtime'

function pair(n: number, outcome: AgentMessage['outcome'] = 'completed'): AgentMessage[] {
  return [
    { id: `u${n}`, turnId: `t${n}`, role: 'user', text: `问题${n}`, sources: [] },
    {
      id: `a${n}`,
      turnId: `t${n}`,
      role: 'assistant',
      text: `过程文字${n}最终回答${n}`,
      finalResponse: `最终回答${n}`,
      outcome,
      sources: []
    }
  ]
}
const current: AgentMessage = {
  id: 'current',
  turnId: 'current',
  role: 'user',
  text: '按刚才的第二个方案继续，只讨论',
  sources: []
}
const target = { target: '继续讨论第二个方案', constraints: ['只讨论，不修改'], unresolved: [] }

test('history uses only paired successful final responses, newest eight, in chronological order', () => {
  const history = Array.from({ length: 11 }, (_, n) => pair(n)).flat()
  history.push(...pair(20, 'failed'), ...pair(21, 'cancelled'))
  const legacy = pair(22)
  delete legacy[1].outcome
  delete legacy[1].finalResponse
  history.push(...legacy, current)
  const selected = rewriteHistory(history)
  assert.deepEqual(
    selected.map((t) => t.turnId),
    Array.from({ length: 8 }, (_, i) => `t${i + 3}`)
  )
  assert.equal(selected[0].response, '最终回答3')
  assert.equal(JSON.stringify(selected).includes('过程文字'), false)
  assert.equal(rewriteHistory([pair(1)[0], pair(2)[1]]).length, 0)
})

test('check and rewrite use identical raw history without tools and retain the original prompt', async () => {
  const inputs: RuntimeMessage[][] = []
  const runtime: ModelRuntime = {
    async complete(messages, _signal, delta, options) {
      inputs.push(structuredClone(messages))
      assert.equal(options?.tools, 'none')
      const text = JSON.stringify(
        inputs.length === 1 ? { needsRewrite: true, reason: '需要解析第二个方案' } : target
      )
      delta(text)
      return { text, calls: [] }
    }
  }
  const result = await rewriteTarget(
    runtime,
    [...pair(1), current],
    new AbortController().signal,
    () => ({})
  )
  assert.equal(result.status, 'rewritten')
  assert.deepEqual(result.target, target)
  assert.deepEqual(inputs[0][1], inputs[1][1])
  assert.deepEqual(JSON.parse(inputs[0][1].content!), {
    prompt: current.text,
    history: rewriteHistory(pair(1))
  })
})

test('self-contained requests skip rewrite and malformed output or tool calls fall back', async () => {
  for (const response of [
    { text: JSON.stringify({ needsRewrite: false, reason: '请求完整' }), calls: [] },
    { text: '{"needsRewrite":"false","reason":"wrong type"}', calls: [] },
    { text: 'not JSON', calls: [] },
    { text: '{}', calls: [{ id: 'x', name: 'write', arguments: '{}' }] }
  ]) {
    let calls = 0
    const runtime = new ScriptedRuntime(() => {
      calls++
      return response
    })
    const result = await rewriteTarget(runtime, [current], new AbortController().signal, () => ({}))
    assert.equal(calls, 1)
    assert.equal(result.status, response.text.includes('请求完整') ? 'skipped' : 'fallback')
    assert.equal(result.target, null)
  }
  const runtime = new ScriptedRuntime((_m, n) => ({
    text: n ? '{"target":"missing lists"}' : '{"needsRewrite":true,"reason":"继续"}',
    calls: []
  }))
  assert.equal(
    (await rewriteTarget(runtime, [current], new AbortController().signal, () => ({}))).status,
    'fallback'
  )
})

test('budget removes whole oldest pairs and cancellation never falls through to main execution', async () => {
  const old = pair(1)
  old[1].finalResponse = '很长的历史'.repeat(10000)
  const runtime: ModelRuntime = {
    policy: { contextTokens: 5000, outputTokens: 256, retryOutputTokens: 256 },
    async complete(messages) {
      assert.deepEqual(JSON.parse(messages[1].content!).history, rewriteHistory(pair(2)))
      return { text: '{"needsRewrite":false,"reason":"完整"}', calls: [] }
    }
  }
  const result = await rewriteTarget(
    runtime,
    [...old, ...pair(2), current],
    new AbortController().signal,
    () => ({})
  )
  assert.equal(result.omittedTurns, 1)
  const controller = new AbortController()
  const hanging = new ScriptedRuntime(() => {
    controller.abort(new Error('cancel test'))
    return new Promise(() => {})
  })
  await assert.rejects(
    rewriteTarget(hanging, [current], controller.signal, () => ({})),
    /cancel test/
  )
})

async function fixture(runtime: ModelRuntime) {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const root = await fs.mkdtemp(resolve('.test-artifacts/target-rewrite-'))
  const store = new DocumentStore()
  const book = await store.createBook(root, '目标改写测试')
  const service = new AgentService(store, () => runtime)
  const conversation = await service.create(book.id, '测试')
  return { store, book, service, conversation }
}

test('a rewritten target exceeding the main context budget falls back without losing the prompt', async () => {
  let calls = 0
  const runtime: ModelRuntime = {
    policy: { contextTokens: 9000, outputTokens: 256, retryOutputTokens: 256 },
    async complete(messages, _signal, delta) {
      calls++
      if (calls === 1) return { text: '{"needsRewrite":true,"reason":"延续"}', calls: [] }
      if (calls === 2)
        return {
          text: JSON.stringify({ target: '目标'.repeat(3900), constraints: [], unresolved: [] }),
          calls: []
        }
      const request = JSON.parse(messages.at(-1)!.content!)
      assert.equal(request.originalPrompt, current.text)
      assert.equal(request.rewriteStatus, 'fallback')
      assert.equal(request.targetRewrite, null)
      delta('预算回退后的回答')
      return { text: '预算回退后的回答', calls: [] }
    }
  }
  const { book, service, conversation } = await fixture(runtime)
  await service.start(book.id, conversation.id, current.text, { targetRewrite: true })
  await service.idle()
  const log = await service.exportTurnLog(book.id, conversation.id)
  assert.equal(calls, 3)
  assert.equal(log.turn!.state, 'completed')
  assert.match(log.log!.user.rewrite!.reason, /上下文预算/)
})

test('service switch, structured main input, persisted final-only history and exported preprocessing logs', async () => {
  const inputs: RuntimeMessage[][] = []
  const runtime = new ScriptedRuntime((messages, step) => {
    inputs.push(structuredClone(messages))
    if (step === 0)
      return {
        text: '先查看目录。',
        calls: [{ id: 'list', name: 'list_files', arguments: '{"path":"book/notes/"}' }]
      }
    if (step === 1) return { text: '最终回答：方案一和方案二', calls: [] }
    if (step === 2) return { text: '{"needsRewrite":true,"reason":"解析第二个方案"}', calls: [] }
    if (step === 3) return { text: JSON.stringify(target), calls: [] }
    return { text: '已经继续讨论。', calls: [] }
  })
  const { store, book, service, conversation } = await fixture(runtime)
  await service.start(book.id, conversation.id, '讨论两个方案', {})
  await service.idle()
  assert.equal(inputs.length, 2)
  assert.equal(inputs[0].at(-1)!.content, '讨论两个方案')
  // Reload from disk to prove final responses are durable, even with the feature off.
  const restarted = new AgentService(store, () => runtime)
  await restarted.start(book.id, conversation.id, current.text, { targetRewrite: true })
  await restarted.idle()
  assert.equal(inputs.length, 5)
  const history = JSON.parse(inputs[2][1].content!).history
  assert.equal(history.length, 1)
  assert.equal(history[0].response, '最终回答：方案一和方案二')
  const main = JSON.parse(inputs[4].at(-1)!.content!)
  assert.deepEqual(main, {
    originalPrompt: current.text,
    targetRewrite: target,
    rewriteStatus: 'rewritten'
  })
  const exported = await restarted.exportTurnLog(book.id, conversation.id)
  assert.equal(exported.log!.preprocessing!.length, 2)
  assert.equal(exported.log!.preprocessing![1].response!.text, JSON.stringify(target))
  assert.equal(exported.log!.rounds.length, 1)
  assert.equal(exported.log!.user.text, current.text)
  assert.deepEqual(exported.log!.user.rewrite!.target, target)
  assert.equal(exported.log!.response!.text, '已经继续讨论。')
})

test('service fallback continues original request, malformed options rejected, cancellation stops all later stages', async () => {
  const inputs: RuntimeMessage[][] = []
  const runtime = new ScriptedRuntime((messages, step) => {
    inputs.push(structuredClone(messages))
    return { text: step ? '主模型回答' : 'bad json', calls: [] }
  })
  const { book, service, conversation, store } = await fixture(runtime)
  await assert.rejects(
    service.start(book.id, conversation.id, '请求', { targetRewrite: 'true' } as never),
    /选项无效/
  )
  await service.start(book.id, conversation.id, current.text, { targetRewrite: true })
  await service.idle()
  assert.equal(inputs.length, 2)
  assert.equal(JSON.parse(inputs[1].at(-1)!.content!).rewriteStatus, 'fallback')
  assert.equal((await service.exportTurnLog(book.id, conversation.id)).turn!.state, 'completed')
  let started!: () => void
  const ready = new Promise<void>((r) => {
    started = r
  })
  let calls = 0
  const blocked = new AgentService(
    store,
    () =>
      new ScriptedRuntime(() => {
        calls++
        started()
        return new Promise(() => {})
      })
  )
  await blocked.start(book.id, conversation.id, '取消本轮', { targetRewrite: true })
  await ready
  await blocked.cancel(book.id)
  await blocked.idle()
  assert.equal(calls, 1)
  const cancelled = await blocked.exportTurnLog(book.id, conversation.id)
  assert.equal(cancelled.turn!.state, 'cancelled')
  assert.equal(cancelled.log!.rounds.length, 0)
})
