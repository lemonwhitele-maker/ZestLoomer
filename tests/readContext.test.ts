import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DocumentStore } from '../src/main/documents'
import { AgentService } from '../src/main/agent/service'
import { BookDocumentAdapter, documentPath } from '../src/main/agent/documents'
import { ScriptedRuntime, type Completion } from '../src/main/agent/runtime'
import type { ReadRelatedDocuments } from '../src/main/agent/readContext'
import { executionBudget } from '../src/main/agent/budgets'

interface ReadResult {
  resultType?: string
  text?: string
  lines?: { text: string; eol?: string }[]
  nextCursor?: string | null
  relatedDocuments?: ReadRelatedDocuments
  items?: ReadResult[]
  error?: string
}
const body = (result: ReadResult) =>
  result.lines?.map((line) => line.text + (line.eol ?? '')).join('')

async function fixture() {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const parent = await fs.mkdtemp(resolve('.test-artifacts/read-context-'))
  const store = new DocumentStore()
  const book = await store.createBook(parent, '读取关联名称测试')
  return { store, book }
}

function related(result: ReadResult): ReadRelatedDocuments {
  assert.ok(result.relatedDocuments, '正文读取应携带关联名称上下文')
  return result.relatedDocuments
}

test('chapter reads identify literal names and explicit aliases per document without granting detail evidence', async (t) => {
  const { store, book } = await fixture()
  const original = (
    await store.create(book.id, 'characters', '陆离', {
      content:
        '---\naliases: [白衣客, "A+B"]\n---\n> **来源记录**：迁移 | 别名：陆先生 | 来源：旧稿\n### 别名\n- 少侠\n### 简介\n详情秘密\n```md\n别名：幽影\n```'
    })
  ).document
  const namesake = (
    await store.create(book.id, 'characters', '陆离', { content: '另一个同名人物的秘密' })
  ).document
  const place = (await store.create(book.id, 'settings', '陆离', { content: '同名地点的秘密' }))
    .document
  const removed = (await store.create(book.id, 'characters', '幽影', { content: '已删除人物' }))
    .document
  await store.trash(book.id, removed.id, removed.version)
  const manuscript = '陆离与陆先生、白衣客同行，少侠写下 a+b 和 A+B；幽影不应命中。'
  const chapter = (await store.create(book.id, 'chapters', '人物登场', { content: manuscript }))
    .document
  const adapter = new BookDocumentAdapter(store, book.id, {}, '', () => [], undefined, true)
  const result = (await adapter.read({ path: documentPath(chapter) })) as ReadResult
  const context = related(result)
  assert.equal(body(result), manuscript)
  assert.equal(context.total, 3)
  assert.equal(context.truncated, false)
  assert.match(context.notice, /不代表已读取|不算.*读取|定位/)
  const byPath = new Map(context.items.map((item) => [item.path, item]))
  assert.equal(byPath.size, 3)
  assert.deepEqual(
    new Set(byPath.get(documentPath(original))!.matchedNames),
    new Set(['陆离', '白衣客', 'a+b', 'A+B', '陆先生', '少侠'])
  )
  assert.equal(byPath.get(documentPath(namesake))!.sourceType, 'character')
  assert.equal(byPath.get(documentPath(place))!.sourceType, 'setting')
  assert.deepEqual(byPath.get(documentPath(place))!.matchedNames, ['陆离'])
  assert.equal(JSON.stringify(context).includes('秘密'), false)
  assert.deepEqual([...adapter.reads.keys()], [chapter.id])
  assert.equal(adapter.evidence.size, 0)
  adapter.acknowledgeDelivery()
  assert.deepEqual([...adapter.evidence.keys()], [chapter.id])
  await assert.rejects(adapter.target(documentPath(original), true), /先 read/)
  await assert.rejects(adapter.target(documentPath(place), true), /先 read/)
  const read = store.agentRead.bind(store)
  t.mock.method(store, 'agentRead', (bookId: string, id: string, explicitReference = false) => {
    if (id === original.id) throw new Error('单份人物资料无法读取')
    return read(bookId, id, explicitReference)
  })
  const partialAdapter = new BookDocumentAdapter(store, book.id, {}, '', () => [])
  const partial = (await partialAdapter.read({ path: documentPath(chapter) })) as ReadResult
  assert.equal(body(partial), manuscript)
  assert.equal(related(partial).total, 2)
  assert.equal(related(partial).truncated, true)
  assert.match(related(partial).notice, /部分.*无法索引/)
  assert.deepEqual([...partialAdapter.evidence.keys()], [chapter.id])
})

