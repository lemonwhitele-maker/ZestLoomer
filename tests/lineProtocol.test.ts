import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import { logicalLines, type NumberedLine } from '../src/shared/logicalLines'
import { DocumentStore } from '../src/main/documents'
import {
  BookDocumentAdapter,
  cachedDocument,
  documentPath,
  toolDefinitions
} from '../src/main/agent/documents'
import { applyLineEdits } from '../src/main/agent/lineEdits'
import { AgentService } from '../src/main/agent/service'
import { proposalCandidateHash } from '../src/main/agent/proposalHash'
import { ScriptedRuntime } from '../src/main/agent/runtime'
import type { AgentWorkspace } from '../src/shared/agent'

async function fixture(
  content: string,
  workspace: (doc: any) => AgentWorkspace = () => ({}),
  deferred = false
) {
  const parent = await fs.mkdtemp(resolve('.test-artifacts/line-protocol-'))
  const store = new DocumentStore()
  const book = await store.createBook(parent, '行号协议')
  const doc = (await store.create(book.id, 'chapters', '测试', { content })).document
  const adapter = new BookDocumentAdapter(
    store,
    book.id,
    workspace(doc),
    '',
    () => [],
    undefined,
    deferred
  )
  const path = documentPath(doc)
  const args = (edits: unknown[]) => ({ path, baseVersion: doc.version, edits })
  return { store, book, doc, adapter, path, args }
}
const replace = (startLine: number, endLine: number, newText = '新正文') => ({
  mode: 'replace',
  target: { kind: 'lines', startLine, endLine },
  newText
})
const insert = (kind: string, newText: string, line?: number) => ({
  mode: 'insert',
  target: { kind, ...(line === undefined ? {} : { line }) },
  newText
})
const body = (page: { lines: NumberedLine[] }) =>
  page.lines.map((line) => line.text + (line.eol ?? '')).join('')

test('chapter proposal finalization follows original coordinates for batches, deletion and all insert anchors', async () => {
  const cases: [string, unknown[], string][] = [
    [
      '甲\n乙\n丙\n',
      [replace(1, 1, '新甲\n新增'), replace(3, 3, '新丙')],
      '新甲\n\n新增\n\n乙\n\n新丙'
    ],
    ['甲\n乙\n丙', [replace(2, 2, '')], '甲\n\n丙'],
    ['甲\n乙', [replace(1, 2, ' \t\n')], ''],
    ['甲\n乙', [insert('before_line', '新增', 2)], '甲\n\n新增\n\n乙'],
    ['甲\n乙', [insert('after_line', '新增', 1)], '甲\n\n新增\n\n乙'],
    ['甲\n乙', [insert('document_start', '新增')], '新增\n\n甲\n\n乙'],
    ['甲\n乙', [insert('document_end', '新增')], '甲\n\n乙\n\n新增'],
    ['', [insert('document_end', '\n甲\n乙\n')], '甲\n\n乙']
  ]
  for (const [source, edits, expected] of cases) {
    const f = await fixture(source)
    const service = new AgentService(
      f.store,
      () =>
        new ScriptedRuntime((_messages, step) => ({
          text: '',
          calls:
            step > 1
              ? []
              : [
                  {
                    id: String(step),
                    name: step === 0 ? 'read' : 'edit',
                    arguments: JSON.stringify(step === 0 ? { path: f.path } : f.args(edits))
                  }
                ]
        }))
    )
    const c = await service.create(f.book.id, '候选规范化')
    await service.start(f.book.id, c.id, '修改正文', {})
    await service.idle()
    const p = (await service.snapshot(f.book.id)).proposals[0]
    assert.ok(p)
    assert.equal(p.content, expected)
    assert.equal(p.before?.content, source)
    await service.action(f.book.id, p.id, 'reject', p.candidateHash)
    assert.equal((await f.store.read(f.book.id, f.doc.id)).document.content, source)
  }
})

