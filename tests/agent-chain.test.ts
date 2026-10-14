import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DocumentStore } from '../src/main/documents'
import { AgentService } from '../src/main/agent/service'
import { BookDocumentAdapter, documentPath } from '../src/main/agent/documents'
import { ScriptedRuntime } from '../src/main/agent/runtime'
import { compactMemory, assembleContext, excerpt } from '../src/main/agent/context'
import { defaultPolicy, modelPolicy } from '../src/main/agent/budgets'
import { rankText } from '../src/main/agent/relevance'
import { requiredDocuments, taskRequest } from '../src/main/agent/taskScope'
import { proposalDiff } from '../src/shared/proposalDiff'
import type { Conversation } from '../src/shared/agent'

async function fixture() {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const root = await fs.mkdtemp(resolve('.test-artifacts/chain-'))
  const store = new DocumentStore(),
    book = await store.createBook(root, '迁移验收')
  return { store, book }
}
test('memory preserves roles, message sources and tail constraints without becoming manuscript facts', () => {
  const c: Conversation = {
    format: 1,
    id: 'conversation_' + randomUUID(),
    bookId: 'book_' + randomUUID(),
    title: '讨论',
    updatedAt: '',
    summary: '旧摘要',
    coveredMessages: 0,
    messages: []
  }
  for (let n = 0; n < 42; n++)
    c.messages.push({
      id: 'message_' + randomUUID(),
      role: n % 2 ? 'assistant' : 'user',
      sources: [],
      text: n % 2 ? '希望师父是反派，这是建议。' : '我希望保留悬念，不要直接写定。'
    })
  c.messages[0].text = '开头' + '中'.repeat(2000) + '末尾限制'
  const memory = compactMemory(c)
  assert.ok(memory.preferences.every((m) => m.role === 'user'))
  assert.ok(memory.discussion.some((m) => m.role === 'assistant'))
  assert.equal('confirmedDecisions' in memory, false)
  assert.match(excerpt(c.messages[0].text), /末尾限制$/)
  assert.equal(compactMemory(c).discussion.length, memory.discussion.length)
  const context = assembleContext(c, '规则', {}, defaultPolicy)
  assert.equal(context.at(-1)?.content, c.messages.at(-1)?.text)
  assert.match(context.map((m) => m.content).join('\n'), /不确认作品事实/)
  assert.throws(() => modelPolicy({ contextTokens: 4096, outputTokens: 4096 }), /容量|预算|上下文/)
})
test('read evidence only becomes usable after delivery; related views never grant coverage', async () => {
  const { store, book } = await fixture()
  const d = (await store.create(book.id, 'notes', '城门', { content: '城门开启两次' })).document
  const adapter = new BookDocumentAdapter(store, book.id, {}, '', () => [], undefined, true)
  await adapter.read({ path: `book/views/${d.id}.md` })
  assert.equal(adapter.reads.size, 0)
  await adapter.read({ path: documentPath(d) })
  await assert.rejects(adapter.target(documentPath(d), true), /先 read/)
  adapter.acknowledgeDelivery()
  assert.equal((await adapter.target(documentPath(d), true)).id, d.id)
})
test('local ranking, continued task scope and separated diff hunks are deterministic', async () => {
  const { store, book } = await fixture()
  const a = (await store.create(book.id, 'notes', '城门', { content: '城门开启两次' })).document
  const b = (await store.create(book.id, 'notes', '城墙', { content: '很高' })).document
  assert.ok(
    rankText('城门开启', a.content, '城门 开启')!.score >
      rankText('普通', a.content, '城门 开启')!.score
  )
  assert.equal(rankText('无关', '山林', '城门'), null)
  const request = taskRequest([
    { id: '1', role: 'user', text: '整理全部速记', sources: [] },
    { id: '2', role: 'assistant', text: '待续', sources: [] },
    { id: '3', role: 'user', text: '继续', sources: [] }
  ])
  assert.deepEqual(requiredDocuments(request, { documentId: a.id }, [a, b]), [a.id, b.id])
  assert.equal(proposalDiff('甲\n原文\n乙\n末尾', '新甲\n原文\n新乙\n末尾').hunks.length, 2)
})
test('transcript manifest survives restart and corrupt records remain isolated; archive blocks sends', async () => {
  const { store, book } = await fixture()
  let selected: string | undefined
  const service = new AgentService(store, (p) => {
    selected = p
    return new ScriptedRuntime(() => ({ text: '已回复', calls: [] }))
  })
  const c = await service.create(book.id, '讨论')
  await service.preferences(book.id, c.id, 'profile-a', false)
  await service.start(book.id, c.id, '讨论故事', {})
  await service.idle()
  assert.equal(selected, 'profile-a')
  const manifest = JSON.parse(
    await fs.readFile(join(book.root, '.workspace/conversations', `${c.id}.json`), 'utf8')
  )
  assert.equal(manifest.messages.length, 0)
  assert.equal(manifest.messageFiles.length, 2)
  const restarted = new AgentService(
    store,
    () => new ScriptedRuntime(() => ({ text: '', calls: [] }))
  )
  assert.equal((await restarted.snapshot(book.id)).conversations[0].messages.length, 2)
  await restarted.preferences(book.id, c.id, '', true)
  await assert.rejects(restarted.start(book.id, c.id, '继续', {}), /恢复/)
  const diagnostics = await fs.readFile(
    join(book.root, '.workspace/diagnostics', `${c.id}.jsonl`),
    'utf8'
  )
  assert.match(diagnostics, /model.completed/)
  assert.equal(diagnostics.includes('讨论故事'), false)
})

test('same-round reads cannot authorize writes and unchanged delivered reads are reused safely', async () => {
  const { store, book } = await fixture()
  const d = (await store.create(book.id, 'notes', '来源', { content: '原文' })).document
  let reused = false,
    rejected = false
  const runtime = new ScriptedRuntime((messages, step) => {
    const call = (name: string, args: unknown, id: string) => ({
      id,
      name,
      arguments: JSON.stringify(args)
    })
    if (step === 0)
      return {
        text: '',
        calls: [
          call('read', { path: documentPath(d) }, 'r1'),
          call('write', { path: documentPath(d), content: '候选' }, 'w1')
        ]
      }
    if (step === 1) {
      rejected = JSON.parse(messages.at(-1)!.content!).code === 'READ_REQUIRED'
      return { text: '', calls: [call('read', { path: documentPath(d) }, 'r2')] }
    }
    reused = JSON.parse(messages.at(-1)!.content!).resultType === 'readReuse'
    return { text: '完成讨论', calls: [] }
  })
  const service = new AgentService(store, () => runtime),
    c = await service.create(book.id, '读取')
  await service.start(book.id, c.id, '读资料', {})
  await service.idle()
  assert.ok(rejected && reused)
  assert.equal((await service.snapshot(book.id)).proposals.length, 0)
  assert.equal((await store.agentRead(book.id, d.id)).content, '原文')
})
