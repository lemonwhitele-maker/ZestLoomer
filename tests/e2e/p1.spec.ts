import { revealMenu } from './menus'
import { test, expect, _electron } from '@playwright/test'
import fs from 'node:fs/promises'
import { resolve, join } from 'node:path'

test('P1 reuses the editor DOM, isolates undo, and retains settings leave protection', async () => {
  const root = await fs.mkdtemp(resolve('.test-artifacts/p1-editor-'))
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    ),
    ZESTLOOMER_USER_DATA: join(root, 'profile'),
    ZESTLOOMER_BOOKLIST: join(root, 'books'),
    ZESTLOOMER_TEST_HIDDEN: '1'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app = await _electron.launch({ args: ['.'], cwd: resolve('.'), env })
  try {
    const page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await revealMenu(page, '作品菜单')
    await expect(page.getByRole('button', { name: '新建作品', exact: true })).toBeEnabled()
    await expect
      .poll(() =>
        page
          .getByRole('img', { name: 'ZestLoomer', exact: true })
          .evaluate((image: HTMLImageElement) => image.naturalWidth)
      )
      .toBeGreaterThan(0)
    const workerFile = (await fs.readdir('out/renderer/assets')).find(
      (name) => name.startsWith('proposalDiff.worker-') && name.endsWith('.js')
    )!
    const preview = await page.evaluate(
      (filename) =>
        new Promise<{ coarse: boolean; hunks: { oldLine: number; after: string }[] }>(
          (resolve, reject) => {
            const worker = new Worker(new URL('./assets/' + filename, location.href), {
              type: 'module'
            })
            const timer = setTimeout(() => {
              worker.terminate()
              reject(new Error('worker deadline'))
            }, 10000)
            worker.onerror = () => {
              clearTimeout(timer)
              worker.terminate()
              reject(new Error('worker failed'))
            }
            worker.onmessage = (event) => {
              clearTimeout(timer)
              worker.terminate()
              resolve(event.data)
            }
            const prefix = '相同\r\n'.repeat(10000)
            worker.postMessage({
              before: prefix + '旧\n' + prefix,
              after: prefix + '新\n' + prefix,
              unified: false
            })
          }
        ),
      workerFile
    )
    expect(preview.coarse).toBe(false)
    expect(preview.hunks[0]).toMatchObject({ oldLine: 10001, after: '新\n' })
    await page.evaluate(async () => {
      const api = window.zestloomer
      const created = await api.createBook('P1 独立测试')
      if (!created.ok || !created.value) throw new Error('fixture book')
      const book = created.value
      for (const title of ['P1甲', 'P1乙']) {
        const result = await api.create(book.id, 'chapters', title, 'blank')
        if (!result.ok) throw new Error(result.message)
        const doc = result.value.document
        const saved = await api.save({
          bookId: book.id,
          id: doc.id,
          expectedVersion: doc.version,
          title,
          content: title + '😀\r\n原文\n末尾'
        })
        if (!saved.ok) throw new Error(saved.message)
      }
      const boot = await api.bootstrap()
      if (!boot.ok) throw new Error(boot.message)
      await api.preferences({
        ...boot.value.preferences,
        lastBookId: book.id,
        agentVisible: false,
        listVisible: true
      })
    })
    await page.reload()
    const open = async (title: string) => {
      await page.locator('.entry-title').filter({ hasText: title }).click()
      await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue(title)
      await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
    }
    await open('P1甲')
    const original = await page.locator('.cm-editor').elementHandle()
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('AAA')
    await open('P1乙')
    expect(await original!.evaluate((el) => el === document.querySelector('.cm-editor'))).toBe(true)
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('BBB')
    await page.keyboard.press('Control+z')
    await expect(page.locator('.cm-content')).not.toContainText('BBB')
    await open('P1甲')
    await expect(page.locator('.cm-content')).toContainText('AAA')
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+z')
    await expect(page.locator('.cm-content')).not.toContainText('AAA')
    await page.keyboard.press('Control+s')
    await expect(page.locator('.save-state')).toContainText('已保存')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByLabel('字号', { exact: true }).fill('21')
    await page.getByRole('tab', { name: /Agent 偏好/ }).click()
    await expect(page.getByRole('alertdialog', { name: '未保存的修改' })).toBeVisible()
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    await expect(page.getByLabel('字号', { exact: true })).toHaveValue('21')
    await page.getByRole('tab', { name: /Agent 偏好/ }).click()
    await page.getByRole('button', { name: '放弃修改', exact: true }).click()
    await expect(page.getByText('启用意图识别与目标改写（实验）', { exact: false })).toBeVisible()
    await page.screenshot({ path: join(root, 'settings.png') })
    expect(errors).toEqual([])
  } finally {
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    })
    await app.close()
  }
})
