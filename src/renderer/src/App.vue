<script setup lang="ts">
import {
  computed,
  markRaw,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch
} from 'vue'
import {
  defaultPreferences,
  kinds,
  labels,
  unwrap,
  type Book,
  type DocumentKind,
  type DocumentMeta,
  type DocumentSnapshot,
  type WorkspacePreferences
} from '../../shared/documents'
import { DocumentSession, type SessionChange } from './session'
import { counters } from '../../shared/perf'
import { SessionWordCounts } from './wordCounts'
import loomLogo from '../../shared/assets/loom-logo.png'
import { knowledgeEntries } from './editorKnowledge'
import TextEditor from './components/TextEditor.vue'
import AgentPanel from './components/Agent/AgentPanel.vue'
import SettingsCenter from './components/SettingsCenter.vue'
import ChapterCreateDialog from './components/ChapterCreateDialog.vue'
import ChapterOrganizeDialog from './components/ChapterOrganizeDialog.vue'
import QuickOpenDialog from './components/QuickOpenDialog.vue'
import ImportDialog from './components/ImportDialog.vue'
import HistoryDialog from './components/HistoryDialog.vue'
import { defaultNamingRule, type NamingRule } from '../../shared/chapterNaming'
import type { BookPreferences, BookStats, Placement } from '../../shared/workspace'
import type { ImportDraft } from '../../shared/imports'
import type { AgentConfig, AgentSnapshot, AgentWorkspace } from '../../shared/agent'
import { defaultToolApiConfig, type ToolApiConfig } from '../../shared/toolApi'

const api = window.loom
const books = ref<Book[]>([])
const currentBook = ref<Book | null>(null)
const kind = ref<DocumentKind>('chapters')
const inTrash = ref(false)
const documents = ref<DocumentMeta[]>([])
const knowledgeContent = ref<Record<string, string>>({})
const highlightEntries = computed(() => knowledgeEntries(documents.value, knowledgeContent.value))
const highlightEnabled = computed(
  () => !currentBook.value || preferences.knowledgeHighlight?.[currentBook.value.id] !== false
)
const filter = ref('')
const session = shallowRef<DocumentSession | null>(null)
const sessions = new Map<string, DocumentSession>()
const tick = ref(0)
const busy = ref(false)
const message = ref('')
const preferences = reactive<WorkspacePreferences>(structuredClone(defaultPreferences))
const editor = ref<InstanceType<typeof TextEditor>>()
const settingsOpen = ref(false)
const settingsSection = ref<'writing' | 'ai' | 'books'>('writing')
const chapterCreateOpen = ref(false)
const organizeOpen = ref(false)
const quickOpen = ref(false)
const importOpen = ref(false)
const historyOpen = ref(false)
const organizeDocuments = ref<DocumentMeta[]>([])
const organizeVersions = new Map<string, string>()
const bookPreferences = ref<BookPreferences>({
  naming: structuredClone(defaultNamingRule),
  targetWords: 0
})
const bookStats = ref<BookStats>({ totalWords: 0, words: {} })
const selectedIds = ref<string[]>([])
const dragId = ref('')
const moveDialog = ref(false)
const movePosition = ref(1)
const bulkTrashOpen = ref(false)
const navigation = ref<
  { bookId: string; id: string; position?: { anchor: number; head: number; scrollTop: number } }[]
>([])
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
let createAttempt: { signature: string; token: string } | null = null
let copyAttempt: { signature: string; token: string } | null = null
let importAttempt: {
  bookId: string
  groups: Partial<Record<DocumentKind, { signature: string; token: string }>>
} | null = null
let importDestination: { title: string; book: Book } | null = null
const systemDark = ref(systemTheme.matches)
const effectiveTheme = computed(() =>
  preferences.theme === 'system' || !preferences.theme
    ? systemDark.value
      ? 'dark'
      : 'light'
    : preferences.theme
)
watch(
  effectiveTheme,
  (theme) => {
    document.documentElement.dataset.theme = theme
  },
  { immediate: true }
)
function themeChanged(event: MediaQueryListEvent): void {
  systemDark.value = event.matches
}
let statsTimer: ReturnType<typeof setTimeout> | undefined
function openSettings(section: 'writing' | 'ai' | 'books' = 'writing'): void {
  settingsSection.value = section
  settingsOpen.value = true
  message.value = ''
}
function showImport(): void {
  importOpen.value = true
  message.value = ''
  importAttempt = null
  importDestination = null
}
function showMoveDialog(): void {
  movePosition.value = 1
  moveDialog.value = true
  message.value = ''
}
function startChapterDrag(id: string, event: DragEvent): void {
  dragId.value = id
  event.dataTransfer?.setData('text/plain', id)
}
const viewportWidth = ref(window.innerWidth)
const resizing = ref(false)
const agentShown = computed(() => preferences.agentVisible && !preferences.focusMode)
const listShown = computed(
  () =>
    preferences.listVisible &&
    !preferences.focusMode &&
    !(agentShown.value && viewportWidth.value < 1180)
)
const layoutKey = computed(() => currentBook.value?.id || 'global')
const maxAgentWidth = computed(() =>
  Math.max(
    300,
    Math.min(
      900,
      viewportWidth.value -
        (viewportWidth.value <= 950 ? 120 : 166) -
        (listShown.value ? 236 : 0) -
        420 -
        8
    )
  )
)
const agentWidth = computed(() =>
  Math.max(300, Math.min(maxAgentWidth.value, preferences.agentWidths?.[layoutKey.value] || 380))
)
let resizeStart = 0
let resizeWidth = 0
function onWindowResize(): void {
  viewportWidth.value = window.innerWidth
}
function startResize(event: PointerEvent): void {
  if (event.button !== 0) return
  event.preventDefault()
  resizing.value = true
  resizeStart = event.clientX
  resizeWidth = agentWidth.value
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function resizeAgent(event: PointerEvent): void {
  if (!resizing.value) return
  preferences.agentWidths[layoutKey.value] = Math.max(
    300,
    Math.min(maxAgentWidth.value, resizeWidth + resizeStart - event.clientX)
  )
}
function finishResize(): void {
  if (!resizing.value) return
  resizing.value = false
  void savePreferences()
}
function keyboardResize(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
  event.preventDefault()
  preferences.agentWidths[layoutKey.value] =
    event.key === 'Home'
      ? 380
      : Math.max(
          300,
          Math.min(maxAgentWidth.value, agentWidth.value + (event.key === 'ArrowLeft' ? 20 : -20))
        )
  void savePreferences()
}
function setLayout(mode: 'focus' | 'chat'): void {
  preferences.focusMode = mode === 'focus' ? !preferences.focusMode : false
  if (mode === 'chat') preferences.agentVisible = true
  void savePreferences()
}
const referenceOpen = ref(false)
const referenceQuery = ref('')
const selectedText = ref('')
const conflict = ref<DocumentSnapshot | null>(null)
const modal = ref<'book' | 'document' | 'trash' | null>(null)
let modalPreviousFocus: HTMLElement | null = null
function activeDialog(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
    .filter((element) => element.offsetParent !== null)
    .at(-1)
}
function dialogControls(dialog: HTMLElement): HTMLElement[] {
  return [
    ...dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]:not(:disabled)'
    )
  ].filter((element) => element.offsetParent !== null)
}
watch(
  [
    settingsOpen,
    modal,
    chapterCreateOpen,
    organizeOpen,
    quickOpen,
    importOpen,
    historyOpen,
    moveDialog,
    bulkTrashOpen,
    referenceOpen,
    conflict
  ],
  async (states, previous) => {
    const before = document.activeElement as HTMLElement | null
    if (states.some(Boolean) && !previous.some(Boolean)) modalPreviousFocus = before
    await nextTick()
    const dialog = activeDialog()
    if (dialog) {
      if (!dialog.contains(document.activeElement)) dialogControls(dialog)[0]?.focus()
    } else {
      if (modalPreviousFocus?.isConnected) modalPreviousFocus.focus()
      modalPreviousFocus = null
    }
  }
)
const newTitle = ref('')
const templateChoice = ref<'basic' | 'blank'>('basic')
const agentSnapshot = ref<AgentSnapshot>({ conversations: [], proposals: [], active: null })
const agentPanel = ref<InstanceType<typeof AgentPanel>>()
const agentLiveText = ref('')
let agentText = ''
let agentTextFrame: number | undefined
let agentEventRevision = 0
let agentSnapshotRequest = 0
function flushAgentText(): void {
  if (agentTextFrame !== undefined) cancelAnimationFrame(agentTextFrame)
  agentTextFrame = undefined
  agentLiveText.value = agentText
}
function resetAgentText(): void {
  agentText = ''
  flushAgentText()
}
function appendAgentText(text: string): void {
  agentText += text
  if (agentShown.value && agentTextFrame === undefined)
    agentTextFrame = requestAnimationFrame(flushAgentText)
}
watch(agentShown, (shown) => {
  if (shown) flushAgentText()
})

