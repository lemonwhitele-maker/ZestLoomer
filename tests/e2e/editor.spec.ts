import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer, type ViteDevServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import type { DocumentMeta, DocumentSnapshot } from '../../src/shared/documents'
import { createServer as createHttpServer } from 'node:http'

let electron: ElectronApplication
let page: Page
let root: string
let profile: string
const consoleErrors: string[] = []
let devServer: ViteDevServer | undefined
async function launch(rendererUrl?: string): Promise<void> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  )
  env.ZESTLOOMER_USER_DATA = profile
  env.ZESTLOOMER_BOOKLIST = root
  env.ZESTLOOMER_TEST_HIDDEN = '1'
  env.ZESTLOOMER_PERF = '1'
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  if (rendererUrl) env.ELECTRON_RENDERER_URL = rendererUrl
  electron = await _electron.launch({ args: ['.'], cwd: resolve('.'), env })
  page = await electron.firstWindow()
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  await electron.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: joinForTest(folder) })
    function joinForTest(path: string) {
      return path + '/export.txt'
    }
  }, root)
  await expect(page.getByRole('button', { name: '新建作品', exact: true })).toBeEnabled()
}
test.beforeEach(async () => {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  root = await fs.mkdtemp(resolve('.test-artifacts/window-'))
  profile = join(root, 'profile')
  consoleErrors.length = 0
  await launch()
  await page.getByRole('button', { name: '新建作品', exact: true }).click()
  await page.getByRole('textbox', { name: '新标题' }).fill('验收小说')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
test.afterEach(async () => {
  if (electron) {
    // Teardown must not wait for a deliberately unresolved conflict in a failed test.
    await electron
      .evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      })
      .catch(() => {})
    await electron.close()
  }
  expect(consoleErrors).toEqual([])
  await devServer?.close()
  devServer = undefined
})

test('new books show immutable examples and editable copies', async () => {
  const examples = (await docs(true)).filter((d) => d.readonlyExample)
  expect(examples).toHaveLength(2)
  for (const kind of ['characters', 'settings'] as const) {
    const example = examples.find((d) => d.kind === kind)!
    await page.getByRole('button', { name: kind === 'characters' ? /^人物/ : /^设定/ }).click()
    await page.locator('.entry-title').filter({ hasText: example.title }).click()
    await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toBeDisabled()
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
    await expect(page.getByRole('button', { name: '移入回收站', exact: true })).toBeDisabled()
    if (kind === 'characters') expect((await disk(example.id)).content).toContain('### 经典发言')
    const version = (await disk(example.id)).version
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toBeEnabled()
    await enterText('复制后可以填写自己的资料。')
    const copy = (await docs()).find((d) => d.kind === kind)!
    expect(copy.readonlyExample).toBeUndefined()
    await expect.poll(async () => (await disk(copy.id)).content).toBe('复制后可以填写自己的资料。')
    expect((await disk(example.id)).version).toBe(version)
  }
})

test('templates and Agent API flow preserve source notes, require review, survive restart and cancel safely', async () => {
  await page.getByRole('button', { name: /^人物/ }).click()
  await newDocument('林舟')
  const person = (await docs()).find((d) => d.kind === 'characters' && !d.readonlyExample)!
  expect((await disk(person.id)).content).toContain('### 核心定位')
  expect((await disk(person.id)).content).toContain('### 经典发言')
  expect((await disk(person.id)).content).not.toContain('confirmed')
  await page.getByRole('button', { name: '新建条目', exact: true }).click()
  await page.getByRole('textbox', { name: '新标题' }).fill('自由人物')
  await page.getByRole('combobox', { name: '初始内容' }).selectOption('blank')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const blank = (await docs()).find((d) => d.title === '自由人物')!
  expect((await disk(blank.id)).content).toBe('')
  await page.getByRole('button', { name: /^速记/ }).click()
  await newDocument('水门灵感')
  await enterText('城市水门每天开启两次。')
  const note = (await docs()).find((d) => d.kind === 'notes')!
  let requests = 0
  let hanging: import('node:http').ServerResponse | undefined
  const server = createHttpServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    expect(request.headers.authorization).toBe('Bearer synthetic-local-test-key')
    requests++
    response.setHeader('Content-Type', 'text/event-stream')
    const latestUser = payload.messages.filter((m: any) => m.role === 'user').at(-1)?.content || ''
    if (latestUser.includes('取消验证')) {
      hanging = response
      response.write(
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '正在处理…' } }] }) + '\n\n'
      )
      return
    }
    const tools = payload.messages.filter((m: any) => m.role === 'tool')
    let choice: unknown
    if (!tools.length)
      choice = {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'read1',
              function: {
                name: 'read',
                arguments: JSON.stringify({ path: `book/notes/${note.id}.md` })
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    else if (tools.length === 1)
      choice = {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'create1',
              function: {
                name: 'create',
                arguments: JSON.stringify({
                  directory: 'book/settings/',
                  title: '城市水门',
                  content: '### 定义\n\n城市水门\n\n### 规则与边界\n\n每天开启两次。',
                  sources: [`book/notes/${note.id}.md`],
                  reason: '根据作者指定速记整理'
                })
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    else choice = { delta: { content: '已根据速记整理设定，请审阅提案。' }, finish_reason: 'stop' }
    response.end('data: ' + JSON.stringify({ choices: [choice] }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: /AI 接入/ }).click()
    await page.getByRole('textbox', { name: 'Agent API 地址' }).fill(`http://127.0.0.1:${port}/v1`)
    await page.getByRole('textbox', { name: 'Agent 模型', exact: true }).fill('synthetic-model')
    await page.getByLabel('Agent API 密钥', { exact: true }).fill('synthetic-local-test-key')
    await page.getByRole('button', { name: '保存 Agent 配置' }).click()
    await expect(page.locator('.settings-footer [role="status"]')).toContainText('Agent 配置已保存')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    const savedConfig = JSON.parse(
      await fs.readFile(join(root, '.zestloomer', 'agent.json'), 'utf8')
    )
    expect(savedConfig.profiles[0].encryptedKey).toBeTruthy()
    expect(JSON.stringify(savedConfig)).not.toContain('synthetic-local-test-key')
    const publicConfig = await page.evaluate(() => window.zestloomer.agent.config())
    expect(publicConfig.ok && publicConfig.value.hasKey).toBe(true)
    expect(JSON.stringify(publicConfig)).not.toContain('synthetic-local-test-key')
    await page.getByRole('button', { name: /^Agent 对话/ }).click()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await page.getByRole('textbox', { name: '给 Agent 的消息' }).fill('依据这份速记整理成设定')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('button', { name: '接受修改', exact: true })).toBeEnabled()
    expect(requests).toBe(3)
    await expect(page.locator('.proposal-card .diff-after').first()).toHaveCSS(
      'white-space',
      'pre-wrap'
    )
    await expect(page.locator('.proposal-card .diff-after').first()).toHaveCSS(
      'max-height',
      '280px'
    )
    const diffBackground = await page
      .locator('.proposal-card .diff-after')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(diffBackground).not.toBe('rgba(0, 0, 0, 0)')
    expect((await docs()).filter((d) => d.kind === 'settings')).toHaveLength(0)
    await page.getByRole('button', { name: '接受修改', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue(
      '城市水门'
    )
    const setting = (await docs()).find((d) => d.kind === 'settings')!
    expect((await disk(setting.id)).content).toContain('每天开启两次')
    expect((await disk(note.id)).content).toBe('城市水门每天开启两次。')
    await page.screenshot({ path: join(root, 'agent-workspace.png') })
    await page.getByRole('button', { name: '撤销这次修改' }).click()
    await expect(page.locator('.trash-banner')).toBeVisible()
    expect((await disk(setting.id)).trashedAt).toBeTruthy()
    await page.getByRole('textbox', { name: '给 Agent 的消息' }).fill('取消验证')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('button', { name: '取消任务' })).toBeVisible()
    const stream = page.locator('.agent-message.assistant .message-text').last()
    await expect(stream).toContainText('正在处理')
    await expect(stream).toHaveCSS('white-space', 'pre-wrap')
    const diffCount = () =>
      page.evaluate(
        () =>
          (
            window as unknown as { __zestloomerPerfSnapshot: () => { proposalDiffCount: number } }
          ).__zestloomerPerfSnapshot().proposalDiffCount
      )
    const beforeStreaming = await diffCount()
    hanging!.write(
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '\n下一段流式正文' } }] }) + '\n\n'
    )
    await expect(stream).toContainText('下一段流式正文')
    expect(await diffCount()).toBe(beforeStreaming)
    await page.getByRole('button', { name: '取消任务' }).click()
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
    await expect(page.locator('.agent-messages')).toContainText('任务已取消')
    await page.locator('summary[aria-label="会话选项"]').click()
    await page.getByRole('textbox', { name: '会话标题' }).fill('水门讨论')
    await page.getByRole('button', { name: '改名', exact: true }).click()
    await expect(page.getByRole('combobox', { name: '选择会话' })).toContainText('水门讨论')
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await electron.close()
    await launch()
    await expect(page.getByRole('combobox', { name: '选择会话' })).toContainText('水门讨论')
    await expect(page.locator('.agent-messages')).toContainText('已撤销')
    expect((await disk(note.id)).content).toBe('城市水门每天开启两次。')
  } finally {
    hanging?.destroy()
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})
async function newDocument(title: string): Promise<void> {
  await page.getByRole('button', { name: '新建条目', exact: true }).click()
  await page.getByRole('textbox', { name: '新标题' }).fill(title)
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue(title)
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

test('target rewrite checkbox sends structured goals with final-response history and can be switched off', async () => {
  const requests: { messages: { role: string; content: string }[]; tools?: unknown[] }[] = []
  const server = createHttpServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    requests.push(payload)
    const system = payload.messages[0].content as string
    const text = system.includes('needsRewrite')
      ? JSON.stringify({ needsRewrite: true, reason: '需要延续前一轮方案' })
      : system.includes('请求澄清预处理器')
        ? JSON.stringify({ target: '继续讨论方案二', constraints: ['只讨论'], unresolved: [] })
        : `主模型最终回答${requests.length}`
    response.setHeader('Content-Type', 'text/event-stream')
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    const port = (server.address() as { port: number }).port
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: /AI 接入/ }).click()
    await page.getByRole('textbox', { name: 'Agent API 地址' }).fill(`http://127.0.0.1:${port}/v1`)
    await page.getByRole('textbox', { name: 'Agent 模型', exact: true }).fill('synthetic-model')
    await page.getByLabel('Agent API 密钥', { exact: true }).fill('synthetic-local-test-key')
    await page.getByRole('button', { name: '保存 Agent 配置' }).click()
    await expect(page.locator('.settings-footer [role="status"]')).toContainText('Agent 配置已保存')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: /^Agent 对话/ }).click()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await page.locator('.context-preview > summary').click()
    await expect(
      page.locator('.agent-panel').getByRole('checkbox', { name: /目标改写/ })
    ).toHaveCount(0)
    const setRewrite = async (enabled: boolean) => {
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByRole('tab', { name: /Agent 偏好/ }).click()
      await page
        .getByRole('checkbox', { name: '启用意图识别与目标改写（实验）' })
        .setChecked(enabled)
      await page.getByRole('button', { name: '保存 Agent 偏好', exact: true }).click()
      await expect(page.locator('.settings-footer [role="status"]')).toContainText(
        'Agent 偏好已保存'
      )
      await page.getByRole('button', { name: '关闭', exact: true }).click()
    }
    const send = async (text: string, answer: string) => {
      await page.getByRole('textbox', { name: '给 Agent 的消息' }).fill(text)
      await page.getByRole('button', { name: '发送', exact: true }).click()
      await expect(page.locator('.agent-messages')).toContainText(answer)
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
    }
    await send('讨论两个方案', '主模型最终回答1')
    expect(requests).toHaveLength(1)
    await setRewrite(true)
    await send('按方案二继续，只讨论', '主模型最终回答4')
    expect(requests).toHaveLength(4)
    expect(requests[1].tools).toBeUndefined()
    expect(requests[2].tools).toBeUndefined()
    expect(JSON.parse(requests[2].messages[1].content).history[0]).toMatchObject({
      prompt: '讨论两个方案',
      response: '主模型最终回答1'
    })
    expect(JSON.parse(requests[3].messages.at(-1)!.content)).toMatchObject({
      originalPrompt: '按方案二继续，只讨论',
      targetRewrite: { target: '继续讨论方案二' }
    })
    const context = page.locator('.sent-context').last()
    await context.locator(':scope > summary').click()
    await expect(context).toContainText('使用 1 轮有效对话')
    await expect(context).toContainText('继续讨论方案二')
    await setRewrite(false)
    await send('换个独立话题', '主模型最终回答5')
    expect(requests).toHaveLength(5)
    expect(requests[4].messages.at(-1)!.content).toBe('换个独立话题')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})
