import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { changedSource } from '../src/renderer/src/editorSource'
import { agentSelection } from '../src/renderer/src/editorSelection'
import { normalizeModelText } from '../src/shared/lineEndings'

test('model paragraph markers are repaired without changing code, URLs or paths', () => {
  assert.equal(normalizeModelText('甲/n/n乙\\n\\n丙\r\n丁', '\r\n'), '甲\r\n\r\n乙\r\n\r\n丙\r\n丁')
  for (const literal of [
    '`/n/n`',
    '```\n/n/n\n```',
    'https://example.com/n/n',
    'C:\\notes\\new',
    '/notes/n/n',
    '单个/n保留'
  ]) {
    assert.equal(normalizeModelText(literal), literal)
  }
  assert.equal(normalizeModelText(normalizeModelText('甲/n/n乙')), '甲\n\n乙')
})

test('mixed line endings render as lines and local edits preserve all untouched source', () => {
  const source = '前文\r\n第一行\n第二行\r尾声\r\n'
  const state = EditorState.create({ doc: source, selection: { anchor: 7, head: 10 } })
  assert.equal(state.doc.lines, 5)
  const selection = agentSelection(state, source)!
  assert.equal(selection.text, '第二行')
  assert.equal(source.slice(selection.from, selection.to), '第二行')
  const update = state.update({ changes: { from: 7, to: 10, insert: '新段\n\n续段' } })
  assert.equal(changedSource(source, update.changes), '前文\r\n第一行\n新段\r\n\r\n续段\r尾声\r\n')
})

test('paste and multiple replacements keep CRLF source offsets and trailing blank lines', () => {
  const source = '甲\r\n乙\r\n丙\r\n\r\n'
  const state = EditorState.create({ doc: source })
  const update = state.update({
    changes: [
      { from: 0, to: 1, insert: 'A\r\nB' },
      { from: 4, to: 5, insert: 'C\nD' }
    ]
  })
  assert.equal(changedSource(source, update.changes), 'A\r\nB\r\n乙\r\nC\r\nD\r\n\r\n')
})
