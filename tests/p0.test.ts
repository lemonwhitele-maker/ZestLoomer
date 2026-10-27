import test from 'node:test'
import assert from 'node:assert/strict'
import { RefreshQueue } from '../src/renderer/src/refreshQueue'
import { trimSessions } from '../src/renderer/src/sessionManager'
import { DocumentSession } from '../src/renderer/src/session'
import type { DocumentSnapshot, ZestLoomerAPI } from '../src/shared/documents'
const document: DocumentSnapshot = {
  id: 'a',
  title: 'A',
  content: 'old',
  version: 'v1',
  generation: 'g1',
  kind: 'chapters',
  order: 0,
  trashedAt: null,
  createdAt: '',
  updatedAt: ''
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>((r) => {
    release = r
  })
  return { promise, release }
}
test('focus bursts share one flight and manual requests force the trailing pass', async () => {
  const pending = gate()
  const calls: boolean[] = []
  const queue = new RefreshQueue(async (force) => {
    calls.push(force)
    if (calls.length === 1) await pending.promise
  })
  const first = queue.request()
  await Promise.resolve()
  for (let i = 0; i < 10; i++) assert.equal(queue.request(i === 9), first)
  pending.release()
  await first
  assert.deepEqual(calls, [false, true])
  await queue.request()
  assert.deepEqual(calls, [false, true, false])
})
test('disposing waits for draft clear and blocks stale edits afterwards', async () => {
  const clearing = gate()
  let writes = 0
  const api: Pick<ZestLoomerAPI, 'save' | 'draft'> = {
    save: async (input) => {
      writes++
      return { ok: true, value: { ...document, content: input.content, version: 'v2' } }
    },
    draft: async (_b, _d, draft) => {
      if (!draft) await clearing.promise
      return { ok: true, value: undefined }
    }
  }
  const session = new DocumentSession('b', { document, draft: null }, api, () => {}, 100000)
  session.edit('new')
  let done = false
  const dispose = session.disposeAfterSettled().then((result) => {
    done = true
    return result
  })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(done, false)
  clearing.release()
  assert.equal(await dispose, true)
  session.edit('late callback')
  assert.equal(session.content, 'new')
  assert.equal(await session.flush(), true)
  assert.equal(writes, 1)
})
test('failed retirement preserves editable content and permits retry', async () => {
  let fail = true
  const api: Pick<ZestLoomerAPI, 'save' | 'draft'> = {
    save: async (input) =>
      fail
        ? { ok: false, code: 'IO', message: 'disk failed' }
        : { ok: true, value: { ...document, content: input.content, version: 'v2' } },
    draft: async () => ({ ok: true, value: undefined })
  }
  const session = new DocumentSession('b', { document, draft: null }, api, () => {}, 100000)
  session.edit('must survive')
  assert.equal(await session.disposeAfterSettled(), false)
  session.edit('still editable')
  fail = false
  assert.equal(await session.disposeAfterSettled(), true)
  assert.equal(session.content, 'still editable')
})
test('cache budget evicts idle entries but retains active and dirty sessions', async () => {
  const api: Pick<ZestLoomerAPI, 'save' | 'draft'> = {
    save: async () => ({ ok: true, value: document }),
    draft: async () => ({ ok: true, value: undefined })
  }
  const make = () => new DocumentSession('b', { document, draft: null }, api, () => {}, 100000)
  const idle = make(),
    active = make(),
    dirty = make()
  dirty.edit('unsaved')
  const sessions = new Map([
    ['idle', idle],
    ['active', active],
    ['dirty', dirty]
  ])
  await trimSessions(sessions, active, 1, 1)
  assert.deepEqual([...sessions.keys()], ['active', 'dirty'])
  dirty.stop()
})
