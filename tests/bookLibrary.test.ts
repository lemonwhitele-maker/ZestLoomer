import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { prepareLibrary, storedBook, libraryBooks, locateBooks } from '../src/main/bookLibrary'
import { DocumentStore } from '../src/main/documents'

test('library migration preserves encrypted bytes, existing settings and does not resurrect old keys', async () => {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const temp = await fs.mkdtemp(resolve('.test-artifacts/library-'))
  const legacy = join(temp, 'profile')
  const root = join(temp, 'BookList')
  await fs.mkdir(legacy)
  const ciphertext = JSON.stringify({ encryptedKey: 'synthetic-ciphertext' })
  await fs.writeFile(join(legacy, 'agent.json'), ciphertext)
  const config = await prepareLibrary(root, legacy)
  assert.equal(await fs.readFile(join(config, 'agent.json'), 'utf8'), ciphertext)
  await fs.writeFile(join(config, 'agent.json'), 'new settings')
  await fs.unlink(join(config, 'migration.json'))
  await prepareLibrary(root, legacy)
  assert.equal(await fs.readFile(join(config, 'agent.json'), 'utf8'), 'new settings')
  await fs.unlink(join(config, 'agent.json'))
  await prepareLibrary(root, legacy)
  await assert.rejects(fs.access(join(config, 'agent.json')))
})

test('moving a library recovers books by ID and persists relative paths', async () => {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const temp = await fs.mkdtemp(resolve('.test-artifacts/library-'))
  const root = join(temp, 'before')
  const moved = join(temp, 'after')
  await fs.mkdir(root)
  const book = await new DocumentStore().createBook(root, '迁移作品')
  const saved = storedBook(root, book)
  assert.equal(saved.root.startsWith('Loom-'), true)
  await fs.rename(root, moved)
  const discovered = await libraryBooks(moved)
  const recovered = locateBooks(moved, [book], discovered)
  assert.equal(recovered.length, 1)
  assert.equal((await new DocumentStore().openBook(recovered[0].root)).id, book.id)
  assert.equal(locateBooks(moved, [saved], [])[0].root, recovered[0].root)
  assert.equal(locateBooks(moved, [], discovered).length, 1)
})
