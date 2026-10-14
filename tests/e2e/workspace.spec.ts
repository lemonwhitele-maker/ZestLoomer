import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { DocumentMeta, DocumentSnapshot } from '../../src/shared/documents'

let electron: ElectronApplication
let page: Page
let root: string
let profile: string
const consoleErrors: string[] = []

async function launch(): Promise<void> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  env.LOOM_USER_DATA = profile
  env.LOOM_TEST_HIDDEN = '1'
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  electron = await _electron.launch({ args: ['.'], cwd: resolve('.'), env })
  page = await electron.firstWindow()
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  await electron.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: folder + '/export.txt' })
  }, root)
  await expect(page.getByRole('button', { name: '新建作品', exact: true })).toBeEnabled()
}

test.beforeEach(async () => {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  root = await fs.mkdtemp(resolve('.test-artifacts/workspace-window-'))
  profile = join(root, 'profile')
  consoleErrors.length = 0
  await launch()
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  await page.getByRole('textbox', { name: '新标题' }).fill('新能力验收作品')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test.afterEach(async () => {
  if (electron) {
    await electron
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await electron.close()
  }
  expect(consoleErrors).toEqual([])
})

async function docs(): Promise<DocumentMeta[]> {
  return page.evaluate(async () => {
    const boot = await window.loom.bootstrap()
    if (!boot.ok) throw new Error(boot.message)
    const result = await window.loom.list(boot.value.preferences.lastBookId!)
    if (!result.ok) throw new Error(result.message)
    return result.value
  })
}
async function disk(id: string): Promise<DocumentSnapshot> {
  return page.evaluate(async (docId) => {
    const boot = await window.loom.bootstrap()
    if (!boot.ok) throw new Error(boot.message)
    const result = await window.loom.read(boot.value.preferences.lastBookId!, docId)
    if (!result.ok) throw new Error(result.message)
    return result.value.document
  }, id)
}
async function activeTitles(): Promise<string[]> {
  return (await docs())
    .filter((item) => item.kind === 'chapters' && !item.trashedAt)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((item) => item.title)
}
async function newDocument(title: string): Promise<void> {
  await page.getByRole('button', { name: '新建条目', exact: true }).click()
  await page.getByRole('textbox', { name: '新标题' }).fill(title)
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue(title)
}
async function enterText(text: string): Promise<void> {
  const content = page.locator('.cm-content')
  await expect(content).toHaveAttribute('contenteditable', 'true')
  await content.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(text)
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
}
async function openChapter(title: string): Promise<void> {
  await page
    .locator('.entry-title')
    .filter({ has: page.locator('span', { hasText: title }) })
    .filter({ hasText: title })
    .first()
    .click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue(title)
}
async function pressNavigationShortcut(
  keys: 'Control+p' | 'Alt+ArrowLeft' | 'Control+Alt+ArrowUp' | 'Control+Alt+ArrowDown'
): Promise<void> {
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '快速打开', exact: true })).toBeEnabled()
  await page.keyboard.press(keys)
}

