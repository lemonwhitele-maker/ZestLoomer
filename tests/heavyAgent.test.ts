import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { HeavySettingsStore } from '../src/main/agent/heavySettings'
import { chapterRange, freezeHeavyContext } from '../src/main/agent/heavyContext'
import { defaultHeavySettings } from '../src/shared/heavyAgent'
import { DocumentStore } from '../src/main/documents'
import { AgentService } from '../src/main/agent/service'
import { ScriptedRuntime } from '../src/main/agent/runtime'
import { assembleContext } from '../src/main/agent/context'
import { defaultPolicy } from '../src/main/agent/budgets'

async function folder() {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  return fs.mkdtemp(resolve('.test-artifacts/heavy-'))
}
test('BookList owns settings, imports legacy once, preserves destination and moves without pointer', async () => {
  const legacy = await folder(),
    root = await folder()
  const old = new HeavySettingsStore(legacy)
  const original = await old.save({
    ...defaultHeavySettings,
    prompt: '迁移偏好',
    appendPrompt: true
  })
  const pointer = join(legacy, 'location.json')
  await fs.writeFile(pointer, JSON.stringify({ root: legacy }))
  const current = new HeavySettingsStore(root, pointer)
  assert.deepEqual((await current.read()).settings, original.settings)
  const changed = await current.save({ ...original.settings, prompt: '书库偏好' })
  assert.equal((await new HeavySettingsStore(root, pointer).read()).settings.prompt, '书库偏好')
  assert.equal((await old.read()).settings.prompt, '迁移偏好')
  const moved = root + '-moved'
  await fs.rename(root, moved)
  assert.deepEqual((await new HeavySettingsStore(moved).read()).settings, changed.settings)
  await fs.unlink(join(moved, '.loom', 'agent-settings.json'))
  await assert.rejects(new HeavySettingsStore(moved, pointer).read(), /配置缺失/)
  const independent = new HeavySettingsStore(await folder())
  assert.equal((await independent.read()).settings.appendPrompt, false)
})
test('global settings survive restart, reject stale concurrent saves and preserve corrupt files', async () => {
  const root = await folder(),
    pointer = join(root, 'pointer.json')
  const store = new HeavySettingsStore(root, pointer)
  assert.equal((await store.read()).root, root)
  const saved = await store.save({
    ...defaultHeavySettings,
    prompt: '中文😀',
    appendPrompt: true
  })
  assert.equal(saved.settings.revision, 1)
  assert.deepEqual(await new HeavySettingsStore(root, pointer).read(), saved)
  const writes = await Promise.allSettled([store.save(saved.settings), store.save(saved.settings)])
  assert.equal(writes.filter((r) => r.status === 'fulfilled').length, 1)
  const path = join(root, '.loom', 'agent-settings.json')
  await fs.writeFile(path, '{broken')
  await assert.rejects(store.read())
  await assert.rejects(store.save(saved.settings))
  assert.equal(await fs.readFile(path, 'utf8'), '{broken')
})
test('Unicode windows use center, compensate boundaries, use cursor or tail, never split emoji', () => {
  const text = '😀'.repeat(12000)
  assert.deepEqual(chapterRange('短文', {}), { start: 0, end: 2 })
  assert.deepEqual(chapterRange(text, {}), { start: 4000, end: 12000 })
  assert.deepEqual(chapterRange(text, { cursor: 100 }), { start: 0, end: 8000 })
  assert.deepEqual(chapterRange(text, { cursor: 12000 }), { start: 2000, end: 10000 })
  assert.deepEqual(chapterRange(text, { selection: { from: 8000, to: 16000, text: '' } }), {
    start: 2000,
    end: 10000
  })
})
test('conversation settings freeze, source data refreshes, ordered full outlines and long selections are preserved', async () => {
  const root = await folder(),
    store = new DocumentStore()
  const book = await store.createBook(root, '合成作品')
  const chapters = []
  for (let i = 0; i < 5; i++)
    chapters.push(
      (
        await store.create(book.id, 'chapters', `章${i}`, {
          content: `章${i}` + '😀'.repeat(12000)
        })
      ).document
    )
  for (const i of [0, 1, 3, 4]) {
    const outline = (await store.create(book.id, 'outlines', `纲${i}`, { content: `完整大纲${i}` }))
      .document
    await store.setChapterOutlineBinding({
      bookId: book.id,
      chapterId: chapters[i].id,
      outlineId: outline.id,
      expectedRevision: (await store.chapterOutlineBindings(book.id)).revision
    })
  }
  let config = { ...defaultHeavySettings }
  const service = new AgentService(
    store,
    () =>
      Object.assign(new ScriptedRuntime(() => ({ text: '完成', calls: [] })), {
        policy: { ...defaultPolicy, contextTokens: 100000 }
      }),
    undefined,
    undefined,
    async () => config
  )
  const a = await service.create(book.id, 'A')
  config = {
    ...config,
    revision: 1,
    appendPrompt: true,
    prompt: '固定偏好',
    chapterOutline: true,
    chapterContext: true,
    previousContext: true
  }
  const b = await service.create(book.id, 'B')
  assert.equal(a.heavySettings?.chapterContext, false)
  assert.equal(b.heavySettings?.chapterContext, true)
  const current = chapters[4]
  const selection = { from: 0, to: 20002, text: current.content.slice(0, 20002) }
  const workspace = { documentId: current.id, savedVersion: current.version, selection }
  const snapshot = await freezeHeavyContext(store, book.id, workspace, b.heavySettings)
  assert.deepEqual(
    snapshot.prefix.map((d) => d.title),
    ['纲1', '纲3', '章3', '纲4']
  )
  assert.ok(snapshot.notices.some((n) => n.includes('章2')))
  assert.equal(Array.from(snapshot.prefix[2].content).length, 2000)
  assert.equal(snapshot.current[0].content, selection.text)
  assert.equal(snapshot.current[0].complete, false)
  b.messages.push({ id: 'request', role: 'user', text: '本次要求', sources: [] })
  const messages = assembleContext(
    b,
    '内置规则',
    { ...workspace, heavySnapshot: snapshot },
    { ...defaultPolicy, contextTokens: 100000 }
  )
  assert.match(messages[0].content!, /固定偏好/)
  assert.match(messages[1].content!, /完整大纲1/)
  assert.match(messages[4].content!, /完整大纲4/)
  assert.equal(messages.at(-1)?.content, '本次要求')
  assert.ok(!JSON.stringify(messages).includes('updatedAt'))
  assert.throws(
    () =>
      assembleContext(
        b,
        '内置规则',
        { ...workspace, heavySnapshot: snapshot },
        { ...defaultPolicy, contextTokens: 4000 }
      ),
    /超出模型预算/
  )
  await service.start(book.id, b.id, '读取资料', workspace)
  await service.idle()
  const restarted = new AgentService(
    store,
    () => new ScriptedRuntime(() => ({ text: '完成', calls: [] }))
  )
  const restored = await restarted.safeSnapshot(book.id)
  assert.equal(restored.conversations.find((c) => c.id === b.id)?.heavySettings?.prompt, '固定偏好')
  const first = await freezeHeavyContext(store, book.id, { documentId: chapters[0].id }, config)
  assert.ok(first.notices.some((n) => n.includes('首章')))
  assert.deepEqual(
    first.prefix.map((d) => d.title),
    ['纲0']
  )
  const draft = await freezeHeavyContext(
    store,
    book.id,
    { documentId: current.id, editorContent: '未保存草稿😀' },
    config
  )
  assert.equal(draft.current[0].draft, true)
  assert.equal(draft.current[0].content, '未保存草稿😀')
  const oldOutline = snapshot.prefix.at(-1)!
  const savedOutline = await store.save({
    bookId: book.id,
    id: oldOutline.id,
    expectedVersion: oldOutline.version,
    title: oldOutline.title,
    content: '下一轮的新大纲'
  })
  const refreshed = await freezeHeavyContext(store, book.id, workspace, b.heavySettings)
  assert.equal(snapshot.prefix.at(-1)!.content, '完整大纲4')
  assert.equal(refreshed.prefix.at(-1)!.content, '下一轮的新大纲')
  assert.equal(refreshed.prefix.at(-1)!.version, savedOutline.version)
  await store.setChapterOutlineBinding({
    bookId: book.id,
    chapterId: current.id,
    outlineId: null,
    expectedRevision: (await store.chapterOutlineBindings(book.id)).revision
  })
  const unbound = await freezeHeavyContext(store, book.id, workspace, b.heavySettings)
  assert.ok(unbound.notices.some((n) => n.includes('章4：未绑定大纲')))
  assert.equal(
    unbound.prefix.some((d) => d.id === oldOutline.id),
    false
  )
})
