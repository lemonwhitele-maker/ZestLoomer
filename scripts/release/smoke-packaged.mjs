import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
await mkdir(resolve(root, '.test-artifacts'), { recursive: true })
const fixture = await mkdtemp(resolve(root, '.test-artifacts/packaged-'))
const profile = resolve(fixture, 'profile')
const executablePath = process.env.LOOM_PACKAGED_EXE || resolve(root, 'dist/win-unpacked/Loom.exe')
const env = { ...process.env, LOOM_USER_DATA: profile, LOOM_TEST_HIDDEN: '1' }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
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
    version: app.getVersion(),
    profile: app.getPath('userData')
  }))
  assert.equal(runtime.packaged, true)
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
  const runtime = await launch()
  await electron.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, fixture)
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
  const backupParent = resolve(fixture, 'backups')
  const importPath = resolve(fixture, 'UTF16 中文导入.txt')
  const importText = '第1章 导入验收\r\n  原始缩进与换行\r\n'
  await writeFile(importPath, Buffer.from('\uFEFF' + importText, 'utf16le'))
  await electron.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, importPath)
  const imported = await page.evaluate(async () => ({
    methods: Object.keys(window.loom.imports),
    draft: await window.loom.imports.chooseFile('utf8')
  }))
  assert.deepEqual(imported.methods, ['chooseFile'])
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
  const report = {
    executablePath,
    fixture,
    runtime,
    errors,
    checks: [
      'packaged startup',
      'renderer and preload',
      'Chinese and space path',
      'create book',
      'save chapter',
      'export book',
      'backup book',
      'TXT-only import API and UTF-16 BOM decoding',
      'restart and read saved chapter'
    ],
    backupFiles: await readdir(backupParent),
    passed: true
  }
  await writeFile(
    resolve(root, `../loom-${version}-packaged-smoke.json`),
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
