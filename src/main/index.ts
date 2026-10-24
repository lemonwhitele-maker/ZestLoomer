import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join, basename } from 'node:path'
import fs from 'node:fs/promises'
import { DocumentStore, atomicWrite } from './documents'
import { counters } from '../shared/perf'
import { initialContent } from '../shared/templates'
import { readTextImport } from './imports'
import { AgentService, instructions } from './agent/service'
import { HeavySettingsStore } from './agent/heavySettings'
import { ApiRuntime } from './agent/runtime'
import { AgentConfigStore } from './agent/config'
import { ToolApiService } from './toolApi'
import { prepareLibrary, libraryBooks, locateBooks, storedBook } from './bookLibrary'
import { userDataDirectory } from './dataPaths'
import { environmentValue } from '../shared/environment'
import zestloomerIcon from '../shared/assets/zestloomer-logo.png?asset'
import {
  defaultPreferences,
  type Book,
  type Result,
  type WorkspacePreferences
} from '../shared/documents'

app.setName('ZestLoomer')
if (process.platform === 'win32') app.setAppUserModelId('io.zestloomer.novelworkspace')
// Fresh profiles use ZestLoomer; existing Loom profiles remain usable without copying secrets.
app.setPath('userData', userDataDirectory(app.getPath('appData')))
const store = new DocumentStore()
let heavySettings: HeavySettingsStore
let agentConfig: AgentConfigStore
let toolApi: ToolApiService
let boundAgentBook: string | null = null
const agent = new AgentService(
  store,
  (profileId) => new ApiRuntime(agentConfig.get(profileId), agentConfig.key(profileId)),
  (event) => {
    if (window && !window.isDestroyed() && event.bookId === boundAgentBook)
      window.webContents.send('zestloomer:agent:event', event)
  },
  (user, assistant, signal) => toolApi.generateTitle(user, assistant, signal),
  async () => (await heavySettings.read()).settings
)
let books: Book[] = []
let preferences: WorkspacePreferences = structuredClone(defaultPreferences)
const errors: string[] = []
let configQueue = Promise.resolve()
let window: BrowserWindow | null = null
let closing = false
let closeRequested = false
let libraryRoot: string
let libraryConfig: string
const configPath = () => join(libraryConfig, 'workspace.json')
function persist(): Promise<void> {
  const text = JSON.stringify(
    { books: books.map((book) => storedBook(libraryRoot, book)), preferences },
    null,
    2
  )
  const current = configQueue.catch(() => {}).then(() => atomicWrite(configPath(), text))
  configQueue = current
  return current
}
async function remember(book: Book): Promise<Book> {
  books = [book, ...books.filter((item) => item.id !== book.id)]
  preferences.lastBookId = book.id
  await persist()
  return book
}
function register(name: string, handler: (...args: any[]) => unknown): void {
  ipcMain.handle(`zestloomer:${name}`, async (event, ...args): Promise<Result<unknown>> => {
    try {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('无效窗口请求')
      const value = await handler(...args)
      if (counters.enabled)
        counters.addIpcPayloadBytes(Buffer.byteLength(JSON.stringify([args, value])))
      return { ok: true, value }
    } catch (error) {
      return {
        ok: false,
        code: (error as { code?: string }).code || 'IO',
        ...((error as { binding?: unknown }).binding
          ? {
              binding: (error as { binding: import('../shared/storyLinks').ChapterOutlinePair })
                .binding
            }
          : {}),
        message: (error as Error).message || '操作失败，原内容已保留'
      }
    }
  })
}
const filename = (title: string) =>
  Array.from(title)
    .map((char) => (char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char) ? '_' : char))
    .join('')
    .replace(/[. ]+$/, '')
    .slice(0, 100) || '文档'
