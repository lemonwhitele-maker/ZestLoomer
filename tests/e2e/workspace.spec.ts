import { revealMenu } from './menus'
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { DocumentMeta, DocumentSnapshot } from '../../src/shared/documents'

let electron: ElectronApplication
let page: Page
let root: string
let profile: string
const consoleErrors: string[] = []

test('LOOM-029 heavy settings and conversation snapshots persist', async () => {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: /超重agent/ }).click()
  await expect(page.getByLabel('追加 prompt', { exact: true })).not.toBeChecked()
  await expect(page.getByRole('button', { name: '选择保存位置' })).toHaveCount(0)
  await expect(page.getByText('配置保存在当前 BookList：', { exact: false })).toContainText(root)
  await page.getByLabel('追加 prompt', { exact: true }).check()
  await page.getByLabel('追加指令', { exact: true }).fill('冻结偏好 A')
  await page.getByLabel('追加本章大纲全文').check()
  await page.getByRole('button', { name: '保存超重agent 设置' }).click()
  await expect(page.locator('.settings-footer')).toContainText('已保存，仅影响后续新建对话')
  const create = () =>
    page.evaluate(async () => {
      const boot = await window.zestloomer.bootstrap()
      if (!boot.ok) throw new Error(boot.message)
      const bookId = boot.value.preferences.lastBookId!
      const bound = await window.zestloomer.agent.bind(bookId)
      if (!bound.ok) throw new Error(bound.message)
      const c = await window.zestloomer.agent.create(bookId, '快照测试')
      if (!c.ok) throw new Error(c.message)
      return c.value
    })
  const a = await create()
  await page.getByLabel('追加指令', { exact: true }).fill('未保存内容')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(page.getByLabel('追加指令', { exact: true })).toHaveValue('未保存内容')
  await page.getByLabel('追加指令', { exact: true }).fill('冻结偏好 B')
  await page.getByRole('button', { name: '保存超重agent 设置' }).click()
  await expect(page.locator('.settings-footer')).toContainText('已保存，仅影响后续新建对话')
  const b = await create()
  expect(a.heavySettings?.prompt).toBe('冻结偏好 A')
  expect(b.heavySettings?.prompt).toBe('冻结偏好 B')
  await page.screenshot({ path: join(root, 'heavy-settings.png') })
  await electron.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.destroy()
  })
  await electron.close()
  await launch()
  const restored = await page.evaluate(
    async ({ bookId }) => window.zestloomer.agent.bind(bookId),
    a
  )
  expect(restored.ok).toBe(true)
  if (restored.ok) {
    expect(restored.value.conversations.find((c) => c.id === a.id)?.heavySettings?.prompt).toBe(
      '冻结偏好 A'
    )
    expect(restored.value.conversations.find((c) => c.id === b.id)?.heavySettings?.prompt).toBe(
      '冻结偏好 B'
    )
  }
})

async function launch(): Promise<void> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  env.ZESTLOOMER_USER_DATA = profile
  env.ZESTLOOMER_BOOKLIST = root
  env.ZESTLOOMER_TEST_HIDDEN = '1'
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  electron = await _electron.launch({ args: ['.'], cwd: resolve('.'), env })
  page = await electron.firstWindow()
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  await electron.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: folder + '/export.txt' })
  }, root)
  await revealMenu(page, '作品菜单')
  await expect(page.getByRole('button', { name: '新建作品', exact: true })).toBeEnabled()
}

