import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DocumentStore } from '../src/main/documents'
import { AgentService } from '../src/main/agent/service'
import { assembleContext } from '../src/main/agent/context'
import { defaultPolicy, estimateTokens, inputLimit } from '../src/main/agent/budgets'
import { toolDefinitions } from '../src/main/agent/documents'
import { ScriptedRuntime, type Completion } from '../src/main/agent/runtime'
import type { Conversation } from '../src/shared/agent'
import { defaultHeavySettings } from '../src/shared/heavyAgent'

const call = (name: string, args: unknown, step: number): Completion => ({
  text: '',
  calls: [{ id: `call-${step}`, name, arguments: JSON.stringify(args) }]
})

test('sent selections retain exact text and backend-derived absolute lines with or without chapter context', async () => {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const root = await fs.mkdtemp(resolve('.test-artifacts/selection-context-'))
  const store = new DocumentStore()
  const book = await store.createBook(root, '选区行号')
  const content = '开头😀\r\n\r\n前选中后\n末行\r尾声</selection>&\r\n'
  const chapter = (await store.create(book.id, 'chapters', '混合换行', { content })).document
  const cases = [
    { text: '选中', startLine: 3, endLine: 3 },
    { text: '选中后\n末', startLine: 3, endLine: 4 },
    { text: '前选中后\n', startLine: 3, endLine: 3 },
    { text: '😀', startLine: 1, endLine: 1 },
    { text: '</selection>&', startLine: 5, endLine: 5 },
    { text: '\r\n', from: content.indexOf('\r\n') + 2, startLine: 2, endLine: 2 },
    { text: content, startLine: 1, endLine: 5 },
    { text: '\r\n', from: content.length - 2, startLine: 5, endLine: 5 },
    { text: '选中', draft: '新增行\n' + content, startLine: 4, endLine: 4 }
  ]
  for (const chapterContext of [false, true]) {
    let sent: any
    const service = new AgentService(
      store,
      () =>
        new ScriptedRuntime((messages) => {
          sent = JSON.parse(messages.at(-2)!.content!.split('：').slice(1).join('：'))
          return { text: '完成', calls: [] }
        }),
      undefined,
      undefined,
      async () => ({ ...defaultHeavySettings, chapterContext })
    )
    for (const item of cases) {
      sent = undefined
      const source = item.draft ?? content
      const from = item.from ?? source.indexOf(item.text)
      const to = from + item.text.length
      const c = await service.create(book.id, '选区范围')
      await service.start(book.id, c.id, '分析选区', {
        documentId: chapter.id,
        savedVersion: chapter.version,
        editorContent: item.draft,
        // Caller-provided line metadata must be recomputed from the frozen source.
        selection: { from, to, text: item.text, startLine: 999, endLine: 999 }
      })
      await service.idle()
      assert.deepEqual(sent?.selection, {
        from,
        to,
        startLine: item.startLine,
        endLine: item.endLine
      })
      assert.equal(sent.documentId, chapter.id)
      assert.equal(sent.savedVersion, chapter.version)
      assert.equal(sent.editorContent, undefined)
      assert.equal(sent.currentContext.length, chapterContext ? 1 : 0)
      const escaped = (s: string) =>
        s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      const expected = `<chapter-context>${chapterContext ? escaped(source.slice(0, from)) : ''}<selection>${escaped(item.text)}</selection>${chapterContext ? escaped(source.slice(to)) : ''}</chapter-context>`
      assert.equal(
        chapterContext ? sent.currentContext[0].content : sent.selectionContent,
        expected
      )
      if (chapterContext) assert.equal(sent.selectionContent, undefined)
      const saved = (await service.snapshot(book.id)).conversations.find(
        (value) => value.id === c.id
      )!
      assert.deepEqual(saved.messages[0].context?.workspace.selection, {
        ...sent.selection,
        text: item.text
      })
    }
    sent = undefined
    const c = await service.create(book.id, '无选区')
    await service.start(book.id, c.id, '分析章节', {
      documentId: chapter.id,
      savedVersion: chapter.version
    })
    await service.idle()
    assert.equal(sent?.selection, null)
  }
})

test('current selection survives contradictory history and memory trimming beside the latest request', () => {
  const c: Conversation = {
    format: 1,
    id: `conversation_${randomUUID()}`,
    bookId: `book_${randomUUID()}`,
    title: '选区回归',
    updatedAt: '',
    summary: '',
    coveredMessages: 0,
    messages: Array.from({ length: 24 }, (_, i) => ({
      id: `message_${randomUUID()}`,
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      text: i % 2 ? '目前无选区，无法读取历史对话。' : '请参考历史讨论。' + '旧讨论'.repeat(300),
      sources: []
    }))
  }
  c.messages.push({
    id: `message_${randomUUID()}`,
    role: 'user',
    text: '现在是无选区吗？',
    sources: []
  })
  const selection = { from: 12, to: 16, text: '选区原文' }
  for (const policy of [
    defaultPolicy,
    { contextTokens: 7000, outputTokens: 1024, retryOutputTokens: 1024 }
  ]) {
    const messages = assembleContext(c, '写作助手', { selection }, policy)
    assert.equal(messages[0].content, '写作助手')
    assert.match(messages.at(-2)!.content!, /本轮编辑状态：有选区/)
    assert.equal(messages.at(-1)!.content, '现在是无选区吗？')
    const workspace = JSON.parse(messages.at(-2)!.content!.split('：').slice(1).join('：'))
    assert.deepEqual(workspace.selection, { from: selection.from, to: selection.to })
    assert.equal(
      workspace.selectionContent,
      `<chapter-context><selection>${selection.text}</selection></chapter-context>`
    )
    assert.ok(messages.slice(1, -2).some((m) => m.content?.includes('旧记录无可验证最终回答')))
    assert.ok(
      estimateTokens(JSON.stringify({ messages, tools: toolDefinitions })) <= inputLimit(policy)
    )
  }
  const cleared = assembleContext(c, '写作助手', {}, defaultPolicy)
  assert.equal(cleared[0].content, '写作助手')
  assert.match(cleared.at(-2)!.content!, /本轮编辑状态：未附带选区/)
  assert.equal(JSON.parse(cleared.at(-2)!.content!.split('：').slice(1).join('：')).selection, null)
})