const agentToolText = ref('')
const agentConfig = ref<AgentConfig>({ baseUrl: '', model: '', hasKey: false })
const toolApiConfig = ref<ToolApiConfig>({ ...defaultToolApiConfig })
async function conversationPreferences(
  id: string,
  profileId: string,
  archived: boolean
): Promise<void> {
  await guarded(async () => {
    if (!currentBook.value) return
    unwrap(await api.agent.preferences(currentBook.value.id, id, profileId, archived))
    await refreshAgent()
  })
}
let removeAgentListener: (() => void) | undefined
let agentRefreshTimer: ReturnType<typeof setTimeout> | undefined
const modalInput = ref<HTMLInputElement>()
let removeCloseListener: (() => void) | undefined
const visibleDocuments = computed(() =>
  documents.value
    .filter(
      (doc) =>
        doc.kind === kind.value &&
        Boolean(doc.trashedAt) === inTrash.value &&
        doc.title.toLocaleLowerCase().includes(filter.value.toLocaleLowerCase())
    )
    .sort((a, b) => {
      if (inTrash.value)
        return String(b.trashedAt).localeCompare(String(a.trashedAt)) || a.id.localeCompare(b.id)
      if (kind.value === 'notes')
        return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
      return a.order - b.order || a.id.localeCompare(b.id)
    })
)
const references = computed(() =>
  documents.value.filter((doc) =>
    doc.title.toLocaleLowerCase().includes(referenceQuery.value.toLocaleLowerCase())
  )
)
const sessionStateTick = ref(0)
const currentError = ref('')
const wordCountDisplay = ref(0)
const wordCountRevision = ref(0)
let wordCountTimer: ReturnType<typeof setTimeout> | undefined
let lastWordCountTime = 0

function updateWordCountDisplay(force = false) {
  const now = Date.now()
  const content = current.value?.content || ''
  const compute = () => Array.from(content.replace(/\s/g, '')).length
  if (counters.enabled)
    counters.setSessionCacheEstimate(
      [...sessions.values()].reduce((bytes, item) => bytes + item.content.length * 2, 0)
    )
  if (force || now - lastWordCountTime >= 150) {
    wordCountDisplay.value = compute()
    wordCountRevision.value++
    lastWordCountTime = now
    if (wordCountTimer) {
      clearTimeout(wordCountTimer)
      wordCountTimer = undefined
    }
  } else if (!wordCountTimer) {
    wordCountTimer = setTimeout(
      () => {
        wordCountDisplay.value = Array.from(
          (current.value?.content || '').replace(/\s/g, '')
        ).length
        wordCountRevision.value++
        lastWordCountTime = Date.now()
        wordCountTimer = undefined
      },
      150 - (now - lastWordCountTime)
    )
  }
}

const current = computed(() => {
  return session.value
})
const status = computed(() => {
  void sessionStateTick.value
  return current.value?.document.trashedAt
    ? '回收站 · 只读'
    : {
        saved: '已保存',
        dirty: '未保存',
        saving: '保存中…',
        error: '保存失败',
        conflict: '版本冲突'
      }[current.value?.status || 'saved']
})
const wordCount = computed(() => {
  return wordCountDisplay.value
})
const activeDocuments = computed(() =>
  documents.value
    .filter((doc) => doc.kind === kind.value && !doc.trashedAt)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
)
const activeChapters = computed(() =>
  documents.value
    .filter((doc) => doc.kind === 'chapters' && !doc.trashedAt)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
)
const wordCountCache = new SessionWordCounts()
function wordsFor(doc: DocumentMeta): number {
  void wordCountRevision.value
  const cached = currentBook.value && sessions.get(key(currentBook.value.id, doc.id))
  return cached && (cached === session.value || cached.dirty || !(doc.id in bookStats.value.words))
    ? wordCountCache.count(cached)
    : bookStats.value.words[doc.id] || 0
}
const totalWords = computed(() => {
  void wordCountRevision.value
  return activeChapters.value.reduce((total, doc) => total + wordsFor(doc), 0)
})
const chapterIndex = computed(() =>
  activeChapters.value.findIndex((doc) => doc.id === current.value?.document.id)
)
const targetProgress = computed(() =>
  bookPreferences.value.targetWords > 0
    ? Math.min(100, Math.round((wordCount.value / bookPreferences.value.targetWords) * 100))
    : 0
)

watch(session, (newSession) => {
  currentError.value = newSession?.error || ''
  if (newSession) {
    updateWordCountDisplay(true)
  } else {
    wordCountDisplay.value = 0
  }
})
const orderable = computed(
  () => !inTrash.value && !filter.value && ['chapters', 'outlines'].includes(kind.value)
)
const referenceType: Record<DocumentKind, string> = {
  chapters: 'chapter',
  notes: 'note',
  characters: 'character',
  settings: 'setting',
  outlines: 'outline'
}
function key(bookId: string, id: string): string {
  return `${bookId}:${id}`
}
function notify(error: unknown): void {
  message.value = error instanceof Error ? error.message : String(error)
}
async function guarded(action: () => Promise<void>): Promise<void> {
  if (busy.value) return
  editor.value?.rememberPosition()
  busy.value = true
  message.value = ''
  try {
    await action()
  } catch (error) {
    notify(error)
  } finally {
    busy.value = false
    await nextTick()
    editor.value?.releasePosition()
  }
}
const lastSessionState = new WeakMap<DocumentSession, string>()

function track(sessionToTrack: DocumentSession, change: SessionChange = 'state'): void {
  if (sessionToTrack === session.value) {
    currentError.value = sessionToTrack.error
    const signature = `${sessionToTrack.status}:${sessionToTrack.error}`
    if (lastSessionState.get(sessionToTrack) !== signature) {
      lastSessionState.set(sessionToTrack, signature)
      sessionStateTick.value++
    }
    if (change === 'replace') tick.value++
    updateWordCountDisplay(change === 'replace' || sessionToTrack.status === 'saved')
  }
  const index = documents.value.findIndex((doc) => doc.id === sessionToTrack.document.id)
  if (index >= 0 && currentBook.value?.id === sessionToTrack.bookId) {
    const old = documents.value[index]
    const { content: _content, version: _version, ...meta } = sessionToTrack.document
    const next = { ...meta, title: sessionToTrack.title, order: old.order }
    if (
      Object.keys(next).some(
        (field) => next[field as keyof DocumentMeta] !== old[field as keyof DocumentMeta]
      )
    ) {
      documents.value[index] = next
      counters.countListUpdate()
    }
  }
  if (
    currentBook.value?.id === sessionToTrack.bookId &&
    ['characters', 'settings'].includes(sessionToTrack.document.kind)
  ) {
    knowledgeRequest++
    knowledgeContent.value[sessionToTrack.document.id] = sessionToTrack.content
    if (!sessionToTrack.dirty)
      knowledgeCache.set(key(sessionToTrack.bookId, sessionToTrack.document.id), {
        generation: sessionToTrack.document.generation,
        content: sessionToTrack.content
      })
  }
  if (change === 'edit' && sessionToTrack.dirty && !dirtyEditors.has(sessionToTrack)) {
    dirtyEditors.add(sessionToTrack)
    void syncAgentEditors().catch(notify)
  } else {
    if (!sessionToTrack.dirty) dirtyEditors.delete(sessionToTrack)
    debouncedSyncAgentEditors()
  }
  if (sessionToTrack.status === 'saved' && currentBook.value?.id === sessionToTrack.bookId) {
    clearTimeout(statsTimer)
    statsTimer = setTimeout(() => {
      void refreshStats().catch(notify)
    }, 800)
  }
  if (
    sessionToTrack.status === 'saved' &&
    agentSnapshot.value.proposals.some(
      (p) => p.state === 'pending' && p.targetId === sessionToTrack.document.id
    )
  ) {
    clearTimeout(agentRefreshTimer)
    agentRefreshTimer = setTimeout(() => {
      void refreshAgent().catch(notify)
    }, 100)
  }
}

let syncAgentTimer: ReturnType<typeof setTimeout> | undefined
let lastAgentEditorsState = ''
let agentEditorsQueue = Promise.resolve()
const dirtyEditors = new WeakSet<DocumentSession>()

async function syncAgentEditors(force = false): Promise<void> {
  if (!currentBook.value) return
  const bookId = currentBook.value.id
  const payload = [...sessions.values()]
    .filter((s) => s.bookId === bookId)
    .map((s) => ({
      id: s.document.id,
      dirty: s.dirty || s.status === 'saving' || s.status === 'conflict',
      revision: s.revision
    }))
  const stateStr = JSON.stringify([bookId, payload])
  const operation = agentEditorsQueue
    .catch(() => {})
    .then(async () => {
      if (currentBook.value?.id !== bookId) return
      if (!force && stateStr === lastAgentEditorsState) return
      unwrap(await api.agent.editor(bookId, payload))
      lastAgentEditorsState = stateStr
    })
  agentEditorsQueue = operation
  await operation
}

