<script setup lang="ts">
import { sourceOffset } from '../editorSource'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChangeSet, Compartment, EditorState, Text } from '@codemirror/state'
import { EditorView, drawSelection, keymap } from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyField,
  historyKeymap,
  redo,
  undo,
  insertNewline,
  insertTab
} from '@codemirror/commands'
import {
  SearchQuery,
  search,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll
} from '@codemirror/search'
import type { DocumentSession } from '../session'
import { editorCache as cache, readPosition, writePosition } from '../editorCache'
import type { WorkspacePreferences } from '../../../shared/documents'
import type { KnowledgeEntry } from '../editorKnowledge'
import { knowledgeHighlights } from '../knowledgeHighlights'
import { agentSelection } from '../editorSelection'
import { changedSource } from '../editorSource'

const props = defineProps<{
  session: DocumentSession
  preferences: WorkspacePreferences
  tick: number
  locked: boolean
  knowledgeEntries: KnowledgeEntry[]
  highlightEnabled: boolean
}>()
const emit = defineEmits<{
  reference: [id: string]
  save: []
  selection: [text: string]
  'agent-send': []
}>()
const host = ref<HTMLDivElement>()
const queryInput = ref<HTMLInputElement>()
const showSearch = ref(false)
const showReplace = ref(false)
const query = ref('')
const replacement = ref('')
const caseSensitive = ref(false)
const matchCount = ref(0)
const readOnly = computed(() => {
  void props.tick
  return Boolean(props.session.document.trashedAt) || props.locked
})
const options = new Compartment()
const highlights = new Compartment()
let view: EditorView | undefined
let mountedSession: DocumentSession | undefined
let mountedSource = ''
let positionTimer: ReturnType<typeof setTimeout> | undefined
let restoreFrame: number | undefined
let restoreGeneration = 0
let pendingScrollTop: number | undefined
let heldScrollTop: number | undefined
function cancelRestore(): void {
  if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
  restoreFrame = undefined
  restoreGeneration++
  pendingScrollTop = undefined
}
function restoreScroll(top: number): void {
  cancelRestore()
  pendingScrollTop = top
  const target = view
  const generation = restoreGeneration
  // CodeMirror first measures wrapped lines and its initial viewport. Restore
  // pixels afterwards so that those estimates cannot overwrite the saved height.
  restoreFrame = requestAnimationFrame(() => {
    if (!target || target !== view || generation !== restoreGeneration) return
    target.requestMeasure({
      read: () => top,
      write: (value) => {
        if (target === view && generation === restoreGeneration) {
          target.scrollDOM.scrollTop = value
          pendingScrollTop = undefined
        }
      }
    })
  })
}
function documentKey(session: DocumentSession): string {
  return `${session.bookId}:${session.document.id}`
}
function keepPosition(): void {
  clearTimeout(positionTimer)
  const value = position()
  if (view && mountedSession && value) {
    writePosition(documentKey(mountedSession), {
      ...value,
      topAnchor: view.lineBlockAtHeight(value.scrollTop).from
    })
  }
}
function schedulePosition(): void {
  clearTimeout(positionTimer)
  positionTimer = setTimeout(keepPosition, 150)
}
function settings() {
  return [
    EditorState.readOnly.of(readOnly.value),
    EditorView.editable.of(!readOnly.value),
    EditorView.contentAttributes.of({
      'aria-label':
        props.session.document.kind === 'chapters' ? '正文编辑器' : 'Markdown 源码编辑器',
      spellcheck: 'false'
    }),
    EditorView.theme({
      '&': { height: '100%', fontSize: `${props.preferences.size}px` },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily: props.preferences.font,
        lineHeight: String(props.preferences.lineHeight)
      },
      '.cm-content': {
        padding: '28px 0 140px',
        minHeight: '100%',
        caretColor: 'var(--text-color, #385438)'
      },
      '.cm-line': {
        padding: '0 36px',
        textIndent: props.session.document.kind === 'chapters' ? '2em !important' : '0'
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        background: 'var(--selected-bg, #dce7d5)'
      },
      '.cm-searchMatch': { background: 'var(--search-bg, #f5e6ae)' },
      '.cm-searchMatch-selected': { background: 'var(--search-active-bg, #e4c66f)' }
    })
  ]
}
function highlightSettings() {
  return props.session.document.kind === 'chapters' && props.highlightEnabled
    ? knowledgeHighlights(props.knowledgeEntries)
    : []
}
function newline(target: EditorView): boolean {
  if (readOnly.value || target.composing) return true
  if (props.session.document.kind !== 'chapters') return insertNewline(target)
  target.dispatch(target.state.replaceSelection(Text.of(['', '', ''])), {
    scrollIntoView: true,
    userEvent: 'input.enter'
  })
  return true
}
function keyboardSend(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return
  // Capture before CodeMirror's default Mod-Enter command inserts a blank line.
  event.preventDefault()
  event.stopPropagation()
  if (
    !props.locked &&
    !event.repeat &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !view?.composing
  )
    emit('agent-send')
}
function openSearch(replace = false): boolean {
  showSearch.value = true
  showReplace.value = replace && !readOnly.value
  const selection = view?.state.selection.main
  if (selection && !selection.empty) {
    const text = view!.state.sliceDoc(selection.from, selection.to)
    if (!text.includes('\n')) query.value = text
  }
  void nextTick(() => {
    queryInput.value?.focus()
    queryInput.value?.select()
    updateSearch()
  })
  return true
}
function updateSearch(): void {
  if (!view) return
  const searchQuery = new SearchQuery({
    search: showSearch.value ? query.value : '',
    replace: replacement.value,
    caseSensitive: caseSensitive.value,
    literal: true
  })
  view.dispatch({ effects: setSearchQuery.of(searchQuery) })
  countMatches()
}
function countMatches(): void {
  matchCount.value = 0
  if (!view || !showSearch.value || !query.value) return
  const cursor = new SearchQuery({
    search: query.value,
    caseSensitive: caseSensitive.value,
    literal: true
  }).getCursor(view.state)
  while (!cursor.next().done) matchCount.value++
}
function runSearch(command: 'next' | 'previous' | 'replace' | 'all'): void {
  if (!view || (readOnly.value && (command === 'replace' || command === 'all'))) return
  updateSearch()
  ;({ next: findNext, previous: findPrevious, replace: replaceNext, all: replaceAll })[command](
    view
  )
  countMatches()
}
function closeSearch(): void {
  showSearch.value = false
  showReplace.value = false
  updateSearch()
  view?.focus()
}
function keepState(): void {
  keepPosition()
  if (view && mountedSession)
    cache.set(documentKey(mountedSession), {
      source: mountedSource,
      json: view.state.toJSON({ history: historyField }),
      scrollTop: heldScrollTop ?? pendingScrollTop ?? view.scrollDOM.scrollTop
    })
  // Keep undo histories bounded; lightweight reading positions remain available on disk.
  while (cache.size > 50) cache.delete(cache.keys().next().value!)
}
function mountSession(): void {
  if (!host.value) return
  keepState()
  heldScrollTop = undefined
  cancelRestore()
  view?.destroy()
  mountedSession = props.session
  mountedSource = props.session.content
  const key = documentKey(props.session)
  const cached = cache.get(key)
  const remembered = readPosition(key)
  const compatible = cached?.source === props.session.content
  const config = {
    doc: Text.of(props.session.content.split(/\r\n|\r|\n/)),
    extensions: [
      // Source remains plain text; knowledge highlights are display-only decorations.
      EditorView.lineWrapping,
      history(),
      drawSelection(),
      search(),
      options.of(settings()),
      highlights.of(highlightSettings()),
      keymap.of([
        {
          key: 'Mod-s',
          run: () => {
            emit('save')
            return true
          }
        },
        { key: 'Mod-f', run: () => openSearch() },
        { key: 'Mod-h', run: () => openSearch(true) },
        {
          key: 'Enter',
          run: newline,
          shift: newline
        },
        {
          key: 'Escape',
          run: () => {
            if (!showSearch.value) return false
            closeSearch()
            return true
          }
        },
        { key: 'Tab', run: (target) => (readOnly.value ? false : insertTab(target)) },
        ...historyKeymap,
        ...defaultKeymap
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          mountedSource = changedSource(mountedSource, update.changes)
          props.session.edit(mountedSource)
          countMatches()
        }
        if (update.selectionSet || update.docChanged) {
          schedulePosition()
          const range = update.state.selection.main
          emit('selection', update.state.sliceDoc(range.from, range.to))
        }
      }),
      EditorView.domEventHandlers({
        wheel() {
          cancelRestore()
          return false
        },
        keydown() {
          cancelRestore()
          return false
        },
        scroll() {
          schedulePosition()
          return false
        },
        mousedown(event, target) {
          cancelRestore()
          if (!(event.ctrlKey || event.metaKey)) return false
          const pos = target.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos === null) return false
          const line = target.state.doc.lineAt(pos)
          const pattern =
            /\[\[(?:chapter|character|setting|outline|note|foreshadow):(doc_[a-f0-9-]{36})(?:\|[^\]\r\n]*)?\]\]/g
          for (const match of line.text.matchAll(pattern)) {
            const start = line.from + match.index!
            if (pos >= start && pos <= start + match[0].length) {
              emit('reference', match[1])
              event.preventDefault()
              return true
            }
          }
          return false
        }
      })
    ]
  }
  let state = compatible
    ? EditorState.fromJSON(cached.json, config, { history: historyField })
    : EditorState.create(config)
  if (cached && !compatible) {
    const before = cached.source.replace(/\r\n|\r/g, '\n')
    const after = state.doc.toString()
    let from = 0,
      oldEnd = before.length,
      newEnd = after.length
    while (from < oldEnd && from < newEnd && before[from] === after[from]) from++
    while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) {
      oldEnd--
      newEnd--
    }
    const changes = ChangeSet.of(
      { from, to: oldEnd, insert: after.slice(from, newEnd) },
      before.length
    )
    if (remembered)
      state = state.update({
        selection: {
          anchor: changes.mapPos(Math.min(before.length, remembered.anchor)),
          head: changes.mapPos(Math.min(before.length, remembered.head))
        }
      }).state
  } else if (!compatible && remembered) {
    state = state.update({
      selection: {
        anchor: Math.min(state.doc.length, remembered.anchor),
        head: Math.min(state.doc.length, remembered.head)
      }
    }).state
  }
  view = new EditorView({
    state,
    parent: host.value,
    scrollTo: remembered
      ? EditorView.scrollIntoView(
          Math.min(state.doc.length, remembered.topAnchor ?? remembered.anchor),
          { y: 'start', yMargin: 0 }
        )
      : undefined
  })
  if (remembered) restoreScroll(remembered.scrollTop)
  emit('selection', state.sliceDoc(state.selection.main.from, state.selection.main.to))
  view.dispatch({ effects: options.reconfigure(settings()) })
  showSearch.value = false
  showReplace.value = false
  query.value = ''
  updateSearch()
}
watch(
  () => props.session,
  () => mountSession()
)
watch(
  () => props.tick,
  () => {
    if (view && mountedSource !== props.session.content) {
      mountSession()
    }
  }
)
watch(
  () => [
    props.preferences.font,
    props.preferences.size,
    props.preferences.lineHeight,
    readOnly.value
  ],
  (values, previous) => {
    if (view) {
      const top = heldScrollTop ?? pendingScrollTop ?? view.scrollDOM.scrollTop
      view.dispatch({ effects: options.reconfigure(settings()) })
      if (values[3] !== previous[3]) {
        view.scrollDOM.scrollTop = top
        restoreScroll(top)
        if (!readOnly.value) heldScrollTop = undefined
      }
    }
    if (readOnly.value) showReplace.value = false
  }
)
watch([query, replacement, caseSensitive], updateSearch)
watch(
  () => JSON.stringify([props.highlightEnabled, props.knowledgeEntries]),
  () => {
    if (view) view.dispatch({ effects: highlights.reconfigure(highlightSettings()) })
  }
)
onMounted(() => {
  mountSession()
  window.addEventListener('beforeunload', keepPosition)
})
onBeforeUnmount(() => {
  keepState()
  cancelRestore()
  window.removeEventListener('beforeunload', keepPosition)
  view?.destroy()
})
function insert(text: string): void {
  if (!view || readOnly.value) return
  const range = view.state.selection.main
  const inserted = Text.of(text.split(/\r\n|\r|\n/))
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: inserted },
    selection: { anchor: range.from + inserted.length },
    userEvent: 'input'
  })
  view.focus()
}
function position(): { anchor: number; head: number; scrollTop: number } | undefined {
  if (!view) return undefined
  return {
    anchor: view.state.selection.main.anchor,
    head: view.state.selection.main.head,
    scrollTop: heldScrollTop ?? pendingScrollTop ?? view.scrollDOM.scrollTop
  }
}
function restorePosition(value: { anchor: number; head: number; scrollTop: number }): void {
  if (!view) return
  const limit = view.state.doc.length
  view.dispatch({
    selection: {
      anchor: Math.min(limit, Math.max(0, value.anchor)),
      head: Math.min(limit, Math.max(0, value.head))
    }
  })
  view.scrollDOM.scrollTop = value.scrollTop
  restoreScroll(value.scrollTop)
  view.focus()
}
function goToLine(number: number): void {
  if (!view) return
  cancelRestore()
  const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, Math.floor(number))))
  view.dispatch({
    selection: { anchor: line.from, head: line.to },
    effects: EditorView.scrollIntoView(line.from, { y: 'center' })
  })
  view.focus()
}
defineExpose({
  rememberPosition: () => {
    heldScrollTop = position()?.scrollTop
    keepPosition()
  },
  releasePosition: () => {
    if (heldScrollTop !== undefined) restoreScroll(heldScrollTop)
    heldScrollTop = undefined
  },
  focus: () => view?.focus(),
  focused: () => Boolean(view?.hasFocus),
  position,
  restorePosition,
  goToLine,
  search: () => openSearch(),
  replace: () => openSearch(true),
  insert,
  undo: () => {
    if (view && !readOnly.value) undo(view)
  },
  redo: () => {
    if (view && !readOnly.value) redo(view)
  },
  context: () => ({
    documentId: props.session.document.id,
    savedVersion: props.session.document.version,
    hasUnsavedChanges: props.session.dirty,
    selection: view?.state.selection.main.toJSON()
  }),
  agentContext: () => {
    return {
      documentId: props.session.document.id,
      savedVersion: props.session.document.version,
      editorContent: props.session.content,
      cursor: view
        ? sourceOffset(props.session.content, view.state.selection.main.head)
        : undefined,
      selection: view ? agentSelection(view.state, props.session.content) : undefined
    }
  },
  composing: () => Boolean(view?.composing)
})
</script>

