import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorSelection, EditorState } from '@codemirror/state'
import { agentSelection } from '../src/renderer/src/editorSelection'

function selectedState(
  source: string,
  separator: string,
  anchor: number,
  head: number
): EditorState {
  return EditorState.create({
    doc: source,
    extensions: EditorState.lineSeparator.of(separator),
    selection: EditorSelection.range(anchor, head)
  })
}

test('LF paragraph selections retain source coordinates for forward and backward selection', () => {
  const source = '甲段\n\n乙段写作\n丙段'
  for (const [anchor, head] of [
    [4, 8],
    [8, 4]
  ]) {
    const selection = agentSelection(selectedState(source, '\n', anchor, head))
    assert.deepEqual(selection, { from: 4, to: 8, text: '乙段写作' })
    assert.equal(source.slice(selection!.from, selection!.to), selection!.text)
  }
})

test('CRLF second-line selections use source positions beyond the first line break', () => {
  const source = '第一行\r\n人物林舟登场\r\n结尾'
  const selection = agentSelection(selectedState(source, '\r\n', 4, 10))
  assert.deepEqual(selection, { from: 5, to: 11, text: '人物林舟登场' })
  assert.equal(source.slice(selection!.from, selection!.to), selection!.text)
})

test('CRLF blank paragraphs and multiline selections preserve every source separator', () => {
  const source = '甲段\r\n\r\n乙段写作\r\n丙段'
  const paragraph = agentSelection(selectedState(source, '\r\n', 4, 8))
  assert.deepEqual(paragraph, { from: 6, to: 10, text: '乙段写作' })
  assert.equal(source.slice(paragraph!.from, paragraph!.to), paragraph!.text)

  for (const [anchor, head] of [
    [1, 10],
    [10, 1]
  ]) {
    const selection = agentSelection(selectedState(source, '\r\n', anchor, head))
    assert.deepEqual(selection, { from: 1, to: 13, text: '段\r\n\r\n乙段写作\r\n丙' })
    assert.equal(source.slice(selection!.from, selection!.to), selection!.text)
  }
})

test('Unicode selections retain UTF-16 offsets used by saved text', () => {
  const source = '😀开场\r\n林舟🧵落笔\r\n完'
  const selection = agentSelection(selectedState(source, '\r\n', 5, 9))
  assert.deepEqual(selection, { from: 6, to: 10, text: '林舟🧵' })
  assert.equal(source.slice(selection!.from, selection!.to), selection!.text)
})

test('cursor-only selections do not send a text range', () => {
  const state = selectedState('甲\r\n乙', '\r\n', 2, 2)
  assert.equal(agentSelection(state), undefined)
})