test('restarted Agent discovers, searches and pages archived history, then edits only the current selection', async () => {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const root = await fs.mkdtemp(resolve('.test-artifacts/context-history-'))
  const store = new DocumentStore()
  const book = await store.createBook(root, '历史读取回归')
  const chapter = (
    await store.create(book.id, 'chapters', '房间', { content: '开头。旧段落。结尾。' })
  ).document
  const writer = new AgentService(
    store,
    () => new ScriptedRuntime(() => ({ text: '历史回答', calls: [] }))
  )
  const old = await writer.create(book.id, '房间讨论')
  const historyText = '房间线索：' + '旧讨论内容。'.repeat(160) + '最终线索：红色钥匙。'
  await writer.start(book.id, old.id, historyText, {})
  await writer.idle()
  await writer.preferences(book.id, old.id, '', true)

  const reopened = new DocumentStore()
  await reopened.openBook(book.root)
  const oldPath = `book/conversations/${old.id}.md`
  let history = ''
  let currentId = ''
  let phase = 'root'
  const service = new AgentService(
    reopened,
    () =>
      new ScriptedRuntime((messages, step) => {
        const result = () => JSON.parse(messages.at(-1)!.content!)
        if (phase === 'root') {
          const workspace = JSON.parse(messages.at(-2)!.content!.split('：').slice(1).join('：'))
          assert.deepEqual(workspace.selection, {
            from: 3,
            to: 6,
            startLine: 1,
            endLine: 1
          })
          assert.deepEqual(workspace.conversationHistory, {
            directory: 'book/conversations/',
            currentPath: `book/conversations/${currentId}.md`,
            count: 2
          })
          phase = 'list'
          return call('list_files', { path: 'book/' }, step)
        }
        if (phase === 'list') {
          assert.ok(
            JSON.parse(result().text).some(
              (r: { path: string }) => r.path === 'book/conversations/'
            )
          )
          phase = 'search'
          return call('list_files', { path: 'book/conversations/' }, step)
        }
        if (phase === 'search') {
          assert.ok(JSON.parse(result().text).some((r: { path: string }) => r.path === oldPath))
          phase = 'read'
          return call('read', { path: 'book/conversations/', query: '红色钥匙' }, step)
        }
        if (phase === 'read') {
          assert.equal(JSON.parse(result().text).hits[0].path, oldPath)
          phase = 'page'
          return call('read', { path: oldPath, maxChars: 500 }, step)
        }
        if (phase === 'page') {
          const page = result()
          assert.equal(page.error, undefined)
          history += page.text
          if (!page.complete) return call('read', { cursor: page.nextCursor, maxChars: 500 }, step)
          assert.ok(history.includes(historyText))
          assert.ok(history.includes('历史回答'))
          phase = 'edit'
          return call('read', { path: `book/chapters/${chapter.id}.txt` }, step)
        }
        if (phase === 'edit') {
          assert.equal(result().lines[0].text, chapter.content)
          phase = 'invalid-write'
          return call(
            'edit',
            {
              path: `book/chapters/${chapter.id}.txt`,
              baseVersion: chapter.version,
              edits: [
                {
                  mode: 'replace',
                  target: { kind: 'selection' },
                  oldText: '旧段',
                  newText: '找到红色钥匙'
                }
              ]
            },
            step
          )
        }
        if (phase === 'invalid-write') {
          assert.equal(result().code, 'SELECTION')
          assert.match(result().message, /oldText.*完整冻结选区/)
          phase = 'retry-edit'
          return call(
            'write',
            { path: `book/chapters/${chapter.id}.txt`, content: '错误的全文替换' },
            step
          )
        }
        if (phase === 'retry-edit') {
          assert.equal(result().code, 'SELECTION')
          assert.match(result().message, /当前有选区.*edit.*不要取消选区/)
          phase = 'done'
          return call(
            'edit',
            {
              path: `book/chapters/${chapter.id}.txt`,
              baseVersion: chapter.version,
              edits: [{ mode: 'replace', target: { kind: 'selection' }, newText: '找到红色钥匙' }]
            },
            step
          )
        }
        assert.equal(result().ok, true)
        return { text: '已参考历史并准备选区替换提案。', calls: [] }
      })
  )
  const current = await service.create(book.id, '新的讨论')
  currentId = current.id
  await service.start(book.id, current.id, '读取历史对话，替换选中文本。', {
    documentId: chapter.id,
    savedVersion: chapter.version,
    selection: { from: 3, to: 6, text: '旧段落' }
  })
  await service.idle()
  const snapshot = await service.snapshot(book.id)
  assert.equal(
    snapshot.conversations.find((c) => c.id === current.id)!.lastTurn!.state,
    'completed'
  )
  assert.equal(snapshot.proposals.length, 1)
  assert.equal(snapshot.proposals[0].content, '开头。找到红色钥匙。结尾。')
  assert.equal((await reopened.read(book.id, chapter.id)).document.content, chapter.content)
  assert.deepEqual(
    snapshot.proposals[0].sources.map((s) => s.id),
    [chapter.id]
  )
})