test.beforeEach(async () => {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  root = await fs.mkdtemp(resolve('.test-artifacts/workspace-window-'))
  profile = join(root, 'profile')
  if (process.env.ZESTLOOMER_STORY_MODEL_CONFIG) {
    await fs.mkdir(join(root, '.zestloomer'), { recursive: true })
    await fs.copyFile(
      process.env.ZESTLOOMER_STORY_MODEL_CONFIG,
      join(root, '.zestloomer', 'agent.json')
    )
    if (process.env.ZESTLOOMER_STORY_MODEL_PROFILE) {
      const isolatedPath = join(root, '.zestloomer', 'agent.json')
      const config = JSON.parse(await fs.readFile(isolatedPath, 'utf8'))
      const selected = config.profiles.find(
        (item: { id: string }) => item.id === process.env.ZESTLOOMER_STORY_MODEL_PROFILE
      )
      if (!selected || !/gemini/i.test(selected.model))
        throw new Error('Selected test profile must be Gemini')
      await fs.writeFile(
        isolatedPath,
        JSON.stringify({ ...config, profiles: [selected], defaultProfileId: selected.id })
      )
    }
    if (process.env.ZESTLOOMER_STORY_LOCAL_STATE) {
      const original = JSON.parse(
        await fs.readFile(process.env.ZESTLOOMER_STORY_LOCAL_STATE, 'utf8')
      )
      await fs.mkdir(profile, { recursive: true })
      await fs.writeFile(
        join(profile, 'Local State'),
        JSON.stringify({ os_crypt: original.os_crypt })
      )
    }
  }
  consoleErrors.length = 0
  await launch()
  await revealMenu(page, '作品菜单')
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
    const boot = await window.zestloomer.bootstrap()
    if (!boot.ok) throw new Error(boot.message)
    const result = await window.zestloomer.list(boot.value.preferences.lastBookId!)
    if (!result.ok) throw new Error(result.message)
    return result.value
  })
}
async function disk(id: string): Promise<DocumentSnapshot> {
  return page.evaluate(async (docId) => {
    const boot = await window.zestloomer.bootstrap()
    if (!boot.ok) throw new Error(boot.message)
    const result = await window.zestloomer.read(boot.value.preferences.lastBookId!, docId)
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

test('book name can be edited and survives restart', async () => {
  await revealMenu(page, '作品菜单')
  await page.getByRole('button', { name: '修改作品名称', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '新标题' })).toHaveValue('新能力验收作品')
  await page.getByRole('textbox', { name: '新标题' }).fill('修改后的作品名')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await revealMenu(page, '作品菜单')
  await expect(page.getByLabel('当前作品').locator('option:checked')).toHaveText('修改后的作品名')
  await electron.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
  })
  await electron.close()
  await launch()
  await revealMenu(page, '作品菜单')
  await expect(page.getByLabel('当前作品').locator('option:checked')).toHaveText('修改后的作品名')
})