function debouncedSyncAgentEditors() {
  clearTimeout(syncAgentTimer)
  syncAgentTimer = setTimeout(() => {
    void syncAgentEditors().catch(notify)
  }, 200)
}
async function refreshAgent(): Promise<void> {
  const bookId = currentBook.value?.id
  if (!bookId) return
  const request = ++agentSnapshotRequest
  const revision = agentEventRevision
  const snapshot = unwrap(await api.agent.snapshot(bookId))
  if (
    currentBook.value?.id === bookId &&
    request === agentSnapshotRequest &&
    revision === agentEventRevision
  ) {
    agentSnapshot.value = snapshot
    if (!snapshot.active) {
      resetAgentText()
      agentToolText.value = ''
    }
  }
}
async function createConversation(): Promise<void> {
  await guarded(async () => {
    if (!currentBook.value) return
    const c = unwrap(await api.agent.create(currentBook.value.id, '新的讨论'))
    await refreshAgent()
    agentPanel.value?.select(c.id)
  })
}
async function renameConversation(id: string, title: string): Promise<void> {
  await guarded(async () => {
    if (currentBook.value) {
      unwrap(await api.agent.rename(currentBook.value.id, id, title))
      await refreshAgent()
    }
  })
}
async function sendAgent(
  id: string,
  text: string,
  options: { document: boolean; selection: boolean; targetRewrite: boolean }
): Promise<void> {
  if (busy.value) return
  const sourceEditor = editor.value
  const sourceSession = session.value
  const position = sourceEditor?.focused() ? sourceEditor.position() : undefined
  await guarded(async () => {
    if (!currentBook.value) return
    if (editor.value?.composing()) throw new Error('请先完成输入法候选确认后发送。')
    if (!(await flushAll())) return
    await syncAgentEditors(true)
    const workspace: AgentWorkspace = editor.value?.agentContext() || {}
    workspace.targetRewrite = options.targetRewrite
    if (!options.document) {
      delete workspace.documentId
      delete workspace.savedVersion
    }
    if (!options.document || !options.selection) delete workspace.selection
    resetAgentText()
    agentToolText.value = ''
    unwrap(await api.agent.start(currentBook.value.id, id, text, workspace))
    agentPanel.value?.clearInput(id, text)
    await refreshAgent()
  })
  // Saving temporarily locks contenteditable and Chromium drops its focus.
  await nextTick()
  if (position && editor.value === sourceEditor && session.value === sourceSession) {
    const active = document.activeElement
    if (!active || active === document.body || active.closest('.cm-content'))
      sourceEditor?.restorePosition(position)
  }
}
function sendAgentFromEditor(): void {
  if (agentShown.value) agentPanel.value?.send()
}
async function cancelAgent(): Promise<void> {
  await guarded(async () => {
    if (currentBook.value) {
      unwrap(await api.agent.cancel(currentBook.value.id))
      await refreshAgent()
    }
  })
}
async function proposalAction(
  id: string,
  action: 'apply' | 'reject' | 'undo',
  hash: string
): Promise<void> {
  await guarded(async () => {
    if (!currentBook.value) return
    if (editor.value?.composing()) throw new Error('请先完成输入法候选确认后审阅。')
    if (action !== 'reject' && !(await flushAll())) return
    await syncAgentEditors(true)
    const bookId = currentBook.value.id
    try {
      unwrap(await api.agent.action(bookId, id, action, hash))
      const p = agentSnapshot.value.proposals.find((p) => p.id === id)
      if (p && action !== 'reject') {
        const cached = sessions.get(key(bookId, p.targetId))
        if (cached && !cached.dirty) {
          cached.stop()
          sessions.delete(key(bookId, p.targetId))
          if (session.value === cached) session.value = null
        }
        await reloadList()
        await openDocument(p.targetId)
      }
    } finally {
      await refreshAgent()
    }
  })
}
async function exportAgentLog(id: string): Promise<void> {
  await guarded(async () => {
    if (!currentBook.value) return
    const result = unwrap(await api.agent.exportLog(currentBook.value.id, id))
    if (result)
      message.value = result.complete
        ? `本轮完整日志已导出：${result.path}`
        : `已有记录已导出：${result.path}。该轮未保存完整上下文，日志内已注明缺失。`
  })
}
async function loadAgentConfig(): Promise<void> {
  agentConfig.value = unwrap(await api.agent.config())
  toolApiConfig.value = unwrap(await api.tools.config())
}

