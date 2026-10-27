import { revealMenu } from './menus'
import { test, expect, _electron } from '@playwright/test'
import fs from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'

test('P0 drawers, focus restoration, lazy failure recovery and scoped sessions', async () => {
  const root = await fs.mkdtemp(resolve('.test-artifacts/p0-ui-'))
  const server = await createServer({
    configFile: false,
    root: resolve('src/renderer'),
    plugins: [vue()],
    server: { host: '127.0.0.1', port: 0 }
  })
  await server.listen()
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    ),
    ZESTLOOMER_USER_DATA: join(root, 'profile'),
    ZESTLOOMER_BOOKLIST: join(root, 'books'),
    ZESTLOOMER_TEST_HIDDEN: '1',
    ZESTLOOMER_PERF: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  env.ELECTRON_RENDERER_URL = server.resolvedUrls!.local[0]
  const app = await _electron.launch({ args: ['.'], cwd: resolve('.'), env })
  const page = await app.firstWindow()
  try {
    await fs.mkdir(resolve('.test-artifacts/release-e2e-final/p0'), { recursive: true })
    await revealMenu(page, '作品菜单')
    await expect(page.getByRole('button', { name: '新建作品', exact: true })).toBeEnabled()
    await page.evaluate(async () => {
      const api = window.zestloomer
      for (let i = 0; i < 3; i++) {
        const book = await api.createBook('隔离作品 ' + i)
        if (!book.ok || !book.value) throw new Error('book fixture failed')
        const doc = await api.create(book.value.id, 'chapters', '晨间来信', 'blank')
        if (!doc.ok) throw new Error(doc.message)
        const saved = await api.save({
          bookId: book.value.id,
          id: doc.value.document.id,
          title: doc.value.document.title,
          expectedVersion: doc.value.document.version,
          content: '清晨，林舟收到一封没有署名的信。\n\n窗外的竹影轻轻晃动。'
        })
        if (!saved.ok) throw new Error(saved.message)
      }
    })
    await page.reload()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.getByRole('button', { name: '边写边聊', exact: true }).click()
    for (const [width, height] of [
      [1920, 1080],
      [1366, 768],
      [960, 720],
      [900, 640]
    ]) {
      await page.setViewportSize({ width, height })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      )
      await expect(page.locator('.cm-content')).toBeVisible()
      if (width < 1180) {
        await page.getByRole('button', { name: '切换文档列表', exact: true }).click()
        await expect(page.locator('.document-list')).toBeVisible()
        await expect(page.locator('.agent-panel')).toBeVisible()
        await page.getByRole('button', { name: '关闭目录', exact: true }).click()
      }
      await page.screenshot({
        path: resolve(`.test-artifacts/release-e2e-final/p0/new-ai-${width}.png`)
      })
    }
    await page.getByRole('button', { name: '专注写作', exact: true }).click()
    await expect(page.locator('.agent-panel')).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(page.locator('.agent-panel')).toBeVisible()
    await page.route('**/components/SettingsCenter.vue', (route) => route.abort())
    const settings = page.getByRole('button', { name: '设置', exact: true })
    await settings.click()
    await expect(page.getByRole('dialog', { name: '加载窗口' })).toContainText('窗口加载失败')
    await page.unroute('**/components/SettingsCenter.vue')
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '设置中心' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(settings).toBeFocused()
    await revealMenu(page, '作品菜单')
    const bookSelect = page.getByRole('combobox', { name: '当前作品' })
    const ids = await bookSelect
      .locator('option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))
    for (const id of ids) {
      await revealMenu(page, '作品菜单')
      await bookSelect.selectOption(id)
      await expect(page.locator('.cm-content')).toContainText('竹影')
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as unknown as { __zestloomerPerfSnapshot: () => { sessions: number } }
              ).__zestloomerPerfSnapshot().sessions
          )
        )
        .toBe(1)
    }
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    await page.screenshot({ path: resolve('.test-artifacts/release-e2e-final/p0/new-dark.png') })
  } finally {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().forEach((window) => window.destroy())
    )
    await app.close()
    await server.close()
  }
})