test('logical numbering preserves blank lines, mixed separators, terminal separators and Unicode', () => {
  for (const [content, expected] of [
    ['', []],
    ['甲\n', ['甲']],
    ['甲\n\n', ['甲', '']],
    ['\n', ['']],
    ['甲\r\n\r\n乙\r丙\n😀', ['甲', '', '乙', '丙', '😀']]
  ] as const) {
    const index = logicalLines(content)
    assert.deepEqual(
      index.map((line) => content.slice(line.start, line.end)),
      expected
    )
    assert.deepEqual(
      index.map((line) => line.line),
      expected.map((_, i) => i + 1)
    )
    assert.equal(index.map((line) => content.slice(line.start, line.after)).join(''), content)
  }
})

test('read, batch, range pages and verified cache share absolute logical lines and a single manuscript copy', async () => {
  const f = await fixture(
    Array.from({ length: 35 }, (_, i) => `第${i + 1}行😀`).join('\r\n') + '\r\n'
  )
  let page: any = await f.adapter.read({ path: f.path, startLine: 12, endLine: 20, maxChars: 500 })
  assert.equal(page.complete, false)
  const rows: NumberedLine[] = []
  do {
    assert.equal(page.text, undefined)
    assert.equal(page.protocolVersion, 2)
    assert.equal(page.lineRange.totalLines, 35)
    assert.ok(JSON.stringify(page.lines).length <= 500)
    rows.push(...page.lines)
    if (!page.nextCursor) break
    assert.equal(page.requestedRangeComplete, false)
    page = await f.adapter.read({ cursor: page.nextCursor, maxChars: 500 })
  } while (page)
  assert.equal(page.requestedRangeComplete, true)
  assert.equal(page.complete, false)
  assert.deepEqual(
    rows.map((line) => line.line),
    Array.from({ length: 9 }, (_, i) => i + 12)
  )
  const batch: any = await f.adapter.read({ paths: [f.path], maxChars: 16000 })
  const cached = cachedDocument(f.doc)
  assert.deepEqual(batch.items[0].lines, cached.lines)
  assert.equal(body(batch.items[0]), f.doc.content)
  assert.equal(batch.items[0].complete, true)
  assert.deepEqual(rows, cached.lines.slice(11, 20))
  assert.equal((await f.store.agentRead(f.book.id, f.doc.id)).content, f.doc.content)
})

test('read line arguments reject missing, reversed, fractional, out-of-range and mixed inputs', async () => {
  const f = await fixture('甲\n乙')
  for (const args of [
    { startLine: 1 },
    { endLine: 2 },
    { startLine: 0, endLine: 1 },
    { startLine: 2, endLine: 1 },
    { startLine: 1.5, endLine: 2 },
    { startLine: 1, endLine: 3 },
    { startLine: 1, endLine: 1, query: '' },
    { startLine: 1, endLine: 1, paths: [f.path] },
    { startLine: 1, endLine: 1, cursor: 'x' },
    { path: 'help/index.md', startLine: 1, endLine: 1 }
  ])
    await assert.rejects(f.adapter.read({ path: f.path, ...args }))
  assert.equal(f.adapter.reads.size, 0)
})

test('long-line fragments do not authorize whole-line edits until complete, delivered, same-version coverage', async () => {
  const f = await fixture('前文\r\n' + '中😀'.repeat(700) + '\r\n后文', () => ({}), true)
  let page: any = await f.adapter.read({ path: f.path, startLine: 2, endLine: 2, maxChars: 500 })
  const text: string[] = []
  f.adapter.acknowledgeDelivery()
  assert.throws(() => applyLineEdits(f.adapter, f.doc, f.args([replace(2, 2)])), /完整目标行/)
  do {
    for (const row of page.lines) {
      assert.equal(row.line, 2)
      assert.equal(row.complete, false)
      assert.ok(row.fragment)
      assert.ok(!/[\uD800-\uDBFF]$/.test(row.text))
    }
    assert.ok(JSON.stringify(page.lines).length <= 500)
    text.push(body(page))
    if (!page.nextCursor) break
    page = await f.adapter.read({ cursor: page.nextCursor, maxChars: 500 })
  } while (page)
  assert.equal(text.join(''), '中😀'.repeat(700) + '\r\n')
  assert.equal(page.complete, false)
  assert.throws(() => applyLineEdits(f.adapter, f.doc, f.args([replace(2, 2)])), /完整目标行/)
  f.adapter.acknowledgeDelivery()
  assert.equal(applyLineEdits(f.adapter, f.doc, f.args([replace(2, 2)])), '前文\r\n新正文\r\n后文')
})

