import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { atomicWrite } from './documents'
import type { Book } from '../shared/documents'

/** Configuration travels with the library; Chromium caches remain in userData. */
export async function prepareLibrary(root: string, legacy: string): Promise<string> {
  const config = join(root, '.loom')
  await fs.mkdir(config, { recursive: true })
  const marker = join(config, 'migration.json')
  try {
    await fs.access(marker)
    return config
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  for (const name of ['agent.json', 'tool-api.json', 'workspace.json']) {
    try {
      // Preserve encrypted bytes and never replace an existing library setting.
      await fs.copyFile(join(legacy, name), join(config, name), constants.COPYFILE_EXCL)
    } catch (error) {
      if (!['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code || '')) throw error
    }
  }
  await atomicWrite(marker, JSON.stringify({ format: 1 }))
  return config
}

export function storedBook(root: string, book: Book): Book {
  const path = relative(root, book.root)
  const inside = path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
  return { ...book, root: inside ? path || '.' : book.root }
}

export async function libraryBooks(root: string): Promise<Book[]> {
  const books: Book[] = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const folder = join(root, entry.name)
    try {
      const meta = JSON.parse(await fs.readFile(join(folder, 'book.json'), 'utf8'))
      if (meta.format === 1 && typeof meta.id === 'string' && typeof meta.title === 'string')
        books.push({ id: meta.id, title: meta.title, format: 1, root: folder })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return books
}

export function locateBooks(root: string, previous: Book[], discovered: Book[]): Book[] {
  const result = previous.map((book) => ({
    ...book,
    root: discovered.find((item) => item.id === book.id)?.root || resolve(root, book.root)
  }))
  return [...result, ...discovered.filter((book) => !result.some((item) => item.id === book.id))]
}
