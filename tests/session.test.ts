import test from 'node:test'
import assert from 'node:assert/strict'
import { DocumentSession } from '../src/renderer/src/session'
import {
  type DocumentSnapshot,
  type LoomAPI,
  type SaveInput,
  type Draft
} from '../src/shared/documents'
const original: DocumentSnapshot = {
  id: 'doc-a',
  kind: 'chapters',
  title: '章',
  content: '原文',
  version: 'v1',
  generation: 'g1',
  order: 0,
  trashedAt: null,
  createdAt: '',
  updatedAt: ''
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
test('concurrent flush calls share the recovery barrier and do not conflict with themselves', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let version = original.version
  const writes: string[] = []
  const api: Pick<LoomAPI, 'save' | 'draft'> = {
    draft: async () => {
      await gate
      return { ok: true, value: undefined }
    },
    save: async (input) => {
      writes.push(input.expectedVersion)
      if (input.expectedVersion !== version)
        return { ok: false, code: 'CONFLICT', message: 'conflict' }
      version = 'v2'
      return { ok: true, value: { ...original, content: input.content, version } }
    }
  }
  const session = new DocumentSession(
    'book',
    { document: original, draft: null },
    api,
    () => {},
    100000
  )
  try {
    session.edit('最新正文')
    const first = session.flush()
    const second = session.settle()
    release()
    assert.deepEqual(await Promise.all([first, second]), [true, true])
    assert.deepEqual(writes, ['v1'])
    assert.equal(session.status, 'saved')
  } finally {
    session.stop()
  }
})

test('adopting a disk version emits a content replacement distinct from local input', () => {
  const changes: (string | undefined)[] = []
  const api: Pick<LoomAPI, 'save' | 'draft'> = {
    draft: async () => ({ ok: true, value: undefined }),
    save: async () => ({ ok: true, value: original })
  }
  const session = new DocumentSession('book', { document: original, draft: null }, api, (change) =>
    changes.push(change)
  )
  session.edit('本地')
  session.useDisk({ ...original, content: '磁盘', version: 'v2' })
  assert.deepEqual(changes, ['edit', 'replace'])
  assert.equal(session.content, '磁盘')
  session.stop()
})
test('a save acknowledgement does not overwrite typing during the request', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const writes: SaveInput[] = []
  let draft: Draft | null = null
  const api: Pick<LoomAPI, 'save' | 'draft'> = {
    draft: async (_book, _id, value) => {
      draft = value
      return { ok: true, value: undefined }
    },
    save: async (input) => {
      writes.push(input)
      if (writes.length === 1) await gate
      return {
        ok: true,
        value: {
          ...original,
          title: input.title,
          content: input.content,
          version: `v${writes.length + 1}`
        }
      }
    }
  }
  const session = new DocumentSession(
    'book',
    { document: original, draft: null },
    api,
    () => {},
    100000
  )
  session.edit('第一稿')
  const saving = session.flush()
  await delay(5)
  session.edit('第二稿')
  release!()
  await saving
  assert.equal(session.content, '第二稿')
  assert.equal(session.dirty, true)
  assert.equal(session.status, 'dirty')
  assert.equal((draft as Draft | null)?.content, '第二稿')
  assert.equal(await session.settle(), true)
  assert.equal(writes[1].expectedVersion, 'v2')
  assert.equal(writes[1].content, '第二稿')
  assert.equal(session.status, 'saved')
  session.stop()
})
test('conflict preserves local text and requires explicit resolution', async () => {
  let calls = 0
  const api: Pick<LoomAPI, 'save' | 'draft'> = {
    draft: async () => ({ ok: true, value: undefined }),
    save: async () => {
      calls++
      return { ok: false, code: 'CONFLICT', message: '外部修改' }
    }
  }
  const session = new DocumentSession('book', { document: original, draft: null }, api)
  session.edit('本地草稿')
  assert.equal(await session.settle(), false)
  assert.equal(session.status, 'conflict')
  assert.equal(session.content, '本地草稿')
  assert.equal(await session.settle(), false)
  assert.equal(calls, 1)
  session.useDisk({ ...original, version: 'v2', content: '外部修改' })
  assert.equal(session.content, '外部修改')
  assert.equal(session.dirty, false)
  session.stop()
})
test('empty recovery drafts are restored and stale recovery does not auto-write', () => {
  const api: Pick<LoomAPI, 'save' | 'draft'> = {
    draft: async () => ({ ok: true, value: undefined }),
    save: async () => {
      throw new Error('must not run')
    }
  }
  const session = new DocumentSession(
    'book',
    { document: original, draft: { content: '', title: '章', baseVersion: 'old', savedAt: '' } },
    api
  )
  assert.equal(session.content, '')
  assert.equal(session.status, 'conflict')
  session.stop()
})

test('editing a conflicted recovery draft preserves its original base across restarts', async () => {
  let stored: Draft | null = null
  const api: Pick<LoomAPI, 'save' | 'draft'> = {
    draft: async (_book, _id, draft) => {
      stored = draft
      return { ok: true, value: undefined }
    },
    save: async () => {
      throw new Error('conflicted source must not auto-save')
    }
  }
  const session = new DocumentSession(
    'book',
    {
      document: original,
      draft: { title: '章', content: '旧草稿', baseVersion: 'old', savedAt: '' }
    },
    api
  )
  session.edit('旧草稿继续输入')
  await delay(5)
  assert.equal((stored as Draft | null)?.baseVersion, 'old')
  const restarted = new DocumentSession('book', { document: original, draft: stored }, api)
  assert.equal(restarted.status, 'conflict')
  assert.equal(restarted.content, '旧草稿继续输入')
  session.stop()
  restarted.stop()
})