test('paged ranges reject version changes and never combine old and new fragments', async () => {
  const f = await fixture('长'.repeat(1200) + '\n末行')
  const first: any = await f.adapter.read({ path: f.path, startLine: 1, endLine: 1, maxChars: 500 })
  await f.store.save({
    bookId: f.book.id,
    id: f.doc.id,
    expectedVersion: f.doc.version,
    title: f.doc.title,
    content: '新版'.repeat(600)
  })
  await assert.rejects(f.adapter.read({ cursor: first.nextCursor }), /分页期间文档变化/)
  await assert.rejects(f.adapter.target(f.path, false), /先 read/)
  const fresh: any = await f.adapter.read({ path: f.path, maxChars: 500 })
  assert.notEqual(fresh.version, f.doc.version)
  assert.equal(fresh.complete, false)
})

test('line edits select repeated text, preserve outside characters and resolve every item against the base version', async () => {
  const f = await fixture('重复\n重复\n中间\n末行\n')
  await f.adapter.read({ path: f.path })
  assert.equal(
    applyLineEdits(f.adapter, f.doc, f.args([replace(2, 2, '另一个词')])),
    '重复\n另一个词\n中间\n末行\n'
  )
  assert.equal(
    applyLineEdits(
      f.adapter,
      f.doc,
      f.args([replace(1, 1, '新增\n两行'), replace(4, 4, '新末行')])
    ),
    '新增\n两行\n重复\n中间\n新末行\n'
  )
  assert.equal(
    applyLineEdits(f.adapter, f.doc, f.args([replace(1, 1, ''), replace(2, 2, '相邻')])),
    '相邻\n中间\n末行\n'
  )
  assert.equal(applyLineEdits(f.adapter, f.doc, f.args([replace(2, 3, '')])), '重复\n末行\n')
  assert.equal(applyLineEdits(f.adapter, f.doc, f.args([replace(4, 4, '')])), '重复\n重复\n中间\n')
  assert.equal(applyLineEdits(f.adapter, f.doc, f.args([replace(1, 4, '')])), '')
  assert.throws(
    () => applyLineEdits(f.adapter, f.doc, { ...f.args([replace(1, 1)]), baseVersion: '旧版本' }),
    /baseVersion/
  )
})

test('insertions add only submitted text and required paragraph separators for LF, CRLF and CR', async () => {
  for (const separator of ['\n', '\r\n', '\r']) {
    for (const terminated of [false, true]) {
      const f = await fixture(`前文${separator}后文${terminated ? separator : ''}`)
      await f.adapter.read({ path: f.path })
      assert.equal(
        applyLineEdits(f.adapter, f.doc, f.args([insert('before_line', '新增', 2)])),
        `前文${separator}新增${separator}后文${terminated ? separator : ''}`
      )
      assert.equal(
        applyLineEdits(f.adapter, f.doc, f.args([insert('after_line', '新增', 1)])),
        `前文${separator}新增${separator}后文${terminated ? separator : ''}`
      )
      assert.equal(
        applyLineEdits(f.adapter, f.doc, f.args([insert('document_start', '新增')])),
        `新增${separator}${f.doc.content}`
      )
      assert.equal(
        applyLineEdits(f.adapter, f.doc, f.args([insert('document_end', '续写')])),
        `前文${separator}后文${separator}续写`
      )
      assert.equal(
        applyLineEdits(f.adapter, f.doc, f.args([insert('document_end', '\n\n续写')])),
        f.doc.content + separator + separator + '续写'
      )
    }
  }
})

