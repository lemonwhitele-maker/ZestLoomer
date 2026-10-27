import { _electron, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import { resolve, join } from 'node:path'
import os from 'node:os'
const label = process.argv[2] || 'new'
const entry = resolve(process.argv[3] || 'out/main/index.js')
const artifacts = resolve(process.argv[4] || 'docs/p0')
await fs.mkdir(artifacts, { recursive: true })
const root = await fs.mkdtemp(join(os.tmpdir(), 'zest-p0-'))
const env = {
  ...process.env,
  ZESTLOOMER_USER_DATA: join(root, 'profile'),
  ZESTLOOMER_BOOKLIST: join(root, 'books'),
  ZESTLOOMER_TEST_HIDDEN: '1',
  ZESTLOOMER_PERF: '1'
}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const app = await _electron.launch({ args: [entry], env })
const page = await app.firstWindow()
page.setDefaultTimeout(15000)
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
const pct = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]
async function activate(locator) {
  await expect(locator).toBeEnabled()
  await locator.evaluate((node) => node.click())
}
try {
  await expect(page.getByRole('button', { name: '新建作品', exact: true })).toBeEnabled()
  await page.evaluate(async () => {
    const api = window.zestloomer
    const unwrap = (r) => {
      if (!r.ok) throw new Error(r.message)
      return r.value
    }
    const ids = []
    for (let b = 0; b < 3; b++) {
      const book = unwrap(await api.createBook('性能夹具 ' + b))
      ids.push(book.id)
      for (let n = 0; n < 55; n++) {
        const doc = unwrap(
          await api.create(book.id, 'chapters', `测试章 ${String(n).padStart(2, '0')}`, 'blank')
        ).document
        if (n < 2)
          unwrap(
            await api.save({
              bookId: book.id,
              id: doc.id,
              title: doc.title,
              expectedVersion: doc.version,
              content: '晨光落在窗前，故事从这里开始。🌿\r\n'.repeat(n === 0 ? 2500 : 150)
            })
          )
      }
    }
    const boot = unwrap(await api.bootstrap())
    unwrap(
      await api.preferences({
        ...boot.preferences,
        lastBookId: ids[0],
        listVisible: true,
        agentVisible: false
      })
    )
  })
  await page.reload()
  console.log('fixtures ready')
  await expect(page.locator('.cm-content')).toBeVisible()
  const layout = []
  for (const [width, height] of [
    [1920, 1080],
    [1366, 768],
    [960, 720],
    [900, 640]
  ]) {
    await page.setViewportSize({ width, height })
    if (
      width < 1180 &&
      label !== 'baseline' &&
      (await page.getByRole('button', { name: '收起文档列表', exact: true }).isVisible())
    )
      await page
        .getByRole('button', { name: '收起文档列表', exact: true })
        .evaluate((node) => node.click())
    await page.screenshot({ path: join(artifacts, `${label}-${width}.png`) })
    layout.push(
      await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        editorHeight: document.querySelector('.cm-scroller').getBoundingClientRect().height
      }))
    )
  }
  await page.setViewportSize({ width: 1366, height: 768 })
  console.log('layout captured')
  const switches = []
  for (let i = 0; i < 30; i++) {
    const title = `测试章 ${String(i % 2).padStart(2, '0')}`
    const start = performance.now()
    await activate(page.locator('.entry-title').filter({ hasText: title }))
    await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue(title)
    switches.push(performance.now() - start)
  }
  await activate(page.locator('.entry-title').filter({ hasText: '测试章 00' }))
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue(
    '测试章 00'
  )
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
  console.log('switch samples captured')
  await page.locator('.cm-content').focus()
  await page.keyboard.press('Control+End')
  await page.evaluate(() => {
    window.inputSamples = []
    window.inputDomSamples = []
    let started
    new MutationObserver(() => {
      if (started !== undefined) {
        window.inputDomSamples.push(performance.now() - started)
        started = undefined
      }
    }).observe(document.querySelector('.cm-content'), {
      subtree: true,
      childList: true,
      characterData: true
    })
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'x') return
      const start = performance.now()
      started = start
      requestAnimationFrame(() =>
        requestAnimationFrame(() => window.inputSamples.push(performance.now() - start))
      )
    })
  })
  for (let i = 0; i < 30; i++) {
    await page.keyboard.type('x')
    await page.waitForTimeout(70)
  }
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toContainText('已保存')
  const samples = await page.evaluate(() => window.inputSamples)
  const domSamples = await page.evaluate(() => window.inputDomSamples)
  console.log('input samples captured')
  const memory = []
  const bookIds = await page
    .getByRole('combobox', { name: '当前作品' })
    .locator('option')
    .evaluateAll((options) => options.map((o) => o.value))
  for (let round = 0; round < 2; round++)
    for (const book of bookIds) {
      console.log('memory pass', round, book)
      await page.getByRole('combobox', { name: '当前作品' }).selectOption(book)
      await expect(page.locator('.cm-content')).toBeVisible()
      for (let i = 0; i < 55; i++) {
        const title = `测试章 ${String(i).padStart(2, '0')}`
        await activate(page.locator('.entry-title').filter({ hasText: title }))
        await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue(
          title
        )
      }
      memory.push(
        await page.evaluate(() => ({
          heap: performance.memory?.usedJSHeapSize,
          counters: window.__zestloomerPerfSnapshot?.()
        }))
      )
    }
  await fs.writeFile(
    join(artifacts, `${label}-renderer.json`),
    JSON.stringify(
      {
        label,
        machine: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        cpu: os.cpus()[0].model,
        electron: await app.evaluate(() => process.versions.electron),
        scale: await page.evaluate(() => devicePixelRatio),
        samples: 30,
        layout,
        switches: { p50: pct(switches, 0.5), p95: pct(switches, 0.95), raw: switches },
        inputTwoFrames: { p50: pct(samples, 0.5), p95: pct(samples, 0.95), raw: samples },
        inputDOM: {
          count: domSamples.length,
          p50: pct(domSamples, 0.5),
          p95: pct(domSamples, 0.95),
          raw: domSamples
        },
        memory,
        errors,
        notes:
          'Hidden Electron; two-rAF values are background-throttled and NOT valid presentation latency. inputDOM is keydown-to-content-mutation only, NOT paint. Chapter timing uses programmatic button activation and includes Playwright round trips. Mixed CRLF fixture. Three books x 55 chapters, two rounds. Heap is coarse performance.memory, not retained-size or GC evidence. No model calls.'
      },
      null,
      2
    )
  )
} finally {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().forEach((w) => w.destroy())
  )
  await app.close()
}
