import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proposalDiff, inlineDiff } from '../src/shared/proposalDiff'

test('unified replacement keeps intervening paragraphs in one exact before/after pair', () => {
  const before = '前文\n\n旧第一段\n\n保持的段落\n\n旧末段\n\n后文'
  const after = '前文\n\n新第一段\n\n保持的段落\n\n新末段\n\n后文'
  assert.equal(proposalDiff(before, after).hunks.length, 2)
  assert.deepEqual(proposalDiff(before, after, true), {
    hunks: [
      {
        before: '旧第一段\n\n保持的段落\n\n旧末段\n',
        after: '新第一段\n\n保持的段落\n\n新末段\n',
        oldLine: 3,
        newLine: 3
      }
    ],
    coarse: false
  })
  assert.equal(proposalDiff(before, before, true).hunks.length, 0)
  assert.equal(proposalDiff('', '新段\n\n后段', true).hunks[0].after, '新段\n\n后段')
  assert.equal(proposalDiff('删除的段落', '', true).hunks[0].after, '')
})

test('continuation previews expose the actual inserted separator and never invent a terminal newline', () => {
  for (const unified of [false, true]) {
    for (const separator of ['\n', '\r\n', '\r']) {
      const diff = proposalDiff('原文', '原文' + separator + '续写', unified)
      assert.equal(diff.hunks[0].before, '原文')
      assert.equal(diff.hunks[0].after, '原文' + separator + '续写')
      const spans = inlineDiff(diff.hunks[0].before, diff.hunks[0].after)
      assert.equal(
        spans.after
          .filter((span) => span.newline)
          .map((span) => span.text)
          .join(''),
        separator
      )
      assert.equal(
        proposalDiff('原文' + separator, '原文' + separator + separator, unified).hunks[0].after,
        separator
      )
    }
  }
})

test('inline preview highlights actual words and inserted separators while preserving all Unicode text', () => {
  const before = '他推开冰冷的门，走进空屋。😀'
  const after = '他推开沉重的门，走进暗屋。😀\n\n续写'
  const spans = inlineDiff(before, after)
  assert.equal(spans.before.map((span) => span.text).join(''), before)
  assert.equal(spans.after.map((span) => span.text).join(''), after)
  assert.equal(
    spans.before
      .filter((span) => span.changed)
      .map((span) => span.text)
      .join(''),
    '冰冷空'
  )
  assert.equal(
    spans.after
      .filter((span) => span.changed)
      .map((span) => span.text)
      .join(''),
    '沉重暗\n\n续写'
  )
  assert.equal(spans.after.filter((span) => span.newline).length, 2)
  assert.ok(spans.after.some((span) => !span.changed && span.text.includes('😀')))
  assert.equal(
    inlineDiff('', '长'.repeat(100000))
      .after.map((span) => span.text)
      .join(''),
    '长'.repeat(100000)
  )
})