test('empty documents and blank lines require real read evidence and accept whitespace insertions', async () => {
  const f = await fixture('')
  assert.throws(
    () => applyLineEdits(f.adapter, f.doc, f.args([insert('document_end', '开篇')])),
    /先 read/
  )
  const page: any = await f.adapter.read({ path: f.path })
  assert.deepEqual(page.lines, [])
  assert.equal(page.lineRange.totalLines, 0)
  assert.equal(page.complete, true)
  assert.equal(applyLineEdits(f.adapter, f.doc, f.args([insert('document_end', '开篇')])), '开篇')
  assert.equal(applyLineEdits(f.adapter, f.doc, f.args([insert('document_start', '\n\n')])), '\n\n')
  assert.throws(() => applyLineEdits(f.adapter, f.doc, f.args([replace(1, 1)])), /行号/)
  const blank = await fixture('甲\n\n乙')
  await blank.adapter.read({ path: blank.path })
  assert.equal(applyLineEdits(blank.adapter, blank.doc, blank.args([replace(2, 2, '')])), '甲\n乙')
})

test('chapter insertions preserve double-spaced paragraph joins for every anchor and line ending', async () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const f = await fixture(`前段${eol}${eol}后段`)
    await f.adapter.read({ path: f.path })
    for (const target of [
      insert('after_line', '新增', 1),
      insert('before_line', '新增', 2),
      insert('after_line', '新增', 2),
      insert('before_line', '新增', 3)
    ]) {
      assert.equal(
        applyLineEdits(f.adapter, f.doc, f.args([target])),
        `前段${eol}${eol}新增${eol}${eol}后段`
      )
    }
    assert.equal(
      applyLineEdits(f.adapter, f.doc, f.args([insert('document_start', '开篇')])),
      `开篇${eol}${eol}${f.doc.content}`
    )
    assert.equal(
      applyLineEdits(f.adapter, f.doc, f.args([insert('document_end', '续写')])),
      `${f.doc.content}${eol}${eol}续写`
    )
    // Count separators on both sides of a join; explicit blank lines are never removed.
    assert.equal(
      applyLineEdits(f.adapter, f.doc, f.args([insert('after_line', '\n新增\n', 1)])),
      `前段${eol}${eol}新增${eol}${eol}后段`
    )
    assert.equal(
      applyLineEdits(f.adapter, f.doc, f.args([insert('after_line', '\n\n\n新增\n\n\n', 1)])),
      `前段${eol.repeat(4)}新增${eol.repeat(4)}后段`
    )
    assert.equal(
      applyLineEdits(f.adapter, f.doc, f.args([insert('after_line', '新一段\\n\\n新二段', 1)])),
      `前段${eol}${eol}新一段${eol}${eol}新二段${eol}${eol}后段`
    )
    // Markdown retains line-based insertion even when its content contains blank lines.
    assert.equal(
      applyLineEdits(
        f.adapter,
        { ...f.doc, kind: 'notes' },
        f.args([insert('after_line', '新增', 1)])
      ),
      `前段${eol}新增${eol}后段`
    )
  }
})

test('chapter continuation fills only missing terminal separators and keeps whitespace-only requests exact', async () => {
  for (const terminal of ['', '\n', '\n\n', '\n\n\n']) {
    const f = await fixture('前段\n\n末段' + terminal)
    await f.adapter.read({ path: f.path })
    assert.equal(
      applyLineEdits(f.adapter, f.doc, f.args([insert('document_end', '续段')])),
      '前段\n\n末段' + '\n'.repeat(Math.max(2, terminal.length)) + '续段'
    )
    assert.equal(
      applyLineEdits(f.adapter, f.doc, f.args([insert('document_end', '\n')])),
      f.doc.content + '\n'
    )
  }
  const f = await fixture('前段\r\n \t\r\n后段')
  await f.adapter.read({ path: f.path })
  assert.equal(
    applyLineEdits(f.adapter, f.doc, f.args([insert('after_line', '新增', 1)])),
    '前段\r\n\r\n新增\r\n \t\r\n后段'
  )
})

