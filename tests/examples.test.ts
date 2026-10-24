import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DocumentStore } from '../src/main/documents'
import { AgentService } from '../src/main/agent/service'
import { ScriptedRuntime } from '../src/main/agent/runtime'
import { documentPath } from '../src/main/agent/documents'
import { knowledgeEntries } from '../src/renderer/src/editorKnowledge'
import { matchReadDocuments } from '../src/main/agent/readContext'

test('new-book examples persist, reject mutation paths, and can be copied as ordinary documents', async () => {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const parent = await fs.mkdtemp(resolve('.test-artifacts/examples-'))
  const store = new DocumentStore()
  const book = await store.createBook(parent, '只读示例测试', true)
  const list = await store.list(book.id)
  assert.equal(list.length, 2)
  assert.ok(list.every((d) => d.readonlyExample))
  assert.deepEqual(list.map((d) => d.kind).sort(), ['characters', 'settings'])
  const reopened = new DocumentStore()
  await reopened.openBook(book.root)
  assert.equal((await reopened.list(book.id)).length, 2)
  for (const meta of list) {
    const d = (await reopened.read(book.id, meta.id)).document
    assert.ok(d.readonlyExample)
    assert.ok(d.content.includes('不属于本书'))
    const readonly = { code: 'READ_ONLY' }
    await assert.rejects(
      reopened.save({
        bookId: book.id,
        id: d.id,
        content: '改写',
        title: '改名',
        expectedVersion: d.version
      }),
      readonly
    )
    await assert.rejects(
      reopened.writeDraft(book.id, d.id, {
        content: '草稿',
        title: d.title,
        baseVersion: d.version,
        savedAt: ''
      }),
      readonly
    )
    await assert.rejects(reopened.trash(book.id, d.id, d.version), readonly)
    await assert.rejects(
      reopened.renameBatch({
        bookId: book.id,
        changes: [{ id: d.id, title: '改名', version: d.version }]
      }),
      readonly
    )
    await assert.rejects(
      reopened.applyAgent(
        {
          bookId: book.id,
          id: d.id,
          kind: d.kind,
          title: d.title,
          content: 'Agent 改写',
          expectedVersion: d.version,
          operationId: randomUUID(),
          sources: []
        },
        () => {}
      ),
      readonly
    )
    assert.deepEqual((await reopened.read(book.id, d.id)).document, d)
    const copy = (await reopened.create(book.id, d.kind, '可编辑副本', { content: d.content }))
      .document
    assert.equal(copy.readonlyExample, undefined)
    const saved = await reopened.save({
      bookId: book.id,
      id: copy.id,
      title: copy.title,
      content: '自己的资料',
      expectedVersion: copy.version
    })
    assert.equal(saved.content, '自己的资料')
    assert.deepEqual(knowledgeEntries([d], { [d.id]: d.content }), [])
    assert.deepEqual(matchReadDocuments([d], [d.title]), [])

    let readReturned = false
    const service = new AgentService(
      reopened,
      () =>
        new ScriptedRuntime((messages, step) => {
          if (step === 0)
            return {
              text: '',
              calls: [
                { id: 'read', name: 'read', arguments: JSON.stringify({ path: documentPath(d) }) }
              ]
            }
          if (step === 1) {
            readReturned = messages.some(
              (m) => m.role === 'tool' && JSON.stringify(m).includes('不属于本书')
            )
            return {
              text: '',
              calls: [
                {
                  id: 'write',
                  name: 'write',
                  arguments: JSON.stringify({ path: documentPath(d), content: '修改示例' })
                }
              ]
            }
          }
          return { text: '示例不可修改。', calls: [] }
        })
    )
    const c = await service.create(book.id, '示例保护')
    await service.start(book.id, c.id, '读取并修改示例', {})
    await service.idle()
    assert.ok(readReturned)
    assert.equal(
      (await service.snapshot(book.id)).proposals.filter((p) => p.conversationId === c.id).length,
      0
    )
  }
  const old = await store.createBook(parent, '已有空作品')
  await reopened.openBook(old.root)
  assert.equal((await reopened.list(old.id)).length, 0)
})
