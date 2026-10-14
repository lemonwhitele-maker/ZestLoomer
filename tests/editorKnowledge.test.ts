import test from 'node:test'
import assert from 'node:assert/strict'
import { knowledgeAliases, knowledgeEntries } from '../src/renderer/src/editorKnowledge'
import { documentAliases } from '../src/main/agent/related'
import type { DocumentMeta } from '../src/shared/documents'

test('knowledge aliases support migrated records, explicit fields and YAML without consuming the next line', () => {
  assert.deepEqual(
    knowledgeAliases('> **来源记录**：状态：active | 别名：白衣客、陆先生 | 标签：主角\n'),
    ['白衣客', '陆先生']
  )
  assert.deepEqual(knowledgeAliases('---\naliases:\n  - 城门\n  - "A+B"\n---\n正文'), [
    '城门',
    'A+B'
  ])
  assert.deepEqual(knowledgeAliases('aliases: ["白衣客", \'陆先生\']\n别称：白衣客；舟哥'), [
    '白衣客',
    '陆先生',
    '舟哥'
  ])
  assert.deepEqual(knowledgeAliases('别名：\n这里不是别名\n化名：新称呼'), ['新称呼'])
})

test('editor and agent share explicit alias parsing across headings, YAML and migrated records', () => {
  const content = [
    '---',
    'aliases:',
    '  - "白衣客"',
    "  - '陆先生'",
    'tags:',
    '  - 不是别名',
    '---',
    '> **来源记录**：状态：active | 别名：白衣客、舟哥 | 标签：主角',
    '**别称**：城门；雾港',
    '- **化名：** 新称呼',
    'aliases: ["A+B", \'港口\']',
    '### 别名',
    '- 舟哥',
    '- 林先生',
    '',
    '正文开始。',
    '- 正文清单不是别名',
    '### 其他',
    '- 另一个清单',
    '别名：\n这行正文不属于别名',
    'aliases: 行内称呼|另一个称呼'
  ].join('\n')
  const expected = [
    '白衣客',
    '陆先生',
    '舟哥',
    '城门',
    '雾港',
    '新称呼',
    'A+B',
    '港口',
    '林先生',
    '行内称呼',
    '另一个称呼'
  ]
  assert.deepEqual(knowledgeAliases(content), expected)
  assert.deepEqual(documentAliases(content), expected)
})

test('explicit aliases exclude fenced examples and prose following alias sections', () => {
  const content = [
    '```yaml',
    'aliases: [示例别名]',
    '```',
    '~~~markdown',
    '### 别名',
    '- 假名',
    '~~~',
    '别名：真实名字',
    '### Aliases',
    '- 真实名字',
    '下面写正文。',
    '- 普通项目',
    '他提到别名：句中的称呼',
    '别名：',
    '- 空字段后的正文项目',
    '```',
    '化名：未闭合示例'
  ].join('\n')
  assert.deepEqual(knowledgeAliases(content), ['真实名字'])
  assert.deepEqual(documentAliases(content), ['真实名字'])
})

test('agent aliases retain minimum length, maximum length and count limits', () => {
  const names = ['短', '长'.repeat(81), ...Array.from({ length: 23 }, (_, index) => `名字${index}`)]
  const content = `aliases: [${names.join(',')}]`
  assert.deepEqual(knowledgeAliases(content), names)
  assert.deepEqual(documentAliases(content), names.slice(2, 22))
})

test('YAML aliases only come from a top-level array, excluding nested fields and block prose', () => {
  const cases = [
    ['summary: |\n  aliases: [并非人物别名]\naliases: [白衣客]', ['白衣客']],
    ['extra:\n  aliases:[局部对象标签]\naliases: [白衣客]', ['白衣客']],
    ['aliases: >\n  这段正文不是别名', []],
    ['aliases: |\n  别名：正文中的标签', []],
    ['aliases: 普通标量', []]
  ] as const
  for (const [yaml, expected] of cases) {
    const content = `---\n${yaml}\n---`
    assert.deepEqual(knowledgeAliases(content), expected)
    assert.deepEqual(documentAliases(content), expected)
  }
})

test('YAML aliases retain quoted punctuation and strip scalar comments independently of Markdown fields', () => {
  const content = [
    '---',
    "aliases: ['A,B','A|B', 'D''E', \"F#G\", 'Captain: Joe'] # array comment",
    '---',
    '别名：Markdown甲、Markdown乙|Markdown丙'
  ].join('\n')
  const expected = [
    'A,B',
    'A|B',
    "D'E",
    'F#G',
    'Captain: Joe',
    'Markdown甲',
    'Markdown乙',
    'Markdown丙'
  ]
  assert.deepEqual(knowledgeAliases(content), expected)
  assert.deepEqual(documentAliases(content), expected)
  const block = [
    '---',
    'aliases:',
    '  - 白衣客 # 注释',
    "  - 'A,B' # 原样保留",
    '  - "A|B"',
    "  - 'D''E'",
    "  - 'A # B' # 引号内井号保留",
    '  - >',
    '    aliases: [正文中错误的别名]',
    '  - 陆先生',
    'extra:',
    '  aliases: [局部对象标签]',
    '---',
    '别称：陆先生'
  ].join('\n')
  const blockExpected = ['白衣客', 'A,B', 'A|B', "D'E", 'A # B', '陆先生']
  assert.deepEqual(knowledgeAliases(block), blockExpected)
  assert.deepEqual(documentAliases(block), blockExpected)
})

test('highlight entries exclude trash and unrelated kinds, prefer characters and order longer names first', () => {
  const document = (
    id: string,
    kind: DocumentMeta['kind'],
    title: string,
    trashedAt: string | null = null
  ): DocumentMeta => ({
    id,
    kind,
    title,
    trashedAt,
    order: 0,
    generation: '1',
    createdAt: '',
    updatedAt: ''
  })
  const entries = knowledgeEntries(
    [
      document('s', 'settings', '雾港'),
      document('c', 'characters', '林舟'),
      document('long', 'characters', '林舟先生'),
      document('trash', 'characters', '已回收', 'today'),
      document('note', 'notes', '灵感')
    ],
    { s: '别名：林舟、城门', c: '别名：白衣客、lin', trash: '别名：旧别名' }
  )
  assert.equal(entries[0].name, '林舟先生')
  assert.equal(entries.find((entry) => entry.name === '林舟')?.kind, 'characters')
  assert.deepEqual(
    new Set(entries.map((entry) => entry.name)),
    new Set(['林舟先生', '林舟', '雾港', '城门', '白衣客', 'lin'])
  )
})
