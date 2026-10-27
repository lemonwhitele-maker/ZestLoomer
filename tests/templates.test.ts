import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  consistentTemplate,
  initialContent,
  templates,
  validateTemplate
} from '../src/shared/templates'
import { DocumentStore } from '../src/main/documents'
import { migrateTemplates } from '../src/main/templateMigration'

test('signature speech stays optional for blank documents and preserves supplied styles without duplication', () => {
  assert.ok(initialContent('characters', 'basic').includes('### 经典发言\n'))
  assert.equal(initialContent('characters', 'blank'), '')
  for (const kind of ['settings', 'outlines', 'notes', 'chapters'] as const)
    assert.equal(initialContent(kind, 'basic').includes('经典发言'), false)
  for (const eol of ['\n', '\r\n']) {
    for (const label of ['### 经典发言']) {
      const speech = [
        label,
        '',
        '- “事情办完再说谢。”——简短直接。',
        '- “你倒是替我安排得明白。”——反讽。'
      ].join(eol)
      const original = [speech, '', '> 别名：小林', '', '### 核心定位', '主角'].join(eol)
      const result = consistentTemplate('characters', original)
      assert.ok(result.includes(speech))
      assert.ok(result.includes('> 别名：小林'))
      assert.equal(result.match(/经典发言/g)?.length, 1)
      assert.equal(consistentTemplate('characters', result), result)
      assert.equal(result.replaceAll(eol, '').includes('\n'), false)
    }
  }
  for (const quote of ['', '> ']) {
    const example = `${quote}\`\`\`md\n${quote}经典发言：示例\n${quote}\`\`\``
    const result = consistentTemplate('characters', `${example}\n\n### 核心定位\n主角`)
    assert.ok(result.includes('### 经典发言\n'))
    assert.ok(result.includes(example))
    assert.equal(consistentTemplate('characters', result), result)
  }
})

test('templates preserve facts, aliases, unknown sections and code while merging historical headings', () => {
  const original =
    '> 别名：小林\r\n\r\n### 已确认事实\r\n事实一\r\n### 核心定位\r\n主角\r\n### 外貌特征\r\n黑衣\r\n### 事实与经历\r\n事实二\r\n#### 补充\r\n保留\r\n```md\r\n### 当前状态\r\n示例\r\n```'
  const result = consistentTemplate('characters', original)
  for (const text of [
    '别名：小林',
    '事实一',
    '事实二',
    '主角',
    '黑衣',
    '#### 补充',
    '保留',
    '示例'
  ])
    assert.ok(result.includes(text))
  assert.ok(result.includes('### 外貌与衣着\r\n'))
  assert.equal(result.includes('### 已确认事实'), false)
  assert.ok(validateTemplate('characters', result))
  assert.equal(consistentTemplate('characters', result), result)
  assert.equal(consistentTemplate('characters', ''), templates.characters)
  assert.equal(consistentTemplate('settings', ''), templates.settings)
  assert.equal(consistentTemplate('notes', original), original)
  assert.ok(consistentTemplate('settings', '自由资料').includes('### 具体内容与记录\n\n自由资料'))
  assert.ok(validateTemplate('settings', consistentTemplate('settings', '```\n### 定义\n样例')))
})

test('migration previews, backs up exact source, preserves identity, supports history and is idempotent', async () => {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const parent = await fs.mkdtemp(resolve('.test-artifacts/templates-'))
  const store = new DocumentStore()
  const book = await store.createBook(parent, '模板迁移')
  const before = (
    await store.create(book.id, 'characters', '人物', { content: '### 已确认事实\n事实\n' })
  ).document
  const preview = await migrateTemplates(store, book)
  assert.equal(preview.documents.length, 1)
  assert.equal((await store.read(book.id, before.id)).document.version, before.version)
  const applied = await migrateTemplates(store, book, true)
  assert.ok(applied.applied)
  assert.deepEqual(JSON.parse(await fs.readFile(applied.backup, 'utf8')), [before])
  const after = (await store.read(book.id, before.id)).document
  assert.equal(after.id, before.id)
  assert.equal(after.title, before.title)
  assert.ok(validateTemplate(after.kind, after.content))
  assert.equal((await migrateTemplates(store, book, true)).documents.length, 0)
  assert.ok(
    (await store.history(book.id, before.id)).some((entry) => entry.version === before.version)
  )
})