test('workspace chapters preview naming, insert batches, sort safely, undo and export the actual order', async () => {
  await newDocument('序章')
  await enterText('序章正文原样保留')
  await newDocument('第10章 十')
  await newDocument('第2章 二')
  const second = (await docs()).find((item) => item.title === '第2章 二')!
  await page.getByRole('button', { name: '新建条目', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '新建章节', exact: true })
  await dialog.getByRole('combobox', { name: /^命名方式/ }).selectOption('number')
  await dialog.getByRole('spinbutton', { name: '起始编号', exact: true }).fill('1')
  await dialog.getByRole('textbox', { name: '新标题', exact: true }).fill('一')
  await dialog.getByRole('combobox', { name: /^插入位置/ }).selectOption('before')
  await dialog.getByRole('combobox', { name: /^参照章节/ }).selectOption(second.id)
  await expect(dialog.getByRole('region', { name: '新建预览' })).toContainText('第1章 一')
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(activeTitles).toEqual(['序章', '第10章 十', '第1章 一', '第2章 二'])

  await page.getByRole('button', { name: '新建条目', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '新建章节', exact: true })
  await dialog.getByRole('checkbox', { name: '批量创建' }).check()
  await dialog.getByRole('combobox', { name: /^创建方式/ }).selectOption('count')
  await dialog.getByRole('spinbutton', { name: '数量', exact: true }).fill('2')
  await dialog.getByRole('spinbutton', { name: '起始编号', exact: true }).fill('3')
  await dialog.getByRole('textbox', { name: '新标题', exact: true }).fill('新篇')
  await dialog.getByRole('combobox', { name: /^插入位置/ }).selectOption('end')
  await expect(dialog.getByRole('region', { name: '新建预览' })).toContainText('第4章 新篇')
  await page.screenshot({ path: join(root, 'chapter-create-preview.png') })
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.getByRole('button', { name: '整理', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '整理章节', exact: true })
  await dialog.getByRole('button', { name: '编号与命名', exact: true }).click()
  await dialog.getByRole('combobox', { name: /^操作/ }).selectOption('format')
  await dialog.getByRole('textbox', { name: '编号后缀', exact: true }).fill('回')
  await dialog.getByRole('spinbutton', { name: '补零位数', exact: true }).fill('2')
  await expect(dialog.getByRole('table', { name: '章节命名预览' })).toContainText('第10回 十')
  await dialog.getByRole('button', { name: '应用 5 个标题', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const before = ['序章', '第10回 十', '第01回 一', '第02回 二', '第03回 新篇', '第04回 新篇']
  const sorted = ['序章', '第01回 一', '第02回 二', '第03回 新篇', '第04回 新篇', '第10回 十']
  await expect.poll(activeTitles).toEqual(before)
  await page.getByRole('button', { name: '整理', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '整理章节', exact: true })
  await expect(
    dialog
      .getByRole('table', { name: '章节顺序预览' })
      .locator('tbody tr')
      .nth(1)
      .locator('td')
      .last()
  ).toHaveText('第01回 一')
  await expect.poll(activeTitles).toEqual(before)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect.poll(activeTitles).toEqual(before)
  await page.getByRole('button', { name: '整理', exact: true }).click()
  await page.getByRole('button', { name: '应用顺序', exact: true }).click()
  await expect.poll(activeTitles).toEqual(sorted)
  await page.getByRole('button', { name: '撤销排序', exact: true }).click()
  await expect.poll(activeTitles).toEqual(before)
  await page.getByRole('button', { name: '整理', exact: true }).click()
  await page.getByRole('button', { name: '应用顺序', exact: true }).click()
  await expect.poll(activeTitles).toEqual(sorted)

  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: /作品与备份/ }).click()
  await page.getByRole('button', { name: '导出全部正文', exact: true }).click()
  await expect
    .poll(async () => fs.readFile(join(root, 'export.txt'), 'utf8').catch(() => ''))
    .toContain('序章正文原样保留')
  const exported = await fs.readFile(join(root, 'export.txt'), 'utf8')
  const positions = sorted.map((title) => exported.indexOf(title))
  expect(
    positions.every(
      (position, index) => position >= 0 && (!index || position > positions[index - 1])
    )
  ).toBe(true)
})