async function enterText(text: string): Promise<void> {
  const content = page.locator('.cm-content')
  await expect(content).toHaveAttribute('contenteditable', 'true')
  await content.click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(text)
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
}
// Existing scenarios count author documents; examples have their own lifecycle test.
async function docs(includeExamples = false): Promise<DocumentMeta[]> {
  return page.evaluate(async (include) => {
    const boot = await window.zestloomer.bootstrap()
    if (!boot.ok) throw new Error(boot.message)
    const result = await window.zestloomer.list(boot.value.preferences.lastBookId!)
    if (!result.ok) throw new Error(result.message)
    return result.value.filter((doc) => include || !doc.readonlyExample)
  }, includeExamples)
}
async function disk(id: string): Promise<DocumentSnapshot> {
  return page.evaluate(async (docId) => {
    const boot = await window.zestloomer.bootstrap()
    if (!boot.ok) throw new Error(boot.message)
    const read = await window.zestloomer.read(boot.value.preferences.lastBookId!, docId)
    if (!read.ok) throw new Error(read.message)
    return read.value.document
  }, id)
}
async function readAt(top: number): Promise<number> {
  // Finish the previous typing/selection layout before simulating a reader's scroll.
  await page.getByRole('textbox', { name: '文档标题', exact: true }).focus()
  return page.locator('.cm-scroller').evaluate(async (el, value) => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await frame()
    await frame()
    el.scrollTop = value
    await frame()
    await frame()
    return el.scrollTop
  }, top)
}

test('reading positions remember each chapter across sections, empty sections and restart', async () => {
  await newDocument('第一章位置')
  await enterText(Array.from({ length: 150 }, (_, i) => `第一章第${i}段正文。`).join('\n\n'))
  const scroll = () => page.locator('.cm-scroller').evaluate((el) => el.scrollTop)
  const firstTop = await readAt(1800)
  expect(Math.abs(firstTop - 1800)).toBeLessThan(100)
  await newDocument('第二章位置')
  await enterText(Array.from({ length: 150 }, (_, i) => `第二章第${i}段正文。`).join('\n\n'))
  const secondTop = await readAt(3000)
  expect(Math.abs(secondTop - 3000)).toBeLessThan(100)
  // Characters and settings now contain immutable examples; notes is still empty.
  await page.getByRole('button', { name: /^速记/ }).click()
  await expect(page.locator('.cm-scroller')).toHaveCount(0)
  const secondChapter = (await docs()).find((doc) => doc.title === '第二章位置')!
  expect(
    await page.evaluate((id) => {
      const key = Object.keys(localStorage).find((key) => key.endsWith(`:${id}`))!
      return JSON.parse(localStorage.getItem(key)!).scrollTop
    }, secondChapter.id)
  ).toBeCloseTo(secondTop, 0)
  await page.getByRole('button', { name: /^人物/ }).click()
  await newDocument('人物资料')
  await enterText(Array.from({ length: 90 }, (_, i) => `人物资料第${i}行`).join('\n'))
  const personTop = await readAt(900)
  expect(Math.abs(personTop - 900)).toBeLessThan(100)
  await page.getByRole('button', { name: /^正文/ }).click()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue(
    '第二章位置'
  )
  await expect.poll(scroll).toBeCloseTo(secondTop, 0)
  await page.getByRole('button', { name: /^设定/ }).click()
  await page.getByRole('button', { name: /^正文/ }).click()
  await expect.poll(scroll).toBeCloseTo(secondTop, 0)
  await page.getByRole('button', { name: /^人物/ }).click()
  await expect.poll(scroll).toBeCloseTo(personTop, 0)
  await page.getByRole('button', { name: /^正文/ }).click()
  await page.locator('.document-list').getByText('第一章位置', { exact: true }).click()
  await expect.poll(scroll).toBeCloseTo(firstTop, 0)
  await electron.close()
  await launch()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue(
    '第一章位置'
  )
  await expect.poll(scroll).toBeCloseTo(firstTop, 0)
})

