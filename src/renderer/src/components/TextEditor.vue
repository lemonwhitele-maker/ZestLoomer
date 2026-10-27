<script setup lang="ts">
import { SourceOffsets } from '../editorSource'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ChangeSet,
  Compartment,
  EditorState,
  EditorSelection,
  Text,
  Transaction
} from '@codemirror/state'
import { EditorView, ViewPlugin, Decoration, drawSelection, keymap } from '@codemirror/view'
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
import { editorCache as cache, readPosition, writePosition, trimEditorCache } from '../editorCache'
import type { WorkspacePreferences } from '../../../shared/documents'
import type { KnowledgeEntry } from '../editorKnowledge'
import { knowledgeHighlights } from '../knowledgeHighlights'
import { agentSelection } from '../editorSelection'
import { changedSource } from '../editorSource'

const props = defineProps<{
  modern: boolean
  paperWidth: number
  typewriter: boolean
  chinesePairs: boolean
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
const scrollHeading = ref<HTMLElement>()
const matchIndex = ref(0)
const typing = ref(false)
let typingTimer: ReturnType<typeof setTimeout> | undefined
const queryInput = ref<HTMLInputElement>()
const showSearch = ref(false)
const showReplace = ref(false)
const query = ref('')
const replacement = ref('')
const caseSensitive = ref(false)
const matchCount = ref(0)
const readOnly = computed(() => {
  void props.tick
  return (
    Boolean(props.session.document.trashedAt || props.session.document.readonlyExample) ||
    props.locked
  )
})
const options = new Compartment()
const highlights = new Compartment()
const undoHistory = new Compartment()
let view: EditorView | undefined
let mountedSession: DocumentSession | undefined
let mountedSource = ''
let sourceOffsets = new SourceOffsets('')
let synchronizing = false
let switchTimer: ReturnType<typeof setTimeout> | undefined
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
      topAnchor: view.lineBlockAtHeight(
        Math.max(0, value.scrollTop - (scrollHeading.value?.offsetHeight || 0))
      ).from
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
        display: 'block !important',
        overflow: 'auto',
        fontFamily: props.preferences.font,
        lineHeight: String(props.preferences.lineHeight)
      },
      '.cm-content': {
        padding: props.typewriter ? '24px 0 55vh' : '24px 0 140px',
        minHeight: '100%',
        caretColor: 'var(--text-color, #385438)'
      },
      '.cm-line.empty-line': { textIndent: '0 !important' },
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
    mountedSession === props.session &&
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
    if (view) view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main) })
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
  matchIndex.value = 0
  if (!view || !showSearch.value || !query.value) return
  const cursor = new SearchQuery({
    search: query.value,
    caseSensitive: caseSensitive.value,
    literal: true
  }).getCursor(view.state)
  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    matchCount.value++
    if (
      item.value.from === view.state.selection.main.from &&
      item.value.to === view.state.selection.main.to
    )
      matchIndex.value = matchCount.value
  }
}
function runSearch(command: 'next' | 'previous' | 'replace' | 'all'): void {
  if (!view || (readOnly.value && (command === 'replace' || command === 'all'))) return
  updateSearch()
  ;({ next: findNext, previous: findPrevious, replace: replaceNext, all: replaceAll })[command](
    view
  )
  countMatches()
}
function searchKeyboard(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229 || event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  closeSearch()
}
function searchEnter(event: KeyboardEvent, replace = false): void {
  if (event.isComposing || event.keyCode === 229) return
  event.preventDefault()
  runSearch(replace ? 'replace' : event.shiftKey ? 'previous' : 'next')
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
  trimEditorCache()
}
function mountSession(): void {
  if (!host.value) return
  clearTimeout(switchTimer)
  if (view?.composing) {
    switchTimer = setTimeout(mountSession, 30)
    return
  }
  if (view && mountedSession === props.session) {
    syncSource()
    return
  }
  keepState()
  heldScrollTop = undefined
  cancelRestore()
  mountedSession = props.session
  mountedSource = props.session.content
  sourceOffsets = new SourceOffsets(mountedSource)
  const key = documentKey(props.session)
  const cached = cache.get(key)
  const remembered = readPosition(key)
  const compatible = cached?.source === props.session.content
  const config = {
    doc: Text.of(props.session.content.split(/\r\n|\r|\n/)),
    extensions: [
      // Source remains plain text; knowledge highlights are display-only decorations.
      EditorView.lineWrapping,
      EditorView.scrollMargins.of(() => ({
        top: showSearch.value ? (showReplace.value ? 160 : 120) : 44
      })),
      ViewPlugin.fromClass(
        class {
          decorations
          constructor(target: EditorView) {
            this.decorations = this.emptyLines(target)
          }
          update(update: import('@codemirror/view').ViewUpdate) {
            if (update.docChanged || update.viewportChanged)
              this.decorations = this.emptyLines(update.view)
          }
          emptyLines(target: EditorView) {
            const marks: import('@codemirror/state').Range<Decoration>[] = []
            for (const { from, to } of target.visibleRanges) {
              for (let pos = from; pos <= to; ) {
                const line = target.state.doc.lineAt(pos)
                if (!line.length)
                  marks.push(Decoration.line({ class: 'empty-line' }).range(line.from))
                pos = line.to + 1
              }
            }
            return Decoration.set(marks, true)
          }
        },
        { decorations: (plugin) => plugin.decorations }
      ),
      EditorView.inputHandler.of((target, _from, _to, text) => {
        if (
          !props.chinesePairs ||
          readOnly.value ||
          target.composing ||
          props.session.document.kind !== 'chapters'
        )
          return false
        const pairs: Record<string, string> = {
          '“': '”',
          '‘': '’',
          '《': '》',
          '「': '」',
          '『': '』',
          '（': '）'
        }
        if (!pairs[text] || target.state.selection.ranges.some((range) => range.empty)) return false
        target.dispatch(
          target.state.changeByRange((range) => ({
            changes: [
              { from: range.from, insert: text },
              { from: range.to, insert: pairs[text] }
            ],
            range: EditorSelection.range(range.from + text.length, range.to + text.length)
          })),
          { userEvent: 'input.pair', scrollIntoView: true }
        )
        return true
      }),
      undoHistory.of(history()),
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
        if (synchronizing) return
        if (update.docChanged) {
          mountedSource = changedSource(mountedSource, update.changes, sourceOffsets)
          sourceOffsets = new SourceOffsets(mountedSource)
          mountedSession?.edit(mountedSource)
          countMatches()
          typing.value = true
          clearTimeout(typingTimer)
          typingTimer = setTimeout(() => {
            typing.value = false
          }, 900)
          if (
            props.typewriter &&
            props.session.document.kind === 'chapters' &&
            !update.view.composing &&
            update.state.selection.ranges.length === 1 &&
            update.state.selection.main.empty &&
            update.transactions.some((tr) => tr.isUserEvent('input'))
          ) {
            const target = update.view
            const state = update.state
            target.requestMeasure({
              read: () => {
                if (target.state !== state || target.composing || !target.hasFocus) return null
                const cursor = target.coordsAtPos(state.selection.main.head)
                const box = target.scrollDOM.getBoundingClientRect()
                return cursor
                  ? (cursor.top + cursor.bottom) / 2 - box.top - box.height * 0.45
                  : null
              },
              write: (delta) => {
                if (delta !== null) target.scrollDOM.scrollTop += delta
              }
            })
          }
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
  if (view) view.setState(state)
  else
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
  if (!scrollHeading.value) {
    const heading = document.createElement('div')
    heading.className = 'scroll-document-heading'
    view.scrollDOM.prepend(heading)
    scrollHeading.value = heading
  }
  if (remembered) restoreScroll(remembered.scrollTop)
  emit('selection', state.sliceDoc(state.selection.main.from, state.selection.main.to))
  view.dispatch({ effects: options.reconfigure(settings()) })
  showSearch.value = false
  showReplace.value = false
  query.value = ''
  updateSearch()
}
/** Authoritative replacements cross a controlled history boundary without saving again. */
function syncSource(): void {
  if (!view || mountedSource === props.session.content) return
  const before = view.state.doc.toString()
  const after = props.session.content.replace(/\r\n|\r/g, '\n')
  let from = 0,
    oldEnd = before.length,
    newEnd = after.length
  while (from < oldEnd && from < newEnd && before[from] === after[from]) from++
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  const top = heldScrollTop ?? pendingScrollTop ?? view.scrollDOM.scrollTop
  synchronizing = true
  try {
    view.dispatch({ effects: undoHistory.reconfigure([]) })
    view.dispatch({
      changes: { from, to: oldEnd, insert: after.slice(from, newEnd) },
      annotations: Transaction.addToHistory.of(false)
    })
    view.dispatch({ effects: undoHistory.reconfigure(history()) })
    mountedSource = props.session.content
    sourceOffsets = new SourceOffsets(mountedSource)
  } finally {
    synchronizing = false
  }
  restoreScroll(top)
  countMatches()
  const range = view.state.selection.main
  emit('selection', view.state.sliceDoc(range.from, range.to))
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
    readOnly.value,
    props.typewriter
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
watch(
  () => props.paperWidth,
  async () => {
    await nextTick()
    view?.requestMeasure()
  }
)
watch([query, replacement, caseSensitive], updateSearch)
watch([() => props.highlightEnabled, () => props.knowledgeEntries], () => {
  if (view) view.dispatch({ effects: highlights.reconfigure(highlightSettings()) })
})
onMounted(() => {
  mountSession()
  window.addEventListener('beforeunload', keepPosition)
})
onBeforeUnmount(() => {
  clearTimeout(switchTimer)
  clearTimeout(typingTimer)
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
      cursor: view ? sourceOffsets.offset(view.state.selection.main.head) : undefined,
      selection: view ? agentSelection(view.state, mountedSource, sourceOffsets) : undefined
    }
  },
  composing: () => Boolean(view?.composing) || mountedSession !== props.session
})
</script>

<template>
  <div class="text-editor" :class="{ readonly: readOnly, typing }">
    <Teleport v-if="scrollHeading" :to="scrollHeading"><slot name="heading" /></Teleport>
    <slot name="tools" />
    <div v-if="showSearch" class="find-panel" aria-label="当前文档查找" @keydown="searchKeyboard">
      <div class="find-row">
        <input
          ref="queryInput"
          v-model="query"
          aria-label="查找文字"
          placeholder="查找当前文档"
          @keydown.enter="searchEnter($event)"
          @keydown="searchKeyboard"
        />
        <span class="match-count">{{ matchIndex }} / {{ matchCount }} 处</span>
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
          @keydown.enter="searchEnter($event, true)"
        />
        <button @click="runSearch('replace')">替换下一处</button>
        <button @click="runSearch('all')">替换本篇全部</button>
      </div>
    </div>
    <div ref="host" class="editor-host" @keydown.capture="keyboardSend" />
  </div>
</template>