test('workspace copies stay independent, multi-select moves and recycles, quick search locates text and returns', async () => {
  await newDocument('甲章')
  await enterText('第一行\n第二行\n暗号在第三行')
  const first = (await docs()).find((item) => item.title === '甲章')!
  await newDocument('乙章')
  await enterText('乙章独立正文')
  const second = (await docs()).find((item) => item.title === '乙章')!
  await newDocument('丙章')
  await enterText('丙章独立正文')
  const third = (await docs()).find((item) => item.title === '丙章')!
  await page.getByRole('button', { name: '复制', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue(
    '丙章（副本）'
  )
  const copy = (await docs()).find((item) => item.title === '丙章（副本）')!
  expect(copy.id).not.toBe(third.id)
  expect((await disk(copy.id)).content).toBe('丙章独立正文')
  await enterText('副本已经独立修改')
  expect((await disk(third.id)).content).toBe('丙章独立正文')
  await page.getByRole('checkbox', { name: '选择 乙章', exact: true }).check()
  await page.getByRole('checkbox', { name: '选择 丙章（副本）', exact: true }).check()
  await page.getByRole('button', { name: '移到…', exact: true }).click()
  await page.getByRole('spinbutton', { name: '目标位置', exact: true }).fill('1')
  await page.getByRole('button', { name: '移动', exact: true }).click()
  await expect.poll(activeTitles).toEqual(['乙章', '丙章（副本）', '甲章', '丙章'])

  await pressNavigationShortcut('Control+p')
  let quick = page.getByRole('dialog', { name: '快速打开与全文搜索' })
  await quick.getByRole('textbox', { name: '快速搜索' }).fill('甲章')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('甲章')
  await page.getByRole('button', { name: '下一章', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('丙章')
  await expect(page.getByRole('button', { name: '快速打开', exact: true })).toBeEnabled()
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('丙章')
  await pressNavigationShortcut('Control+p')
  quick = page.getByRole('dialog', { name: '快速打开与全文搜索' })
  await quick.getByRole('button', { name: '全书全文', exact: true }).click()
  await quick.getByRole('textbox', { name: '快速搜索' }).fill('暗号')
  await expect(quick.locator('.quick-result')).toHaveCount(1)
  await expect(quick.locator('.quick-result')).toContainText('第 3 行')
  await quick.locator('.quick-result').click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('甲章')
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe('暗号在第三行')
  await pressNavigationShortcut('Alt+ArrowLeft')
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('丙章')
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('丙章')
  await expect(page.locator('.cm-content')).toBeFocused()

  await pressNavigationShortcut('Control+Alt+ArrowUp')
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('甲章')
  await pressNavigationShortcut('Control+Alt+ArrowDown')
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('丙章')
  await expect(page.locator('.cm-content')).toBeFocused()

  await page.getByRole('button', { name: '回收 2 项', exact: true }).click()
  await page
    .getByRole('dialog', { name: '批量回收确认' })
    .getByRole('button', { name: '取消', exact: true })
    .click()
  expect((await disk(second.id)).trashedAt).toBeNull()
  await page.getByRole('button', { name: '回收 2 项', exact: true }).click()
  await page.getByRole('button', { name: '确认回收所选文档', exact: true }).click()
  await expect.poll(activeTitles).toEqual(['甲章', '丙章'])
  expect((await disk(second.id)).trashedAt).toBeTruthy()
  expect((await disk(copy.id)).content).toBe('副本已经独立修改')
  expect((await disk(first.id)).content).toBe('第一行\n第二行\n暗号在第三行')
})

test('workspace history restore retains replaced content, trash is protected, theme and chapter target survive restart', async () => {
  await newDocument('历史章')
  await enterText('最初正文')
  await enterText('最新正文保留证据')
  await expect(page.locator('main footer')).toContainText('全书 8 字')
  const item = (await docs()).find((entry) => entry.title === '历史章')!
  await page.getByRole('button', { name: '历史版本', exact: true }).click()
  let history = page.getByRole('dialog', { name: '文档历史版本', exact: true })
  const buttons = history.locator('.history-list button')
  await expect(buttons).not.toHaveCount(0)
  let oldIndex = -1
  for (let index = 0; index < (await buttons.count()); index++) {
    await buttons.nth(index).click()
    await expect(buttons.nth(index)).toBeEnabled()
    if (
      (await history.getByRole('textbox', { name: '历史版本正文', exact: true }).inputValue()) ===
      '最初正文'
    ) {
      oldIndex = index
      break
    }
  }
  expect(oldIndex).toBeGreaterThanOrEqual(0)
  await expect(history.getByRole('textbox', { name: '当前版本正文', exact: true })).toHaveValue(
    '最新正文保留证据'
  )
  await history.getByRole('button', { name: '恢复所选版本', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.cm-content')).toHaveText('最初正文')
  await expect(page.locator('main footer')).toContainText('全书 4 字')
  expect((await disk(item.id)).content).toBe('最初正文')
  await page.getByRole('button', { name: '历史版本', exact: true }).click()
  history = page.getByRole('dialog', { name: '文档历史版本', exact: true })
  await expect(history.locator('.history-list button')).not.toHaveCount(0)
  let newestFound = false
  for (let index = 0; index < (await history.locator('.history-list button').count()); index++) {
    await history.locator('.history-list button').nth(index).click()
    await expect(history.locator('.history-list button').nth(index)).toBeEnabled()
    if (
      (await history.getByRole('textbox', { name: '历史版本正文', exact: true }).inputValue()) ===
      '最新正文保留证据'
    ) {
      newestFound = true
      break
    }
  }
  expect(newestFound).toBe(true)
  await history.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('spinbutton', { name: '章节目标字数', exact: true }).fill('12')
  await page.getByRole('spinbutton', { name: '章节目标字数', exact: true }).press('Tab')
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-label', '章节目标进度 33%')
  await page.screenshot({ path: join(root, 'workspace-target-light.png') })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('combobox', { name: '写作主题', exact: true }).selectOption('dark')
  await page.getByRole('button', { name: '保存显示设置', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await electron.close()
  await launch()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('spinbutton', { name: '章节目标字数', exact: true })).toHaveValue(
    '12'
  )
  await expect(page.locator('.cm-content')).toHaveText('最初正文')
  await expect(page.locator('main footer')).toContainText('全书 4 字')
  await page.screenshot({ path: join(root, 'workspace-target-dark.png') })
  await page.getByRole('button', { name: '移入回收站', exact: true }).click()
  await page.getByRole('button', { name: '确认回收', exact: true }).click()
  await page.getByRole('button', { name: /^回收站/ }).click()
  await openChapter('历史章')
  await page.getByRole('button', { name: '历史版本', exact: true }).click()
  history = page.getByRole('dialog', { name: '文档历史版本', exact: true })
  await expect(history.locator('.history-list button')).not.toHaveCount(0)
  await expect(history.locator('.history-list button').first()).toBeEnabled()
  await expect(page.getByRole('button', { name: '恢复所选版本', exact: true })).toBeDisabled()
  expect((await disk(item.id)).content).toBe('最初正文')
})

test('workspace TXT import previews exact source, cancels without writes and imports only checked chapters', async () => {
  await newDocument('原有章')
  await enterText('原有正文')
  const original = (await docs()).find((item) => item.title === '原有章')!
  const filename = join(root, '来源测试.txt')
  const source = '第1章 雨夜\r\n  缩进原文\r\n\r\n第2章 重逢\r\n第二篇正文\r\n'
  await fs.writeFile(filename, source, 'utf8')
  await electron.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, filename)
  await page.getByRole('button', { name: '导入', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '导入文字资料', exact: true })
  await expect(dialog.locator('.source-actions button')).toHaveCount(1)
  expect(await page.evaluate(() => Object.keys(window.loom.imports))).toEqual(['chooseFile'])
  await dialog.getByRole('button', { name: '选择 TXT / Markdown', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: '导入文档标题', exact: true })).toHaveValue(
    '第1章 雨夜'
  )
  await expect(dialog.getByRole('textbox', { name: '导入正文预览', exact: true })).toHaveValue(
    '  缩进原文\n\n'
  )
  await expect.poll(activeTitles).toEqual(['原有章'])
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect.poll(activeTitles).toEqual(['原有章'])
  await page.getByRole('button', { name: '导入', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '导入文字资料', exact: true })
  await dialog.getByRole('button', { name: '选择 TXT / Markdown', exact: true }).click()
  await dialog.getByRole('checkbox', { name: '导入 第2章 重逢', exact: true }).uncheck()
  await dialog.getByRole('button', { name: '导入 1 篇', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(activeTitles).toEqual(['原有章', '第1章 雨夜'])
  const imported = (await docs()).find((item) => item.title === '第1章 雨夜')!
  expect((await disk(imported.id)).content).toBe('  缩进原文\r\n\r\n')
  expect((await disk(original.id)).content).toBe('原有正文')
  expect(await fs.readFile(filename, 'utf8')).toBe(source)
})

test('workspace dialogs contain keyboard focus, native Enter closes quick open and cross-kind jumps clear selection', async () => {
  await newDocument('甲章')
  await newDocument('乙章')
  await page.getByRole('button', { name: /^人物/ }).click()
  await newDocument('林舟')
  await page.getByRole('button', { name: /^正文/ }).click()
  await openChapter('乙章')
  await page.getByRole('checkbox', { name: '选择 甲章', exact: true }).check()
  await page.getByRole('checkbox', { name: '选择 乙章', exact: true }).check()
  await expect(page.getByRole('button', { name: '回收 2 项', exact: true })).toBeVisible()

  await page.getByRole('button', { name: '历史版本', exact: true }).click()
  const focusIsInsideDialog = () =>
    page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]')
      return Boolean(dialog?.contains(document.activeElement))
    })
  await expect.poll(focusIsInsideDialog).toBe(true)
  await page
    .getByRole('textbox', { name: '文档标题', exact: true })
    .evaluate((element) => element.focus())
  await page.keyboard.press('Tab')
  await expect.poll(focusIsInsideDialog).toBe(true)
  await expect(
    page
      .getByRole('dialog', { name: '文档历史版本', exact: true })
      .getByRole('button', { name: '关闭', exact: true })
  ).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await pressNavigationShortcut('Control+p')
  let quick = page.getByRole('dialog', { name: '快速打开与全文搜索', exact: true })
  await expect.poll(focusIsInsideDialog).toBe(true)
  await expect(quick.locator('.quick-result').first()).toContainText('甲章')
  await quick.getByRole('button', { name: '关闭', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('乙章')

  await pressNavigationShortcut('Control+p')
  quick = page.getByRole('dialog', { name: '快速打开与全文搜索', exact: true })
  await quick.getByRole('textbox', { name: '快速搜索', exact: true }).fill('林舟')
  await expect(quick.locator('.quick-result')).toHaveCount(1)
  await quick.locator('.quick-result').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('林舟')
  await expect(page.getByRole('button', { name: /^回收 \d+ 项$/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '取消选择', exact: true })).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: '选择 林舟', exact: true })).not.toBeChecked()
  expect((await docs()).filter((item) => item.trashedAt)).toHaveLength(0)
})
