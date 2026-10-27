import { test, expect, _electron } from '@playwright/test'
import fs from 'node:fs/promises'
import { resolve, join } from 'node:path'

test('N1–N3 layout, menus, floating search, focus, pairing and typewriter', async () => {
  const root = await fs.mkdtemp(resolve('.test-artifacts/n3-'))
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
    await expect(page.getByRole('button', { name: '作品菜单', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '作品菜单', exact: true }).click()
    await expect(page.getByRole('button', { name: '新建作品', exact: true })).toBeEnabled()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '作品菜单', exact: true })).toBeFocused()
    await page.evaluate(async () => {
      const api = window.zestloomer
      const book = await api.createBook('空间写作验收')
      if (!book.ok) throw new Error(book.message)
      if (!book.value) throw new Error('Book creation cancelled')
      for (const title of ['第一章 清晨', '第二章 晚风']) {
        const created = await api.create(book.value.id, 'chapters', title, 'blank')
        if (!created.ok) throw new Error(created.message)
        const doc = created.value.document
        const saved = await api.save({
          bookId: book.value.id,
          id: doc.id,
          title,
          expectedVersion: doc.version,
          content: '晨光落在窗前，故事从这里开始。🌿\r\n\r\n'.repeat(250)
        })
        if (!saved.ok) throw new Error(saved.message)
      }
      const boot = await api.bootstrap()
      if (!boot.ok) throw new Error(boot.message)
      await api.preferences({
        ...boot.value.preferences,
        lastBookId: book.value.id,
        agentVisible: false,
        listVisible: true
      })
    })
    await page.reload()
    await expect(page.locator('.cm-content')).toBeVisible()
    await page.getByRole('button', { name: '章节与目标', exact: true }).click()
    await page.getByLabel('章节目标字数', { exact: true }).fill('5000')
    await page.getByLabel('章节目标字数', { exact: true }).press('Tab')
    await expect(page.locator('.footer-target progress')).toBeVisible()
    await expect(page.locator('.footer-controls progress')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await fs.mkdir('.test-artifacts/release-e2e-final/n3', { recursive: true })
    const measurements: unknown[] = []
    for (const [width, height] of [
      [1920, 1080],
      [1366, 768],
      [960, 720],
      [900, 640]
    ]) {
      await page.setViewportSize({ width, height })
      await page.waitForTimeout(150)
      const result = await page.evaluate(() => ({
        titleBottom: document.querySelector('.document-heading')!.getBoundingClientRect().bottom,
        contentTop: document.querySelector('.cm-content')!.getBoundingClientRect().top,
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        editorHeight: document.querySelector('.cm-scroller')!.getBoundingClientRect().height,
        visibleNonemptyLines: [...document.querySelectorAll('.cm-line')].filter((line) => {
          const box = line.getBoundingClientRect()
          const viewport = document.querySelector('.cm-scroller')!.getBoundingClientRect()
          return (
            line.textContent?.trim() && box.top >= viewport.top && box.bottom <= viewport.bottom
          )
        }).length
      }))
      expect(result.scrollWidth).toBe(width)
      expect(result.contentTop).toBeGreaterThanOrEqual(result.titleBottom)
      if (width === 1366) expect(result.editorHeight).toBeGreaterThanOrEqual(533)
      const placement = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
        const paper = rect('.text-editor'),
          tools = rect('.editor-toolbar')
        const footer = rect('.writing-area > footer'),
          controls = rect('#relationship-controls')
        return {
          centerDelta: Math.abs(paper.x + paper.width / 2 - tools.x - tools.width / 2),
          controlsInFooter: controls.top >= footer.top && controls.bottom <= footer.bottom,
          summaryInFooter: !!document.querySelector('footer #relationship-status span')
        }
      })
      const paperStyle = await page.evaluate(() => {
        const sheet = document.querySelector('.cm-content')!,
          desk = document.querySelector('.text-editor')!
        return {
          sheetWidth: sheet.getBoundingClientRect().width,
          deskWidth: desk.getBoundingClientRect().width,
          sheetColor: getComputedStyle(sheet, '::before').backgroundColor,
          deskColor: getComputedStyle(desk).backgroundColor
        }
      })
      const overlay = await page.evaluate(() => {
        const box = (s: string) => document.querySelector(s)!.getBoundingClientRect()
        const toolbar = box('.editor-toolbar'),
          heading = box('.scroll-document-heading')
        const scroll = box('.cm-scroller'),
          workspace = box('.text-editor')
        return {
          overlap: toolbar.bottom > heading.top && toolbar.top < heading.bottom,
          lift: heading.top - toolbar.top,
          edge: Math.abs(scroll.right - workspace.right),
          settingsAlign: getComputedStyle(document.querySelector('.sidebar-bottom button')!)
            .textAlign
        }
      })
      expect(overlay.overlap).toBe(true)
      expect(overlay.lift).toBeGreaterThan(0)
      expect(overlay.lift).toBeLessThanOrEqual(8)
      expect(overlay.edge).toBeLessThan(2)
      expect(overlay.settingsAlign).toBe('center')
      expect(paperStyle.sheetWidth).toBeLessThan(paperStyle.deskWidth)
      expect(paperStyle.sheetColor).not.toBe(paperStyle.deskColor)
      expect(placement.centerDelta).toBeLessThan(2)
      expect(placement.controlsInFooter).toBe(true)
      expect(placement.summaryInFooter).toBe(true)
      measurements.push({ ...result, ...placement })
      await page.screenshot({ path: `.test-artifacts/release-e2e-final/n3/workspace-${width}.png` })
    }
    await fs.writeFile(
      '.test-artifacts/release-e2e-final/n3/layout.json',
      JSON.stringify(measurements, null, 2)
    )
    await page.setViewportSize({ width: 1366, height: 768 })

    // Regression: opaque paper used to conceal CodeMirror's selected text background.
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('Shift+End')
    await expect(page.locator('.cm-selectionBackground').first()).toBeVisible()
    const selectionLayers = await page.evaluate(() => {
      const sheet = document.querySelector('.cm-content')!
      const selection = document.querySelector('.cm-selectionLayer')!
      const tools = document.querySelector('.editor-toolbar')!
      return {
        paperZ: Number(getComputedStyle(sheet, '::before').zIndex),
        selectionZ: Number(getComputedStyle(selection).zIndex),
        paper: getComputedStyle(sheet, '::before').backgroundColor,
        tools: getComputedStyle(tools).backgroundColor,
        surface: getComputedStyle(sheet).backgroundColor
      }
    })
    expect(selectionLayers.paperZ).toBeLessThan(selectionLayers.selectionZ)
    expect(selectionLayers.surface).toBe('rgba(0, 0, 0, 0)')
    expect(selectionLayers.tools).not.toBe(selectionLayers.paper)
    await expect(page.locator('.cm-selectionBackground').first()).toHaveCSS(
      'background-color',
      'rgb(197, 223, 247)'
    )
    await page.screenshot({ path: '.test-artifacts/release-e2e-final/n3/selection-light.png' })
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    await page.screenshot({ path: '.test-artifacts/release-e2e-final/n3/selection-dark.png' })
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light'
    })
    await page.getByRole('button', { name: '高亮人物与设定', exact: true }).focus()
    await expect(page.locator('.cm-selectionBackground').first()).toHaveCSS(
      'background-color',
      'rgb(197, 223, 247)'
    )
    await page.screenshot({ path: '.test-artifacts/release-e2e-final/n3/selection-unfocused.png' })
    await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop = 240
    })
    await page.screenshot({ path: '.test-artifacts/release-e2e-final/n3/scrolled.png' })
    const toolsTop = await page
      .locator('.editor-toolbar')
      .evaluate((el) => el.getBoundingClientRect().top)
    const paperTop = await page
      .locator('.scroll-document-heading')
      .evaluate((el) => el.getBoundingClientRect().top)
    expect(toolsTop).toBeGreaterThan(paperTop)
    await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop = 0
    })

    const resizer = page.getByRole('separator', { name: '调整目录宽度' })
    await resizer.focus()
    await page.keyboard.press('ArrowRight')
    await expect(resizer).toHaveAttribute('aria-valuenow', '244')
    await page.keyboard.press('Home')
    await expect(resizer).toHaveAttribute('aria-valuenow', '224')
    const handle = await resizer.boundingBox()
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + 60)
    await page.mouse.down()
    await page.mouse.move(handle!.x + handle!.width / 2 + 80, handle!.y + 60)
    await page.mouse.up()
    await expect(resizer).toHaveAttribute('aria-valuenow', '304')
    await resizer.press('Home')
    await page.getByRole('button', { name: '文档更多', exact: true }).click()
    await expect(page.getByRole('button', { name: '历史版本', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '管理关联', exact: true }).click()
    await expect(page.getByLabel('选择关联文档')).toBeVisible()
    await page.keyboard.press('Escape')
    const heightBefore = await page.locator('.cm-scroller').evaluate((el) => el.clientHeight)
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('Control+h')
    await page.getByLabel('查找文字', { exact: true }).fill('晨光')
    const compositionKeys = await page.getByLabel('查找文字', { exact: true }).evaluate((input) => {
      return ['Enter', 'Escape'].map((key) => {
        const event = new KeyboardEvent('keydown', {
          key,
          isComposing: true,
          bubbles: true,
          cancelable: true
        })
        input.dispatchEvent(event)
        return event.defaultPrevented
      })
    })
    expect(compositionKeys).toEqual([false, false])
    await expect(page.locator('.find-panel')).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(page.locator('.match-count')).toHaveText('1 / 250 处')
    await page.keyboard.press('Shift+Enter')
    await expect(page.locator('.match-count')).toHaveText('250 / 250 处')
    expect(await page.locator('.cm-scroller').evaluate((el) => el.clientHeight)).toBe(heightBefore)
    await page.screenshot({ path: '.test-artifacts/release-e2e-final/n3/search.png' })
    await page.keyboard.press('Escape')
    await expect(page.locator('.cm-content')).toBeFocused()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('TEST')
    await page.getByRole('button', { name: '专注写作', exact: true }).click()
    await expect(page.locator('.sidebar')).toBeHidden()
    await page.keyboard.press('Escape')
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.cm-content')).toContainText('TEST')
    await page.getByRole('button', { name: '写作显示', exact: true }).click()
    await page.getByLabel('版心宽度', { exact: true }).selectOption('680')
    await expect
      .poll(() => page.locator('.cm-content').evaluate((el) => el.getBoundingClientRect().width))
      .toBe(680)
    await page.getByLabel('版心宽度', { exact: true }).selectOption('820')
    await page.getByLabel('中文选区配对', { exact: true }).check()
    await page.getByLabel('打字机模式', { exact: true }).check()
    await page.keyboard.press('Escape')
    await page.locator('.cm-content').focus()
    await page.keyboard.press('Control+End')
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.insertText('《')
    await expect(page.locator('.cm-content')).toContainText('《TEST》')
    await page.keyboard.press('Control+z')
    await expect(page.locator('.cm-content')).not.toContainText('《TEST》')
    await page.keyboard.press('Control+End')
    await page.keyboard.type('Z')
    await page.waitForTimeout(150)
    const cursorRatio = await page.evaluate(() => {
      const cursor = document.querySelector('.cm-cursor')!.getBoundingClientRect()
      const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect()
      return (cursor.top + cursor.height / 2 - scroller.top) / scroller.height
    })
    expect(cursorRatio).toBeGreaterThan(0.35)
    expect(cursorRatio).toBeLessThan(0.55)
    const readingTop = await page.locator('.cm-scroller').evaluate((el) => {
      el.scrollTop -= 180
      return el.scrollTop
    })
    await page.waitForTimeout(250)
    expect(await page.locator('.cm-scroller').evaluate((el) => el.scrollTop)).toBeCloseTo(
      readingTop,
      0
    )
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    await page.screenshot({ path: '.test-artifacts/release-e2e-final/n3/dark.png' })
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light'
    })
    await page.keyboard.press('F11')
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true)
    await expect(page.locator('.sidebar')).toBeHidden()
    await page.keyboard.press('F11')
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false)
    await expect(page.locator('.sidebar')).toBeVisible()
    await page.setViewportSize({ width: 900, height: 640 })
    await page.getByRole('button', { name: '边写边聊', exact: true }).click()
    await page.getByRole('button', { name: '切换文档列表', exact: true }).click()
    await expect(page.locator('.document-list')).toBeVisible()
    await expect(page.locator('.agent-panel')).toBeVisible()
    await page.screenshot({ path: '.test-artifacts/release-e2e-final/n3/narrow-ai-drawer.png' })
    await page.getByRole('button', { name: '关闭目录', exact: true }).click()
    const agentResize = page.getByRole('separator', { name: '调整 Agent 宽度' })
    await agentResize.focus()
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowLeft')
    expect(
      await page.locator('.writing-area').evaluate((el) => el.getBoundingClientRect().width)
    ).toBeGreaterThanOrEqual(480)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(900)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.locator('.settings-center')).toBeVisible()
    await expect(page.locator('.settings-heading h2')).toHaveCSS('font-size', '18px')
    await page.screenshot({ path: '.test-artifacts/release-e2e-final/n3/settings.png' })

    await page.keyboard.press('Escape')
    // Isolated display fixture only; never calls a model or changes real conversations.
    await app.evaluate(({ ipcMain }) => {
      const snapshot = (_event: unknown, bookId: string) => ({
        ok: true,
        value: {
          active: null,
          proposals: [],
          conversations: [
            {
              format: 1,
              id: 'ui-message-fixture',
              bookId,
              title: '消息布局验收',
              updatedAt: new Date().toISOString(),
              summary: '',
              coveredMessages: 0,
              messages: [
                {
                  id: 'fixture-user',
                  role: 'user',
                  text: '请帮我看看这一章。',
                  sources: [
                    {
                      id: 'fixture-source',
                      title: '第一章 清晨',
                      version: 'fixture-version',
                      kind: 'chapters'
                    }
                  ]
                },
                {
                  id: 'fixture-assistant',
                  role: 'assistant',
                  text: '章节开头的环境描写可以保留。',
                  sources: [
                    {
                      id: 'fixture-source',
                      title: '第一章 清晨',
                      version: 'fixture-version',
                      kind: 'chapters'
                    }
                  ]
                }
              ]
            }
          ]
        }
      })
      for (const name of ['zestloomer:agent:bind', 'zestloomer:agent:snapshot']) {
        ipcMain.removeHandler(name)
        ipcMain.handle(name, snapshot)
      }
    })
    await page.setViewportSize({ width: 1366, height: 768 })
    await page.reload()
    await expect(page.locator('.agent-message')).toHaveCount(2)
    for (const message of await page.locator('.agent-message').all()) {
      const sources = await message.locator('.agent-sources').boundingBox()
      const actions = await message.locator('.message-actions').boundingBox()
      expect(actions!.y).toBeGreaterThanOrEqual(sources!.y + sources!.height)
      await expect(message.locator('.message-actions button').first()).toHaveCSS(
        'font-size',
        '11px'
      )
    }
    await page.getByRole('button', { name: '再次编辑', exact: true }).click()
    await expect(page.locator('.agent-input textarea')).toHaveValue('请帮我看看这一章。')
    await page.screenshot({ path: '.test-artifacts/release-e2e-final/n3/agent-actions.png' })

    expect(errors).toEqual([])
  } finally {
    await app.close()
  }
})