async function savePreferences(): Promise<void> {
  try {
    unwrap(await api.preferences(JSON.parse(JSON.stringify(preferences))))
  } catch (error) {
    notify(error)
  }
}
function toggleAgent(): void {
  preferences.agentVisible = !preferences.agentVisible
  void savePreferences()
}
function toggleList(): void {
  if (preferences.focusMode || (agentShown.value && viewportWidth.value < 1180)) {
    preferences.focusMode = false
    preferences.agentVisible = false
    preferences.listVisible = true
  } else preferences.listVisible = !preferences.listVisible
  void savePreferences()
}
const knowledgeCache = new Map<string, { generation: string; content: string }>()
let knowledgeRequest = 0
let listRequest = 0
async function reloadList(): Promise<void> {
  const bookId = currentBook.value?.id
  if (!bookId) return
  const request = ++listRequest
  const list = unwrap(await api.list(bookId))
  if (currentBook.value?.id !== bookId || request !== listRequest) return
  documents.value = list
  selectedIds.value = selectedIds.value.filter((id) =>
    documents.value.some((doc) => doc.id === id && doc.kind === kind.value && !doc.trashedAt)
  )
  void reloadKnowledge().catch(notify)
  void refreshStats().catch(notify)
  void refreshAgent().catch(notify)
}
async function reloadKnowledge(): Promise<void> {
  const bookId = currentBook.value?.id
  if (!bookId) return
  const request = ++knowledgeRequest
  const valid = () => currentBook.value?.id === bookId && request === knowledgeRequest
  const sources = documents.value.filter(
    (doc) => !doc.trashedAt && ['characters', 'settings'].includes(doc.kind)
  )
  const nextContent: Record<string, string> = {}
  const toFetch: DocumentMeta[] = []
  for (const doc of sources) {
    const local = sessions.get(key(bookId, doc.id))
    const cached = knowledgeCache.get(key(bookId, doc.id))
    if (local?.dirty) nextContent[doc.id] = local.content
    else if (cached?.generation === doc.generation) nextContent[doc.id] = cached.content
    else toFetch.push(doc)
  }
  for (let i = 0; i < toFetch.length; i += 10) {
    if (!valid()) return
    const results = await Promise.allSettled(
      toFetch.slice(i, i + 10).map(async (doc) => {
        const opened = unwrap(await api.read(bookId, doc.id))
        const local = sessions.get(key(bookId, doc.id))
        const content = local?.dirty
          ? local.content
          : (opened.draft?.content ?? opened.document.content)
        return { doc, opened, content }
      })
    )
    if (!valid()) return
    for (const result of results) {
      if (result.status === 'rejected') {
        notify(result.reason)
        continue
      }
      const { doc, opened, content } = result.value
      nextContent[doc.id] = content
      if (!opened.draft)
        knowledgeCache.set(key(bookId, doc.id), { generation: opened.document.generation, content })
    }
  }
  if (valid()) knowledgeContent.value = nextContent
}
async function refreshFromDisk(): Promise<void> {
  const bookId = currentBook.value?.id
  if (!bookId || busy.value) return
  try {
    await api.workspace.refresh(bookId).then(unwrap)
    if (currentBook.value?.id !== bookId) return
    knowledgeCache.clear()
    await reloadList()
  } catch (error) {
    if (currentBook.value?.id === bookId) notify(error)
  }
}
function toggleKnowledgeHighlight(): void {
  if (!currentBook.value) return
  preferences.knowledgeHighlight = {
    ...preferences.knowledgeHighlight,
    [currentBook.value.id]: !highlightEnabled.value
  }
  void savePreferences()
}
async function refreshStats(): Promise<void> {
  const bookId = currentBook.value?.id
  if (!bookId) return
  const value = unwrap(await api.workspace.stats(bookId))
  if (currentBook.value?.id === bookId) bookStats.value = value
}
async function flushCurrent(): Promise<boolean> {
  if (!session.value || (await session.value.settle())) return true
  message.value = '当前内容尚未保存，请先处理保存失败或版本冲突。'
  return false
}
async function flushAll(): Promise<boolean> {
  let okay = true
  for (const item of sessions.values())
    if (!(await item.settle())) {
      okay = false
      session.value = item
    }
  if (!okay) message.value = '窗口保持打开：有内容未保存，请先处理提示。'
  return okay
}
async function openDocument(id: string, remember = true): Promise<void> {
  if (!currentBook.value || !(await flushCurrent())) return
  const bookId = currentBook.value.id
  const opened = unwrap(await api.read(bookId, id))
  if (opened.document.kind !== kind.value || Boolean(opened.document.trashedAt) !== inTrash.value)
    selectedIds.value = []
  if (remember && session.value && session.value.document.id !== id)
    navigation.value = [
      ...navigation.value,
      { bookId, id: session.value.document.id, position: editor.value?.position() }
    ].slice(-100)
  let target = sessions.get(key(bookId, id))
  if (
    !target ||
    target.document.version !== opened.document.version ||
    target.document.trashedAt !== opened.document.trashedAt
  ) {
    target?.stop()
    const created = markRaw(
      new DocumentSession(bookId, opened, api, (change) => track(created, change))
    )
    target = created
    sessions.set(key(bookId, id), target)
  }
  session.value = target
  kind.value = target.document.kind
  inTrash.value = Boolean(target.document.trashedAt)
  preferences.lastDocuments[bookId] = id
  if (!target.document.trashedAt) {
    preferences.lastDocumentsByKind ??= {}
    preferences.lastDocumentsByKind[bookId] ??= {}
    preferences.lastDocumentsByKind[bookId][target.document.kind] = id
  }
  selectedText.value = ''
  conflict.value = null
  tick.value++
  await savePreferences()
}
async function chooseFirst(): Promise<void> {
  const remembered =
    currentBook.value && !inTrash.value
      ? preferences.lastDocumentsByKind?.[currentBook.value.id]?.[kind.value]
      : undefined
  const first =
    visibleDocuments.value.find((doc) => doc.id === remembered) || visibleDocuments.value[0]
  if (first) await openDocument(first.id)
  else session.value = null
}
async function switchKind(next: DocumentKind, trash = false): Promise<void> {
  if (!(await flushCurrent())) return
  kind.value = next
  inTrash.value = trash
  filter.value = ''
  selectedIds.value = []
  conflict.value = null
  if (!documents.value.length) {
    await reloadList()
  }
  await chooseFirst()
}
async function switchBook(book: Book): Promise<void> {
  if (currentBook.value?.id !== book.id && agentSnapshot.value.active) {
    message.value = '请等待 Agent 任务完成，或先取消任务后再切换作品。'
    return
  }
  if (!(await flushAll())) return
  const nextAgent = unwrap(await api.agent.bind(book.id))
  currentBook.value = book
  knowledgeContent.value = {}
  bookPreferences.value = unwrap(await api.workspace.getPreferences(book.id))
  navigation.value = []
  selectedIds.value = []
  agentSnapshot.value = nextAgent
  resetAgentText()
  agentToolText.value = ''
  session.value = null
  inTrash.value = false
  filter.value = ''
  conflict.value = null
  preferences.lastBookId = book.id
  await reloadList()
  const remembered = preferences.lastDocuments[book.id]
  if (remembered && documents.value.some((doc) => doc.id === remembered))
    await openDocument(remembered)
  else {
    kind.value = 'chapters'
    await chooseFirst()
  }
  await savePreferences()
}
function askNew(mode: 'book' | 'document'): void {
  message.value = ''
  if (mode === 'document' && kind.value === 'chapters') {
    createAttempt = null
    chapterCreateOpen.value = true
    return
  }
  modal.value = mode
  newTitle.value = ''
  templateChoice.value = 'basic'
  void nextTick(() => modalInput.value?.focus())
}
async function createChapters(payload: {
  items: { title: string; content?: string }[]
  placement: Placement
  naming: NamingRule
}): Promise<void> {
  await guarded(async () => {
    if (!currentBook.value || !(await flushAll())) return
    const bookId = currentBook.value.id
    const signature = JSON.stringify({ bookId, items: payload.items, placement: payload.placement })
    if (createAttempt?.signature !== signature)
      createAttempt = { signature, token: crypto.randomUUID() }
    unwrap(
      await api.workspace.setPreferences(
        bookId,
        JSON.parse(JSON.stringify({ ...bookPreferences.value, naming: payload.naming }))
      )
    )
    bookPreferences.value.naming = payload.naming
    const created = unwrap(
      await api.workspace.createBatch(
        JSON.parse(
          JSON.stringify({
            bookId,
            kind: 'chapters',
            items: payload.items,
            placement: payload.placement,
            expectedOrder: activeChapters.value.map((doc) => doc.id),
            operationId: createAttempt.token
          })
        )
      )
    )
    chapterCreateOpen.value = false
    inTrash.value = false
    filter.value = ''
    await reloadList()
    if (created[0]) await openDocument(created[0].document.id)
    message.value = created.length > 1 ? `已创建 ${created.length} 个章节。` : ''
  })
}
async function showOrganizer(): Promise<void> {
  await guarded(async () => {
    if (!currentBook.value || !(await flushAll())) return
    await reloadList()
    organizeDocuments.value = activeDocuments.value.map((doc) => ({ ...doc }))
    organizeVersions.clear()
    for (const doc of organizeDocuments.value)
      organizeVersions.set(
        doc.id,
        unwrap(await api.read(currentBook.value.id, doc.id)).document.version
      )
    organizeOpen.value = true
  })
}
async function applyOrder(ids: string[], expectedIds: string[]): Promise<void> {
  await guarded(async () => {
    if (!currentBook.value || !(await flushCurrent())) return
    unwrap(await api.workspace.reorder(currentBook.value.id, kind.value, ids, expectedIds))
    organizeOpen.value = false
    moveDialog.value = false
    await reloadList()
    message.value = '顺序已更新；可点击“撤销排序”恢复。'
  })
}
async function applyNames(changes: { id: string; title: string }[]): Promise<void> {
  await guarded(async () => {
    if (!currentBook.value || !(await flushAll())) return
    const bookId = currentBook.value.id
    unwrap(
      await api.workspace.renameBatch({
        bookId,
        changes: changes.map((change) => ({
          ...change,
          version: organizeVersions.get(change.id) || ''
        }))
      })
    )
    for (const change of changes) {
      sessions.get(key(bookId, change.id))?.stop()
      sessions.delete(key(bookId, change.id))
    }
    const id = session.value?.document.id
    session.value = null
    organizeOpen.value = false
    await reloadList()
    if (id) await openDocument(id, false)
    message.value = '章节名称已更新；原名称可在历史版本中查看和恢复。'
  })
}
async function undoOrder(): Promise<void> {
  await guarded(async () => {
    if (!currentBook.value || !(await flushCurrent())) return
    unwrap(await api.workspace.undoOrder(currentBook.value.id, kind.value))
    await reloadList()
    message.value = '已恢复上次排序前的顺序。'
  })
}
function toggleSelection(id: string): void {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}
function moveIds(ids: string[], position: number): void {
  const currentIds = activeDocuments.value.map((doc) => doc.id)
  const selected = currentIds.filter((id) => ids.includes(id))
  const remaining = currentIds.filter((id) => !ids.includes(id))
  const target = Math.max(0, Math.min(remaining.length, position - 1))
  const reordered = [...remaining.slice(0, target), ...selected, ...remaining.slice(target)]
  void applyOrder(reordered, currentIds)
}
function dropChapter(targetId: string, event: DragEvent): void {
  event.preventDefault()
  if (!orderable.value || !dragId.value || dragId.value === targetId) return
  const ids = activeDocuments.value.map((doc) => doc.id)
  const target = ids.filter((id) => id !== dragId.value).indexOf(targetId)
  moveIds([dragId.value], target + 1)
  dragId.value = ''
}
async function copyCurrent(): Promise<void> {
  await guarded(async () => {
    const item = session.value
    if (!item || !currentBook.value || item.document.trashedAt || !(await flushCurrent())) return
    const signature = item.bookId + ':' + item.document.id + ':' + item.document.version
    if (copyAttempt?.signature !== signature)
      copyAttempt = { signature, token: crypto.randomUUID() }
    const created = unwrap(
      await api.workspace.createBatch({
        bookId: currentBook.value.id,
        kind: item.document.kind,
        items: [{ title: item.title.slice(0, 196) + '（副本）', content: item.content }],
        operationId: copyAttempt.token,
        placement: ['chapters', 'outlines'].includes(item.document.kind)
          ? { position: 'after', anchorId: item.document.id }
          : { position: 'end' },
        expectedOrder: activeDocuments.value.map((doc) => doc.id)
      })
    )
    await reloadList()
    if (created[0]) await openDocument(created[0].document.id)
    copyAttempt = null
  })
}
async function trashSelected(): Promise<void> {
  await guarded(async () => {
    if (!currentBook.value || !(await flushAll())) return
    const bookId = currentBook.value.id
    let count = 0
    try {
      for (const id of [...selectedIds.value]) {
        const doc = unwrap(await api.read(bookId, id)).document
        unwrap(await api.trash(bookId, id, doc.version))
        sessions.get(key(bookId, id))?.stop()
        sessions.delete(key(bookId, id))
        if (session.value?.document.id === id) session.value = null
        count++
      }
      message.value = `已将 ${count} 个文档移入回收站。`
    } catch (error) {
      throw new Error(
        `已回收 ${count} 个文档；其余保留。${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      selectedIds.value = selectedIds.value.slice(count)
      bulkTrashOpen.value = false
      await reloadList()
      if (!session.value) await chooseFirst()
    }
  })
}
async function navigateChapter(offset: number): Promise<void> {
  const target = activeChapters.value[chapterIndex.value + offset]
  if (!target) return
  let opened = false
  await guarded(async () => {
    await openDocument(target.id)
    opened = session.value?.document.id === target.id
  })
  if (opened) {
    await nextTick()
    if (session.value?.document.id === target.id) editor.value?.focus()
  }
}
async function returnToDocument(): Promise<void> {
  let returned: (typeof navigation.value)[number] | undefined
  await guarded(async () => {
    const target = navigation.value.at(-1)
    if (!target || target.bookId !== currentBook.value?.id) return
    await openDocument(target.id, false)
    if (session.value?.document.id === target.id) {
      navigation.value.pop()
      returned = target
    }
  })
  if (returned) {
    await nextTick()
    if (currentBook.value?.id !== returned.bookId || session.value?.document.id !== returned.id)
      return
    if (returned.position) editor.value?.restorePosition(returned.position)
    else editor.value?.focus()
  }
}
async function quickNavigate(id: string, line?: number): Promise<void> {
  const bookId = currentBook.value?.id
  let opened = false
  await guarded(async () => {
    await openDocument(id)
    if (session.value?.document.id !== id) return
    quickOpen.value = false
    filter.value = ''
    opened = true
  })
  if (opened) {
    await nextTick()
    if (currentBook.value?.id !== bookId || session.value?.document.id !== id) return
    if (line) editor.value?.goToLine(line)
    else editor.value?.focus()
  }
}
async function showQuickOpen(): Promise<void> {
  await guarded(async () => {
    if (currentBook.value && (await flushAll())) {
      message.value = ''
      quickOpen.value = true
    }
  })
}
async function restoreHistory(entryId: string): Promise<void> {
  await guarded(async () => {
    const item = session.value
    if (!item || item.document.trashedAt || !(await flushAll())) return
    unwrap(
      await api.workspace.restoreHistory(
        item.bookId,
        item.document.id,
        entryId,
        item.document.version
      )
    )
    item.stop()
    sessions.delete(key(item.bookId, item.document.id))
    session.value = null
    historyOpen.value = false
    await reloadList()
    await openDocument(item.document.id, false)
    message.value = '已将历史内容保存为新版本。'
  })
}
async function showHistory(): Promise<void> {
  await guarded(async () => {
    if (session.value && (await flushCurrent())) historyOpen.value = true
  })
}
async function importDocuments(draft: ImportDraft, newBookTitle?: string): Promise<void> {
  await guarded(async () => {
    if (!(await flushAll())) return
    if (newBookTitle) {
      if (agentSnapshot.value.active)
        throw new Error('请先等待 Agent 完成或取消任务后再导入新作品。')
      const book =
        importDestination?.title === newBookTitle
          ? importDestination.book
          : unwrap(await api.createBook(newBookTitle))
      if (!book) return
      importDestination = { title: newBookTitle, book }
      if (!books.value.some((item) => item.id === book.id)) books.value.unshift(book)
      if (currentBook.value?.id !== book.id) await switchBook(book)
    }
    if (!currentBook.value) throw new Error('请先打开作品，或选择导入为新作品。')
    const bookId = currentBook.value.id
    if (importAttempt?.bookId !== bookId) importAttempt = { bookId, groups: {} }
    let imported = 0
    let firstId = ''
    try {
      for (const documentKind of kinds) {
        const items = draft.items.filter((item) => item.kind === documentKind)
        if (!items.length) continue
        const signature = JSON.stringify(items)
        if (importAttempt.groups[documentKind]?.signature !== signature)
          importAttempt.groups[documentKind] = { signature, token: crypto.randomUUID() }
        const created = unwrap(
          await api.workspace.createBatch(
            JSON.parse(
              JSON.stringify({
                bookId,
                kind: documentKind,
                items,
                placement: { position: 'end' },
                operationId: importAttempt.groups[documentKind]!.token
              })
            )
          )
        )
        imported += created.length
        firstId ||= created[0]?.document.id || ''
      }
    } catch (error) {
      throw new Error(
        `导入中断，已写入批次会恢复。请检查刷新后的列表；直接重试相同方案不会重复创建。${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      await reloadList()
      if (firstId) await openDocument(firstId)
    }
    importOpen.value = false
    message.value = `已导入 ${imported} 个文档。${draft.warnings.length ? '导入提示：' + draft.warnings.join('；') : ''}`
  })
}
async function updateTargetWords(): Promise<void> {
  await guarded(async () => {
    if (!currentBook.value) return
    unwrap(
      await api.workspace.setPreferences(
        currentBook.value.id,
        JSON.parse(JSON.stringify(bookPreferences.value))
      )
    )
    message.value = '章节目标字数已保存。'
  })
}
async function submitModal(): Promise<void> {
  if (!modal.value || (modal.value !== 'trash' && !newTitle.value.trim())) return
  await guarded(async () => {
    if (!(await flushCurrent())) return
    if (modal.value === 'book') {
      if (agentSnapshot.value.active) throw new Error('请先等待 Agent 完成或取消任务后再新建作品。')
      const book = unwrap(await api.createBook(newTitle.value))
      if (book) {
        books.value.unshift(book)
        await switchBook(book)
      }
    } else if (modal.value === 'document' && currentBook.value) {
      const created = unwrap(
        await api.create(currentBook.value.id, kind.value, newTitle.value, templateChoice.value)
      )
      inTrash.value = false
      filter.value = ''
      await reloadList()
      await openDocument(created.document.id)
    } else if (modal.value === 'trash' && session.value && currentBook.value) {
      const item = session.value
      unwrap(await api.trash(item.bookId, item.document.id, item.document.version))
      item.stop()
      sessions.delete(key(item.bookId, item.document.id))
      session.value = null
      await reloadList()
      await chooseFirst()
    }
    modal.value = null
  })
}
async function openBook(): Promise<void> {
  await guarded(async () => {
    if (agentSnapshot.value.active)
      throw new Error('请先等待 Agent 完成或取消任务后再打开另一部作品。')
    if (!(await flushAll())) return
    const book = unwrap(await api.openBook())
    if (book) {
      books.value = [book, ...books.value.filter((item) => item.id !== book.id)]
      await switchBook(book)
    }
  })
}
async function restore(): Promise<void> {
  await guarded(async () => {
    const item = session.value
    if (!item) return
    unwrap(await api.restore(item.bookId, item.document.id, item.document.version))
    item.stop()
    sessions.delete(key(item.bookId, item.document.id))
    session.value = null
    await reloadList()
    await openDocument(item.document.id)
  })
}
async function move(doc: DocumentMeta, offset: number): Promise<void> {
  await guarded(async () => {
    if (!currentBook.value || !(await flushCurrent())) return
    const ids = visibleDocuments.value.map((item) => item.id)
    const expected = [...ids]
    const index = ids.indexOf(doc.id),
      target = index + offset
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    unwrap(await api.workspace.reorder(currentBook.value.id, kind.value, ids, expected))
    await reloadList()
  })
}
async function compareDisk(): Promise<void> {
  await guarded(async () => {
    if (session.value)
      conflict.value = unwrap(
        await api.read(session.value.bookId, session.value.document.id)
      ).document
  })
}
async function resolveConflict(keepMine: boolean): Promise<void> {
  await guarded(async () => {
    if (!session.value || !conflict.value) return
    if (keepMine && conflict.value.trashedAt) return
    if (keepMine) {
      session.value.rebase(conflict.value)
      await session.value.settle()
    } else {
      session.value.useDisk(conflict.value)
      inTrash.value = Boolean(conflict.value.trashedAt)
    }
    conflict.value = null
    await reloadList()
  })
}
function editTitle(event: Event): void {
  session.value?.edit(session.value.content, (event.target as HTMLInputElement).value)
}
function insertReference(doc: DocumentMeta): void {
  const label = doc.title.replace(/[\]|\r\n]/g, ' ')
  editor.value?.insert(`[[${referenceType[doc.kind]}:${doc.id}|${label}]]`)
  referenceOpen.value = false
}
async function referenceJump(id: string): Promise<void> {
  await guarded(async () => {
    filter.value = ''
    await openDocument(id)
  })
}
async function exportCurrent(): Promise<void> {
  await guarded(async () => {
    if (!session.value || !(await flushCurrent())) return
    if (unwrap(await api.exportDocument(session.value.bookId, session.value.document.id)))
      message.value = '文档已导出。'
  })
}
async function bookAction(action: 'exportBook' | 'backup' | 'import'): Promise<void> {
  if (action === 'import') {
    settingsOpen.value = false
    showImport()
    return
  }
  await guarded(async () => {
    if (!currentBook.value || !(await flushAll())) return
    if (unwrap(await api[action](currentBook.value.id)))
      message.value = action === 'backup' ? '完整作品已备份并校验。' : '全部正文已导出。'
  })
}
function keyboard(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing) return
  if (event.key === 'Tab') {
    const dialog = activeDialog()
    if (dialog) {
      const candidates = dialogControls(dialog)
      if (!dialog.contains(document.activeElement) || !candidates.length) {
        event.preventDefault()
        ;(event.shiftKey ? candidates.at(-1) : candidates[0])?.focus()
      } else if (event.shiftKey && document.activeElement === candidates[0]) {
        event.preventDefault()
        candidates.at(-1)?.focus()
      } else if (!event.shiftKey && document.activeElement === candidates.at(-1)) {
        event.preventDefault()
        candidates[0]?.focus()
      }
    }
    return
  }
  if (settingsOpen.value) return
  const dialogOpen = Boolean(
    modal.value ||
      chapterCreateOpen.value ||
      organizeOpen.value ||
      quickOpen.value ||
      importOpen.value ||
      historyOpen.value ||
      moveDialog.value ||
      bulkTrashOpen.value ||
      referenceOpen.value ||
      conflict.value
  )
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    if (!dialogOpen) void showQuickOpen()
    return
  }
  if (event.altKey && event.key === 'ArrowLeft' && !dialogOpen) {
    event.preventDefault()
    void returnToDocument()
    return
  }
  if (
    (event.ctrlKey || event.metaKey) &&
    event.altKey &&
    ['ArrowUp', 'ArrowDown'].includes(event.key)
  ) {
    event.preventDefault()
    if (!dialogOpen) void navigateChapter(event.key === 'ArrowUp' ? -1 : 1)
    return
  }
  if (dialogOpen) return
  if (!(event.ctrlKey || event.metaKey) || !session.value) return
  const key = event.key.toLowerCase()
  if (key === 's') {
    event.preventDefault()
    void flushCurrent()
  }
  if (key === 'f') {
    event.preventDefault()
    editor.value?.search()
  }
  if (key === 'h') {
    event.preventDefault()
    editor.value?.replace()
  }
}
function navigationKeyboard(event: KeyboardEvent): void {
  const modifier = event.ctrlKey || event.metaKey
  if (
    (modifier && event.key.toLowerCase() === 'p') ||
    (event.altKey && event.key === 'ArrowLeft') ||
    (modifier && event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key))
  ) {
    // App navigation must run before the editor consumes its arrow shortcuts.
    keyboard(event)
    if (event.defaultPrevented) event.stopPropagation()
  }
}
onMounted(async () => {
  systemTheme.addEventListener('change', themeChanged)
  window.addEventListener('keydown', keyboard)
  window.addEventListener('keydown', navigationKeyboard, true)
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('focus', refreshFromDisk)
  removeCloseListener = api.onClose(async () => {
    busy.value = true
    try {
      if (currentBook.value) unwrap(await api.agent.cancel(currentBook.value.id))
      return await flushAll()
    } finally {
      busy.value = false
    }
  })
  removeAgentListener = api.agent.onEvent((event) => {
    if (currentBook.value?.id !== event.bookId) return
    if (event.type === 'started') {
      agentEventRevision++
      resetAgentText()
      agentToolText.value = ''
      agentSnapshot.value.active = { conversationId: event.conversationId, turnId: event.turnId }
    }
    if (event.type === 'text' && agentSnapshot.value.active?.turnId === event.turnId)
      appendAgentText(event.text || '')
    if (event.type === 'tool') agentToolText.value = event.tool || ''
    if (event.type === 'progress' && event.diagnostic) {
      const conversation = agentSnapshot.value.conversations.find(
        (c) => c.id === event.conversationId
      )
      if (
        conversation &&
        !conversation.diagnostics?.some(
          (d) =>
            d.turnId === event.turnId &&
            d.at === event.diagnostic!.at &&
            d.phase === event.diagnostic!.phase &&
            d.tool === event.diagnostic!.tool
        )
      )
        conversation.diagnostics = [...(conversation.diagnostics || []), event.diagnostic].slice(
          -200
        )
      if (event.diagnostic.phase === 'model.started') agentToolText.value = ''
    }
    if (['completed', 'cancelled', 'failed'].includes(event.type)) {
      agentEventRevision++
      flushAgentText()
      if (event.type === 'failed') message.value = event.text || 'Agent 任务失败，请检查提示。'
    }
    if (['started', 'proposal', 'completed', 'cancelled', 'failed', 'title'].includes(event.type))
      void refreshAgent().catch(notify)
  })
  await guarded(async () => {
    const boot = unwrap(await api.bootstrap())
    counters.enabled = boot.performanceEnabled === true
    if (counters.enabled)
      Object.defineProperty(window, '__loomPerfSnapshot', {
        configurable: true,
        value: () => counters.snapshot()
      })
    books.value = boot.books
    Object.assign(preferences, boot.preferences)
    const book = books.value.find((item) => item.id === preferences.lastBookId) || books.value[0]
    if (book) await switchBook(book)
    if (boot.errors.length) message.value = boot.errors.join(' ')
    await loadAgentConfig()
  })
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', navigationKeyboard, true)
  systemTheme.removeEventListener('change', themeChanged)
  clearTimeout(statsTimer)
  clearTimeout(agentRefreshTimer)
  clearTimeout(wordCountTimer)
  clearTimeout(syncAgentTimer)
  if (agentTextFrame !== undefined) cancelAnimationFrame(agentTextFrame)
  removeAgentListener?.()
  removeCloseListener?.()
  window.removeEventListener('keydown', keyboard)
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('focus', refreshFromDisk)
  for (const item of sessions.values()) item.stop()
})
</script>

