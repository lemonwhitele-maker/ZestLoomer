import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { environmentValue } from '../src/shared/environment'
import { libraryConfigDirectory, userDataDirectory } from '../src/main/dataPaths'
import { prepareLibrary, libraryBooks } from '../src/main/bookLibrary'
import { HeavySettingsStore } from '../src/main/agent/heavySettings'
import { defaultHeavySettings } from '../src/shared/heavyAgent'
import { DocumentStore } from '../src/main/documents'
import { readPosition, writePosition } from '../src/renderer/src/editorCache'

async function fixture() {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  return fs.mkdtemp(resolve('.test-artifacts/branding-'))
}

test('new environment names win, legacy names remain usable and explicit isolation wins over profiles', async () => {
  const root = await fixture()
  await fs.mkdir(join(root, 'Loom'))
  assert.equal(userDataDirectory(root, {}), join(root, 'Loom'))
  await fs.mkdir(join(root, 'ZestLoomer'))
  assert.equal(userDataDirectory(root, {}), join(root, 'ZestLoomer'))
  assert.equal(userDataDirectory(root, { LOOM_USER_DATA: 'legacy-override' }), 'legacy-override')
  assert.equal(
    userDataDirectory(root, { LOOM_USER_DATA: 'old', ZESTLOOMER_USER_DATA: 'isolated' }),
    'isolated'
  )
  for (const suffix of ['BOOKLIST', 'USER_DATA', 'TEST_HIDDEN', 'PERF']) {
    assert.equal(environmentValue(suffix, { [`LOOM_${suffix}`]: 'old' }), 'old')
    assert.equal(
      environmentValue(suffix, { [`LOOM_${suffix}`]: 'old', [`ZESTLOOMER_${suffix}`]: 'new' }),
      'new'
    )
    assert.equal(
      environmentValue(suffix, { [`LOOM_${suffix}`]: 'old', [`ZESTLOOMER_${suffix}`]: '' }),
      ''
    )
  }
  const fresh = await fixture()
  assert.equal(userDataDirectory(fresh, {}), join(fresh, 'ZestLoomer'))
})

test('legacy library settings stay together, retain encrypted bytes and survive repeated opens', async () => {
  const root = await fixture()
  const legacy = join(root, '.loom')
  await fs.mkdir(legacy)
  const settings = { ...defaultHeavySettings, revision: 7, prompt: '旧书库的偏好' }
  const snapshots = {
    'agent.json': JSON.stringify({ encryptedKey: 'synthetic-encrypted-bytes' }),
    'tool-api.json': JSON.stringify({ value: '旧工具配置' }),
    'workspace.json': JSON.stringify({ books: [], preferences: { theme: 'dark' } }),
    'agent-settings.json': JSON.stringify(settings)
  }
  for (const [name, value] of Object.entries(snapshots))
    await fs.writeFile(join(legacy, name), value)
  assert.equal(await prepareLibrary(root, join(root, 'missing-profile')), legacy)
  assert.deepEqual((await new HeavySettingsStore(root).read()).settings, settings)
  await prepareLibrary(root, join(root, 'missing-profile'))
  assert.deepEqual((await new HeavySettingsStore(root).read()).settings, settings)
  for (const [name, value] of Object.entries(snapshots))
    assert.equal(await fs.readFile(join(legacy, name), 'utf8'), value)
  await assert.rejects(fs.access(join(root, '.zestloomer')))
  const saved = await new HeavySettingsStore(root).save({ ...settings, prompt: '正常保存的新偏好' })
  assert.equal(saved.settings.revision, 8)
  assert.equal(
    JSON.parse(await fs.readFile(join(legacy, 'agent-settings.json'), 'utf8')).prompt,
    '正常保存的新偏好'
  )
})

test('new libraries use new directories; existing new settings beat old, and damaged paths never fall back', async () => {
  const root = await fixture()
  const current = await prepareLibrary(root, join(root, 'missing-profile'))
  assert.equal(current, join(root, '.zestloomer'))
  const store = new HeavySettingsStore(root)
  await store.save({ ...defaultHeavySettings, prompt: '新配置' })
  await fs.mkdir(join(root, '.loom'))
  await fs.writeFile(join(root, '.loom', 'agent-settings.json'), '{broken legacy')
  assert.equal((await new HeavySettingsStore(root).read()).settings.prompt, '新配置')
  await fs.writeFile(join(current, 'agent-settings.json'), '{broken current')
  await assert.rejects(new HeavySettingsStore(root).read())
  assert.equal(await fs.readFile(join(current, 'agent-settings.json'), 'utf8'), '{broken current')
  assert.equal(
    await fs.readFile(join(root, '.loom', 'agent-settings.json'), 'utf8'),
    '{broken legacy'
  )
  const invalid = await fixture()
  await fs.mkdir(join(invalid, '.loom'))
  await fs.writeFile(join(invalid, '.zestloomer'), 'not a directory')
  assert.throws(() => libraryConfigDirectory(invalid), /不是文件夹/)
})

test('old external heavy settings can still be imported from .loom without changing their source', async () => {
  const root = await fixture()
  const source = await fixture()
  await fs.mkdir(join(source, '.loom'))
  const original = JSON.stringify({ ...defaultHeavySettings, revision: 4, prompt: '原全局偏好' })
  await fs.writeFile(join(source, '.loom', 'agent-settings.json'), original)
  const pointer = join(root, 'legacy-location.json')
  await fs.writeFile(pointer, JSON.stringify({ root: source }))
  assert.equal((await new HeavySettingsStore(root, pointer).read()).settings.prompt, '原全局偏好')
  assert.equal(await fs.readFile(join(source, '.loom', 'agent-settings.json'), 'utf8'), original)
})

test('old book directory names remain discoverable and document bytes and IDs are preserved', async () => {
  const root = await fixture()
  const store = new DocumentStore()
  const book = await store.createBook(root, '兼容作品')
  const chapter = await store.create(book.id, 'chapters', '第一章', {
    content: 'Loom 是原文。\n不替换书稿。'
  })
  const previous = join(root, 'Loom-old-book')
  await fs.rename(book.root, previous)
  const found = await libraryBooks(root)
  assert.equal(found[0].id, book.id)
  const reopened = new DocumentStore()
  await reopened.openBook(previous)
  assert.equal(
    (await reopened.read(book.id, chapter.document.id)).document.content,
    chapter.document.content
  )
})

test('reading positions fall back to Loom keys and new writes preserve the original cache', (t) => {
  const storage = new Map<string, string>()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value)
    }
  })
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  const original = { anchor: 8, head: 10, scrollTop: 200 }
  storage.set('loom.editor-position:legacy', JSON.stringify(original))
  assert.deepEqual(readPosition('legacy'), original)
  const updated = { anchor: 20, head: 22, scrollTop: 300 }
  writePosition('legacy', updated)
  assert.equal(storage.get('loom.editor-position:legacy'), JSON.stringify(original))
  assert.equal(storage.get('zestloomer.editor-position:legacy'), JSON.stringify(updated))
  storage.set('loom.editor-position:both', JSON.stringify(original))
  storage.set('zestloomer.editor-position:both', JSON.stringify(updated))
  assert.deepEqual(readPosition('both'), updated)
})
