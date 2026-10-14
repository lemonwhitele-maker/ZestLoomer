import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proposalDiff } from '../src/shared/proposalDiff'

test('unified replacement keeps intervening paragraphs in one exact before/after pair', () => {
  const before = '前文\n\n旧第一段\n\n保持的段落\n\n旧末段\n\n后文'
  const after = '前文\n\n新第一段\n\n保持的段落\n\n新末段\n\n后文'
  assert.equal(proposalDiff(before, after).hunks.length, 2)
  assert.deepEqual(proposalDiff(before, after, true), {
    hunks: [
      {
        before: '旧第一段\n\n保持的段落\n\n旧末段',
        after: '新第一段\n\n保持的段落\n\n新末段',
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
