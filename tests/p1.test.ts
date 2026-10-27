import test from 'node:test'
import assert from 'node:assert/strict'
import { ChangeSet, Text } from '@codemirror/state'
import { reactive, ref } from 'vue'
import { countWords } from '../src/shared/wordCount'
import { SourceOffsets, changedSource } from '../src/renderer/src/editorSource'
import { queryTimeout, timedQueries } from '../src/shared/queryTimeout'
import { proposalDiff } from '../src/shared/proposalDiff'
import { proposalPreview } from '../src/renderer/src/proposalPreview'
import { dirtyFields } from '../src/renderer/src/components/settings/dirtyFields'

test('count semantics match all BMP characters, Unicode whitespace and unpaired surrogates', () => {
  const samples = [
    '😀甲\u00a0乙\u3000\ufeff\u2028\ud800x\udc00',
    'a\r\nb\nc\r',
    '\ud800 \n\u00a0\udc00',
    '\ud800\ud800 \udc00'
  ]
  for (let i = 0; i < 65536; i += 512)
    samples.push(String.fromCharCode(...Array.from({ length: 512 }, (_, n) => n + i)))
  for (const text of samples)
    assert.equal(countWords(text), Array.from(text.replace(/\s/g, '')).length)
})

test('source index agrees at every UTF-16 boundary across mixed line endings', () => {
  for (const source of ['', '甲😀\r\n\r\n乙\n丙\r丁\r\n', 'a\n'.repeat(500), 'a\r\n'.repeat(500)]) {
    const index = new SourceOffsets(source)
    const normalized = source.replace(/\r\n|\r/g, '\n')
    for (let pos = 0; pos <= normalized.length; pos++) {
      let extra = 0
      for (const match of source.matchAll(/\r\n|\r|\n/g)) {
        if (match.index - extra >= pos) break
        extra += match[0].length - 1
      }
      assert.equal(index.offset(pos), pos + extra)
    }
  }
})

test('multiple edits preserve untouched mixed separators and emoji', () => {
  const source = '😀甲\r\n乙\n丙\r丁\r\n末'
  const doc = Text.of(source.split(/\r\n|\r|\n/))
  const changes = ChangeSet.of(
    [
      { from: 2, to: 3, insert: '新' },
      { from: doc.length, insert: '\n终' }
    ],
    doc.length
  )
  assert.equal(changedSource(source, changes), '😀新\r\n乙\n丙\r丁\r\n末\r\n终')
})

test('large mostly unchanged proposal retains precise line numbers after trimming', () => {
  const prefix = '相同\r\n'.repeat(10000)
  const suffix = '\n结尾'.repeat(10000)
  const result = proposalDiff(prefix + '旧' + suffix, prefix + '新' + suffix)
  assert.equal(result.coarse, false)
  assert.deepEqual(result.hunks, [
    { before: '旧\n', after: '新\n', oldLine: 10001, newLine: 10001 }
  ])
})

test('query deadline ignores late results; write operations are excluded', async () => {
  let resolve!: (value: string) => void
  const pending = new Promise<string>((r) => {
    resolve = r
  })
  await assert.rejects(queryTimeout(pending, 5), { code: 'QUERY_TIMEOUT' })
  resolve('late')
  assert.equal(await queryTimeout(Promise.resolve('ok'), 100), 'ok')
  for (const name of [
    'save',
    'draft',
    'agent:action',
    'agent:start',
    'workspace:history-restore',
    'preferences'
  ])
    assert.equal(timedQueries.has(name), false)
})

test('settings dirty state follows only its local fields and saved baseline', () => {
  const form = reactive({ text: '甲', enabled: false })
  const baseline = ref(JSON.stringify(form))
  const dirty = dirtyFields(form, baseline)
  assert.equal(dirty.value, false)
  form.text = '乙'
  assert.equal(dirty.value, true)
  baseline.value = JSON.stringify(form)
  assert.equal(dirty.value, false)
  form.enabled = true
  assert.equal(dirty.value, true)
  Object.assign(form, JSON.parse(baseline.value))
  assert.equal(dirty.value, false)
})

test('large preview marks coarse highlighting and bounds groups without changing source text', () => {
  const before = '甲'.repeat(100001)
  const after = '乙'.repeat(100001)
  const coarse = proposalPreview(before, after, true)
  assert.equal(coarse.coarse, true)
  assert.equal(coarse.highlighted[0].before.map((span) => span.text).join(''), before)
  assert.equal(coarse.highlighted[0].after.map((span) => span.text).join(''), after)
  const grouped = proposalPreview(
    Array.from({ length: 90 }, (_, i) => `旧${i}\n同${i}\n`).join(''),
    Array.from({ length: 90 }, (_, i) => `新${i}\n同${i}\n`).join(''),
    false
  )
  assert.equal(grouped.truncated, true)
  assert.equal(grouped.hunks.length, 80)
  assert.equal(grouped.hunks[0].before, '旧0\n')
})