test('pagination and batch reads match only returned chapter fragments; other read modes and recycled chapters stay separate', async () => {
  const { store, book } = await fixture()
  await store.create(book.id, 'characters', '陆离', { content: '人物资料' })
  await store.create(book.id, 'settings', '山海', { content: '地域资料' })
  const chapter = (
    await store.create(book.id, 'chapters', '分页', {
      content: '陆离' + '甲'.repeat(497) + '山海陆离'
    })
  ).document
  const left = (await store.create(book.id, 'chapters', '左片段', { content: '陆离山' })).document
  const right = (await store.create(book.id, 'chapters', '右片段', { content: '海' })).document
  const adapter = new BookDocumentAdapter(store, book.id, {}, '', () => [
    { id: 'conversation_12345678-1234-1234-1234-123456789abc', title: '历史', text: '陆离山海' }
  ])
  const first = (await adapter.read({ path: documentPath(chapter), maxChars: 500 })) as ReadResult
  const second = (await adapter.read({ cursor: first.nextCursor, maxChars: 500 })) as ReadResult
  assert.equal(body(first)! + body(second)!, chapter.content)
  for (const page of [first, second]) {
    const expected = ['陆离', '山海'].filter((name) => body(page)!.includes(name))
    assert.deepEqual(
      related(page).items.map((item) => item.title),
      expected
    )
    assert.equal(related(page).total, expected.length)
  }
  const batch = (await adapter.read({
    paths: [documentPath(left), documentPath(right), documentPath(left), 'C:/outside'],
    maxChars: 1000
  })) as ReadResult
  assert.deepEqual(
    related(batch).items.map((item) => item.title),
    ['陆离']
  )
  assert.equal(related(batch).total, 1)
  assert.equal(batch.items!.length, 4)
  assert.ok(batch.items![3].error)
  assert.ok(batch.items!.every((item) => item.relatedDocuments === undefined))
  for (const kind of ['characters', 'settings', 'outlines', 'notes'] as const) {
    const document = (await store.create(book.id, kind, '独立资料', { content: '陆离山海' }))
      .document
    const result = (await adapter.read({ path: documentPath(document) })) as ReadResult
    assert.equal(result.relatedDocuments, undefined, `${kind} 不是正文读取`)
  }
  for (const args of [
    { path: 'book/' },
    { path: 'book/', query: '陆离' },
    { path: 'help/index.md' },
    { path: `book/views/${chapter.id}.md` },
    { path: 'book/conversations/conversation_12345678-1234-1234-1234-123456789abc.md' }
  ]) {
    const result = (await adapter.read(args)) as ReadResult
    assert.equal(result.relatedDocuments, undefined, `${args.path} 不是现行正文`)
  }
  await store.save({
    bookId: book.id,
    id: chapter.id,
    expectedVersion: chapter.version,
    title: chapter.title,
    content: '改写后的正文'
  })
  await assert.rejects(adapter.read({ cursor: first.nextCursor, maxChars: 500 }), /文档变化/)
  await store.trash(book.id, left.id, left.version)
  const historical = new BookDocumentAdapter(
    store,
    book.id,
    {},
    `[[chapter:${left.id}|旧正文]]`,
    () => []
  )
  const recycled = (await historical.read({ path: documentPath(left) })) as ReadResult
  assert.equal(body(recycled), left.content)
  assert.equal(recycled.relatedDocuments, undefined)
  assert.equal(historical.reads.size, 0)
})

test('large name indexes preserve manuscript text and exact match totals within the tool-result budget', async (t) => {
  const { store, book } = await fixture()
  const count = 160
  const template = (
    await store.create(book.id, 'characters', '陆离', { content: '详情不应随索引返回' })
  ).document
  const knowledge = new Map(
    Array.from({ length: count }, (_, index) => {
      const document = {
        ...template,
        id: 'doc_' + randomUUID(),
        kind: index % 2 ? ('characters' as const) : ('settings' as const)
      }
      return [document.id, document] as const
    })
  )
  const manuscript = '陆离' + '正文'.repeat(7999)
  const chapter = (await store.create(book.id, 'chapters', '预算', { content: manuscript }))
    .document
  const read = store.agentRead.bind(store)
  t.mock.method(store, 'agentDocuments', async () => [chapter, ...knowledge.values()])
  t.mock.method(store, 'agentRead', (bookId: string, id: string, explicitReference = false) => {
    const document = knowledge.get(id)
    return document ? Promise.resolve(document) : read(bookId, id, explicitReference)
  })
  const adapter = new BookDocumentAdapter(store, book.id, {}, '', () => [])
  const result = (await adapter.read({
    path: documentPath(chapter),
    maxChars: 16000
  })) as ReadResult
  const context = related(result)
  assert.ok(manuscript.startsWith(body(result)!))
  assert.ok(body(result)!.length > 0)
  let text = body(result)!,
    cursor = result.nextCursor
  while (cursor) {
    const page = (await adapter.read({ cursor, maxChars: 16000 })) as ReadResult
    text += body(page)
    cursor = page.nextCursor
  }
  assert.equal(text, manuscript)
  assert.equal(context.total, count)
  assert.equal(context.truncated, true)
  assert.ok(context.items.length > 0 && context.items.length < count)
  assert.ok(JSON.stringify(result).length <= 20000)
  assert.equal(new Set(context.items.map((item) => item.path)).size, context.items.length)
  assert.deepEqual([...adapter.reads.keys()], [chapter.id])
})

