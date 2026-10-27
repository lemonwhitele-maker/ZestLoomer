import { statSync } from 'node:fs'
import { join } from 'node:path'
import { environmentValue } from '../shared/environment'

function directoryExists(path: string): boolean {
  try {
    if (!statSync(path).isDirectory()) throw new Error(`配置位置不是文件夹：${path}`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Reuse existing legacy data in place, including encrypted keys and Chromium caches. */
function compatibleDirectory(parent: string, current: string, legacy: string): string {
  const next = join(parent, current)
  if (directoryExists(next)) return next
  const previous = join(parent, legacy)
  return directoryExists(previous) ? previous : next
}

export function userDataDirectory(
  appData: string,
  env: Record<string, string | undefined> = process.env
): string {
  return environmentValue('USER_DATA', env) || compatibleDirectory(appData, 'ZestLoomer', 'Loom')
}

export function libraryConfigDirectory(root: string): string {
  return compatibleDirectory(root, '.zestloomer', '.loom')
}
