import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
await mkdir(resolve(root, '.test-artifacts'), { recursive: true })
const fixture = await mkdtemp(resolve(root, '.test-artifacts/packaged-'))
const profile = resolve(fixture, 'profile')
const library = resolve(fixture, 'BookList')
const productionProfile = resolve(fixture, 'production-profile')
const productionLibrary = resolve(fixture, 'production-BookList')
const executablePath =
  process.env.LOOM_PREVIEW_PACKAGED_EXE || resolve(root, 'dist/win-unpacked/LoomPreview.exe')
const env = {
  ...process.env,
  LOOM_PREVIEW_USER_DATA: profile,
  LOOM_USER_DATA: productionProfile,
  LOOM_BOOKLIST: productionLibrary,
  LOOM_TEST_HIDDEN: '1'
}
delete env.LOOM_PREVIEW_BOOKLIST
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL

// These are synthetic sentinels, never an installed application's real profile or books.
await mkdir(profile, { recursive: true })
await mkdir(productionProfile, { recursive: true })
await mkdir(resolve(productionLibrary, '.loom'), { recursive: true })
await mkdir(resolve(productionLibrary, 'sentinel'), { recursive: true })
const sentinelBook = { format: 1, id: 'book_preview_isolation_fixture', title: '隔离验收占位作品' }
const sentinelConfig = {
  format: 2,
  defaultProfileId: 'production_marker',
  profiles: [
    {
      id: 'production_marker',
      label: 'Synthetic production sentinel',
      baseUrl: 'https://invalid.example/v1',
      model: 'never-call',
      encryptedKey: ''
    }
  ]
}
await writeFile(resolve(productionLibrary, 'sentinel/book.json'), JSON.stringify(sentinelBook))
await writeFile(resolve(productionLibrary, '.loom/agent.json'), JSON.stringify(sentinelConfig))
await writeFile(resolve(productionProfile, 'agent.json'), JSON.stringify(sentinelConfig))
for (const directory of [productionProfile, profile]) {
  await writeFile(resolve(directory, 'library.json'), JSON.stringify({ root: productionLibrary }))
  await writeFile(
    resolve(directory, 'heavy-agent-location.json'),
    JSON.stringify({ root: productionLibrary })
  )
}
async function snapshot(directory) {
  const files = []
  async function visit(folder, prefix = '') {
    const entries = await readdir(folder, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = prefix + entry.name
      if (entry.isDirectory()) {
        files.push(`directory:${path}`)
        await visit(resolve(folder, entry.name), path + '/')
      } else {
        files.push(
          `file:${path}:${createHash('sha256')
            .update(await readFile(resolve(folder, entry.name)))
            .digest('hex')}`
        )
      }
    }
  }
  await visit(directory)
  return files
}
const productionBefore = await Promise.all([
  snapshot(productionProfile),
  snapshot(productionLibrary)
])
const errors = []
let electron
let page
async function launch() {
  electron = await _electron.launch({ executablePath, args: [], cwd: fixture, env, timeout: 30000 })
  page = await electron.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('button', { name: '新建作品', exact: true })).toBeEnabled()
  const runtime = await electron.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    name: app.getName(),
    version: app.getVersion(),
    profile: app.getPath('userData')
  }))
  assert.equal(runtime.packaged, true)
  assert.equal(runtime.name, 'Loom Preview')
  assert.equal(runtime.version, version)
  assert.equal(runtime.profile, profile)
  return runtime
}
async function close() {
  await electron.evaluate(({ app }) => app.quit())
  await electron.close()
  electron = undefined
}
try {
  const isolationRuntime = await launch()
  const isolated = await page.evaluate(async () => ({
    bootstrap: await window.loom.bootstrap(),
    config: await window.loom.agent.config(),
    heavy: await window.loom.agent.heavySettings()
  }))
  assert.equal(isolated.bootstrap.ok, true)
  assert.deepEqual(isolated.bootstrap.value.books, [])
  assert.deepEqual(isolated.bootstrap.value.errors, [])
  assert.equal(isolated.config.ok, true)
  assert.deepEqual(isolated.config.value.profiles, [])
  assert.equal(isolated.heavy.ok, true)
  assert.equal(isolated.heavy.value.root, resolve(profile, 'BookList'))
  assert.equal(isolated.heavy.value.settings.appendPrompt, false)
  await close()

  env.LOOM_PREVIEW_BOOKLIST = library
  const runtime = await launch()
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  await page.getByRole('textbox', { name: '新标题' }).fill('中文 安装验收小说')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const saved = await page.evaluate(async () => {
    const unwrap = (result) => {
      if (!result.ok) throw new Error(result.message)
      return result.value
    }
    const boot = unwrap(await window.loom.bootstrap())
    const book = boot.books[0]
    const { document } = unwrap(
      await window.loom.create(book.id, 'chapters', '第一章 验收', 'blank')
    )
    const saved = unwrap(
      await window.loom.save({
        bookId: book.id,
        id: document.id,
        title: document.title,
        content: '这是安装版保存与重启验收。\n中文、空格与换行都应保留。',
        expectedVersion: document.version
      })
    )
    return { book, saved }
  })
  assert.equal(dirname(saved.book.root), library)
  const backupParent = resolve(fixture, 'backups')
  const importPath = resolve(fixture, 'UTF16 中文导入.txt')
  const importText = '第1章 导入验收\r\n  原始缩进与换行\r\n'
  await writeFile(importPath, Buffer.from('\uFEFF' + importText, 'utf16le'))
  await electron.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, importPath)
  const imported = await page.evaluate(async () => ({
    draft: await window.loom.imports.chooseFile('utf8')
  }))
  assert.equal(imported.draft.ok, true)
  assert.equal(imported.draft.value.rawContent, importText)
  assert.equal(imported.draft.value.items[0].title, '第1章 导入验收')
  assert.equal(imported.draft.value.items[0].content, '  原始缩进与换行\r\n')
  await mkdir(backupParent)
  await electron.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: directory + '/export.txt' })
  }, backupParent)
  const operations = await page.evaluate(
    async (bookId) => ({
      backup: await window.loom.backup(bookId),
      export: await window.loom.exportBook(bookId)
    }),
    saved.book.id
  )
  assert.deepEqual(operations.backup, { ok: true, value: true })
  assert.deepEqual(operations.export, { ok: true, value: true })
  assert.ok(
    (await readFile(resolve(backupParent, 'export.txt'), 'utf8')).includes(saved.saved.content)
  )
  await close()
  await launch()
  const reopened = await page.evaluate(
    async ({ bookId, id }) => {
      return await window.loom.read(bookId, id)
    },
    { bookId: saved.book.id, id: saved.saved.id }
  )
  assert.equal(reopened.ok, true)
  assert.equal(reopened.value.document.content, saved.saved.content)
  assert.deepEqual(errors, [])
  await close()
  assert.deepEqual(
    await Promise.all([snapshot(productionProfile), snapshot(productionLibrary)]),
    productionBefore
  )
  const report = {
    executablePath,
    fixture,
    runtime,
    isolationRuntime,
    errors,
    checks: [
      'packaged startup',
      'Preview application name and isolated profile',
      'default empty Preview BookList without a directory picker',
      'production environment and legacy library pointers ignored',
      'production configuration not imported and synthetic production files unchanged',
      'explicit Preview BookList environment',
      'renderer and preload',
      'Chinese and space path',
      'create book',
      'save chapter',
      'export book',
      'backup book',
      'text import and UTF-16 BOM decoding',
      'restart and read saved chapter'
    ],
    backupFiles: await readdir(backupParent),
    passed: true
  }
  await writeFile(
    resolve(root, `.test-artifacts/loom-preview-${version}-packaged-smoke.json`),
    JSON.stringify(report, null, 2) + '\n'
  )
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (electron) {
    await electron
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await electron.close()
  }
}