test('boundary insertions require the correct complete anchor, not another line or a fragment', async () => {
  const f = await fixture('首行\n中间\n' + '尾'.repeat(900))
  await f.adapter.read({ path: f.path, startLine: 2, endLine: 2 })
  for (const operation of [
    insert('document_start', '新首'),
    insert('document_end', '续写'),
    insert('after_line', '新增', 1)
  ])
    assert.throws(() => applyLineEdits(f.adapter, f.doc, f.args([operation])), /先 read/)
  await f.adapter.read({ path: f.path, startLine: 3, endLine: 3, maxChars: 500 })
  assert.throws(
    () => applyLineEdits(f.adapter, f.doc, f.args([insert('document_end', '续写')])),
    /先 read/
  )
})

test('selection replacement checks optional complete oldText and never expands frozen scope', async () => {
  const f = await fixture('前文冰冷后文', (doc) => ({
    documentId: doc.id,
    savedVersion: doc.version,
    selection: { from: 2, to: 4, text: '冰冷' }
  }))
  await f.adapter.read({ path: f.path })
  const selected = { mode: 'replace', target: { kind: 'selection' }, newText: '刺骨\n寒冷' }
  for (const oldText of [undefined, '冰冷'])
    assert.equal(
      applyLineEdits(
        f.adapter,
        f.doc,
        f.args([{ ...selected, ...(oldText === undefined ? {} : { oldText }) }])
      ),
      '前文刺骨\n寒冷后文'
    )
  for (const oldText of ['冰', '前文冰冷后文', '错误'])
    assert.throws(
      () => applyLineEdits(f.adapter, f.doc, f.args([{ ...selected, oldText }])),
      /完整冻结选区/
    )
  for (const operation of [replace(1, 1), insert('document_end', '续写')])
    assert.throws(() => applyLineEdits(f.adapter, f.doc, f.args([operation])), /当前有选区/)
  assert.throws(
    () => applyLineEdits(f.adapter, f.doc, f.args([selected, selected])),
    /一次完整替换/
  )
  const other = (await f.store.create(f.book.id, 'notes', '另一篇', { content: '冰冷' })).document
  await f.adapter.read({ path: documentPath(other) })
  assert.throws(
    () =>
      applyLineEdits(f.adapter, other, {
        baseVersion: other.version,
        edits: [{ ...replace(1, 1), oldText: '冰冷' }]
      }),
    /无有效选区/
  )
})

test('invalid fields, legacy oldText calls and conflicting operations are rejected without fallback', async () => {
  const f = await fixture('甲\n乙\n丙')
  await f.adapter.read({ path: f.path })
  for (const edits of [
    [{ oldText: '甲', newText: '坏' }],
    [{ ...replace(1, 1), oldText: '甲' }],
    [replace(0, 1)],
    [replace(1, 4)],
    [replace(2, 1)],
    [replace(1.2, 2)],
    [{ newText: '旧选区调用' }],
    [{ mode: 'replace', target: { kind: 'selection' }, newText: '坏' }],
    [{ ...replace(1, 1), target: { kind: 'lines', startLine: 1, endLine: 1, line: 1 } }],
    [{ ...insert('document_end', '新增'), target: { kind: 'document_end', line: 3 } }],
    [insert('before_line', '新增')],
    [insert('document_end', '')],
    [{ ...replace(1, 1), from: 0 }],
    [replace(1, 2), replace(2, 3)],
    [insert('after_line', '一', 1), insert('before_line', '二', 2)],
    [replace(2, 2), insert('before_line', '新增', 2)],
    [replace(3, 3), insert('document_end', '新增')],
    [replace(1, 3), insert('after_line', '新增', 1)],
    [],
    Array.from({ length: 21 }, () => replace(1, 1))
  ])
    assert.throws(() => applyLineEdits(f.adapter, f.doc, f.args(edits)))
  assert.equal((await f.store.agentRead(f.book.id, f.doc.id)).content, f.doc.content)
})