test('proposal apply and undo preserve reading position and settings merge paragraph comparisons', async () => {
  await newDocument('提案位置')
  const oldText = '旧第一段\n\n中间保留段\n\n旧最后段'
  const newText = '新第一段\n\n中间保留段\n\n新最后段'
  const source =
    Array.from({ length: 100 }, (_, i) => `第${i}段正文。`).join('\n\n') + '\n\n' + oldText
  await enterText(source)
  const chapter = (await docs()).find((doc) => doc.title === '提案位置')!
  const path = `book/chapters/${chapter.id}.txt`
  const server = createHttpServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const payload = JSON.parse(raw)
    const count = payload.messages.filter((m: any) => m.role === 'tool').length
    const choice =
      count < 2
        ? {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `tool${count}`,
                  function: {
                    name: count === 0 ? 'read' : 'edit',
                    arguments: JSON.stringify(
                      count === 0
                        ? { path, startLine: 201, endLine: 205 }
                        : {
                            path,
                            baseVersion: JSON.parse(
                              payload.messages.filter((m: any) => m.role === 'tool').at(-1).content
                            ).version,
                            edits: [
                              {
                                mode: 'replace',
                                target: { kind: 'lines', startLine: 201, endLine: 205 },
                                newText: newText.replaceAll('\n\n', '\n')
                              }
                            ]
                          }
                    )
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        : { delta: { content: '请审阅修改。' }, finish_reason: 'stop' }
    response.setHeader('Content-Type', 'text/event-stream')
    response.end('data: ' + JSON.stringify({ choices: [choice] }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await configureSelectionAgent((server.address() as { port: number }).port)
    await page.getByRole('textbox', { name: '给 Agent 的消息' }).fill('修改最后两段')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('button', { name: '接受修改', exact: true })).toBeEnabled()
    await expect(page.locator('.proposal-diff')).toHaveCount(2)
    await expect(page.locator('.proposal-card')).toContainText(
      '已统一候选正文的段落换行，请一并审阅。'
    )
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: /Agent 偏好/ }).click()
    await page.getByRole('checkbox', { name: '合并替换前后对照' }).check()
    await page.getByRole('button', { name: '保存 Agent 偏好', exact: true }).click()
    await expect(page.locator('.settings-footer [role="status"]')).toContainText('Agent 偏好已保存')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.locator('.proposal-diff')).toHaveCount(1)
    expect(await page.locator('.diff-before').textContent()).toBe(oldText)
    expect(await page.locator('.diff-after').textContent()).toBe(newText)
    const readingTop = await readAt(2500)
    expect(Math.abs(readingTop - 2500)).toBeLessThan(100)
    const scroll = () => page.locator('.cm-scroller').evaluate((el) => el.scrollTop)
    await expect.poll(scroll).toBeCloseTo(readingTop, 0)
    await page.getByRole('button', { name: '接受修改', exact: true }).click()
    await expect(page.getByRole('button', { name: '撤销这次修改' })).toBeEnabled()
    await expect.poll(scroll).toBeCloseTo(readingTop, 0)
    expect((await disk(chapter.id)).content).toBe(source.replace(oldText, newText))
    await page.getByRole('button', { name: '撤销这次修改' }).click()
    await expect(page.locator('.proposal-card')).toContainText('已撤销')
    await expect.poll(scroll).toBeCloseTo(readingTop, 0)
    expect((await disk(chapter.id)).content).toBe(source)
    await electron.close()
    await launch()
    await expect(page.locator('.proposal-diff')).toHaveCount(1)
    await expect.poll(scroll).toBeCloseTo(readingTop, 0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('line-protocol continuation previews real separators and waits for review before apply and undo', async () => {
  await newDocument('行号续写验收')
  const source = '他推开门，屋内没有人。'
  await enterText(source)
  const chapter = (await docs()).find((doc) => doc.title === '行号续写验收')!
  const path = `book/chapters/${chapter.id}.txt`
  const server = createHttpServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const payload = JSON.parse(raw)
    const results = payload.messages.filter((message: any) => message.role === 'tool')
    const count = results.length
    const read = count ? JSON.parse(results[0].content) : undefined
    const choice =
      count < 2
        ? {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `continue-${count}`,
                  function: {
                    name: count ? 'edit' : 'read',
                    arguments: JSON.stringify(
                      count
                        ? {
                            path,
                            baseVersion: read.version,
                            edits: [
                              {
                                mode: 'insert',
                                target: { kind: 'document_end' },
                                newText: '窗外忽然传来脚步声。'
                              }
                            ]
                          }
                        : { path }
                    )
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        : { delta: { content: '文末续写已准备，请审阅。' }, finish_reason: 'stop' }
    response.setHeader('Content-Type', 'text/event-stream')
    response.end('data: ' + JSON.stringify({ choices: [choice] }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await configureSelectionAgent((server.address() as { port: number }).port)
    await page
      .getByRole('textbox', { name: '给 Agent 的消息' })
      .fill('在这一章末尾续写一句，保留前文。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('button', { name: '接受修改', exact: true })).toBeEnabled()
    expect((await disk(chapter.id)).content).toBe(source)
    expect(await page.locator('.diff-before').textContent()).toBe(source)
    // LOOM-034 normalizes the complete chapter proposal to double paragraph separators.
    expect(await page.locator('.diff-after').textContent()).toBe(
      source + '\n\n窗外忽然传来脚步声。'
    )
    await expect(page.locator('.diff-after .diff-newline')).toHaveCount(2)
    await expect(page.locator('.proposal-card')).toContainText(
      '已统一候选正文的段落换行，请一并审阅。'
    )
    await page
      .locator('.proposal-card')
      .screenshot({ path: resolve('.test-artifacts/zestloomer-026-continuation-preview.png') })
    await page.getByRole('button', { name: '接受修改', exact: true }).click()
    await expect(page.getByRole('button', { name: '撤销这次修改' })).toBeEnabled()
    expect((await disk(chapter.id)).content).toBe(source + '\n\n窗外忽然传来脚步声。')
    await page.getByRole('button', { name: '撤销这次修改' }).click()
    await expect(page.locator('.proposal-card')).toContainText('已撤销')
    expect((await disk(chapter.id)).content).toBe(source)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('reviewing one of two document proposals preserves the other preview and review position', async () => {
  const chapters: DocumentMeta[] = []
  for (const title of ['甲提案', '乙提案']) {
    await newDocument(title)
    await enterText(`${title}原文。`)
    chapters.push((await docs()).find((doc) => doc.title === title)!)
  }
  const server = createHttpServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const payload = JSON.parse(raw)
    const count = payload.messages.filter((m: any) => m.role === 'tool').length
    const chapter = chapters[Math.floor(count / 2)]
    const path = chapter && `book/chapters/${chapter.id}.txt`
    const choice =
      count < 4
        ? {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `tool${count}`,
                  function: {
                    name: count % 2 === 0 ? 'read' : 'edit',
                    arguments: JSON.stringify(
                      count % 2 === 0
                        ? { path }
                        : {
                            path,
                            baseVersion: JSON.parse(
                              payload.messages.filter((m: any) => m.role === 'tool').at(-1).content
                            ).version,
                            edits: [
                              {
                                mode: 'replace',
                                target: { kind: 'lines', startLine: 1, endLine: 1 },
                                newText: `${chapter.title}修改后。`
                              }
                            ]
                          }
                    )
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        : { delta: { content: '两篇文档的修改已准备好，请分别审阅。' }, finish_reason: 'stop' }
    response.setHeader('Content-Type', 'text/event-stream')
    response.end('data: ' + JSON.stringify({ choices: [choice] }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await configureSelectionAgent((server.address() as { port: number }).port)
    await page.getByRole('textbox', { name: '给 Agent 的消息' }).fill('修改两篇文档')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const cards = page.locator('.proposal-card')
    await expect(cards).toHaveCount(2)
    await expect(cards.first().getByRole('button', { name: '接受修改', exact: true })).toBeEnabled()
    const secondPreview = await cards.last().locator('.proposal-diff').textContent()
    const scroll = () => page.locator('.agent-messages').evaluate((el) => el.scrollTop)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    // Stay within the follow-latest threshold, but deliberately above the bottom.
    const top = await page.locator('.agent-messages').evaluate((el) => {
      el.scrollTop = el.scrollHeight - el.clientHeight - 40
      el.dispatchEvent(new Event('scroll'))
      return el.scrollTop
    })
    expect(top).toBeGreaterThan(0)
    // Dispatch without Playwright scrolling the first card into view.
    await cards
      .first()
      .getByRole('button', { name: '接受修改', exact: true })
      .dispatchEvent('click')
    await expect(cards.first()).toContainText('已应用')
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    await expect.poll(scroll).toBeCloseTo(top, 0)
    await expect(cards.last()).toContainText('等待审阅')
    expect(await cards.last().locator('.proposal-diff').textContent()).toBe(secondPreview)
    expect((await disk(chapters[0].id)).content).toBe('甲提案修改后。')
    expect((await disk(chapters[1].id)).content).toBe('乙提案原文。')
    await cards.last().getByRole('button', { name: '接受修改', exact: true }).click()
    // The second proposal read the first document, so its source guard still applies.
    await expect(cards.last()).toContainText('版本冲突')
    expect(await cards.last().locator('.proposal-diff').textContent()).toBe(secondPreview)
    expect((await disk(chapters[1].id)).content).toBe('乙提案原文。')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('five kinds share source editor, local search, rename, trash and stable references', async () => {
  await newDocument('第一章')
  const prose = '清晨，城门开了。\n\n  原有空格\n\t制表符\n<不应变成标签> & **字面字符**\n'
  await enterText(prose)
  const chapter = (await docs())[0]
  expect((await disk(chapter.id)).content).toBe(prose)
  await expect(page.locator('.cm-line').first()).toHaveCSS('text-indent', '36px')
  await page.getByRole('button', { name: /^人物/ }).click()
  await newDocument('林舟')
  const source = '# 林舟\n\n**这不是渲染后的粗体**\n- 自由条目\n无固定区块也可保存。'
  await enterText(source)
  await expect(page.locator('.cm-line').first()).toHaveCSS('text-indent', '0px')
  await expect(page.locator('.cm-content h1, .cm-content strong')).toHaveCount(0)
  await page.getByRole('textbox', { name: '文档标题', exact: true }).fill('林舟改名')
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
  const person = (await docs()).find((doc) => doc.kind === 'characters')!
  await page.getByRole('button', { name: /^正文/ }).click()
  await page.getByRole('button', { name: '插入引用', exact: true }).click()
  await page.getByRole('button', { name: '林舟改名 人物' }).click()
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
  expect((await disk(chapter.id)).content).toContain(person.id)
  await page.getByRole('button', { name: /^人物/ }).click()
  await page.getByRole('button', { name: '移入回收站', exact: true }).click()
  await page.getByRole('button', { name: '确认回收', exact: true }).click()
  await page.getByRole('button', { name: /^正文/ }).click()
  const referenceLine = page.locator('.cm-line').filter({ hasText: person.id })
  // Click the source text itself, including after its target has been moved to trash.
  await referenceLine.click({ modifiers: ['Control'], position: { x: 120, y: 10 } })
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('林舟改名')
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
  await page.keyboard.press('Control+h')
  await expect(page.getByRole('textbox', { name: '查找文字', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '替换文字', exact: true })).toHaveCount(0)
  await page.getByRole('textbox', { name: '查找文字', exact: true }).fill('自由')
  await expect(page.locator('.match-count')).toHaveText('1 处')
  await page.getByRole('button', { name: '恢复文档', exact: true }).click()
  expect((await disk(person.id)).id).toBe(person.id)
  await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
  for (const [section, title] of [
    ['设定', '城市'],
    ['大纲', '开篇'],
    ['速记', '灵感一']
  ] as const) {
    await page.getByRole('button', { name: new RegExp('^' + section) }).click()
    await newDocument(title)
    await enterText('# 源码\n任意内容')
  }
  await newDocument('灵感二')
  await enterText('另一条独立速记')
  expect((await docs()).filter((doc) => doc.kind === 'notes')).toHaveLength(2)
  await page.screenshot({ path: join(root, 'workspace.png') })
})
test('find/replace and undo stay local; chapter order and saved state survive restart', async () => {
  await newDocument('甲章')
  await enterText('甲苹果 甲苹果\n\n保留空行')
  const a = (await docs())[0]
  await page.keyboard.press('Control+h')
  await page.getByRole('textbox', { name: '查找文字', exact: true }).fill('苹果')
  await page.getByRole('textbox', { name: '替换文字', exact: true }).fill('梨')
  await page.getByRole('button', { name: '替换本篇全部' }).click()
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
  expect((await disk(a.id)).content).toBe('甲梨 甲梨\n\n保留空行')
  await page.getByRole('button', { name: '关闭查找' }).click()
  await newDocument('乙章')
  await enterText('乙苹果')
  const b = (await docs()).find((doc) => doc.title === '乙章')!
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
  expect((await disk(b.id)).content).not.toContain('甲')
  await enterText('乙苹果')
  await page.getByRole('button', { name: '上移 乙章' }).click()
  await expect(page.locator('.entry-title').first()).toContainText('乙章')
  await electron.close()
  await launch()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('乙章')
  await expect(page.locator('.entry-title').first()).toContainText('乙章')
  expect((await disk(a.id)).content).toBe('甲梨 甲梨\n\n保留空行')
})
test('external conflict preserves input, compares versions, then explicitly saves', async () => {
  await newDocument('冲突章')
  await enterText('原文')
  const doc = (await docs())[0]
  const bookFolders = (await fs.readdir(root)).filter((name) => name.startsWith('ZestLoomer-'))
  const path = join(root, bookFolders[0], 'chapters', doc.id, 'content.txt')
  await fs.writeFile(path, '外部改写', 'utf8')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText('人的新输入')
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('版本冲突')
  await expect(page.locator('.cm-content')).toContainText('人的新输入')
  expect(await fs.readFile(path, 'utf8')).toBe('外部改写')
  await page.getByRole('button', { name: '比较磁盘版本' }).click()
  await expect(page.locator('.comparison textarea').nth(0)).toHaveValue('人的新输入')
  await expect(page.locator('.comparison textarea').nth(1)).toHaveValue('外部改写')
  await page.getByRole('button', { name: '保存当前输入', exact: true }).click()
  await expect(page.locator('.save-state')).toHaveText('已保存')
  expect(await fs.readFile(path, 'utf8')).toBe('人的新输入')
  await fs.writeFile(path, '选择保留的磁盘正文', 'utf8')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('冲突输入')
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('版本冲突')
  await page.getByRole('button', { name: '比较磁盘版本' }).click()
  await page.getByRole('button', { name: '采用磁盘版本', exact: true }).click()
  await expect(page.locator('.cm-content')).toHaveText('选择保留的磁盘正文')
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('继续写作')
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
  expect(await fs.readFile(path, 'utf8')).toBe('选择保留的磁盘正文继续写作')
})
test('long source remains responsive and exports without visual indentation or metadata', async () => {
  await newDocument('长章')
  const content = ('一段中文，包含标点与英文 ABC。'.repeat(10) + '\n\n').repeat(600)
  const started = Date.now()
  await enterText(content)
  expect(Date.now() - started).toBeLessThan(15000)
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('文档已导出')
  expect(await fs.readFile(join(root, 'export.txt'), 'utf8')).toBe(content)
  await page.keyboard.press('Control+f')
  await page.getByRole('textbox', { name: '查找文字', exact: true }).fill('ABC')
  await expect(page.locator('.match-count')).toHaveText('6000 处')
  await page.screenshot({ path: join(root, 'long-document.png') })
})

test('development server startup supports creation, autosave and clean close', async () => {
  await electron.close()
  devServer = await createServer({
    configFile: false,
    root: resolve('src/renderer'),
    plugins: [vue()],
    server: { host: '127.0.0.1', port: 0 }
  })
  await devServer.listen()
  await launch(devServer.resolvedUrls!.local[0])
  await newDocument('开发模式')
  await enterText('开发模式自动保存验证。')
  expect((await disk((await docs())[0].id)).content).toBe('开发模式自动保存验证。')
})

test('undo and selection survive an empty module; Markdown never changes appearance', async () => {
  await newDocument('保留状态')
  await enterText('第一段\n第二段')
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('新增')
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
  const doc = (await docs())[0]
  await page.getByRole('button', { name: /^速记/ }).click()
  await expect(page.getByRole('heading', { name: '留一页给新的想法' })).toBeVisible()
  await page.getByRole('button', { name: /^正文/ }).click()
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
  expect((await disk(doc.id)).content).not.toContain('新增')
  await page.getByRole('button', { name: /^人物/ }).click()
  await newDocument('普通源码')
  await enterText('# 标题\n**粗体源码**')
  const styles = await page.locator('.cm-line').evaluateAll((lines) =>
    lines.map((line) => ({
      size: getComputedStyle(line).fontSize,
      weight: getComputedStyle(line).fontWeight
    }))
  )
  expect(new Set(styles.map((style) => JSON.stringify(style))).size).toBe(1)
})

test('Enter inserts two newlines without indent; close flushes and an interrupted draft recovers', async () => {
  await newDocument('保存边界')
  await enterText('  自己输入的空格')
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('下一段')
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
  const doc = (await docs())[0]
  expect((await disk(doc.id)).content).toBe('  自己输入的空格\n\n下一段')
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('关闭前输入')
  // Close before the 650 ms automatic-save debounce expires.
  await electron.close()
  await launch()
  await expect(page.getByRole('textbox', { name: '文档标题', exact: true })).toHaveValue('保存边界')
  expect((await disk(doc.id)).content).toContain('关闭前输入')
  const boot = await page.evaluate(() => window.zestloomer.bootstrap())
  if (!boot.ok) throw new Error(boot.message)
  const book = boot.value.books[0]
  // Simulate a previous abnormal exit by persisting a recovery draft, then destroying the window.
  await page.evaluate(
    async ({ bookId, id, version }) => {
      const result = await window.zestloomer.draft(bookId, id, {
        content: '异常退出的草稿',
        title: '保存边界',
        baseVersion: version,
        savedAt: new Date().toISOString()
      })
      if (!result.ok) throw new Error(result.message)
    },
    { bookId: book.id, id: doc.id, version: (await disk(doc.id)).version }
  )
  await electron.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.destroy()
  })
  await electron.close()
  await launch()
  await expect(page.locator('.cm-content')).toContainText('异常退出的草稿')
  await expect(page.locator('.save-state')).toHaveText('已保存')
  expect((await disk(doc.id)).content).toBe('异常退出的草稿')
})

test('knowledge highlights match titles and aliases, refresh after edits and preserve source and undo', async () => {
  await page.getByRole('button', { name: /^人物/ }).click()
  await newDocument('林舟')
  await enterText(
    '> **来源记录**：状态：active | 别名：白衣客、陆先生 | 标签：主角\n\n### 核心定位'
  )
  await newDocument('林舟先生')
  await page.getByRole('button', { name: /^设定/ }).click()
  await newDocument('雾港')
  await enterText('---\naliases:\n  - 城门\n  - "A+B"\n---\n\n### 定义')
  await page.getByRole('button', { name: /^正文/ }).click()
  await newDocument('高亮验收')
  const source = '林舟与白衣客、陆先生、林舟先生来到雾港。城门上写着 A+B。\n\n第二段仍然缩进。'
  await enterText(source)
  const chapter = (await docs()).find((doc) => doc.kind === 'chapters')!
  const people = page.locator('.cm-knowledge-character')
  const settings = page.locator('.cm-knowledge-setting')
  await expect(people).toHaveText(['林舟', '白衣客', '陆先生', '林舟先生'])
  await expect(settings).toHaveText(['雾港', '城门', 'A+B'])
  await expect(people.last()).toHaveAttribute('title', '人物：林舟先生')
  await expect(page.locator('.cm-line').last()).toHaveCSS('text-indent', '36px')
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await expect(people.first()).toHaveCSS('background-color', 'rgb(101, 85, 42)')
  await expect(settings.first()).toHaveCSS('background-color', 'rgb(53, 85, 56)')
  await page.screenshot({ path: join(root, 'knowledge-highlights-dark.png') })
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
  })
  await expect(people.first()).toHaveCSS('background-color', 'rgb(255, 240, 171)')
  await expect(settings.first()).toHaveCSS('background-color', 'rgb(218, 239, 201)')
  await page.screenshot({ path: join(root, 'knowledge-highlights-light.png') })
  const toggle = page.getByRole('button', { name: '高亮人物与设定', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(people).toHaveCount(0)
  await expect(settings).toHaveCount(0)
  expect((await disk(chapter.id)).content).toBe(source)
  await toggle.click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('林舟')
  await expect(people).toHaveCount(5)
  await toggle.click()
  await toggle.click()
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
  expect((await disk(chapter.id)).content).toBe(source)
  await expect(people).toHaveCount(4)
  await page.keyboard.press('Control+f')
  await page.getByRole('textbox', { name: '查找文字', exact: true }).fill('林舟')
  await expect(page.locator('.match-count')).toHaveText('2 处')
  await expect(people).toHaveCount(4)
  await page.getByRole('button', { name: '关闭查找', exact: true }).click()
  await page.getByRole('button', { name: /^人物/ }).click()
  await page
    .locator('.entry-title')
    .filter({ has: page.getByText('林舟', { exact: true }) })
    .click()
  await page.getByRole('textbox', { name: '文档标题', exact: true }).fill('陆行舟')
  await enterText('别名：陆先生')
  await page.getByRole('button', { name: /^正文/ }).click()
  await expect(people).toHaveText(['陆先生', '林舟先生'])
  await page.getByRole('button', { name: /^设定/ }).click()
  await page.getByRole('button', { name: '移入回收站', exact: true }).click()
  await page.getByRole('button', { name: '确认回收', exact: true }).click()
  await page.getByRole('button', { name: /^正文/ }).click()
  await expect(settings).toHaveCount(0)
  await toggle.click()
  await electron.close()
  await launch()
  const restoredToggle = page.getByRole('button', { name: '高亮人物与设定', exact: true })
  await expect(restoredToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.cm-knowledge-character')).toHaveCount(0)
  await restoredToggle.click()
  await expect(page.locator('.cm-knowledge-character')).toHaveText(['陆先生', '林舟先生'])
  expect((await disk(chapter.id)).content).toBe(source)
  await page.screenshot({ path: join(root, 'knowledge-highlights.png') })
})

test('chapter Enter and Shift+Enter insert double line breaks, preserve CRLF and leave Markdown Enter unchanged', async () => {
  await newDocument('双换行')
  await enterText('第一段')
  const chapter = (await docs())[0]
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('第二段')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.insertText('第三段')
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
  expect((await disk(chapter.id)).content).toBe('第一段\n\n第二段\n\n第三段')
  await expect(page.locator('.cm-line')).toHaveCount(5)
  for (const line of await page.locator('.cm-line').all()) {
    await expect(line).toHaveCSS('text-indent', '36px')
  }
  await page.getByRole('button', { name: /^速记/ }).click()
  await newDocument('源码换行')
  await enterText('第一行')
  const note = (await docs()).find((doc) => doc.kind === 'notes')!
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('第二行')
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
  expect((await disk(note.id)).content).toBe('第一行\n第二行')
  await expect(page.locator('.cm-line').last()).toHaveCSS('text-indent', '0px')
  await page.evaluate(async (id) => {
    const boot = await window.zestloomer.bootstrap()
    if (!boot.ok) throw new Error(boot.message)
    const bookId = boot.value.preferences.lastBookId!
    const read = await window.zestloomer.read(bookId, id)
    if (!read.ok) throw new Error(read.message)
    const saved = await window.zestloomer.save({
      bookId,
      id,
      title: read.value.document.title,
      content: '原有\r\n换行',
      expectedVersion: read.value.document.version
    })
    if (!saved.ok) throw new Error(saved.message)
  }, chapter.id)
  await page.getByRole('button', { name: /^正文/ }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('新段')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.insertText('再一段')
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
  expect((await disk(chapter.id)).content).toBe('原有\r\n换行\r\n\r\n新段\r\n\r\n再一段')
})

test('mixed proposal line endings remain separate lines and typing preserves the rest of the source', async () => {
  await newDocument('混合换行')
  const chapter = (await docs()).find((doc) => doc.title === '混合换行')!
  await page.getByRole('button', { name: /^速记/ }).click()
  await page.evaluate(async (id) => {
    const boot = await window.zestloomer.bootstrap()
    if (!boot.ok) throw new Error(boot.message)
    const bookId = boot.value.preferences.lastBookId!
    const read = await window.zestloomer.read(bookId, id)
    if (!read.ok) throw new Error(read.message)
    const saved = await window.zestloomer.save({
      bookId,
      id,
      title: read.value.document.title,
      content: '前文\r\n提案第一段\n提案第二段\r尾声',
      expectedVersion: read.value.document.version
    })
    if (!saved.ok) throw new Error(saved.message)
  }, chapter.id)
  await page.getByRole('button', { name: /^正文/ }).click()
  await expect(page.locator('.cm-line')).toHaveCount(4)
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('新段')
  await page.keyboard.press('Control+s')
  await expect(page.locator('.save-state')).toHaveText('已保存')
  expect((await disk(chapter.id)).content).toBe('前文\r\n提案第一段\n提案第二段\r尾声\r\n\r\n新段')
  await page.getByRole('button', { name: /^速记/ }).click()
  await page.getByRole('button', { name: /^正文/ }).click()
  await expect(page.locator('.cm-line')).toHaveCount(6)
})

test('edited configuration probes separate chat and tools without saving or exposing book data', async () => {
  const requests: any[] = []
  const server = createHttpServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    if (request.url?.endsWith('/models')) {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'probe-model' }] }))
      return
    }
    const body = JSON.parse(raw)
    requests.push(body)
    const nonce = body.messages[0].content.match(/[a-f0-9]{8}-[a-f0-9-]{27}/)?.[0]
    const hasResult = body.messages.some((m: any) => m.role === 'tool')
    const calls =
      body.tools && !hasResult && body.model !== 'chat-only'
        ? [
            {
              index: 0,
              id: 'probe1',
              type: 'function',
              function: {
                name: 'zestloomer_connection_probe',
                arguments: JSON.stringify({
                  value: body.model === 'wrong-value' ? 'incorrect' : nonce
                })
              },
              extra_content: { google: { thought_signature: 'synthetic-signature' } }
            }
          ]
        : undefined
    const content = hasResult ? nonce : 'Hello'
    response.setHeader('Content-Type', 'text/event-stream')
    response.end(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              delta: calls ? { tool_calls: calls } : { content },
              finish_reason: calls ? 'tool_calls' : 'stop'
            }
          ]
        }) +
        '\n\ndata: [DONE]\n\n'
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  try {
    const input = { id: 'new', baseUrl, model: 'probe-model', apiKey: '' }
    const configBefore = await page.evaluate(() => window.zestloomer.agent.config())
    const connection = await page.evaluate(
      (input) => window.zestloomer.agent.test(input, 'connection'),
      input
    )
    expect(connection.ok).toBe(true)
    const tools = await page.evaluate(
      (input) => window.zestloomer.agent.test(input, 'tools'),
      input
    )
    expect(tools.ok).toBe(true)
    const final = requests.at(-1)
    expect(
      final.messages.find((m: any) => m.tool_calls)?.tool_calls[0].extra_content.google
        .thought_signature
    ).toBe('synthetic-signature')
    const chatOnly = { ...input, model: 'chat-only' }
    expect(
      (await page.evaluate((input) => window.zestloomer.agent.test(input, 'connection'), chatOnly))
        .ok
    ).toBe(true)
    expect(
      (await page.evaluate((input) => window.zestloomer.agent.test(input, 'tools'), chatOnly)).ok
    ).toBe(false)
    expect(
      (
        await page.evaluate((input) => window.zestloomer.agent.test(input, 'tools'), {
          ...input,
          model: 'wrong-value'
        })
      ).ok
    ).toBe(false)
    expect(await page.evaluate(() => window.zestloomer.agent.config())).toEqual(configBefore)
    expect(JSON.stringify(requests)).not.toContain('book/')
    const models = await page.evaluate((input) => window.zestloomer.agent.models(input), {
      ...input,
      model: ''
    })
    expect(models.ok && models.value).toEqual(['probe-model'])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('legacy encrypted configuration migrates to profiles and survives restart', async () => {
  const encryptedKey = await electron.evaluate(({ safeStorage }) =>
    safeStorage.encryptString('synthetic-migration-key').toString('base64')
  )
  await electron.close()
  await fs.unlink(join(root, '.zestloomer', 'migration.json'))
  await fs.writeFile(
    join(profile, 'agent.json'),
    JSON.stringify({
      format: 1,
      baseUrl: 'http://127.0.0.1:9123/v1',
      model: 'legacy-model',
      encryptedKey
    }),
    'utf8'
  )
  await launch()
  const legacy = await page.evaluate(() => window.zestloomer.agent.config())
  expect(legacy.ok && legacy.value.profiles?.[0].id).toBe('default')
  const migrated = await page.evaluate(() =>
    window.zestloomer.agent.configure({
      id: 'default',
      baseUrl: 'http://127.0.0.1:9123/v1',
      model: 'legacy-model',
      label: '保留原配置'
    })
  )
  expect(migrated.ok && migrated.value.hasKey).toBe(true)
  const refused = await page.evaluate(() =>
    window.zestloomer.agent.configure({
      id: 'default',
      baseUrl: 'http://127.0.0.1:9999/v1',
      model: 'legacy-model'
    })
  )
  expect(refused.ok).toBe(false)
  const added = await page.evaluate(() =>
    window.zestloomer.agent.configure({
      id: 'new',
      baseUrl: 'http://127.0.0.1:9124/v1',
      model: 'second-model',
      apiKey: '',
      makeDefault: false,
      contextTokens: 65536,
      outputTokens: 8192,
      retryOutputTokens: 16384
    })
  )
  expect(added.ok && added.value.profiles?.length).toBe(2)
  await electron.close()
  await launch()
  const restarted = await page.evaluate(() => window.zestloomer.agent.config())
  expect(restarted.ok && restarted.value.model).toBe('legacy-model')
  expect(JSON.stringify(restarted)).not.toContain('synthetic-migration-key')
  expect(JSON.stringify(restarted)).not.toContain('encryptedKey')
})

test('Agent context controls match sent data, preserve drafts during work and explain failure', async () => {
  const payloads: any[] = []
  const server = createHttpServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    payloads.push(body)
    const prompt = body.messages.at(-1).content
    if (prompt.includes('失败验证')) {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: '测试密钥无效' } }))
      return
    }
    response.setHeader('Content-Type', 'text/event-stream')
    response.write(
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '正在分析选区。' } }] }) + '\n\n'
    )
    if (!prompt.includes('挂起验证'))
      response.end(
        'data: ' +
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) +
          '\n\ndata: [DONE]\n\n'
      )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    await newDocument('发送上下文章节')
    await enterText('这段原文用于核对选区。')
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+a')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('tab', { name: /AI 接入/ }).click()
    await page
      .getByRole('textbox', { name: 'Agent API 地址' })
      .fill(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`)
    await page.getByRole('textbox', { name: 'Agent 模型', exact: true }).fill('context-test-model')
    await page.getByLabel('Agent API 密钥', { exact: true }).fill('test-key')
    await page.getByRole('button', { name: '保存 Agent 配置' }).click()
    await expect(page.locator('.settings-footer [role="status"]')).toContainText('Agent 配置已保存')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '边写边聊', exact: true }).click()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await page.locator('.context-preview summary').click()
    await expect(page.locator('.context-preview pre')).toHaveText('这段原文用于核对选区。')
    await expect(page.locator('.model-hint')).toContainText('context-test-model')
    const input = page.getByRole('textbox', { name: '给 Agent 的消息' })
    await input.fill('挂起验证：分析选区')
    await input.dispatchEvent('compositionstart')
    await input.press('Control+Enter')
    expect(payloads).toHaveLength(0)
    await input.dispatchEvent('compositionend')
    await input.press('Control+Enter')
    await expect.poll(() => payloads.length).toBe(1)
    const sentWorkspace = (index: number) =>
      JSON.parse(payloads[index].messages.at(-2).content.split('：').slice(1).join('：'))
    expect(sentWorkspace(0).selection.text).toBe('这段原文用于核对选区。')
    await expect(input).toBeEnabled()
    await expect(input).toHaveValue('')
    await input.fill('下一条草稿')
    await expect(page.getByRole('region', { name: '本轮进度' })).toContainText('正在组织回复')
    await fs.mkdir(resolve('.test-artifacts/ux-agent-context'), { recursive: true })
    await page.screenshot({ path: resolve('.test-artifacts/ux-agent-context/running.png') })
    await page.getByRole('button', { name: '取消任务', exact: true }).click()
    await expect(input).toHaveValue('下一条草稿')
    await expect(page.getByRole('button', { name: '编辑后重试' })).toBeDisabled()
    await page.getByLabel('附带选区原文').uncheck()
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect.poll(() => payloads.length).toBe(2)
    expect(sentWorkspace(1).selection).toBeNull()
    expect(sentWorkspace(1).documentId).toBeTruthy()
    await expect(page.getByRole('region', { name: '本轮进度' })).toContainText('本轮已完成')
    await page.getByLabel('附带当前文档位置').uncheck()
    await input.fill('失败验证')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.getByRole('region', { name: '本轮进度' })).toContainText('本轮未完成')
    expect(sentWorkspace(2).documentId).toBeUndefined()
    expect(sentWorkspace(2).selection).toBeNull()
    await page.getByRole('button', { name: '编辑后重试' }).click()
    await expect(input).toHaveValue('失败验证')
    await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 720)
    )
    await page.screenshot({ path: resolve('.test-artifacts/ux-agent-context/failure-900.png') })
    const bounds = await page.locator('.agent-input').boundingBox()
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(721)
    const sendBounds = await page.getByRole('button', { name: '发送', exact: true }).boundingBox()
    expect(sendBounds!.y + sendBounds!.height).toBeLessThanOrEqual(721)
    expect((await page.locator('.agent-messages').boundingBox())!.height).toBeGreaterThan(90)
    await electron.close()
    await launch()
    await page.locator('.sent-context summary').first().click()
    await expect(page.locator('.sent-context').first()).toContainText('context-test-model')
    await expect(page.locator('.sent-context').first()).toContainText('这段原文用于核对选区。')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

async function configureSelectionAgent(port: number): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: /AI 接入/ }).click()
  await page.getByRole('textbox', { name: 'Agent API 地址' }).fill(`http://127.0.0.1:${port}/v1`)
  await page.getByRole('textbox', { name: 'Agent 模型', exact: true }).fill('selection-test-model')
  await page.getByLabel('Agent API 密钥', { exact: true }).fill('selection-test-key')
  await page.getByRole('button', { name: '保存 Agent 配置' }).click()
  await expect(page.locator('.settings-footer [role="status"]')).toContainText('Agent 配置已保存')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '边写边聊', exact: true }).click()
  await page.getByRole('button', { name: '新对话', exact: true }).click()
}

test('export latest Agent log saves exact context and replies, survives restart and respects dialog cancellation', async () => {
  const payloads: any[] = []
  const server = createHttpServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    payloads.push(JSON.parse(raw))
    response.setHeader('Content-Type', 'text/event-stream')
    response.end(
      'data: ' +
        JSON.stringify({
          choices: [{ delta: { content: '日志测试的完整回复。' }, finish_reason: 'stop' }]
        }) +
        '\n\ndata: [DONE]\n\n'
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const exportPath = join(root, 'agent-log.json')
  try {
    await newDocument('日志上下文')
    await enterText('这是需要附带的选区原文。')
    await configureSelectionAgent((server.address() as { port: number }).port)
    const button = page.getByRole('button', { name: '导出本轮日志', exact: true })
    await expect(button).toBeDisabled()
    await expect(page.locator('.cm-content')).toHaveAttribute('contenteditable', 'true')
    await page.locator('.cm-content').click()
    await page.keyboard.press('Control+a')
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe('这是需要附带的选区原文。')
    const input = page.getByRole('textbox', { name: '给 Agent 的消息' })
    await input.fill('请核对选区')
    await input.press('Control+Enter')
    await expect(page.getByRole('region', { name: '本轮进度' })).toContainText('本轮已完成')
    await expect(button).toBeEnabled()
    await electron.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, exportPath)
    await button.click()
    await expect
      .poll(async () => fs.readFile(exportPath, 'utf8').catch(() => ''))
      .toContain('日志测试的完整回复。')
    const content = await fs.readFile(exportPath, 'utf8')
    const exported = JSON.parse(content)
    expect(exported.complete).toBe(true)
    expect(exported.log.workspace.selection.text).toBe('这是需要附带的选区原文。')
    expect(exported.log.rounds[0].requests.find((e: any) => e.type === 'request').body).toEqual(
      payloads[0]
    )
    expect(content).not.toContain('selection-test-key')
    await expect(button).toBeEnabled()
    await electron.evaluate(({ dialog }) => {
      dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' })
    })
    await button.click()
    await expect(button).toBeEnabled()
    expect(await fs.readFile(exportPath, 'utf8')).toBe(content)
    await electron.close()
    await launch()
    await electron.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, exportPath)
    await page.getByRole('button', { name: '导出本轮日志', exact: true }).click()
    await expect
      .poll(async () => JSON.parse(await fs.readFile(exportPath, 'utf8')).exportedAt)
      .not.toBe(exported.exportedAt)
    expect(JSON.parse(await fs.readFile(exportPath, 'utf8')).log).toEqual(exported.log)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('editor Ctrl+Enter sends the selected source without changing text, selection, scroll or focus', async () => {
  const payloads: any[] = []
  const server = createHttpServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    payloads.push(JSON.parse(raw))
    response.setHeader('Content-Type', 'text/event-stream')
    response.write(
      'data: ' + JSON.stringify({ choices: [{ delta: { content: '选区已收到。' } }] }) + '\n\n'
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    await newDocument('快捷发送保留编辑位置')
    const selected = '最后一段选区：林舟推开城门。'
    const source =
      Array.from({ length: 90 }, (_, i) => `第${i + 1}段，正文继续。`).join('\n\n') +
      '\n\n' +
      selected
    await enterText(source)
    const chapter = (await docs()).find((doc) => doc.title === '快捷发送保留编辑位置')!
    await configureSelectionAgent((server.address() as { port: number }).port)
    const input = page.getByRole('textbox', { name: '给 Agent 的消息' })
    const content = page.locator('.cm-content')
    await input.fill('检查这段选区的节奏')
    await content.focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Shift+Home')
    const editorPosition = () =>
      page.evaluate(() => ({
        selected: window.getSelection()?.toString(),
        scrollTop: document.querySelector('.cm-scroller')!.scrollTop,
        focused: Boolean(document.activeElement?.closest('.cm-content'))
      }))
    await expect.poll(async () => (await editorPosition()).selected).toBe(selected)
    const before = await editorPosition()
    expect(before.scrollTop).toBeGreaterThan(0)
    expect(before.focused).toBe(true)
    await content.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      ctrlKey: true,
      keyCode: 229
    })
    await content.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      ctrlKey: true,
      repeat: true
    })
    await expect.poll(editorPosition).toEqual(before)
    await expect(input).toHaveValue('检查这段选区的节奏')
    expect(payloads).toHaveLength(0)
    await page.keyboard.press('Control+Enter')
    await expect.poll(editorPosition).toEqual(before)
    await expect.poll(() => payloads.length).toBe(1)
    const workspace = JSON.parse(
      payloads[0].messages.at(-2).content.split('：').slice(1).join('：')
    )
    expect(payloads[0].messages.at(-1).content).toBe('检查这段选区的节奏')
    expect(workspace.selection).toEqual({
      from: source.lastIndexOf(selected),
      to: source.length,
      text: selected
    })
    expect((await disk(chapter.id)).content).toBe(source)
    await expect(input).toHaveValue('')
    await expect(page.getByRole('button', { name: '取消任务', exact: true })).toBeVisible()

    // A held shortcut and a pending next draft must not alter the editor or send twice.
    await content.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      ctrlKey: true,
      repeat: true
    })
    await input.fill('保留下一条草稿')
    await content.focus()
    await page.keyboard.press('Control+Enter')
    await expect.poll(editorPosition).toEqual(before)
    await expect(input).toHaveValue('保留下一条草稿')
    expect(payloads).toHaveLength(1)
    await page.getByRole('button', { name: '取消任务', exact: true }).click()
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled()

    // IME confirmation must not submit the next nonempty draft.
    await content.focus()
    await content.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      ctrlKey: true,
      isComposing: true
    })
    await expect.poll(editorPosition).toEqual(before)
    await expect(input).toHaveValue('保留下一条草稿')
    expect(payloads).toHaveLength(1)

    await input.fill('')
    await content.focus()
    await page.keyboard.press('Control+Enter')
    await expect.poll(editorPosition).toEqual(before)
    expect(payloads).toHaveLength(1)
    expect((await disk(chapter.id)).content).toBe(source)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('CRLF selection after earlier paragraphs sends source coordinates from both editor and composer', async () => {
  const payloads: any[] = []
  const server = createHttpServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    payloads.push(JSON.parse(raw))
    response.setHeader('Content-Type', 'text/event-stream')
    response.end(
      'data: ' +
        JSON.stringify({
          choices: [{ delta: { content: '已核对选区。' }, finish_reason: 'stop' }]
        }) +
        '\n\ndata: [DONE]\n\n'
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    await newDocument('CRLF 选区章节')
    await enterText('占位正文')
    const chapter = (await docs()).find((doc) => doc.title === 'CRLF 选区章节')!
    await page.getByRole('button', { name: /^速记/ }).click()
    await newDocument('切换文档以重载原文')
    const source = '第一段，尚未选中。\r\n\r\n第二段含有 😀 表情。\r\n\r\n第三段，林舟推开城门。'
    await page.evaluate(
      async ({ id, source }) => {
        const boot = await window.zestloomer.bootstrap()
        if (!boot.ok) throw new Error(boot.message)
        const bookId = boot.value.preferences.lastBookId!
        const read = await window.zestloomer.read(bookId, id)
        if (!read.ok) throw new Error(read.message)
        const saved = await window.zestloomer.save({
          bookId,
          id,
          title: read.value.document.title,
          content: source,
          expectedVersion: read.value.document.version
        })
        if (!saved.ok) throw new Error(saved.message)
      },
      { id: chapter.id, source }
    )
    await page.getByRole('button', { name: /^正文/ }).click()
    await expect(page.locator('.cm-content')).toContainText('第三段，林舟推开城门。')
    await configureSelectionAgent((server.address() as { port: number }).port)
    const input = page.getByRole('textbox', { name: '给 Agent 的消息' })
    const content = page.locator('.cm-content')
    await content.focus()
    await page.keyboard.press('Control+f')
    await page.getByRole('textbox', { name: '查找文字', exact: true }).fill('第二段含有 😀 表情。')
    await page.getByTitle('下一个', { exact: true }).click()
    await page.getByRole('button', { name: '关闭查找', exact: true }).click()
    await expect
      .poll(() => page.evaluate(() => window.getSelection()?.toString()))
      .toBe('第二段含有 😀 表情。')
    await input.fill('从输入框发送第二段')
    await input.press('Control+Enter')
    await expect.poll(() => payloads.length).toBe(1)
    await expect(page.getByRole('region', { name: '本轮进度' })).toContainText('本轮已完成')

    await input.fill('从编辑器发送第三段')
    await content.focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Shift+Home')
    await page.keyboard.press('Control+Enter')
    await expect.poll(() => payloads.length).toBe(2)
    await expect(page.getByRole('region', { name: '本轮进度' })).toContainText('本轮已完成')
    for (const [index, selected] of ['第二段含有 😀 表情。', '第三段，林舟推开城门。'].entries()) {
      const workspace = JSON.parse(
        payloads[index].messages.at(-2).content.split('：').slice(1).join('：')
      )
      expect(workspace.selection).toEqual({
        from: source.indexOf(selected),
        to: source.indexOf(selected) + selected.length,
        text: selected
      })
    }
    expect((await disk(chapter.id)).content).toBe(source)
    expect(payloads.map((payload) => payload.messages.at(-1).content)).toEqual([
      '从输入框发送第二段',
      '从编辑器发送第三段'
    ])
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('workspace layout stays beside the editor, remembers width and preserves chat drafts', async () => {
  await newDocument('第一章：雾中的来信')
  await enterText('凌晨四点，窗外的灯亮了。\n故事从这里继续。')
  await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800)
  )
  await page.getByRole('button', { name: '边写边聊', exact: true }).click()
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '给 Agent 的消息' })).toBeEnabled()
  const first = await page.getByRole('combobox', { name: '选择会话' }).inputValue()
  await page.getByRole('textbox', { name: '给 Agent 的消息' }).fill('尚未发送的故事构想')
  await page.getByRole('button', { name: '收起 Agent' }).click()
  await page.getByRole('button', { name: '边写边聊', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '给 Agent 的消息' })).toHaveValue(
    '尚未发送的故事构想'
  )
  await page.getByRole('button', { name: '新对话', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '给 Agent 的消息' })).toHaveValue('')
  await page.getByRole('combobox', { name: '选择会话' }).selectOption(first)
  await expect(page.getByRole('textbox', { name: '给 Agent 的消息' })).toHaveValue(
    '尚未发送的故事构想'
  )
  await page.getByRole('button', { name: '专注写作', exact: true }).click()
  await expect(page.locator('.sidebar')).toBeHidden()
  await expect(page.locator('.agent-panel')).toBeHidden()
  await expect(page.locator('.cm-content')).toContainText('窗外的灯亮了')
  await page.getByRole('button', { name: '退出专注', exact: true }).click()
  const separator = page.getByRole('separator', { name: '调整 Agent 宽度' })
  const box = (await separator.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 100)
  await page.mouse.down()
  await page.mouse.move(box.x - 44, box.y + 100, { steps: 5 })
  await page.mouse.up()
  const width = (await page.locator('.agent-panel').boundingBox())!.width
  expect(width).toBeGreaterThan(400)
  await expect
    .poll(async () => {
      const state = await page.evaluate(() => window.zestloomer.bootstrap())
      return state.ok && Object.values(state.value.preferences.agentWidths)[0]
    })
    .toBe(width)
  const screenshots = resolve('.test-artifacts/ux-layout-settings')
  await fs.mkdir(screenshots, { recursive: true })
  await page.screenshot({ path: join(screenshots, 'workspace-wide.png') })
  for (const w of [1100, 900]) {
    await electron.evaluate(
      ({ BrowserWindow }, w) => BrowserWindow.getAllWindows()[0].setContentSize(w, 720),
      w
    )
    await expect(page.locator('.document-list')).toBeHidden()
    await expect
      .poll(async () => {
        const editor = (await page.locator('.writing-area').boundingBox())!
        const agent = (await page.locator('.agent-panel').boundingBox())!
        return editor.x + editor.width <= agent.x && editor.width >= 419
      })
      .toBe(true)
    await expect(page.locator('.save-state')).toBeVisible()
    await page.screenshot({ path: join(screenshots, `workspace-${w}.png`) })
  }
  await page.getByRole('button', { name: '切换文档列表' }).click()
  await expect(page.locator('.document-list')).toBeVisible()
  await expect(page.locator('.agent-panel')).toBeHidden()
  await page.getByRole('button', { name: '边写边聊', exact: true }).click()
  await electron.close()
  await launch()
  await expect(page.locator('.agent-panel')).toBeVisible()
  await expect
    .poll(async () => (await page.locator('.agent-panel').boundingBox())!.width)
    .toBe(width)
})

