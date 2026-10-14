import { contextBridge, ipcRenderer } from 'electron'
import type { LoomAPI } from '../shared/documents'
import type { AgentEvent } from '../shared/agent'
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke(`loom:${name}`, ...args)
const api: LoomAPI = {
  tools: {
    config: () => invoke('tools:config'),
    configure: (input) => invoke('tools:configure', input),
    test: (input) => invoke('tools:test', input),
    cancelTest: () => invoke('tools:cancel-test')
  },
  imports: {
    chooseFile: (encoding) => invoke('import:file', encoding)
  },
  workspace: {
    refresh: (book) => invoke('workspace:refresh', book),
    getPreferences: (book) => invoke('workspace:preferences:get', book),
    setPreferences: (book, value) => invoke('workspace:preferences:set', book, value),
    createBatch: (input) => invoke('workspace:create-batch', input),
    reorder: (book, kind, ids, expected) => invoke('workspace:reorder', book, kind, ids, expected),
    undoOrder: (book, kind) => invoke('workspace:undo-order', book, kind),
    renameBatch: (input) => invoke('workspace:rename-batch', input),
    stats: (book) => invoke('workspace:stats', book),
    history: (book, id) => invoke('workspace:history', book, id),
    historyRead: (book, id, entry) => invoke('workspace:history-read', book, id, entry),
    restoreHistory: (book, id, entry, version) =>
      invoke('workspace:history-restore', book, id, entry, version),
    search: (book, query) => invoke('workspace:search', book, query),
    cancelSearch: (book) => invoke('workspace:search-cancel', book)
  },
  agent: {
    exportLog: (book, id) => invoke('agent:export-log', book, id),
    bind: (book) => invoke('agent:bind', book),
    snapshot: (book) => invoke('agent:snapshot', book),
    create: (book, title) => invoke('agent:create', book, title),
    rename: (book, id, title) => invoke('agent:rename', book, id, title),
    start: (book, id, text, workspace) => invoke('agent:start', book, id, text, workspace),
    cancel: (book) => invoke('agent:cancel', book),
    editor: (book, states) => invoke('agent:editor', book, states),
    action: (book, id, action, hash) => invoke('agent:action', book, id, action, hash),
    config: () => invoke('agent:config'),
    configure: (input) => invoke('agent:configure', input),
    test: (input, mode) => invoke('agent:test', input, mode),
    cancelTest: () => invoke('agent:cancel-test'),
    models: (input) => invoke('agent:models', input),
    preferences: (book, id, profileId, archived) =>
      invoke('agent:preferences', book, id, profileId, archived),
    onEvent(listener) {
      const handler = (_event: unknown, payload: AgentEvent) => listener(payload)
      ipcRenderer.on('loom:agent:event', handler)
      return () => ipcRenderer.removeListener('loom:agent:event', handler)
    }
  },
  bootstrap: () => invoke('bootstrap'),
  createBook: (title) => invoke('create-book', title),
  openBook: () => invoke('open-book'),
  list: (book) => invoke('list', book),
  create: (book, kind, title, template) => invoke('create', book, kind, title, template),
  read: (book, id) => invoke('read', book, id),
  save: (input) => invoke('save', input),
  draft: (book, id, draft) => invoke('draft', book, id, draft),
  trash: (book, id, version) => invoke('trash', book, id, version),
  restore: (book, id, version) => invoke('restore', book, id, version),
  reorder: (book, kind, ids) => invoke('reorder', book, kind, ids),
  preferences: (value) => invoke('preferences', value),
  exportDocument: (book, id) => invoke('export-document', book, id),
  exportBook: (book) => invoke('export-book', book),
  backup: (book) => invoke('backup', book),
  onClose(handler) {
    const listener = () => {
      void handler()
        .then((ok) => ipcRenderer.send('loom:close-result', ok))
        .catch(() => ipcRenderer.send('loom:close-result', false))
    }
    ipcRenderer.on('loom:before-close', listener)
    return () => {
      ipcRenderer.removeListener('loom:before-close', listener)
    }
  }
}
contextBridge.exposeInMainWorld('loom', api)