<template>
  <div
    class="workspace"
    :class="{ resizing, 'focus-mode': preferences.focusMode }"
    :style="{ '--agent-width': agentWidth + 'px' }"
  >
    <nav v-show="!preferences.focusMode" class="sidebar" aria-label="创作分区">
      <div class="brand">
        <img class="brand-logo" :src="loomLogo" alt="Loom Logo" width="44" height="44" />
        <div class="brand-name">Loom <span>织机</span></div>
      </div>
      <div class="book-controls">
        <select
          aria-label="当前作品"
          :value="currentBook?.id || ''"
          :disabled="busy"
          @change="
            guarded(() =>
              switchBook(
                books.find((book) => book.id === ($event.target as HTMLSelectElement).value)!
              )
            )
          "
        >
          <option v-if="!currentBook" value="">尚未打开作品</option>
          <option v-for="book in books" :key="book.id" :value="book.id">{{ book.title }}</option>
        </select>
        <div class="row">
          <button :disabled="busy" @click="askNew('book')">新建作品</button
          ><button :disabled="busy" @click="openBook">打开作品</button>
        </div>
        <div class="row book-tools">
          <button :disabled="busy || !currentBook" @click="showQuickOpen">快速打开</button>
          <button :disabled="busy" @click="showImport">导入</button>
        </div>
      </div>
      <button
        v-for="item in kinds"
        :key="item"
        :class="{ selected: kind === item }"
        :disabled="busy || !currentBook"
        :aria-current="kind === item ? 'page' : undefined"
        @click="guarded(() => switchKind(item))"
      >
        {{ labels[item] }}
        <span class="nav-count">{{
          documents.filter((doc) => doc.kind === item && !doc.trashedAt).length || ''
        }}</span>
      </button>
      <button class="agent-toggle" :aria-expanded="preferences.agentVisible" @click="toggleAgent">
        Agent 对话 <span>{{ preferences.agentVisible ? '−' : '+' }}</span>
      </button>
      <div class="sidebar-bottom">
        <button @click="openSettings()">设置</button><span>本地写作 · 自动保存</span>
      </div>
    </nav>
    <section v-if="listShown" class="document-list" aria-label="文档列表">
      <header>
        <button
          :disabled="busy || !currentBook"
          title="重新核对外部文件变化"
          @click="refreshFromDisk"
        >
          刷新
        </button>
        <strong>{{ labels[kind] }}</strong
        ><button
          :disabled="!currentBook || busy || inTrash"
          aria-label="新建条目"
          @click="askNew('document')"
        >
          ＋ 新建
        </button>
      </header>
      <div class="list-tabs">
        <button
          :class="{ active: !inTrash }"
          :disabled="busy"
          @click="guarded(() => switchKind(kind, false))"
        >
          文档</button
        ><button
          :class="{ active: inTrash }"
          :disabled="busy"
          @click="guarded(() => switchKind(kind, true))"
        >
          回收站
          <span>{{
            documents.filter((doc) => doc.kind === kind && doc.trashedAt).length || ''
          }}</span>
        </button>
      </div>
      <div v-if="orderable" class="list-actions">
        <button :disabled="busy || !activeDocuments.length" @click="showOrganizer">整理</button>
        <button :disabled="busy || !activeDocuments.length" @click="undoOrder">撤销排序</button>
        <button :disabled="busy || (!selectedIds.length && !current)" @click="showMoveDialog">
          移到…
        </button>
      </div>
      <div v-if="!inTrash && visibleDocuments.length" class="selection-actions">
        <label
          ><input
            type="checkbox"
            :checked="visibleDocuments.every((doc) => selectedIds.includes(doc.id))"
            :disabled="busy"
            aria-label="选择当前列表全部文档"
            @change="
              selectedIds = ($event.target as HTMLInputElement).checked
                ? visibleDocuments.map((doc) => doc.id)
                : []
            "
          />多选</label
        >
        <button v-if="selectedIds.length" :disabled="busy" @click="bulkTrashOpen = true">
          回收 {{ selectedIds.length }} 项
        </button>
        <button v-if="selectedIds.length" :disabled="busy" @click="selectedIds = []">
          取消选择
        </button>
      </div>
      <input v-model="filter" class="list-filter" aria-label="筛选标题" placeholder="筛选标题…" />
      <div class="entries">
        <div
          v-for="(doc, index) in visibleDocuments"
          :key="doc.id"
          class="entry"
          :class="{ selected: current?.document.id === doc.id }"
          :draggable="orderable && !busy"
          @dragstart="startChapterDrag(doc.id, $event)"
          @dragover="orderable && $event.preventDefault()"
          @drop="dropChapter(doc.id, $event)"
          @dragend="dragId = ''"
        >
          <input
            v-if="!inTrash"
            class="entry-select"
            type="checkbox"
            :checked="selectedIds.includes(doc.id)"
            :disabled="busy"
            :aria-label="'选择 ' + doc.title"
            @change="toggleSelection(doc.id)"
          />
          <button class="entry-title" :disabled="busy" @click="guarded(() => openDocument(doc.id))">
            <span>{{ doc.title }}</span
            ><small>{{
              inTrash
                ? '已回收'
                : kind === 'notes'
                  ? '最近修改 ' + new Date(doc.updatedAt).toLocaleDateString('zh-CN')
                  : labels[doc.kind] + ' · ' + wordsFor(doc).toLocaleString() + ' 字'
            }}</small>
          </button>
          <div v-if="orderable" class="order-buttons">
            <button
              :disabled="busy || index === 0"
              :aria-label="'上移 ' + doc.title"
              @click="move(doc, -1)"
            >
              ↑</button
            ><button
              :disabled="busy || index === visibleDocuments.length - 1"
              :aria-label="'下移 ' + doc.title"
              @click="move(doc, 1)"
            >
              ↓
            </button>
          </div>
        </div>
        <p v-if="!visibleDocuments.length" class="list-empty">
          {{ filter ? '没有匹配的标题' : inTrash ? '回收站为空' : '还没有文档，开始写下第一条。' }}
        </p>
      </div>
      <p v-if="inTrash" class="list-hint">这里只读保留已回收文档。可恢复，不提供永久删除。</p>
      <p v-else class="list-hint">
        {{
          kind === 'notes'
            ? '按最近修改排序'
            : kind === 'outlines'
              ? '平铺大纲 · 使用箭头调整顺序'
              : '所有内容保存在本地作品目录'
        }}
      </p>
      <p v-if="filter && !inTrash && ['chapters', 'outlines'].includes(kind)" class="list-hint">
        清除筛选后可调整完整列表顺序。
      </p>
    </section>
    <main class="writing-area">
      <header class="workspace-header">
        <div class="row">
          <button
            aria-label="切换文档列表"
            :title="
              agentShown && viewportWidth < 1180 ? '显示文档列表并收起 Agent' : '显示或收起文档列表'
            "
            :aria-expanded="listShown"
            @click="toggleList"
          >
            ☰</button
          ><span
            >{{ currentBook?.title || '写下你的故事' }}
            <span class="muted"> / {{ labels[kind] }}{{ inTrash ? ' / 回收站' : '' }}</span></span
          >
        </div>
        <div class="workspace-layout-actions">
          <span class="save-state" :class="current?.status" aria-live="polite">{{
            current ? status : ''
          }}</span>
          <button :aria-pressed="preferences.focusMode" @click="setLayout('focus')">
            {{ preferences.focusMode ? '退出专注' : '专注写作' }}
          </button>
          <button :aria-pressed="agentShown" @click="setLayout('chat')">边写边聊</button>
        </div>
      </header>
      <div v-if="message" class="notice" role="status">
        <span>{{ message }}</span
        ><button aria-label="关闭提示" @click="message = ''">×</button>
      </div>
      <template v-if="current">
        <div class="document-heading">
          <input
            :value="current.title"
            aria-label="文档标题"
            :disabled="Boolean(current.document.trashedAt) || busy"
            maxlength="200"
            @input="editTitle"
          />
          <div class="row">
            <button v-if="!current.document.trashedAt" :disabled="busy" @click="copyCurrent">
              复制
            </button>
            <button :disabled="busy" @click="showHistory">历史版本</button>
            <button :disabled="busy" @click="exportCurrent">导出</button
            ><button v-if="!current.document.trashedAt" :disabled="busy" @click="modal = 'trash'">
              移入回收站</button
            ><button v-else class="primary" :disabled="busy" @click="restore">恢复文档</button>
          </div>
        </div>
        <div class="document-navigation">
          <div class="row">
            <button :disabled="busy || !navigation.length" @click="returnToDocument">
              返回原文
            </button>
            <template v-if="current.document.kind === 'chapters' && !current.document.trashedAt">
              <button :disabled="busy || chapterIndex <= 0" @click="navigateChapter(-1)">
                上一章
              </button>
              <button
                :disabled="busy || chapterIndex < 0 || chapterIndex >= activeChapters.length - 1"
                @click="navigateChapter(1)"
              >
                下一章
              </button>
            </template>
          </div>
          <label
            v-if="current.document.kind === 'chapters' && !current.document.trashedAt"
            class="chapter-target"
            >章节目标
            <input
              v-model.number="bookPreferences.targetWords"
              type="number"
              min="0"
              max="1000000"
              aria-label="章节目标字数"
              :disabled="busy"
              @change="updateTargetWords"
            />字
            <progress
              v-if="bookPreferences.targetWords > 0"
              :value="targetProgress"
              max="100"
              :aria-label="'章节目标进度 ' + targetProgress + '%'"
            /><span>{{
              bookPreferences.targetWords > 0 ? targetProgress + '%' : '不设目标'
            }}</span></label
          >
        </div>
        <div class="editor-toolbar">
          <div class="row">
            <button :disabled="busy || Boolean(current.document.trashedAt)" @click="editor?.undo()">
              撤销</button
            ><button
              :disabled="busy || Boolean(current.document.trashedAt)"
              @click="editor?.redo()"
            >
              重做</button
            ><span class="separator" /><button @click="editor?.search()">查找</button
            ><button
              :disabled="busy || Boolean(current.document.trashedAt)"
              @click="editor?.replace()"
            >
              替换</button
            ><button
              :disabled="busy || Boolean(current.document.trashedAt)"
              @click="referenceOpen = true"
            >
              插入引用
            </button>
            <button
              v-if="kind === 'chapters'"
              :aria-pressed="highlightEnabled"
              title="人物名称与别名为黄色，设定名称与别名为绿色"
              @click="toggleKnowledgeHighlight"
            >
              高亮人物与设定
            </button>
          </div>
          <span class="muted">{{
            kind === 'chapters' ? '纯文本 · 双换行 · 首行缩进两字' : 'Markdown 源码 · 不渲染'
          }}</span>
        </div>
        <div v-if="currentError" class="notice error" role="alert">
          <span>{{ currentError }}</span
          ><button v-if="current.status === 'conflict'" @click="compareDisk">比较磁盘版本</button
          ><button v-else @click="flushCurrent">重试保存</button>
        </div>
        <div v-if="current.document.trashedAt" class="trash-banner">
          此文档已移入回收站，引用仍有效。恢复后可继续编辑。
        </div>
        <TextEditor
          ref="editor"
          :session="current"
          :preferences="preferences"
          :tick="tick"
          :locked="busy"
          :knowledge-entries="highlightEntries"
          :highlight-enabled="highlightEnabled"
          @save="flushCurrent"
          @reference="referenceJump"
          @selection="selectedText = $event"
          @agent-send="sendAgentFromEditor"
        />
        <footer>
          <span
            >{{ wordCount.toLocaleString() }} 字{{
              selectedText ? ' · 已选 ' + Array.from(selectedText).length + ' 字符' : ''
            }}
            · 全书 {{ totalWords.toLocaleString() }} 字</span
          ><span>Ctrl+S 保存 · Ctrl+F 查找 · Ctrl+点击引用跳转</span>
        </footer>
      </template>
      <section v-else class="empty">
        <span class="eyebrow">LOOM / {{ labels[kind] }}</span>
        <h1>
          {{
            currentBook ? (inTrash ? '每一个想法都可以找回' : '留一页给新的想法') : '从一部作品开始'
          }}
        </h1>
        <p>
          {{
            currentBook
              ? inTrash
                ? '回收的文档会保存在这里。'
                : '新建一篇文档，内容会自动保存。'
              : '新建或打开本地作品，开始写作。'
          }}
        </p>
        <button
          v-if="!inTrash"
          class="primary"
          :disabled="busy"
          @click="askNew(currentBook ? 'document' : 'book')"
        >
          {{ currentBook ? '新建' + labels[kind] : '新建第一部作品' }}
        </button>
      </section>
    </main>
    <button
      v-if="agentShown"
      class="workspace-resizer"
      role="separator"
      aria-label="调整 Agent 宽度"
      aria-orientation="vertical"
      :aria-valuenow="Math.round(agentWidth)"
      :aria-valuemin="300"
      :aria-valuemax="maxAgentWidth"
      title="拖动调整宽度；方向键微调，Home 恢复默认"
      @pointerdown="startResize"
      @pointermove="resizeAgent"
      @pointerup="finishResize"
      @pointercancel="finishResize"
      @lostpointercapture="finishResize"
      @keydown="keyboardResize"
    />
    <AgentPanel
      v-show="agentShown"
      :key="currentBook?.id || 'no-book'"
      ref="agentPanel"
      :snapshot="agentSnapshot"
      :profiles="agentConfig.profiles || []"
      :default-profile-id="agentConfig.defaultProfileId"
      :live-text="agentLiveText"
      :tool-text="agentToolText"
      :busy="busy"
      :has-book="Boolean(currentBook)"
      :document="current ? { id: current.document.id, title: current.title } : undefined"
      :selection-text="current ? selectedText : ''"
      :target-rewrite="Boolean(preferences.targetRewrite)"
      :unified-proposal-preview="Boolean(preferences.unifiedProposalPreview)"
      @preferences="conversationPreferences"
      @close="toggleAgent"
      @create="createConversation"
      @select="refreshAgent"
      @rename="renameConversation"
      @send="sendAgent"
      @export-log="exportAgentLog"
      @cancel="cancelAgent"
      @action="proposalAction"
      @reference="referenceJump"
      @settings="openSettings('ai')"
    />

    <div v-if="modal" class="modal-backdrop" @keydown.esc="!busy && (modal = null)">
      <form
        class="dialog"
        role="dialog"
        aria-modal="true"
        :aria-label="
          modal === 'trash' ? '移入回收站确认' : modal === 'book' ? '新建作品' : '新建条目'
        "
        @submit.prevent="submitModal"
      >
        <h2>
          {{
            modal === 'trash'
              ? '移入回收站？'
              : modal === 'book'
                ? '新建作品'
                : '新建' + labels[kind]
          }}
        </h2>
        <template v-if="modal === 'trash'"
          ><p>
            「{{ current?.title }}」将从正常列表移出。已有引用仍可打开它，也可以随时恢复。
          </p></template
        ><template v-else
          ><label
            >标题<input
              ref="modalInput"
              v-model="newTitle"
              aria-label="新标题"
              maxlength="200"
              :disabled="busy"
              required
          /></label>
          <p v-if="modal === 'book'" class="muted">
            接下来选择保存位置，软件会建立独立作品文件夹。
          </p>
          <label v-if="modal === 'document' && ['characters', 'settings'].includes(kind)">
            初始内容<select v-model="templateChoice" aria-label="初始内容" :disabled="busy">
              <option value="basic">基础模板</option>
              <option value="blank">空白文档</option>
            </select>
          </label>
          <p v-if="modal === 'document' && ['characters', 'settings'].includes(kind)" class="muted">
            区块可以自由删改。尚未确定的构想建议放在速记。
          </p></template
        >
        <p v-if="message" class="error-text">{{ message }}</p>
        <div class="dialog-actions">
          <button type="button" :disabled="busy" @click="modal = null">取消</button
          ><button
            class="primary"
            :disabled="busy || (modal !== 'trash' && !newTitle.trim())"
            type="submit"
          >
            {{ modal === 'trash' ? '确认回收' : '创建' }}
          </button>
        </div>
      </form>
    </div>
    <ChapterCreateDialog
      v-if="chapterCreateOpen"
      :documents="activeChapters"
      :current-id="current?.document.trashedAt ? undefined : current?.document.id"
      :preferences="bookPreferences"
      :busy="busy"
      :error="message"
      @close="chapterCreateOpen = false"
      @submit="createChapters"
    />
    <ChapterOrganizeDialog
      v-if="organizeOpen"
      :documents="organizeDocuments"
      :kind="kind"
      :busy="busy"
      :error="message"
      @close="organizeOpen = false"
      @apply-order="applyOrder"
      @apply-names="applyNames"
    />
    <QuickOpenDialog
      v-if="quickOpen && currentBook"
      :book-id="currentBook.id"
      :documents="documents"
      :busy="busy"
      @close="quickOpen = false"
      @open="quickNavigate"
    />
    <ImportDialog
      v-if="importOpen"
      :busy="busy"
      :has-book="Boolean(currentBook)"
      :error="message"
      @close="importOpen = false"
      @submit="importDocuments"
    />
    <HistoryDialog
      v-if="historyOpen && current"
      :book-id="current.bookId"
      :document="current.document"
      :busy="busy"
      :error="message"
      @close="historyOpen = false"
      @restore="restoreHistory"
    />
    <div v-if="moveDialog" class="modal-backdrop" @keydown.esc="!busy && (moveDialog = false)">
      <form
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="移到指定位置"
        @submit.prevent="
          moveIds(
            selectedIds.length ? selectedIds : current ? [current.document.id] : [],
            movePosition
          )
        "
      >
        <h2>移到指定位置</h2>
        <p>
          移动{{
            selectedIds.length ? '选中的 ' + selectedIds.length + ' 项' : '当前文档'
          }}，保留名称和正文。
        </p>
        <label
          >移动后从第几项开始
          <input
            v-model.number="movePosition"
            type="number"
            min="1"
            :max="activeDocuments.length"
            aria-label="目标位置"
            :disabled="busy"
            required
        /></label>
        <p v-if="message" class="error-text" role="alert">{{ message }}</p>
        <div class="dialog-actions">
          <button type="button" :disabled="busy" @click="moveDialog = false">取消</button
          ><button type="button" :disabled="busy" @click="movePosition = 1">开头</button
          ><button type="button" :disabled="busy" @click="movePosition = activeDocuments.length">
            末尾</button
          ><button class="primary" :disabled="busy">移动</button>
        </div>
      </form>
    </div>
    <div
      v-if="bulkTrashOpen"
      class="modal-backdrop"
      @keydown.esc="!busy && (bulkTrashOpen = false)"
    >
      <section class="dialog" role="dialog" aria-modal="true" aria-label="批量回收确认">
        <h2>回收 {{ selectedIds.length }} 个文档？</h2>
        <p>选中文档将移入各自回收站，可以恢复。</p>
        <ul class="bulk-preview">
          <li v-for="id in selectedIds" :key="id">
            {{ documents.find((doc) => doc.id === id)?.title }}
          </li>
        </ul>
        <div class="dialog-actions">
          <button :disabled="busy" @click="bulkTrashOpen = false">取消</button
          ><button class="primary" :disabled="busy" @click="trashSelected">确认回收所选文档</button>
        </div>
      </section>
    </div>
    <SettingsCenter
      v-if="settingsOpen"
      :initial-section="settingsSection"
      :preferences="preferences"
      :config="agentConfig"
      :tool-config="toolApiConfig"
      :has-book="Boolean(currentBook)"
      :busy="busy"
      :agent-running="Boolean(agentSnapshot.active)"
      :book-message="message"
      @close="settingsOpen = false"
      @configured="agentConfig = $event"
      @tool-configured="toolApiConfig = $event"
      @appearance="Object.assign(preferences, $event)"
      @book-action="bookAction"
    />
    <div v-if="referenceOpen" class="modal-backdrop" @keydown.esc="referenceOpen = false">
      <section class="dialog" role="dialog" aria-modal="true" aria-label="插入文档引用">
        <h2>插入引用</h2>
        <input v-model="referenceQuery" placeholder="筛选引用标题" aria-label="筛选引用标题" />
        <div class="reference-list">
          <button v-for="doc in references" :key="doc.id" @click="insertReference(doc)">
            {{ doc.title }}
            <small>{{ labels[doc.kind] }}{{ doc.trashedAt ? ' · 已回收' : '' }}</small>
          </button>
        </div>
        <div class="dialog-actions"><button @click="referenceOpen = false">取消</button></div>
      </section>
    </div>
    <div v-if="conflict" class="modal-backdrop">
      <section class="dialog conflict-dialog" role="dialog" aria-modal="true" aria-label="比较版本">
        <h2>保留哪份内容？</h2>
        <p>当前输入保持完整。请选择以磁盘版本继续，或明确将当前输入保存为新版本。</p>
        <div class="comparison">
          <label
            >当前输入：{{ current?.title }}<textarea :value="current?.content" readonly /></label
          ><label
            >磁盘版本：{{ conflict.title }}{{ conflict.trashedAt ? '（已回收）' : ''
            }}<textarea :value="conflict.content" readonly />
          </label>
        </div>
        <div class="dialog-actions">
          <button :disabled="busy" @click="conflict = null">稍后处理</button
          ><button :disabled="busy" @click="resolveConflict(false)">采用磁盘版本</button
          ><button
            class="primary"
            :disabled="busy || Boolean(conflict.trashedAt)"
            @click="resolveConflict(true)"
          >
            保存当前输入
          </button>
        </div>
      </section>
    </div>
  </div>
</template>
