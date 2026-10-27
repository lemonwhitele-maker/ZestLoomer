import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import { atomicWrite } from '../documents'
import { ApiRuntime, endpoint } from './runtime'
import { fail } from './documents'
import { defaultPolicy, modelPolicy } from './budgets'
import type {
  AgentConfig,
  AgentConfigInput,
  AgentProfile,
  ConnectionTestResult
} from '../../shared/agent'

type StoredProfile = Omit<AgentProfile, 'hasKey'> & { encryptedKey: string }
export class AgentConfigStore {
  private profiles: StoredProfile[] = []
  private defaultId = ''
  private queue = Promise.resolve()
  private testing?: AbortController
  constructor(private path: string) {}
  async load(): Promise<void> {
    try {
      const c = JSON.parse(await fs.readFile(this.path, 'utf8'))
      if (
        c.format === 1 &&
        typeof c.baseUrl === 'string' &&
        typeof c.model === 'string' &&
        typeof c.encryptedKey === 'string'
      ) {
        this.profiles = [
          {
            id: 'default',
            label: '原有配置',
            ...defaultPolicy,
            baseUrl: c.baseUrl,
            model: c.model,
            encryptedKey: c.encryptedKey
          }
        ]
        this.defaultId = 'default'
      } else if (
        c.format === 2 &&
        Array.isArray(c.profiles) &&
        c.profiles.every(
          (p: StoredProfile) =>
            typeof p.id === 'string' &&
            /^[a-zA-Z0-9_-]{1,100}$/.test(p.id) &&
            typeof p.label === 'string' &&
            typeof p.baseUrl === 'string' &&
            typeof p.model === 'string' &&
            typeof p.encryptedKey === 'string'
        )
      ) {
        for (const p of c.profiles) {
          endpoint(p.baseUrl)
          modelPolicy(p)
        }
        if (new Set(c.profiles.map((p: StoredProfile) => p.id)).size !== c.profiles.length)
          fail('CONFIG', '接入配置标识重复')
        this.profiles = c.profiles
        this.defaultId = c.defaultProfileId
      } else fail('CONFIG', 'Agent 配置格式无效')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  private profile(id?: string): StoredProfile | undefined {
    const p = this.profiles.find((p) => p.id === (id || this.defaultId))
    if (id && !p) fail('CONFIG', '本会话选择的模型配置不存在，请重新选择')
    return p
  }
  get(id?: string): AgentConfig & Partial<AgentProfile> {
    const p = this.profile(id)
    return {
      ...(p ? { ...modelPolicy(p), id: p.id, label: p.label } : {}),
      baseUrl: p?.baseUrl || '',
      model: p?.model || '',
      hasKey: Boolean(p?.encryptedKey),
      defaultProfileId: this.defaultId,
      profiles: this.profiles.map((p) => ({
        id: p.id,
        label: p.label,
        baseUrl: p.baseUrl,
        model: p.model,
        hasKey: Boolean(p.encryptedKey),
        ...modelPolicy(p)
      }))
    }
  }
  key(id?: string): string {
    const encrypted = this.profile(id)?.encryptedKey
    if (!encrypted) return ''
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch {
      fail('CONFIG', '无法解密已保存密钥，请在设置中重新填写')
    }
  }
  private resolve(input: AgentConfigInput): { config: AgentProfile; key: string } {
    if (
      !input ||
      typeof input.baseUrl !== 'string' ||
      typeof input.model !== 'string' ||
      !input.model.trim() ||
      input.baseUrl.length > 2000 ||
      input.model.length > 200
    )
      fail('CONFIG', '请填写接入地址与模型名称')
    endpoint(input.baseUrl)
    if (input.id !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id))
      fail('CONFIG', '接入配置标识无效')
    if (
      input.apiKey !== undefined &&
      (typeof input.apiKey !== 'string' || input.apiKey.length > 10000)
    )
      fail('CONFIG', '密钥格式无效')
    const existing = input.id === 'new' ? undefined : this.profile(input.id)
    if (
      input.apiKey === undefined &&
      existing?.encryptedKey &&
      input.baseUrl.trim() !== existing.baseUrl
    )
      fail('CONFIG', '接入地址变化时请重新填写密钥，或明确清除密钥')
    const policy = modelPolicy({
      ...defaultPolicy,
      ...(existing ? modelPolicy(existing) : {}),
      ...(input.contextTokens === undefined ? {} : { contextTokens: input.contextTokens }),
      ...(input.outputTokens === undefined ? {} : { outputTokens: input.outputTokens }),
      ...(input.retryOutputTokens === undefined
        ? {}
        : { retryOutputTokens: input.retryOutputTokens }),
      ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning })
    })
    return {
      config: {
        id: existing?.id || randomUUID(),
        label: (input.label || existing?.label || input.model).slice(0, 100),
        baseUrl: input.baseUrl.trim(),
        model: input.model.trim(),
        hasKey: Boolean(input.apiKey || existing?.encryptedKey),
        ...policy
      },
      key: input.apiKey ?? (existing ? this.key(existing.id) : '')
    }
  }
  save(input: AgentConfigInput): Promise<AgentConfig> {
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        const { config, key } = this.resolve(input)
        if (key && !safeStorage.isEncryptionAvailable())
          fail('CONFIG', '系统密钥加密不可用，未保存密钥')
        const { hasKey: _hasKey, ...fields } = config
        const next = {
          ...fields,
          encryptedKey: key ? safeStorage.encryptString(key).toString('base64') : ''
        }
        const profiles = [...this.profiles.filter((p) => p.id !== next.id), next]
        const defaultId = !this.defaultId || input.makeDefault !== false ? next.id : this.defaultId
        await atomicWrite(
          this.path,
          JSON.stringify({ format: 2, defaultProfileId: defaultId, profiles }, null, 2)
        )
        this.profiles = profiles
        this.defaultId = defaultId
        return this.get()
      })
    this.queue = operation.then(() => {})
    return operation
  }
  cancelTest(): void {
    this.testing?.abort(new Error('测试已取消'))
  }
  async test(input: AgentConfigInput, mode: 'connection' | 'tools'): Promise<ConnectionTestResult> {
    if (!['connection', 'tools'].includes(mode)) fail('ARGUMENT', '测试类型无效')
    if (this.testing) fail('BUSY', '接入测试正在进行')
    const { config, key } = this.resolve(input)
    config.outputTokens = Math.min(config.outputTokens, 512)
    config.retryOutputTokens = Math.min(config.retryOutputTokens, 1024)
    const controller = new AbortController()
    this.testing = controller
    const timeout = setTimeout(() => controller.abort(new Error('接入测试超时')), 45000)
    const started = Date.now(),
      nonce = randomUUID()
    try {
      if (mode === 'connection') {
        const runtime = new ApiRuntime(config, key, { tools: [] })
        const result = await runtime.complete(
          [{ role: 'user', content: 'This is a connection test. Reply with a short greeting.' }],
          controller.signal,
          () => {}
        )
        if (!result.text.trim() || result.calls.length)
          fail('TEST_CONNECTION', '未返回正常聊天文本')
      } else {
        const tools = [
          {
            type: 'function',
            function: {
              name: 'zestloomer_connection_probe',
              description: 'Echo a synthetic test value. No files or side effects.',
              parameters: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false
              }
            }
          }
        ]
        const messages = [
          {
            role: 'user' as const,
            content: `Protocol test: call zestloomer_connection_probe exactly once with value ${nonce}. After receiving the tool result, reply with that value.`
          }
        ]
        const first = await new ApiRuntime(config, key, {
          tools,
          toolChoice: { type: 'function', function: { name: 'zestloomer_connection_probe' } }
        }).complete(messages, controller.signal, () => {})
        if (
          first.calls.length !== 1 ||
          first.calls[0].name !== 'zestloomer_connection_probe' ||
          JSON.parse(first.calls[0].arguments).value !== nonce
        )
          fail('TEST_TOOLS', '模型未正确调用测试函数；普通聊天成功不代表支持工具调用')
        const call = first.calls[0]
        const final = await new ApiRuntime(config, key, { tools }).complete(
          [
            ...messages,
            {
              role: 'assistant',
              content: first.text || null,
              tool_calls: [
                {
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.arguments },
                  ...(call.extra_content ? { extra_content: call.extra_content } : {})
                }
              ]
            },
            { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ value: nonce }) }
          ],
          controller.signal,
          () => {}
        )
        if (final.calls.length || !final.text.includes(nonce))
          fail('TEST_TOOLS', '工具结果回传后未得到正确回复')
      }
      return {
        mode,
        elapsedMs: Date.now() - started,
        model: config.model,
        testedAt: new Date().toISOString(),
        message:
          mode === 'connection'
            ? '连接与聊天通过；工具能力需单独测试。'
            : '工具调用、结果回传及最终回复通过。'
      }
    } finally {
      clearTimeout(timeout)
      this.testing = undefined
    }
  }
  async models(input: AgentConfigInput): Promise<string[]> {
    const { config, key } = this.resolve({ ...input, model: input.model || '_catalog_' })
    const url = endpoint(config.baseUrl).replace(/chat\/completions$/, 'models')
    const response = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: 'error',
      headers: key ? { Authorization: `Bearer ${key}` } : {}
    })
    if (!response.ok) {
      await response.body?.cancel()
      fail('MODEL_CATALOG', '模型目录不可用，仍可手工填写模型名')
    }
    const value = (await response.json()) as { data?: { id: string }[] }
    return (value.data || [])
      .filter((p) => typeof p.id === 'string')
      .map((p) => p.id)
      .slice(0, 500)
  }
}
