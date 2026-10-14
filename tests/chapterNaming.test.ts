import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chapterDiagnostics,
  chineseNumber,
  defaultNamingRule,
  formatChapterTitles,
  formatChapterTitle,
  parseChapterTitle,
  renumberChapters,
  sortChapters,
  validateNamingRule
} from '../src/shared/chapterNaming'

test('free titles remain free; numbered titles support suffix, padding and explicit templates', () => {
  assert.equal(formatChapterTitle(defaultNamingRule, 1, '  序章：雨夜  '), '序章：雨夜')
  assert.equal(
    formatChapterTitle(
      { ...defaultNamingRule, mode: 'number', suffix: '回', padding: 3 },
      12,
      '重逢'
    ),
    '第012回 重逢'
  )
  assert.equal(
    formatChapterTitle({ ...defaultNamingRule, mode: 'hanzi' }, 101, '山外'),
    '第一百零一章 山外'
  )
  assert.equal(
    formatChapterTitle(
      { ...defaultNamingRule, mode: 'number', template: '{n:03} · {cn} · {title}' },
      20,
      ' 雨后 '
    ),
    '020 · 二十 · 雨后'
  )
  assert.equal(formatChapterTitle({ ...defaultNamingRule, mode: 'number' }, 2, ''), '第2章')
  assert.equal(
    formatChapterTitle({ ...defaultNamingRule, mode: 'hanzi', suffix: '部' }, 3, '远行'),
    '第三部 远行'
  )
})

test('chapter parsing recognizes Chinese, padded and fullwidth numbers without rewriting other titles', () => {
  for (const [title, number, subtitle] of [
    ['第001章：雨夜', 1, '雨夜'],
    ['第十二回 重逢', 12, '重逢'],
    ['第三部 远行', 3, '远行'],
    ['第004部：归来', 4, '归来'],
    ['第一万零一章 远方', 10001, '远方'],
    ['第两百章', 200, ''],
    ['第００２章 落雨', 2, '落雨'],
    ['03. 夜色', 3, '夜色'],
    ['第十万零一章 长篇', 100001, '长篇']
  ] as const)
    assert.deepEqual(parseChapterTitle(title), { number, subtitle })
  for (const title of [
    '序章',
    '番外：第2章之后',
    '第一幕 夜色',
    '第十十章 误字',
    '第1000000章 超限',
    '第零章 自由章'
  ])
    assert.deepEqual(parseChapterTitle(title), { number: null, subtitle: title })
})

test('Chinese numbering includes internal zeroes and valid bounds', () => {
  for (const [number, title] of [
    [10, '十'],
    [20, '二十'],
    [101, '一百零一'],
    [1001, '一千零一'],
    [10010, '一万零一十'],
    [999999, '九十九万九千九百九十九']
  ] as const)
    assert.equal(chineseNumber(number), title)
  assert.throws(() => chineseNumber(0))
  assert.throws(() => chineseNumber(1000000))
  assert.throws(() => chineseNumber(2.5))
})

test('number sorting holds unmatched positions and retains duplicates in stable order', () => {
  const items = [
    { id: 'prologue', title: '序章' },
    { id: 'ten', title: '第10章 十' },
    { id: 'two-a', title: '第二章 贰' },
    { id: 'extra', title: '番外' },
    { id: 'one', title: '第1章 一' },
    { id: 'two-b', title: '第02章 二' }
  ]
  assert.deepEqual(
    sortChapters(items, 'number').map((item) => item.id),
    ['prologue', 'one', 'two-a', 'extra', 'two-b', 'ten']
  )
  assert.deepEqual(
    items.map((item) => item.id),
    ['prologue', 'ten', 'two-a', 'extra', 'one', 'two-b']
  )
  const diagnostics = chapterDiagnostics(items)
  assert.deepEqual(
    diagnostics.unmatched.map((item) => item.id),
    ['prologue', 'extra']
  )
  assert.deepEqual(
    diagnostics.duplicates.map((group) => ({
      number: group.number,
      ids: group.items.map((item) => item.id)
    })),
    [{ number: 2, ids: ['two-a', 'two-b'] }]
  )
  assert.deepEqual(diagnostics.gaps, [{ start: 3, end: 9 }])
})

test('natural title and creation time sorts are numeric-aware and stable', () => {
  const items = [
    { id: '10', title: '笔记10', createdAt: '2026-10-02T00:00:00Z' },
    { id: '2-a', title: '笔记2', createdAt: '2026-10-01T00:00:00Z' },
    { id: '2-b', title: '笔记2', createdAt: '2026-10-01T00:00:00Z' }
  ]
  assert.deepEqual(
    sortChapters(items, 'natural').map((item) => item.id),
    ['2-a', '2-b', '10']
  )
  assert.deepEqual(
    sortChapters(items, 'created').map((item) => item.id),
    ['2-a', '2-b', '10']
  )
})