test('story links navigate both ways and foreshadow rows save independently', async () => {
  await page.getByRole('button', { name: /^大纲/ }).click()
  await newDocument('章一大纲')
  const outline = (await docs()).find((doc) => doc.kind === 'outlines')!
  // Create a chapter through the same desktop IPC, avoiding unrelated naming dialog steps.
  await page.evaluate(async () => {
    const boot = await window.zestloomer.bootstrap()
    if (!boot.ok) throw new Error(boot.message)
    const created = await window.zestloomer.create(
      boot.value.preferences.lastBookId!,
      'chapters',
      '章一'
    )
    if (!created.ok) throw new Error(created.message)
  })
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByRole('button', { name: /^正文/ }).click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('章一')
  const chapter = (await docs()).find((doc) => doc.kind === 'chapters')!
  await revealMenu(page, '管理关联')
  await page.getByRole('combobox', { name: '选择关联文档' }).selectOption(outline.id)
  await revealMenu(page, '管理关联')
  await expect(page.getByRole('combobox', { name: '选择关联文档' })).toBeEnabled()
  await expect(page.getByRole('button', { name: '保存关联', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '刷新关系', exact: true })).toHaveCount(0)
  await fs.writeFile(
    resolve('.test-artifacts/story-binding-ui.txt'),
    await page.locator('.story-tools').innerText()
  )
  await revealMenu(page, '管理关联')
  await page.getByRole('button', { name: /^章一大纲.*↗$/ }).click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('章一大纲')
  await revealMenu(page, '管理关联')
  await page.getByRole('button', { name: /^章一\s*↗$/ }).click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('章一')
  await page.getByRole('button', { name: /^伏笔/ }).click()
  await page.getByRole('button', { name: '新建伏笔', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '编辑伏笔内容', exact: true }).click()
  await page.getByRole('textbox', { name: '伏笔内容', exact: true }).fill('遇热显现纹路')
  await page.getByRole('button', { name: '编辑开始章节', exact: true }).click()
  await page.getByRole('combobox', { name: '开始章节', exact: true }).selectOption(chapter.id)
  await page.getByRole('button', { name: '保存此行', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存此行', exact: true })).toHaveCount(0)
  const foreshadow = (await docs()).find((doc) => doc.kind === 'foreshadows')!
  expect(JSON.parse((await disk(foreshadow.id)).content)).toEqual({
    content: '遇热显现纹路',
    startChapterId: chapter.id,
    endChapterId: null
  })
  await revealMenu(page, '管理关联')
  await page.getByRole('button', { name: /^章一\s*↗$/ }).click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('章一')
  await page.getByRole('button', { name: /^伏笔/ }).click()
  await expect(page.getByRole('button', { name: '编辑伏笔内容', exact: true })).toHaveText(
    '遇热显现纹路'
  )
  await page.getByRole('button', { name: '新建伏笔', exact: true }).click()
  const rows = page.locator('.story-tools tbody tr')
  await expect(rows).toHaveCount(2)
  await rows.nth(1).getByRole('button', { name: '编辑伏笔内容', exact: true }).click()
  await rows.nth(1).getByRole('textbox', { name: '伏笔内容', exact: true }).fill('第二条独立伏笔')
  await rows.nth(0).getByRole('button', { name: '编辑伏笔内容', exact: true }).click()
  await rows.nth(0).getByRole('textbox', { name: '伏笔内容', exact: true }).fill('临时修改')
  await rows.nth(0).getByRole('button', { name: '取消修改', exact: true }).click()
  await expect(rows.nth(0)).toContainText('遇热显现纹路')
  await rows.nth(1).getByRole('button', { name: '保存此行', exact: true }).click()
  await expect(rows.nth(1).getByRole('button', { name: '保存此行', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '刷新表格', exact: true }).click()
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(1)).toContainText('第二条独立伏笔')
  await rows.nth(0).getByRole('button', { name: '原文／历史', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回伏笔表格', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveCount(0)
  await expect(rows).toHaveCount(2)
  await page.screenshot({ path: resolve('.test-artifacts/story-links-desktop.png') })
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  await page.screenshot({ path: resolve('.test-artifacts/foreshadows-dark.png') })
})

test('chapter numbers automatically bind and the match button fills existing unbound pairs', async () => {
  await page.getByRole('button', { name: /^大纲/ }).click()
  await newDocument('第012章大纲')
  await page.evaluate(async () => {
    const boot = await window.zestloomer.bootstrap()
    if (!boot.ok) throw new Error(boot.message)
    const result = await window.zestloomer.create(
      boot.value.preferences.lastBookId!,
      'chapters',
      '第十二章 铜钥匙'
    )
    if (!result.ok) throw new Error(result.message)
  })
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await page.getByRole('button', { name: /^正文/ }).click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue(
    '第十二章 铜钥匙'
  )
  await revealMenu(page, '管理关联')
  const link = page.getByRole('button', { name: /^第012章大纲.*↗$/ })
  await expect(link).toBeVisible()
  await revealMenu(page, '管理关联')
  await page.getByRole('combobox', { name: '选择关联文档' }).selectOption('')
  await expect(link).toHaveCount(0)
  await revealMenu(page, '管理关联')
  await page.getByRole('button', { name: '自动匹配', exact: true }).click()
  await expect(link).toBeVisible()
  await expect(page.locator('.story-tools')).toContainText('已新增 1 组绑定')
  await link.click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue(
    '第012章大纲'
  )
  await revealMenu(page, '管理关联')
  await expect(page.getByRole('button', { name: /^第十二章 铜钥匙.*↗$/ })).toBeVisible()
  await page.screenshot({ path: resolve('.test-artifacts/chapter-auto-binding.png') })
})

test('real model searches reads proposes one foreshadow field and rereads after acceptance', async () => {
  test.skip(
    !process.env.ZESTLOOMER_STORY_MODEL_CONFIG,
    'Requires an explicitly selected local model configuration'
  )
  test.setTimeout(240000)
  const state = await page.evaluate(async () => {
    const api = window.zestloomer
    const boot = await api.bootstrap()
    if (!boot.ok) throw new Error(boot.message)
    const bookId = boot.value.preferences.lastBookId!
    const chapter = await api.create(bookId, 'chapters', '合成第一章')
    const record = await api.create(bookId, 'foreshadows', '合成铜钥匙伏笔')
    if (!chapter.ok || !record.ok) throw new Error('fixture creation failed')
    const saved = await api.save({
      bookId,
      id: record.value.document.id,
      title: '合成铜钥匙伏笔',
      expectedVersion: record.value.document.version,
      content: JSON.stringify(
        {
          content: '铜钥匙遇热浮现旧纹路。',
          startChapterId: chapter.value.document.id,
          endChapterId: null
        },
        null,
        2
      )
    })
    if (!saved.ok) throw new Error(saved.message)
    const bound = await api.agent.bind(bookId)
    if (!bound.ok) throw new Error(bound.message)
    const conversation = await api.agent.create(bookId, '映射伏笔真实模型验收（合成数据）')
    if (!conversation.ok) throw new Error(conversation.message)
    const started = await api.agent.start(
      bookId,
      conversation.value.id,
      '这是一部合成测试作品。请先用 read({path:"book/",query:"铜钥匙"}) 混合搜索，随后 read 命中的伏笔文档完整原文；只将该伏笔 content 字段里的“旧纹路”改成“新纹路”，其他两个字段原样保留。使用 edit 提出一条待审提案，不创建其他文档。',
      {}
    )
    if (!started.ok) throw new Error(started.message)
    return {
      bookId,
      conversationId: conversation.value.id,
      documentId: saved.value.id,
      chapterId: chapter.value.document.id
    }
  })
  const snapshot = async () =>
    page.evaluate(async (bookId) => {
      const result = await window.zestloomer.agent.snapshot(bookId)
      if (!result.ok) throw new Error(result.message)
      return result.value
    }, state.bookId)
  await expect
    .poll(async () => Boolean((await snapshot()).active), { timeout: 180000, intervals: [1000] })
    .toBe(false)
  const proposals = (await snapshot()).proposals.filter(
    (proposal) => proposal.conversationId === state.conversationId
  )
  await page.evaluate(async ({ bookId, conversationId }) => {
    const exported = await window.zestloomer.agent.exportLog(bookId, conversationId)
    if (!exported.ok) throw new Error(exported.message)
  }, state)
  const initialLog = JSON.parse(await fs.readFile(join(root, 'export.txt'), 'utf8'))
  await fs.writeFile(
    resolve('.test-artifacts/story-real-model.json'),
    JSON.stringify({ state, proposals, log: initialLog }, null, 2)
  )
  expect(proposals).toHaveLength(1)
  expect(proposals[0].operation).toBe('edit')
  expect(JSON.parse(proposals[0].content)).toEqual({
    content: '铜钥匙遇热浮现新纹路。',
    startChapterId: state.chapterId,
    endChapterId: null
  })
  const final = await page.evaluate(
    async ({ state, proposal }) => {
      const accepted = await window.zestloomer.agent.action(
        state.bookId,
        proposal.id,
        'apply',
        proposal.candidateHash
      )
      if (!accepted.ok) throw new Error(accepted.message)
      const reread = await window.zestloomer.read(state.bookId, state.documentId)
      if (!reread.ok) throw new Error(reread.message)
      const exported = await window.zestloomer.agent.exportLog(state.bookId, state.conversationId)
      if (!exported.ok) throw new Error(exported.message)
      return { document: reread.value.document, export: exported.value }
    },
    { state, proposal: proposals[0] }
  )
  expect(final.document.content).toBe(proposals[0].content)
  const log = JSON.parse(await fs.readFile(join(root, 'export.txt'), 'utf8'))
  await fs.writeFile(
    resolve('.test-artifacts/story-real-model.json'),
    JSON.stringify({ state, final, log }, null, 2)
  )
  expect(log.log.state).toBe('completed')
  if (process.env.ZESTLOOMER_STORY_MODEL_PROFILE) expect(log.log.model).toMatch(/gemini/i)
  expect(log.log.tools.map((tool: { call: { name: string } }) => tool.call.name)).toEqual([
    'read',
    'read',
    'edit'
  ])
  expect(JSON.parse(log.log.tools[0].call.arguments)).toMatchObject({
    path: 'book/',
    query: '铜钥匙'
  })
  expect(log.log.tools[1].result.complete).toBe(true)
})
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
  await revealMenu(page, '作品菜单')
  await expect(page.getByRole('button', { name: '快速打开', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '作品菜单', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false'
  )
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

  await revealMenu(page, '目录更多')
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
  await revealMenu(page, '目录更多')
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
  await revealMenu(page, '目录更多')
  await page.getByRole('button', { name: '整理', exact: true }).click()
  await page.getByRole('button', { name: '应用顺序', exact: true }).click()
  await expect.poll(activeTitles).toEqual(sorted)
  await revealMenu(page, '目录更多')
  await page.getByRole('button', { name: '撤销排序', exact: true }).click()
  await expect.poll(activeTitles).toEqual(before)
  await revealMenu(page, '目录更多')
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
  await revealMenu(page, '文档更多')
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
  await revealMenu(page, '目录更多')
  await page.getByRole('button', { name: '移到…', exact: true }).click()
  await page.getByRole('spinbutton', { name: '目标位置', exact: true }).fill('1')
  await page.getByRole('button', { name: '移动', exact: true }).click()
  await expect.poll(activeTitles).toEqual(['乙章', '丙章（副本）', '甲章', '丙章'])

  await pressNavigationShortcut('Control+p')
  let quick = page.getByRole('dialog', { name: '快速打开与全文搜索' })
  await quick.getByRole('textbox', { name: '快速搜索' }).fill('甲章')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('甲章')
  await revealMenu(page, '章节与目标')
  await page.getByRole('button', { name: '下一章', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('丙章')
  await revealMenu(page, '作品菜单')
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
  await revealMenu(page, '文档更多')
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
  await revealMenu(page, '文档更多')
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
  await revealMenu(page, '章节与目标')
  await page.getByRole('spinbutton', { name: '章节目标字数', exact: true }).fill('12')
  await revealMenu(page, '章节与目标')
  await page.getByRole('spinbutton', { name: '章节目标字数', exact: true }).press('Tab')
  await revealMenu(page, '章节与目标')
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
  await revealMenu(page, '章节与目标')
  await expect(page.getByRole('spinbutton', { name: '章节目标字数', exact: true })).toHaveValue(
    '12'
  )
  await expect(page.locator('.cm-content')).toHaveText('最初正文')
  await expect(page.locator('main footer')).toContainText('全书 4 字')
  await page.screenshot({ path: join(root, 'workspace-target-dark.png') })
  await revealMenu(page, '文档更多')
  await page.getByRole('button', { name: '移入回收站', exact: true }).click()
  await page.getByRole('button', { name: '确认回收', exact: true }).click()
  await page.getByRole('button', { name: /^回收站/ }).click()
  await openChapter('历史章')
  await revealMenu(page, '文档更多')
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
  await revealMenu(page, '作品菜单')
  await page.getByRole('button', { name: '导入', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '导入文字资料', exact: true })
  await expect(dialog.locator('.source-actions button')).toHaveCount(1)
  expect(await page.evaluate(() => Object.keys(window.zestloomer.imports))).toEqual(['chooseFile'])
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
  await revealMenu(page, '作品菜单')
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

  await revealMenu(page, '文档更多')
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
