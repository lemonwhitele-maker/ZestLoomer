import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { atomicWrite } from '../documents'
import { defaultHeavySettings, type HeavyAgentSettings } from '../../shared/heavyAgent'

export function validateHeavySettings(value: unknown): HeavyAgentSettings {
  const v = value as HeavyAgentSettings
  if (
    !v ||
    v.schemaVersion !== 1 ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0 ||
    ['appendPrompt', 'chapterOutline', 'chapterContext', 'previousContext'].some(
      (k) => typeof v[k as keyof HeavyAgentSettings] !== 'boolean'
    ) ||
    typeof v.prompt !== 'string' ||
    !Number.isSafeInteger(v.previousTailChars) ||
    v.previousTailChars < 1 ||
    v.previousTailChars > 1000000
  )
    throw new Error('超重agent 配置损坏或格式无效，未覆盖原文件')
  return structuredClone(v)
}

/** Custom settings live beside the API settings in the selected BookList. */
export class HeavySettingsStore {
  private queue = Promise.resolve()
  private migration?: Promise<void>
  constructor(
    private root: string,
    private legacyPointer?: string
  ) {}
  private async migrate(): Promise<void> {
    const folder = join(this.root, '.loom')
    const path = join(folder, 'agent-settings.json')
    const marker = join(folder, 'heavy-settings-migration.json')
    await fs.mkdir(folder, { recursive: true })
    try {
      await fs.access(marker)
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    try {
      await fs.access(path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      if (this.legacyPointer) {
        let pointer: { root: string } | undefined
        try {
          pointer = JSON.parse(await fs.readFile(this.legacyPointer, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (pointer) {
          if (typeof pointer.root !== 'string' || !isAbsolute(pointer.root))
            throw new Error('旧超重agent 配置位置无效，请修复后重试')
          const source = join(pointer.root, '.loom', 'agent-settings.json')
          validateHeavySettings(JSON.parse(await fs.readFile(source, 'utf8')))
          try {
            await fs.copyFile(source, path, constants.COPYFILE_EXCL)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          }
        }
      }
    }
    let hasSettings = true
    try {
      await fs.access(path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      hasSettings = false
    }
    await atomicWrite(marker, JSON.stringify({ schemaVersion: 1, hasSettings }))
  }
  async read(): Promise<{ root: string; settings: HeavyAgentSettings }> {
    this.migration ??= this.migrate().catch((error) => {
      this.migration = undefined
      throw error
    })
    await this.migration
    try {
      return {
        root: this.root,
        settings: validateHeavySettings(
          JSON.parse(await fs.readFile(join(this.root, '.loom', 'agent-settings.json'), 'utf8'))
        )
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      const marker = JSON.parse(
        await fs.readFile(join(this.root, '.loom', 'heavy-settings-migration.json'), 'utf8')
      )
      if (marker.hasSettings)
        throw new Error('BookList 中已保存的超重agent 配置缺失，请恢复文件后重试')
      return { root: this.root, settings: structuredClone(defaultHeavySettings) }
    }
  }
  save(input: HeavyAgentSettings): Promise<{ root: string; settings: HeavyAgentSettings }> {
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        const settings = validateHeavySettings(input)
        const current = await this.read()
        const root = this.root
        await fs.access(root)
        const path = join(root, '.loom', 'agent-settings.json')
        const existing = current.settings
        if (settings.revision !== existing.revision)
          throw new Error('超重agent 配置已变化，请重新加载后保存')
        await fs.mkdir(join(root, '.loom'), { recursive: true })
        const lock = await fs.open(`${path}.lock`, 'wx').catch(() => {
          throw new Error('超重agent 配置正在保存，请稍后重试')
        })
        try {
          // Recheck disk after acquiring the inter-process lock.
          try {
            const disk = validateHeavySettings(JSON.parse(await fs.readFile(path, 'utf8')))
            if (disk.revision !== existing.revision)
              throw new Error('超重agent 配置已变化，请重新加载')
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || existing.revision !== 0) throw e
          }
          const next = { ...settings, revision: existing.revision + 1 }
          await atomicWrite(path, JSON.stringify(next, null, 2))
          const verified = validateHeavySettings(JSON.parse(await fs.readFile(path, 'utf8')))
          if (JSON.stringify(verified) !== JSON.stringify(next))
            throw new Error('超重agent 配置读回校验失败')
          await atomicWrite(
            join(root, '.loom', 'heavy-settings-migration.json'),
            JSON.stringify({ schemaVersion: 1, hasSettings: true })
          )
          return { root, settings: verified }
        } finally {
          await lock.close()
          await fs.unlink(`${path}.lock`)
        }
      })
    this.queue = operation.then(
      () => {},
      () => {}
    )
    return operation
  }
}