test('model requests receive chapter name context in tool results, duplicate-read reuse and verified cache without extra sources', async () => {
  const { store, book } = await fixture()
  const character = (
    await store.create(book.id, 'characters', '陆离', { content: '别名：白衣客\n未读详情' })
  ).document
  const setting = (await store.create(book.id, 'settings', '山海城', { content: '未读地点详情' }))
    .document
  const chapter = (
    await store.create(book.id, 'chapters', '入城', { content: '白衣客进入山海城。' })
  ).document
  const call = (id: string): Completion => ({
    text: '',
    calls: [{ id, name: 'read', arguments: JSON.stringify({ path: documentPath(chapter) }) }]
  })
  const done: Completion = { text: '已分析正文。', calls: [] }
  let turn = 0
  const received: ReadResult[] = []
  let cached: ReadResult | undefined
  const service = new AgentService(store, () => {
    const currentTurn = turn++
    return new ScriptedRuntime((messages, step) => {
      if (currentTurn === 0) {
        if (step === 0) return call('first-read')
        const message = messages.at(-1)!
        assert.equal(message.role, 'tool')
        received.push(JSON.parse(message.content!) as ReadResult)
        return step === 1 ? call('same-read') : done
      }
      const cache = messages.find((message) => message.content?.startsWith('已核验版本的原文缓存'))
      assert.ok(cache, '下轮当前章节应使用已经送达的同版本原文缓存')
      assert.equal(cache.role, 'user')
      cached = JSON.parse(cache.content!.slice(cache.content!.indexOf('：') + 1)) as ReadResult
      return done
    })
  })
  const conversation = await service.create(book.id, '人物定位')
  const workspace = { documentId: chapter.id, savedVersion: chapter.version }
  await service.start(book.id, conversation.id, '请分析这段正文', workspace)
  await service.idle()
  assert.deepEqual(
    received.map((result) => result.resultType),
    ['document', 'readReuse']
  )
  await store.save({
    bookId: book.id,
    id: character.id,
    expectedVersion: character.version,
    title: character.title,
    content: '别名：客\n新的未读详情'
  })
  await service.start(book.id, conversation.id, '继续分析', workspace)
  await service.idle()
  assert.ok(cached)
  assert.equal(body(cached), chapter.content)
  for (const result of [...received, cached]) {
    const context = related(result)
    assert.equal(context.total, 2)
    assert.deepEqual(
      new Set(context.items.map((item) => item.path)),
      new Set([documentPath(character), documentPath(setting)])
    )
    assert.deepEqual(
      context.items.flatMap((item) => item.matchedNames).sort(),
      result === cached ? ['客', '山海城'] : ['山海城', '白衣客']
    )
  }
  const restored = (await service.snapshot(book.id)).conversations.find(
    (item) => item.id === conversation.id
  )!
  assert.equal(restored.lastTurn?.state, 'completed')
  for (const message of restored.messages.filter((item) => item.role === 'assistant'))
    assert.deepEqual(
      message.sources.map((source) => source.id),
      [chapter.id]
    )
})

test('a hanging name index on duplicate read stops at the tool timeout without another model request', async (t) => {
  const { store, book } = await fixture()
  const chapter = (await store.create(book.id, 'chapters', '超时', { content: '陆离入城' }))
    .document
  const priorTimeout = executionBudget.toolTimeoutMs
  t.after(() => {
    executionBudget.toolTimeoutMs = priorTimeout
  })
  const readContext = BookDocumentAdapter.prototype.readContext
  let indexes = 0
  t.mock.method(
    BookDocumentAdapter.prototype,
    'readContext',
    function (this: BookDocumentAdapter, fragments: string[], resultChars: number) {
      if (++indexes === 2) return new Promise<ReadRelatedDocuments>(() => {})
      return readContext.call(this, fragments, resultChars)
    }
  )
  let requests = 0
  const service = new AgentService(
    store,
    () =>
      new ScriptedRuntime((_messages, step) => {
        requests++
        // Allow the disk/version checks to finish under concurrent Windows test I/O;
        // the mocked index itself never resolves and must still time out.
        if (step === 1) executionBudget.toolTimeoutMs = 500
        return {
          text: '',
          calls: [
            {
              id: `read-${step}`,
              name: 'read',
              arguments: JSON.stringify({ path: documentPath(chapter) })
            }
          ]
        }
      })
  )
  const conversation = await service.create(book.id, '重复读取超时')
  await service.start(book.id, conversation.id, '分析正文', {})
  await service.idle()
  const state = await service.snapshot(book.id)
  assert.equal(indexes, 2)
  assert.equal(requests, 2)
  assert.equal(state.active, null)
  assert.equal(state.conversations[0].lastTurn?.state, 'failed')
  assert.match(state.conversations[0].messages.at(-1)!.text, /任务超时/)
  assert.deepEqual(
    state.conversations[0].messages.at(-1)!.sources.map((source) => source.id),
    [chapter.id]
  )
})
