import { revealMenu } from './menus'
import { test, expect, _electron, type ElectronApplication } from '@playwright/test'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'

test('ZestLoomer branding, narrow layout and legacy library settings survive a restart', async () => {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const fixture = await fs.mkdtemp(resolve('.test-artifacts/rename-desktop-'))
  const library = join(fixture, 'BookList')
  const profile = join(fixture, 'profile')
  await fs.mkdir(library)
  let electron: ElectronApplication | undefined
  const errors: string[] = []
  const launch = async (legacy = false) => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && !/^(LOOM_|ZESTLOOMER_|ELECTRON_)/.test(entry[0])
      )
    )
    const prefix = legacy ? 'LOOM' : 'ZESTLOOMER'
    env[`${prefix}_BOOKLIST`] = library
    env[`${prefix}_USER_DATA`] = profile
    env[`${prefix}_TEST_HIDDEN`] = '1'
    electron = await _electron.launch({ args: ['.'], cwd: resolve('.'), env })
    const page = await electron.firstWindow()
    page.on('pageerror', (error) => errors.push(error.message))
    await revealMenu(page, '作品菜单')
    await expect(page.getByRole('button', { name: '新建作品', exact: true })).toBeEnabled()
    await expect(page).toHaveTitle('ZestLoomer')
    await expect(page.getByRole('img', { name: 'ZestLoomer', exact: true })).toBeVisible()
    return page
  }
  try {
    let page = await launch()
    expect(await electron!.evaluate(({ app }) => app.getName())).toBe('ZestLoomer')
    const state = await page.evaluate(async () => {
      const api = window.zestloomer
      const book = await api.createBook('旧书库兼容验收')
      if (!book.ok || !book.value) throw new Error('Create book failed')
      const created = await api.create(book.value.id, 'chapters', '第一章', 'blank')
      if (!created.ok) throw new Error(created.message)
      const doc = created.value.document
      const saved = await api.save({
        bookId: book.value.id,
        id: doc.id,
        title: doc.title,
        expectedVersion: doc.version,
        content: 'Loom 是原书稿的一部分。\n保留原文与稳定 ID。'
      })
      if (!saved.ok) throw new Error(saved.message)
      const config = await api.agent.configure({
        id: 'new',
        label: '旧接入配置',
        baseUrl: 'http://127.0.0.1:9123/v1',
        model: 'synthetic-model',
        apiKey: 'synthetic-rename-key',
        makeDefault: true
      })
      if (!config.ok) throw new Error(config.message)
      const heavy = await api.agent.heavySettings()
      if (!heavy.ok) throw new Error(heavy.message)
      const settings = await api.agent.saveHeavySettings({
        ...heavy.value.settings,
        appendPrompt: true,
        prompt: '旧书库的自定义指令'
      })
      if (!settings.ok) throw new Error(settings.message)
      const bound = await api.agent.bind(book.value.id)
      if (!bound.ok) throw new Error(bound.message)
      const conversation = await api.agent.create(book.value.id, '保留历史会话')
      if (!conversation.ok) throw new Error(conversation.message)
      return { book: book.value, document: saved.value, conversation: conversation.value }
    })
    expect(state.book.root).toContain('ZestLoomer-')
    await page.reload()
    await expect(page.locator('.cm-content')).toContainText('Loom 是原书稿的一部分。')
    await page.screenshot({ path: join(fixture, 'ZestLoomer-desktop.png') })
    await electron!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(900, 700)
    )
    await expect.poll(async () => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(900)
    const fits = await page
      .getByRole('img', { name: 'ZestLoomer', exact: true })
      .evaluate((node) => {
        const logo = node.getBoundingClientRect()
        const header = node.closest('.workspace-header')!.getBoundingClientRect()
        return (
          logo.left >= header.left &&
          logo.right <= header.right &&
          document.documentElement.scrollWidth <= window.innerWidth
        )
      })
    expect(fits).toBe(true)
    await page.screenshot({ path: join(fixture, 'ZestLoomer-narrow.png') })
    await electron!.close()
    electron = undefined

    // Reproduce an existing Loom layout without touching any real user library.
    const oldConfig = join(library, '.loom')
    await fs.rename(join(library, '.zestloomer'), oldConfig)
    await fs.rename(state.book.root, join(library, 'Loom-legacy-book'))
    const encryptedBefore = await fs.readFile(join(oldConfig, 'agent.json'), 'utf8')
    page = await launch(true)
    await expect(page.locator('.cm-content')).toContainText('Loom 是原书稿的一部分。')
    const restored = await page.evaluate(async ({ book, document }) => {
      const api = window.zestloomer
      return {
        bootstrap: await api.bootstrap(),
        read: await api.read(book.id, document.id),
        heavy: await api.agent.heavySettings(),
        config: await api.agent.config(),
        conversations: await api.agent.bind(book.id)
      }
    }, state)
    expect(restored.bootstrap.ok && restored.bootstrap.value.errors).toEqual([])
    expect(restored.read.ok && restored.read.value.document.content).toBe(state.document.content)
    expect(restored.heavy.ok && restored.heavy.value.settings.prompt).toBe('旧书库的自定义指令')
    expect(restored.config.ok && restored.config.value.hasKey).toBe(true)
    expect(
      restored.conversations.ok &&
        restored.conversations.value.conversations.some((item) => item.id === state.conversation.id)
    ).toBe(true)
    expect(await fs.readFile(join(oldConfig, 'agent.json'), 'utf8')).toBe(encryptedBefore)
    const encryptedKey = JSON.parse(encryptedBefore).profiles[0].encryptedKey
    expect(
      await electron!.evaluate(
        ({ safeStorage }, key) => safeStorage.decryptString(Buffer.from(key, 'base64')),
        encryptedKey
      )
    ).toBe('synthetic-rename-key')
    await expect(fs.access(join(library, '.zestloomer'))).rejects.toThrow()
    expect(errors).toEqual([])
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
})