<template>
  <div class="text-editor" :class="{ readonly: readOnly }">
    <div v-if="showSearch" class="find-panel" aria-label="当前文档查找">
      <div class="find-row">
        <input
          ref="queryInput"
          v-model="query"
          aria-label="查找文字"
          placeholder="查找当前文档"
          @keydown.enter.prevent="runSearch('next')"
          @keydown.esc="closeSearch"
        />
        <span class="match-count">{{ matchCount }} 处</span>
        <label><input v-model="caseSensitive" type="checkbox" />区分大小写</label>
        <button title="上一个" @click="runSearch('previous')">↑</button>
        <button title="下一个" @click="runSearch('next')">↓</button>
        <button v-if="!readOnly" @click="showReplace = !showReplace">替换</button>
        <button aria-label="关闭查找" @click="closeSearch">×</button>
      </div>
      <div v-if="showReplace && !readOnly" class="find-row">
        <input
          v-model="replacement"
          aria-label="替换文字"
          placeholder="替换为"
          @keydown.enter.prevent="runSearch('replace')"
        />
        <button @click="runSearch('replace')">替换下一处</button>
        <button @click="runSearch('all')">替换本篇全部</button>
      </div>
    </div>
    <div ref="host" class="editor-host" @keydown.capture="keyboardSend" />
  </div>
</template>