test('settings explicitly save appearance, guard navigation and contain keyboard focus', async () => {
  await newDocument('设置验证')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const settings = page.getByRole('dialog', { name: '设置中心' })
  await expect(page.getByRole('tab', { name: /写作显示/ })).toBeFocused()
  await page.getByRole('spinbutton', { name: '字号', exact: true }).fill('22')
  let saved = await page.evaluate(() => window.zestloomer.bootstrap())
  expect(saved.ok && saved.value.preferences.size).toBe(18)
  await page.getByRole('tab', { name: /AI 接入/ }).click()
  await expect(page.getByRole('alertdialog', { name: '未保存的修改' })).toBeVisible()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: '字号', exact: true })).toHaveValue('22')
  await page.getByRole('button', { name: '保存显示设置' }).click()
  await expect(page.locator('.settings-footer')).toContainText('显示设置已保存')
  const screenshots = resolve('.test-artifacts/ux-layout-settings')
  await fs.mkdir(screenshots, { recursive: true })
  await page.screenshot({ path: join(screenshots, 'settings-writing.png') })
  saved = await page.evaluate(() => window.zestloomer.bootstrap())
  expect(saved.ok && saved.value.preferences.size).toBe(22)
  await page.getByRole('spinbutton', { name: '字号', exact: true }).fill('23')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '放弃修改', exact: true }).click()
  await expect(settings).toBeHidden()
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeFocused()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('spinbutton', { name: '字号', exact: true })).toHaveValue('22')
  await page.getByRole('button', { name: '关闭', exact: true }).focus()
  await page.keyboard.press('Tab')
  expect(
    await page.evaluate(() => Boolean(document.activeElement?.closest('.settings-center')))
  ).toBe(true)
  await page.keyboard.press('Control+f')
  await expect(page.locator('.find-panel')).toBeHidden()
  await electron.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(900, 640)
  )
  await page.getByRole('tab', { name: /AI 接入/ }).click()
  const footer = (await page.locator('.settings-footer').boundingBox())!
  expect(footer.y + footer.height).toBeLessThanOrEqual(640)
  await page.getByRole('tab', { name: /作品与备份/ }).click()
  await expect(page.getByRole('button', { name: '备份完整作品' })).toBeEnabled()
  await page.screenshot({ path: join(screenshots, 'settings-backup-900.png') })
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  await page.getByRole('button', { name: '边写边聊', exact: true }).click()
  await page.getByRole('button', { name: 'AI 设置', exact: true }).click()
  await expect(page.getByRole('tab', { name: /AI 接入/ })).toHaveAttribute('aria-selected', 'true')
})

