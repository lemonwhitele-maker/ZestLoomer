import { _electron, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import { resolve, join } from 'node:path'
await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
const root = await fs.mkdtemp(resolve('.test-artifacts/p0-production-'))
const env = {
  ...process.env,
  ZESTLOOMER_USER_DATA: join(root, 'profile'),
  ZESTLOOMER_BOOKLIST: join(root, 'books'),
  ZESTLOOMER_TEST_HIDDEN: '1'
}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const app = await _electron.launch({ args: ['.'], cwd: resolve('.'), env })
try {
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.locator('.workspace-header').waitFor()
  const menu = page.getByRole('button', { name: '作品菜单', exact: true })
  await menu.click()
  await expect(page.getByRole('button', { name: '新建作品', exact: true })).toBeEnabled()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '设置中心' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeFocused()
  await menu.click()
  await page.getByRole('button', { name: '经典布局', exact: true }).click()
  await expect(page.locator('.modern-workspace')).toHaveCount(0)
  await page.getByRole('button', { name: '新布局', exact: true }).click()
  await expect(page.locator('.modern-workspace')).toBeVisible()
  await fs.writeFile(
    '.test-artifacts/production-smoke.json',
    JSON.stringify(
      {
        passed: errors.length === 0,
        errors,
        checks: [
          'production boot',
          'lazy settings open',
          'focus restore',
          'classic and modern layout toggle'
        ]
      },
      null,
      2
    )
  )
  expect(errors).toEqual([])
} finally {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.destroy())
  )
  await app.close()
}
