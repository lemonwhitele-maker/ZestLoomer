import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { ToolApiService, cleanConversationTitle } from '../src/main/toolApi'
import { DocumentStore } from '../src/main/documents'
import { AgentService } from '../src/main/agent/service'
import { ScriptedRuntime } from '../src/main/agent/runtime'

const profiles = {
  get(id = 'primary') {
    if (!['primary', 'cheap'].includes(id)) throw new Error('配置不存在')
    return { baseUrl: 'http://127.0.0.1:1234/v1', model: `${id}-model`, hasKey: true }
  },
  key(id = 'primary') {
    return `synthetic-${id}-key`
  }
}
async function folder() {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  return fs.mkdtemp(resolve('.test-artifacts/tools-'))
}

test('tool API chooses saved profiles, bounds title input and persists only profile identity', async () => {
  const path = join(await folder(), 'tool-api.json')
  const requests: { body: any; headers: any }[] = []
  const mockFetch = (async (_url, init) => {
    requests.push({ body: JSON.parse(String(init?.body)), headers: init?.headers })
    return Response.json({ choices: [{ message: { content: '标题：“城门规则整理”' } }] })
  }) as typeof fetch
  const service = new ToolApiService(path, profiles, mockFetch)
  assert.equal(await service.generateTitle('未启用', '不会发送'), null)
  assert.equal(requests.length, 0)
  await service.save({ enabled: true, profileId: 'cheap' })
  assert.equal(await service.generateTitle('甲'.repeat(4000), '乙'.repeat(6000)), '城门规则整理')
  assert.equal(requests[0].body.model, 'cheap-model')
  assert.equal(requests[0].headers.Authorization, 'Bearer synthetic-cheap-key')
  assert.equal(requests[0].body.messages.length, 2)
  assert.equal(
    requests[0].body.messages[1].content,
    `用户请求：\n${'甲'.repeat(2000)}\n\n助手最终回答：\n${'乙'.repeat(3000)}`
  )
  assert.equal(requests[0].body.tools, undefined)
  assert.equal(requests[0].body.stream, false)
  const stored = await fs.readFile(path, 'utf8')
  assert.deepEqual(JSON.parse(stored), { format: 1, enabled: true, profileId: 'cheap' })
  assert.ok(!stored.includes('synthetic-'))
  const restarted = new ToolApiService(path, profiles, mockFetch)
  await restarted.load()
  assert.deepEqual(restarted.get(), service.get())
  await restarted.save({ enabled: true, profileId: '' })
  await restarted.generateTitle('请求', '回答')
  assert.equal(requests[1].body.model, 'primary-model')
  assert.throws(() => restarted.save({ enabled: true, profileId: 'missing' }))
  assert.deepEqual(restarted.get(), { enabled: true, profileId: '' })
})

test('tool API tests draft selections without saving, and invalid output or service errors fall back', async () => {
  const path = join(await folder(), 'tool-api.json')
  let content = 'OK'
  let status = 200
  const service = new ToolApiService(path, profiles, (async () =>
    Response.json({ choices: [{ message: { content } }] }, { status })) as typeof fetch)
  const result = await service.test({ enabled: false, profileId: 'cheap' })
  assert.equal(result.model, 'cheap-model')
  assert.deepEqual(service.get(), { enabled: false, profileId: '' })
  await assert.rejects(fs.access(path))
  await service.save({ enabled: true, profileId: 'cheap' })
  content = '过长的模型回复'.repeat(10)
  assert.equal(await service.generateTitle('请求', '回答'), null)
  content = ''
  assert.equal(await service.generateTitle('请求', '回答'), null)
  status = 401
  assert.equal(await service.generateTitle('请求', '回答'), null)
  await assert.rejects(service.test(service.get()), /401/)
})

test('failed tool API persistence keeps the current selection and permits retry', async () => {
  const root = await folder()
  const blocker = join(root, 'config')
  await fs.writeFile(blocker, 'temporary obstruction')
  const service = new ToolApiService(join(blocker, 'tool-api.json'), profiles)
  await assert.rejects(service.save({ enabled: true, profileId: 'cheap' }))
  assert.deepEqual(service.get(), { enabled: false, profileId: '' })
  await fs.unlink(blocker)
  await fs.mkdir(blocker)
  assert.deepEqual(await service.save({ enabled: true, profileId: 'cheap' }), {
    enabled: true,
    profileId: 'cheap'
  })
})