test('AI settings separate defaults, preserve key identity and invalidate edited probe results', async () => {
  const server = createHttpServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url?.endsWith('/models')) {
      response.end(JSON.stringify({ data: [{ id: 'local-test-model' }] }))
      return
    }
    for await (const _chunk of request) {
      /* drain synthetic probe */
    }
    response.end(
      JSON.stringify({ choices: [{ message: { content: '连接正常' }, finish_reason: 'stop' }] })
    )
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  try {
    await page.getByRole('button', { name: '边写边聊', exact: true }).click()
    await page.getByRole('button', { name: 'AI 设置', exact: true }).click()
    await page.getByRole('textbox', { name: '配置名称', exact: true }).fill('主力模型')
    await page.getByRole('textbox', { name: 'Agent API 地址' }).fill(`http://127.0.0.1:${port}/v1`)
    await page.getByRole('button', { name: '获取模型列表' }).click()
    await expect(page.getByRole('status').filter({ hasText: '已获取 1 个模型' })).toBeVisible()
    await page
      .getByRole('combobox', { name: '已获取的模型', exact: true })
      .selectOption('local-test-model')
    await page.getByLabel('Agent API 密钥', { exact: true }).fill('synthetic-ui-key')
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await expect(page.locator('.probe-row').first()).toContainText('ms')
    await page.getByRole('textbox', { name: 'Agent 模型', exact: true }).fill('edited-model')
    await expect(page.locator('.probe-row').first()).toContainText('需要重新测试')
    await page.getByRole('button', { name: '保存 Agent 配置' }).click()
    await expect(page.locator('.settings-footer')).toContainText('Agent 配置已保存')
    let config = await page.evaluate(() => window.zestloomer.agent.config())
    const firstId = config.ok ? config.value.defaultProfileId! : ''
    expect(config.ok && config.value.hasKey).toBe(true)
    await page.getByRole('combobox', { name: '接入配置', exact: true }).selectOption('new')
    await expect(page.getByText('尚未设置；本地无密钥服务可留空', { exact: true })).toBeVisible()
    await expect(page.getByRole('checkbox', { name: /保留已有密钥/ })).toBeHidden()
    await expect(page.locator('.model-choice option')).toHaveCount(0)
    await page.getByRole('textbox', { name: '配置名称', exact: true }).fill('备用模型')
    await page.getByRole('textbox', { name: 'Agent API 地址' }).fill(`http://127.0.0.1:${port}/v1`)
    await page.getByRole('textbox', { name: 'Agent 模型', exact: true }).fill('backup-model')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Agent 模型', exact: true })).toHaveValue(
      'backup-model'
    )
    await page.getByRole('button', { name: '保存 Agent 配置' }).click()
    await expect(page.locator('.settings-footer')).toContainText('Agent 配置已保存')
    config = await page.evaluate(() => window.zestloomer.agent.config())
    expect(config.ok && config.value.defaultProfileId).toBe(firstId)
    expect(config.ok && config.value.profiles?.length).toBe(2)
    await page.getByRole('checkbox', { name: '保存后设为默认配置', exact: true }).check()
    await page.getByRole('button', { name: '保存 Agent 配置' }).click()
    await expect(page.locator('.config-badge')).toHaveText('当前默认')
    config = await page.evaluate(() => window.zestloomer.agent.config())
    expect(config.ok && config.value.model).toBe('backup-model')
    expect(config.ok && config.value.hasKey).toBe(false)
    await page.getByRole('combobox', { name: '接入配置', exact: true }).selectOption(firstId)
    await expect(page.getByRole('checkbox', { name: /保留已有密钥/ })).toBeChecked()
    await page.getByRole('textbox', { name: '配置名称', exact: true }).fill('尚未保存的名称')
    await page.getByRole('combobox', { name: '接入配置', exact: true }).selectOption('new')
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    await expect(page.getByRole('combobox', { name: '接入配置', exact: true })).toHaveValue(firstId)
    await expect(page.getByRole('textbox', { name: '配置名称', exact: true })).toHaveValue(
      '尚未保存的名称'
    )
    await page.getByRole('tab', { name: /写作显示/ }).click()
    await page.getByRole('button', { name: '放弃修改', exact: true }).click()
    await page.getByRole('tab', { name: /AI 接入/ }).click()
    await expect(page.getByRole('textbox', { name: '配置名称', exact: true })).toHaveValue(
      '主力模型'
    )
    const screenshots = resolve('.test-artifacts/ux-layout-settings')
    await fs.mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, 'settings-ai.png') })
    await page.locator('.settings-content').evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await page.screenshot({ path: join(screenshots, 'settings-ai-checks.png') })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