test('renumbering preserves subtitles and unrecognized titles, and never changes source data', () => {
  const items = [
    { id: 's', title: '序章' },
    { id: 'a', title: '第10章：雨夜' },
    { id: 'b', title: '第二回 重逢' },
    { id: 'x', title: '番外（旧标题）' }
  ]
  assert.deepEqual(
    renumberChapters(items, { ...defaultNamingRule, mode: 'hanzi', suffix: '回', start: 3 }),
    [
      { id: 's', title: '序章' },
      { id: 'a', title: '第三回 雨夜' },
      { id: 'b', title: '第四回 重逢' },
      { id: 'x', title: '番外（旧标题）' }
    ]
  )
  assert.equal(items[1].title, '第10章：雨夜')
  assert.deepEqual(renumberChapters(items, defaultNamingRule), items)
  assert.throws(() =>
    renumberChapters(items, { ...defaultNamingRule, mode: 'number', start: 999999 })
  )
})

test('invalid rules and unbounded template tokens are rejected', () => {
  assert.equal(validateNamingRule(defaultNamingRule), null)
  for (const rule of [
    { ...defaultNamingRule, start: 0 },
    { ...defaultNamingRule, start: 1.5 },
    { ...defaultNamingRule, padding: 7 },
    { ...defaultNamingRule, suffix: '章\n' },
    { ...defaultNamingRule, template: '{n:999999} {title}' },
    { ...defaultNamingRule, template: '{unknown} {n}' },
    { ...defaultNamingRule, template: '{title}' },
    { ...defaultNamingRule, template: '第{n}章\n{title}' }
  ])
    assert.equal(typeof validateNamingRule(rule), 'string')
})

test('formatting is independent from renumbering and retains original chapter numbers', () => {
  const items = [
    { id: 's', title: '序章' },
    { id: 'a', title: '第10章：雨夜' },
    { id: 'b', title: '第二回 重逢' }
  ]
  const rule = {
    ...defaultNamingRule,
    mode: 'number' as const,
    suffix: '节',
    padding: 3,
    start: 99
  }
  assert.deepEqual(formatChapterTitles(items, rule), [
    { id: 's', title: '序章' },
    { id: 'a', title: '第010节 雨夜' },
    { id: 'b', title: '第002节 重逢' }
  ])
})

test('missing ranges respect a custom starting number, mixed numbering and duplicates', () => {
  const items = Object.freeze([
    Object.freeze({ id: '18', title: '第十八章' }),
    Object.freeze({ id: '10', title: '第１０回 起始章' }),
    Object.freeze({ id: 'extra', title: '番外' }),
    Object.freeze({ id: '14-a', title: '第014节' }),
    Object.freeze({ id: '11', title: '第十一章' }),
    Object.freeze({ id: '14-b', title: '第十四章 重复编号' })
  ])
  const diagnostics = chapterDiagnostics(items)
  assert.deepEqual(diagnostics.gaps, [
    { start: 12, end: 13 },
    { start: 15, end: 17 }
  ])
  assert.deepEqual(
    diagnostics.duplicates.map((group) => group.number),
    [14]
  )
  assert.deepEqual(
    diagnostics.unmatched.map((item) => item.id),
    ['extra']
  )
  assert.equal(items[0].id, '18')
})

test('empty, unnumbered, single-number and contiguous chapter lists have no missing ranges', () => {
  for (const titles of [
    [],
    ['序章', '番外'],
    ['第99章'],
    ['第99章', '第九十九回'],
    ['第10章', '第12章', '第11章']
  ])
    assert.deepEqual(
      chapterDiagnostics(titles.map((title, index) => ({ id: String(index), title }))).gaps,
      []
    )
})

test('large numbering gaps are represented by one bounded range and invalid endpoints stay unmatched', () => {
  const diagnostics = chapterDiagnostics([
    { id: 'last', title: '第999999章' },
    { id: 'zero', title: '第0章' },
    { id: 'first', title: '第1章' },
    { id: 'over', title: '第1000000章' }
  ])
  assert.deepEqual(diagnostics.gaps, [{ start: 2, end: 999998 }])
  assert.equal(diagnostics.gaps.length, 1)
  assert.deepEqual(
    diagnostics.unmatched.map((item) => item.id),
    ['zero', 'over']
  )
})