async function chooseDirectory(title: string): Promise<string | null> {
  const result = await dialog.showOpenDialog(window!, {
    title,
    properties: ['openDirectory', 'createDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
}
function registerHandlers(): void {
  const assertAgentBook = (bookId: string) => {
    if (!bookId || bookId !== boundAgentBook) throw new Error('Agent 未绑定当前作品')
  }
  register('agent:bind', async (bookId: string) => {
    if (boundAgentBook && boundAgentBook !== bookId && agent.isRunning(boundAgentBook))
      throw new Error('请先等待当前任务完成或取消后再切书')
    const snapshot = await agent.safeSnapshot(bookId)
    boundAgentBook = bookId
    return snapshot
  })
  register('agent:snapshot', (bookId) => {
    assertAgentBook(bookId)
    return agent.safeSnapshot(bookId)
  })
  register('agent:export-log', async (bookId: string, id: string) => {
    assertAgentBook(bookId)
    const log = await agent.exportTurnLog(bookId, id)
    const result = await dialog.showSaveDialog(window!, {
      title: '导出最近一轮 Agent 日志',
      defaultPath: `${filename(log.title)}-${log.turn!.id}.json`,
      filters: [{ name: 'Agent 完整运行日志', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    await atomicWrite(result.filePath, JSON.stringify(log, null, 2) + '\n')
    return { path: result.filePath, complete: log.complete }
  })
  register('agent:create', (bookId, title) => {
    assertAgentBook(bookId)
    return agent.create(bookId, title)
  })
  register('agent:rename', (bookId, id, title) => {
    assertAgentBook(bookId)
    return agent.rename(bookId, id, title)
  })
  register('agent:start', (bookId, id, text, workspace) => {
    assertAgentBook(bookId)
    return agent.start(bookId, id, text, workspace)
  })
  register('agent:cancel', (bookId) => {
    assertAgentBook(bookId)
    return agent.cancel(bookId)
  })
  register('agent:editor', (bookId, states) => {
    assertAgentBook(bookId)
    return agent.editor(bookId, states)
  })
  register('agent:action', (bookId, id, action, hash) => {
    assertAgentBook(bookId)
    return agent.action(bookId, id, action, hash)
  })
  register('agent:heavy-settings', async () => ({ ...(await heavySettings.read()), instructions }))
  register('agent:heavy-save', async (settings) => ({
    ...(await heavySettings.save(settings)),
    instructions
  }))
  register('agent:config', () => agentConfig.get())
  register('agent:configure', (input) => agentConfig.save(input))
  register('agent:test', (input, mode) => agentConfig.test(input, mode))
  register('agent:cancel-test', () => agentConfig.cancelTest())
  register('agent:models', (input) => agentConfig.models(input))
  register('tools:config', () => toolApi.get())
  register('tools:configure', (input) => toolApi.save(input))
  register('tools:test', (input) => toolApi.test(input))
  register('tools:cancel-test', () => toolApi.cancelTest())
  register('agent:preferences', (bookId, id, profileId, archived) => {
    assertAgentBook(bookId)
    if (profileId) agentConfig.get(profileId)
    return agent.preferences(bookId, id, profileId, archived)
  })
  register('bootstrap', () => ({
    books,
    preferences,
    errors,
    performanceEnabled: counters.enabled,
    performanceCounters: counters.enabled ? counters.snapshot() : undefined
  }))
  register('import:file', async (encoding: 'utf8' | 'gb18030') => {
    const selected = await dialog.showOpenDialog(window!, {
      title: '选择要导入的文本或 Markdown',
      properties: ['openFile'],
      filters: [{ name: '文本与 Markdown', extensions: ['txt', 'md', 'markdown'] }]
    })
    return selected.canceled || !selected.filePaths[0]
      ? null
      : readTextImport(selected.filePaths[0], encoding)
  })
  register('create-book', async (title: string) => {
    return remember(await store.createBook(libraryRoot, title, true))
  })
  register('open-book', async () => {
    const root = await chooseDirectory('打开 ZestLoomer 作品目录（包含 book.json）')
    return root ? remember(await store.openBook(root)) : null
  })
  register('rename-book', async (bookId: string, title: string) => {
    const book = await store.renameBook(bookId, title)
    books = books.map((item) => (item.id === book.id ? book : item))
    await persist()
    return book
  })
  register('list', (bookId) => store.orderedList(bookId))
  register('create', (bookId, kind, title, template = 'basic') => {
    if (!['basic', 'blank'].includes(template)) throw new Error('模板选项无效')
    return store.create(bookId, kind, title, { content: initialContent(kind, template) })
  })
  register('read', (bookId, id) => store.read(bookId, id))
  register('story:bindings', (bookId) => store.chapterOutlineBindings(bookId))
  register('story:match', (bookId, revision) => store.matchChapterOutlines(bookId, revision))
  register('story:bind', (input) => store.setChapterOutlineBinding(input))
  register('story:read', (bookId, ids) => {
    if (!Array.isArray(ids) || ids.length > 200) throw new Error('文档 ID 列表无效')
    return store.readWithBindings(bookId, ids, true)
  })
  register('story:foreshadows', (bookId, offset, limit) =>
    store.foreshadowRows(bookId, offset, limit)
  )
  register('save', (input) => store.save(input))
  register('draft', (bookId, id, draft) => store.writeDraft(bookId, id, draft))
  register('trash', (bookId, id, version) => store.trash(bookId, id, version))
  register('restore', (bookId, id, version) => store.restore(bookId, id, version))
  register('reorder', (bookId, kind, ids) => store.reorder(bookId, kind, ids))
  register('workspace:preferences:get', (bookId) => store.getPreferences(bookId))
  register('workspace:preferences:set', (bookId, value) => store.setPreferences(bookId, value))
  register('workspace:create-batch', (input) => store.createBatch(input))
  register('workspace:reorder', (bookId, kind, ids, expectedIds) => {
    if (!Array.isArray(expectedIds)) throw new Error('缺少排序预览基准，请刷新后重试')
    return store.reorder(bookId, kind, ids, expectedIds)
  })
  register('workspace:undo-order', (bookId, kind) => store.undoOrder(bookId, kind))
  register('workspace:rename-batch', (input) => store.renameBatch(input))
  register('workspace:refresh', (bookId) => store.refreshCatalog(bookId))
  register('workspace:stats', (bookId) => store.stats(bookId))
  register('workspace:history', (bookId, id) => store.history(bookId, id))
  register('workspace:history-read', (bookId, id, entryId) =>
    store.historyRead(bookId, id, entryId)
  )
  register('workspace:history-restore', (bookId, id, entryId, version) =>
    store.restoreHistory(bookId, id, entryId, version)
  )
  const searchControllers = new Map<string, AbortController>()
  register('workspace:search', async (bookId, query) => {
    const prev = searchControllers.get(bookId)
    if (prev) prev.abort()
    const controller = new AbortController()
    searchControllers.set(bookId, controller)
    try {
      return await store.search(bookId, query, controller.signal)
    } finally {
      if (searchControllers.get(bookId) === controller) {
        searchControllers.delete(bookId)
      }
    }
  })
  register('workspace:search-cancel', (bookId) => {
    const prev = searchControllers.get(bookId)
    if (prev) {
      prev.abort()
      searchControllers.delete(bookId)
    }
    return undefined
  })
  register('preferences', async (value: WorkspacePreferences) => {
    preferences = {
      ...preferences,
      theme: ['light', 'dark', 'system'].includes(value.theme || '')
        ? value.theme
        : preferences.theme,
      font: ['Microsoft YaHei', 'SimSun', 'KaiTi', 'Consolas'].includes(value.font)
        ? value.font
        : preferences.font,
      size: Math.max(12, Math.min(32, Number(value.size) || 18)),
      lineHeight: Math.max(1.2, Math.min(3, Number(value.lineHeight) || 1.9)),
      lastBookId: books.some((book) => book.id === value.lastBookId)
        ? value.lastBookId
        : preferences.lastBookId,
      lastDocuments:
        value.lastDocuments && typeof value.lastDocuments === 'object'
          ? value.lastDocuments
          : preferences.lastDocuments,
      agentVisible: Boolean(value.agentVisible),
      targetRewrite: Boolean(value.targetRewrite),
      unifiedProposalPreview: Boolean(value.unifiedProposalPreview),
      lastDocumentsByKind: value.lastDocumentsByKind || {},
      listVisible: Boolean(value.listVisible),
      focusMode: Boolean(value.focusMode),
      agentWidths: Object.fromEntries(
        Object.entries(value.agentWidths || {})
          .filter(([id, width]) => id.length <= 100 && Number.isFinite(width))
          .slice(0, 2000)
          .map(([id, width]) => [id, Math.max(300, Math.min(900, width))])
      ),
      knowledgeHighlight: Object.fromEntries(
        Object.entries(value.knowledgeHighlight || {})
          .filter(
            ([id, enabled]) => books.some((book) => book.id === id) && typeof enabled === 'boolean'
          )
          .map(([id, enabled]) => [id, enabled])
      )
    }
    await persist()
  })
  register('export-document', async (bookId: string, id: string) => {
    const { document } = await store.read(bookId, id)
    const ext = document.kind === 'chapters' ? 'txt' : 'md'
    const result = await dialog.showSaveDialog(window!, {
      title: '导出当前文档',
      defaultPath: `${filename(document.title)}.${ext}`
    })
    if (result.canceled || !result.filePath) return false
    await atomicWrite(result.filePath, document.content)
    return true
  })
  register('export-book', async (bookId: string) => {
    const book = books.find((item) => item.id === bookId)
    if (!book) throw new Error('作品未打开')
    const chapters = (await store.orderedList(bookId))
      .filter((doc) => doc.kind === 'chapters' && !doc.trashedAt)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    const parts: string[] = []
    for (const chapter of chapters)
      parts.push(`${chapter.title}\n\n${(await store.read(bookId, chapter.id)).document.content}`)
    const result = await dialog.showSaveDialog(window!, {
      title: '导出全部正文',
      defaultPath: `${filename(book.title)}.txt`
    })
    if (result.canceled || !result.filePath) return false
    await atomicWrite(result.filePath, parts.join('\n\n'))
    return true
  })
  register('backup', async (bookId: string) => {
    const parent = await chooseDirectory('选择作品之外的备份位置')
    if (!parent) return false
    const book = books.find((item) => item.id === bookId)
    if (!book) throw new Error('作品未打开')
    await store.backup(bookId, join(parent, `${basename(book.root)}-backup-${Date.now()}`))
    return true
  })
  ipcMain.on('zestloomer:close-result', async (event, success: boolean) => {
    if (event.sender !== window?.webContents || !closeRequested) return
    closeRequested = false
    if (!success) return
    await agent.close()
    await store.idle()
    await configQueue.catch(() => {})
    closing = true
    window.close()
  })
}

function createWindow(): void {
  closing = false
  window = new BrowserWindow({
    title: 'ZestLoomer',
    icon: zestloomerIcon,
    width: 1380,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    show: !environmentValue('TEST_HIDDEN'),
    autoHideMenuBar: true,
    backgroundColor: '#f6f4ef',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: true
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.on('close', (event) => {
    if (closing) return
    event.preventDefault()
    if (!closeRequested) {
      closeRequested = true
      window?.webContents.send('zestloomer:before-close')
    }
  })
  window.webContents.on('render-process-gone', () => {
    closeRequested = false
    closing = true
  })
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) app.quit()
else
  void app.whenReady().then(async () => {
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    const pointer = join(app.getPath('userData'), 'library.json')
    libraryRoot = environmentValue('BOOKLIST') || ''
    if (!libraryRoot) {
      try {
        libraryRoot = JSON.parse(await fs.readFile(pointer, 'utf8')).root || ''
        await fs.access(libraryRoot)
      } catch {
        libraryRoot = ''
      }
    }
    if (!libraryRoot) {
      const selected = await dialog.showOpenDialog({
        title: '选择书库 BookList（保存作品、对话、API 和自定义设置）',
        properties: ['openDirectory', 'createDirectory']
      })
      if (selected.canceled || !selected.filePaths[0]) {
        app.quit()
        return
      }
      libraryRoot = selected.filePaths[0]
      await atomicWrite(pointer, JSON.stringify({ root: libraryRoot }, null, 2))
    }
    libraryConfig = await prepareLibrary(libraryRoot, app.getPath('userData'))
    heavySettings = new HeavySettingsStore(
      libraryRoot,
      join(app.getPath('userData'), 'heavy-agent-location.json')
    )
    agentConfig = new AgentConfigStore(join(libraryConfig, 'agent.json'))
    toolApi = new ToolApiService(join(libraryConfig, 'tool-api.json'), agentConfig)
    try {
      await agentConfig.load()
    } catch {
      errors.push('Agent 配置读取失败，请在设置中重新配置。')
    }
    try {
      await toolApi.load()
    } catch {
      errors.push('工具 API 配置读取失败，请在 AI 设置中重新配置。')
    }
    let previousBooks: Book[] = []
    let workspaceReadable = true
    try {
      const config = JSON.parse(await fs.readFile(configPath(), 'utf8'))
      preferences = { ...defaultPreferences, ...config.preferences }
      if (!['light', 'dark', 'system'].includes(preferences.theme || ''))
        preferences.theme = 'system'
      previousBooks = config.books || []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        workspaceReadable = false
        errors.push('工作区设置读取失败，作品文件未受影响。')
      }
    }
    try {
      for (const previous of locateBooks(
        libraryRoot,
        previousBooks,
        await libraryBooks(libraryRoot)
      )) {
        try {
          books.push(await store.openBook(previous.root))
        } catch {
          errors.push(`无法打开「${previous.title}」，可用“打开作品”重新定位。`)
        }
      }
      if (workspaceReadable) await persist()
    } catch {
      errors.push('书库扫描或列表保存失败，请检查书库目录权限与 book.json。')
    }
    registerHandlers()
    createWindow()
    app.on('second-instance', () => {
      window?.show()
      window?.focus()
    })
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