test('tool API selects saved profiles in AI settings, titles completed conversations and persists independently', async () => {
  test.setTimeout(180000)
  const requests: { body: any; key: string | undefined }[] = []
  const server = createHttpServer(async (request, response) => {
    let text = ''
    for await (const chunk of request) text += chunk
    const body = JSON.parse(text)
    requests.push({ body, key: request.headers.authorization })
    if (body.stream) {
      response.setHeader('Content-Type', 'text/event-stream')
      response.end(
        'data: ' +
          JSON.stringify({
            choices: [
              { delta: { content: '城门应隔日开启，便于城内休整。' }, finish_reason: 'stop' }
            ]
          }) +
          '\n\ndata: [DONE]\n\n'
      )
    } else {
      response.setHeader('Content-Type', 'application/json')
      response.end(
        JSON.stringify({
          choices: [{ message: { content: '标题：“城门开启规则”' }, finish_reason: 'stop' }]
        })
      )
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  try {
    await newDocument('工具 API 验证章')
    await enterText('不得发给工具 API 的原始章节内容。')
    await page.getByRole('button', { name: '边写边聊', exact: true }).click()
    await page.getByRole('button', { name: 'AI 设置', exact: true }).click()
    for (const [name, model, key] of [
      ['写作配置', 'writer-model', 'synthetic-writer-key'],
      ['标题配置', 'title-model', 'synthetic-title-key']
    ]) {
      await page.getByRole('combobox', { name: '接入配置', exact: true }).selectOption('new')
      await page.getByRole('textbox', { name: '配置名称', exact: true }).fill(name)
      await page
        .getByRole('textbox', { name: 'Agent API 地址', exact: true })
        .fill(`http://127.0.0.1:${port}/v1`)
      await page.getByRole('textbox', { name: 'Agent 模型', exact: true }).fill(model)
      await page.getByLabel('Agent API 密钥', { exact: true }).fill(key)
      await page.getByRole('button', { name: '保存 Agent 配置', exact: true }).click()
      await expect(page.locator('.settings-footer')).toContainText('Agent 配置已保存')
    }
    const agentConfig = await page.evaluate(() => window.zestloomer.agent.config())
    if (!agentConfig.ok) throw new Error(agentConfig.message)
    const titleId = agentConfig.value.profiles!.find(
      (profile) => profile.model === 'title-model'
    )!.id
    expect(agentConfig.value.model).toBe('writer-model')
    await page.getByRole('button', { name: '工具 API', exact: true }).click()
    await expect(
      page.getByRole('checkbox', { name: '启用工具 API', exact: true })
    ).not.toBeChecked()
    const picker = page.getByRole('combobox', { name: '工具 API 配置', exact: true })
    await expect(picker).toContainText('写作配置')
    await expect(picker).toContainText('标题配置')
    await picker.selectOption(titleId)
    await page.getByRole('checkbox', { name: '启用工具 API', exact: true }).check()
    await page.getByRole('button', { name: '测试工具 API', exact: true }).click()
    await expect(page.locator('.probe-row')).toContainText('连接正常')
    let toolConfig = await page.evaluate(() => window.zestloomer.tools.config())
    expect(toolConfig.ok && toolConfig.value.enabled).toBe(false)
    expect(requests[0].body.model).toBe('title-model')
    expect(requests[0].key).toBe('Bearer synthetic-title-key')
    expect(JSON.stringify(requests[0].body)).not.toContain('原始章节')
    await page.getByRole('button', { name: '保存工具 API 配置', exact: true }).click()
    await expect(page.locator('.settings-footer')).toContainText('工具 API 配置已保存')
    await picker.selectOption('')
    await expect(page.locator('.probe-row')).toContainText('需要重新测试')
    await page.getByRole('button', { name: 'Agent API', exact: true }).click()
    await expect(page.getByRole('alertdialog', { name: '未保存的修改' })).toBeVisible()
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    await expect(picker).toHaveValue('')
    await page.getByRole('button', { name: 'Agent API', exact: true }).click()
    await page.getByRole('button', { name: '放弃修改', exact: true }).click()
    await page.getByRole('button', { name: '工具 API', exact: true }).click()
    await expect(picker).toHaveValue(titleId)
    const screenshots = resolve('.test-artifacts/ux-tool-api')
    await fs.mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, 'settings-tools.png') })
    await electron.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 720)
    )
    await page.screenshot({ path: join(screenshots, 'settings-tools-900.png') })
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await page.getByRole('textbox', { name: '给 Agent 的消息' }).fill('解释城门开启规则')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.locator('.agent-messages')).toContainText('城门应隔日开启')
    await expect(page.getByRole('combobox', { name: '选择会话', exact: true })).toContainText(
      '城门开启规则'
    )
    const agentRequest = requests.find((request) => request.body.stream)!
    expect(agentRequest.body.model).toBe('writer-model')
    expect(agentRequest.key).toBe('Bearer synthetic-writer-key')
    const titleRequest = requests.filter((request) => !request.body.stream).at(-1)!
    expect(titleRequest.body.model).toBe('title-model')
    expect(titleRequest.body.tools).toBeUndefined()
    expect(titleRequest.body.messages).toHaveLength(2)
    expect(titleRequest.body.messages[1].content).toContain('解释城门开启规则')
    expect(titleRequest.body.messages[1].content).toContain('城门应隔日开启')
    expect(JSON.stringify(titleRequest.body)).not.toContain('原始章节')
    await page.getByRole('textbox', { name: '给 Agent 的消息' }).fill('继续解释')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.locator('.agent-message.user .message-text')).toHaveText([
      '解释城门开启规则',
      '继续解释'
    ])
    await expect(page.getByRole('region', { name: '本轮进度' })).toContainText('本轮已完成')
    expect(requests.filter((request) => !request.body.stream)).toHaveLength(2)
    await electron.close()
    await launch()
    await expect(page.getByRole('combobox', { name: '选择会话', exact: true })).toContainText(
      '城门开启规则'
    )
    await page.getByRole('button', { name: 'AI 设置', exact: true }).click()
    await page.getByRole('button', { name: '工具 API', exact: true }).click()
    await expect(page.getByRole('combobox', { name: '工具 API 配置', exact: true })).toHaveValue(
      titleId
    )
    await expect(page.getByRole('checkbox', { name: '启用工具 API', exact: true })).toBeChecked()
    await page.getByRole('checkbox', { name: '启用工具 API', exact: true }).uncheck()
    await page.getByRole('button', { name: '保存工具 API 配置', exact: true }).click()
    await expect(page.locator('.settings-footer')).toContainText('工具 API 配置已保存')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '新对话', exact: true }).click()
    await page.getByRole('textbox', { name: '给 Agent 的消息' }).fill('关闭工具后保留本地标题')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.locator('.agent-message.user .message-text')).toHaveText([
      '关闭工具后保留本地标题'
    ])
    await expect(page.getByRole('region', { name: '本轮进度' })).toContainText('本轮已完成')
    expect(requests.filter((request) => !request.body.stream)).toHaveLength(2)
    toolConfig = await page.evaluate(() => window.zestloomer.tools.config())
    expect(toolConfig.ok && toolConfig.value).toEqual({ enabled: false, profileId: titleId })
    const saved = JSON.parse(await fs.readFile(join(root, '.zestloomer', 'tool-api.json'), 'utf8'))
    expect(saved).toEqual({ format: 1, enabled: false, profileId: titleId })
    expect(JSON.stringify(saved)).not.toContain('synthetic-')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