test('draft storage failure can be retried after the disk becomes writable', async () => {
  let failed = true
  const api: Pick<LoomAPI, 'save' | 'draft'> = {
    draft: async () =>
      failed ? { ok: false, code: 'IO', message: '不可写' } : { ok: true, value: undefined },
    save: async (input) => ({
      ok: true,
      value: { ...original, content: input.content, version: 'v2' }
    })
  }
  const session = new DocumentSession('book', { document: original, draft: null }, api)
  session.edit('需要重试')
  assert.equal(await session.settle(), false)
  failed = false
  assert.equal(await session.settle(), true)
  assert.equal(session.document.content, '需要重试')
  assert.equal(session.status, 'saved')
  session.stop()
})

test('settling a title with surrounding whitespace accepts the stored normalization once', async () => {
  let calls = 0
  let draft: Draft | null = null
  const api: Pick<LoomAPI, 'save' | 'draft'> = {
    draft: async (_book, _id, value) => {
      draft = value
      return { ok: true, value: undefined }
    },
    save: async (input) => {
      if (++calls > 2) throw new Error('标题规范化引发重复保存')
      return {
        ok: true,
        value: { ...original, title: input.title.trim(), content: input.content, version: 'v2' }
      }
    }
  }
  const session = new DocumentSession(
    'book',
    { document: original, draft: null },
    api,
    () => {},
    100000
  )
  try {
    session.edit('正文保持完整', '　新章节　 ')
    assert.equal(await session.settle(), true)
    assert.equal(calls, 1)
    assert.equal(session.title, '新章节')
    assert.equal(session.content, '正文保持完整')
    assert.equal(session.dirty, false)
    assert.equal(session.status, 'saved')
    assert.equal(draft, null)
  } finally {
    session.stop()
  }
})

test('a normalized title acknowledgement preserves title and content typed during the request', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const writes: SaveInput[] = []
  let draft: Draft | null = null
  const api: Pick<LoomAPI, 'save' | 'draft'> = {
    draft: async (_book, _id, value) => {
      draft = value
      return { ok: true, value: undefined }
    },
    save: async (input) => {
      writes.push(input)
      if (writes.length === 1) await gate
      return {
        ok: true,
        value: {
          ...original,
          title: input.title.trim(),
          content: input.content,
          version: `v${writes.length + 1}`
        }
      }
    }
  }
  const session = new DocumentSession(
    'book',
    { document: original, draft: null },
    api,
    () => {},
    100000
  )
  try {
    session.edit('第一稿', ' 第一标题 ')
    const saving = session.flush()
    await delay(5)
    session.edit('第二稿', ' 第二标题 ')
    release!()
    await saving
    assert.equal(session.title, ' 第二标题 ')
    assert.equal(session.content, '第二稿')
    assert.equal((draft as Draft | null)?.title, ' 第二标题 ')
    assert.equal((draft as Draft | null)?.baseVersion, 'v2')
    assert.equal(await session.settle(), true)
    assert.equal(writes.length, 2)
    assert.equal(writes[1].title, ' 第二标题 ')
    assert.equal(writes[1].expectedVersion, 'v2')
    assert.equal(session.title, '第二标题')
    assert.equal(session.content, '第二稿')
    assert.equal(session.status, 'saved')
  } finally {
    session.stop()
  }
})

test('coalesces rapid draft writes when disk is slow and preserves the latest revision', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let draftCalls = 0
  let latestDraft: Draft | null = null
  const api: Pick<LoomAPI, 'save' | 'draft'> = {
    draft: async (_book, _id, draft) => {
      draftCalls++
      latestDraft = draft
      if (draftCalls === 1) await gate
      return { ok: true, value: undefined }
    },
    save: async (input) => ({
      ok: true,
      value: { ...original, title: input.title, content: input.content, version: 'v2' }
    })
  }
  const session = new DocumentSession(
    'book',
    { document: original, draft: null },
    api,
    () => {},
    100000
  )
  try {
    session.edit('输入 0')
    for (let i = 1; i <= 100; i++) {
      session.edit(`输入 ${i}`)
    }
    assert.equal(draftCalls, 1)
    release!()
    assert.equal(await session.flushDraft(), true)
    assert.equal(draftCalls, 2)
    assert.equal((latestDraft as Draft | null)?.content, '输入 100')
    assert.equal(await session.settle(), true)
    assert.equal(session.status, 'saved')
  } finally {
    session.stop()
  }
})

test('editing during draft clearing does not let the older clearing wipe out newer draft', async () => {
  let releaseClear: (() => void) | undefined
  const clearGate = new Promise<void>((resolve) => {
    releaseClear = resolve
  })
  let clearInFlight = false
  const draftHistory: (Draft | null)[] = []
  const api: Pick<LoomAPI, 'save' | 'draft'> = {
    draft: async (_book, _id, draft) => {
      draftHistory.push(draft)
      if (draft === null) {
        clearInFlight = true
        await clearGate
      }
      return { ok: true, value: undefined }
    },
    save: async (input) => ({
      ok: true,
      value: { ...original, title: input.title, content: input.content, version: 'v2' }
    })
  }
  const session = new DocumentSession(
    'book',
    { document: original, draft: null },
    api,
    () => {},
    100000
  )
  try {
    session.edit('保存中内容')
    const saving = session.flush()
    while (!clearInFlight) {
      await delay(2)
    }
    session.edit('清理期间新输入')
    releaseClear!()
    await saving
    assert.equal(await session.flushDraft(), true)
    assert.equal(draftHistory.at(-1)?.content, '清理期间新输入')
    assert.equal(session.dirty, true)
    assert.equal(await session.settle(), true)
    assert.equal(session.status, 'saved')
  } finally {
    session.stop()
  }
})