test('tool Schema advertises exactly the six edit branches and versioned read line inputs', () => {
  const schema: any = toolDefinitions.find((tool) => tool.function.name === 'edit')!.function
    .parameters
  assert.ok(schema.required.includes('baseVersion'))
  const branches = schema.properties.edits.items.oneOf
  assert.equal(branches.length, 6)
  for (const branch of branches) {
    assert.deepEqual(branch.required, ['mode', 'target', 'newText'])
    assert.equal(branch.additionalProperties, false)
    assert.equal(branch.properties.target.additionalProperties, false)
    assert.equal(
      'oldText' in branch.properties,
      branch.properties.target.properties.kind.enum[0] === 'selection'
    )
  }
  const read: any = toolDefinitions.find((tool) => tool.function.name === 'read')!.function
    .parameters
  assert.equal(read.properties.startLine.minimum, 1)
  assert.equal(read.properties.endLine.minimum, 1)
})

test('a maximum batch budgets escaped numbered records and metadata without dropping delivered text', async () => {
  const f = await fixture(('"\\\t😀'.repeat(600) + '\r\n').repeat(2))
  const result: any = await f.adapter.read({ paths: Array(12).fill(f.path), maxChars: 16000 })
  assert.ok(JSON.stringify(result).length <= 20000)
  assert.equal(result.items.length, 12)
  for (const item of result.items) {
    assert.equal(item.error, undefined)
    assert.ok(item.nextCursor)
    assert.equal(body(item), f.doc.content.slice(item.range.start, item.range.end))
    assert.equal(item.lines[0].complete, false)
  }
})

test('service line proposals stay pending, persist, apply and undo; legacy persisted proposals retain their candidates', async () => {
  const f = await fixture('前文\n重复\n重复')
  const service = new AgentService(
    f.store,
    () =>
      new ScriptedRuntime((_messages, step) => ({
        text: step > 1 ? '请审阅' : '',
        calls:
          step > 1
            ? []
            : [
                {
                  id: String(step),
                  name: step ? 'edit' : 'read',
                  arguments: JSON.stringify(
                    step ? f.args([replace(3, 3, '新的结尾')]) : { path: f.path }
                  )
                }
              ]
      }))
  )
  const c = await service.create(f.book.id, '行号修改')
  await service.start(f.book.id, c.id, '改第三行', {})
  await service.idle()
  const p = (await service.snapshot(f.book.id)).proposals[0]
  assert.ok(p)
  assert.equal(p.state, 'pending')
  assert.equal(p.content, '前文\n\n重复\n\n新的结尾')
  assert.equal((await f.store.agentRead(f.book.id, f.doc.id)).content, f.doc.content)
  assert.ok(
    (await service.snapshot(f.book.id)).conversations[0]
      .diagnostics!.filter((event) => event.phase === 'tool.completed')
      .every((event) => event.toolVersion === 2)
  )
  // Proposal format is unchanged: a stored candidate needs no line-operation migration.
  const restarted = new AgentService(
    f.store,
    () => new ScriptedRuntime(() => ({ text: '', calls: [] }))
  )
  await restarted.action(f.book.id, p.id, 'apply', p.candidateHash)
  assert.equal((await f.store.agentRead(f.book.id, f.doc.id)).content, p.content)
  await restarted.action(f.book.id, p.id, 'undo', p.candidateHash)
  assert.equal((await f.store.agentRead(f.book.id, f.doc.id)).content, f.doc.content)
  // Simulate a pre-normalization proposal on the current saved version.
  const legacy = {
    ...p,
    before: await f.store.agentRead(f.book.id, f.doc.id),
    content: '旧候选\n单换行\n',
    state: 'pending' as const,
    sources: []
  }
  delete legacy.paragraphNormalization
  legacy.candidateHash = proposalCandidateHash(legacy)
  await f.store.writeAgentRecord(f.book.id, 'proposals', legacy.id, legacy)
  const legacyService = new AgentService(
    f.store,
    () => new ScriptedRuntime(() => ({ text: '', calls: [] }))
  )
  await legacyService.action(f.book.id, legacy.id, 'apply', legacy.candidateHash)
  assert.equal((await f.store.agentRead(f.book.id, f.doc.id)).content, legacy.content)
})