test('tool API cancellation stops a pending request without changing saved configuration', async () => {
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const service = new ToolApiService(
    join(await folder(), 'tool-api.json'),
    profiles,
    ((_url, init) =>
      new Promise((_resolve, reject) => {
        started()
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      })) as typeof fetch
  )
  const testing = service.test({ enabled: true, profileId: 'cheap' })
  await ready
  service.cancelTest()
  await assert.rejects(testing, /测试已取消/)
  assert.deepEqual(service.get(), { enabled: false, profileId: '' })
})

test('conversation title cleanup accepts ordinary wrappers but rejects empty, long and control text', () => {
  assert.equal(cleanConversationTitle('```text\n标题：“城门规则整理”\n```'), '城门规则整理')
  assert.equal(cleanConversationTitle('1. 《开篇人物讨论》'), '开篇人物讨论')
  assert.equal(cleanConversationTitle(''), null)
  assert.equal(cleanConversationTitle('很长'.repeat(20)), null)
  assert.equal(cleanConversationTitle('含\0控制字符'), null)
  assert.equal(cleanConversationTitle({ text: '对象' }), null)
})

async function agentFixture() {
  const parent = await folder()
  const store = new DocumentStore()
  const book = await store.createBook(parent, '标题合成验证')
  return { store, book }
}
const runtime = () => new ScriptedRuntime(() => ({ text: '回答片段', calls: [] }))

test('automatic titles do not block completion, survive restart and run only once per conversation', async () => {
  const { store, book } = await agentFixture()
  let finish!: (title: string) => void
  let titled!: () => void
  const titleReady = new Promise<void>((resolve) => {
    titled = resolve
  })
  let calls = 0
  const service = new AgentService(
    store,
    runtime,
    (event) => {
      if (event.type === 'title') titled()
    },
    async (user, answer) => {
      calls++
      assert.equal(user, '首次请求')
      assert.equal(answer, '回答片段')
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    }
  )
  const c = await service.create(book.id, '')
  await service.start(book.id, c.id, '首次请求', {})
  await service.idle()
  let snapshot = await service.snapshot(book.id)
  assert.equal(snapshot.active, null)
  assert.equal(snapshot.conversations[0].lastTurn?.state, 'completed')
  assert.equal(snapshot.conversations[0].title, '首次请求')
  finish('城门规则整理')
  await titleReady
  await service.start(book.id, c.id, '后续请求', {})
  await service.idle()
  assert.equal(calls, 1)
  const restarted = new AgentService(store, runtime)
  snapshot = await restarted.snapshot(book.id)
  assert.equal(snapshot.conversations[0].title, '城门规则整理')
  assert.equal(snapshot.conversations[0].autoTitleDone, true)
})

test('manual renames and shutdown win over an in-flight automatic title', async () => {
  const { store, book } = await agentFixture()
  let finish!: (title: string) => void
  let signal!: AbortSignal
  const service = new AgentService(
    store,
    runtime,
    () => {},
    async (_user, _answer, currentSignal) => {
      signal = currentSignal
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    }
  )
  const c = await service.create(book.id, '')
  await service.start(book.id, c.id, '本地标题', {})
  await service.idle()
  await service.rename(book.id, c.id, '作者命名')
  finish('不应覆盖作者')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal((await service.snapshot(book.id)).conversations[0].title, '作者命名')
  const other = await service.create(book.id, '')
  await service.start(book.id, other.id, '关闭前标题', {})
  await service.idle()
  await service.close()
  assert.equal(signal.aborted, true)
  finish('关闭后不能改名')
  await new Promise((resolve) => setImmediate(resolve))
  const restarted = new AgentService(store, runtime)
  const conversations = (await restarted.snapshot(book.id)).conversations
  assert.equal(conversations.find((item) => item.id === c.id)?.title, '作者命名')
  assert.equal(conversations.find((item) => item.id === other.id)?.title, '关闭前标题')
  const intentional = await restarted.create(book.id, '')
  await restarted.rename(book.id, intentional.id, '新的讨论')
  await restarted.start(book.id, intentional.id, '不应覆盖手动标题', {})
  await restarted.idle()
  assert.equal(
    (await restarted.snapshot(book.id)).conversations.find((item) => item.id === intentional.id)
      ?.title,
    '新的讨论'
  )
})
