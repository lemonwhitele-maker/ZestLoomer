import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseTextImport } from '../src/shared/imports'
import { decodeImportText, readTextImport } from '../src/main/imports'

async function fixture(): Promise<string> {
  const parent = resolve('.test-artifacts')
  await fs.mkdir(parent, { recursive: true })
  return fs.mkdtemp(join(parent, 'import-'))
}

test('TXT splitting preserves prefix, Chinese and numeric chapter order, specials and body whitespace', () => {
  const source =
    '\uFEFF书前说明\r\n\r\n序章 风起\r\n  序章文字  \r\n第十二章 相逢\r\n正文\r\n第2章 回望\r\n\r\n结尾  \r\n番外（一） 灯火\r\n番外正文'
  const value = parseTextImport(source, '一部小说.txt')
  assert.deepEqual(
    value.items.map((item) => item.title),
    ['一部小说 · 开篇文字', '序章 风起', '第十二章 相逢', '第2章 回望', '番外（一） 灯火']
  )
  assert.equal(value.items[0].content, '书前说明\r\n\r\n')
  assert.equal(value.items[1].content, '  序章文字  \r\n')
  assert.equal(value.items[3].content, '\r\n结尾  \r\n')
  assert.equal(value.items[4].content, '番外正文')
  assert.equal(value.rawContent, source.slice(1))
})

test('Markdown defaults to one document; optional split respects hierarchy and code fences', () => {
  const source = '# 总览\n介绍\n## 细节\n保留子标题\n```md\n# 假标题\n```\n# 第二幕\n尾文\n'
  const whole = parseTextImport(source, '故事.md')
  assert.equal(whole.items.length, 1)
  assert.equal(whole.items[0].content, source)
  const split = parseTextImport(source, '故事.md', {
    split: true,
    markdown: true,
    kind: 'outlines'
  })
  assert.deepEqual(
    split.items.map((item) => item.title),
    ['总览', '第二幕']
  )
  assert.match(split.items[0].content, /## 细节/)
  assert.match(split.items[0].content, /# 假标题/)
  assert.ok(split.items.every((item) => item.kind === 'outlines'))
})

test('unrecognized chapter boundaries preserve the whole source and duplicate titles remain explicit', () => {
  assert.throws(() => parseTextImport(' \r\n', '空.txt'), /没有可导入/)
  const value = parseTextImport('这是没有章标题的文字\n', '正文.txt')
  assert.equal(value.items[0].content, '这是没有章标题的文字\n')
  assert.match(value.warnings.join('\n'), /没有识别/)
  const duplicate = parseTextImport('第1章 甲\n第一份\n第1章 甲\n第二份', '正文.txt')
  assert.equal(duplicate.items.length, 2)
  assert.match(duplicate.warnings.join('\n'), /重复标题/)
})

test('UTF-8 BOM and GB18030 bytes decode without replacement or silently accepting invalid input', async () => {
  assert.equal(decodeImportText(Buffer.from('\uFEFF中文', 'utf8'), 'utf8'), '中文')
  assert.equal(decodeImportText(Buffer.from('\uFEFF中文', 'utf8'), 'gb18030'), '中文')
  assert.equal(decodeImportText(Buffer.from('\uFEFF中文', 'utf16le'), 'utf8'), '中文')
  assert.equal(
    decodeImportText(Uint8Array.from([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87]), 'utf8'),
    '中文'
  )
  assert.equal(decodeImportText(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]), 'gb18030'), '中文')
  assert.throws(() => decodeImportText(Uint8Array.from([0xff]), 'utf8'), /不是有效的 UTF-8/)
  const root = await fixture()
  const path = join(root, '旧中文.txt')
  await fs.writeFile(path, Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]))
  const value = await readTextImport(path, 'gb18030')
  assert.equal(value.items[0].content, '中文')
  assert.equal((await fs.readFile(path)).toString('hex'), 'd6d0cec4')
  await assert.rejects(readTextImport(path, 'utf8'), /不是有效的 UTF-8/)
})
