import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import fs from 'node:fs/promises'
import { DocumentStore, atomicWrite } from './documents'
import { consistentTemplate, templateVersion, validateTemplate } from '../shared/templates'
import type { Book, DocumentSnapshot } from '../shared/documents'

export async function migrateTemplates(store: DocumentStore, book: Book, apply = false) {
  const changes: { before: DocumentSnapshot; content: string }[] = []
  const blocked: string[] = []
  for (const meta of await store.list(book.id)) {
    if (meta.trashedAt || !['characters', 'settings'].includes(meta.kind)) continue
    const { document, draft } = await store.read(book.id, meta.id)
    const content = consistentTemplate(document.kind, document.content)
    if (!validateTemplate(document.kind, content)) throw new Error(`模板无法稳定归一：${meta.id}`)
    if (content === document.content) continue
    if (draft) blocked.push(meta.id)
    changes.push({ before: document, content })
  }
  const report = {
    templateVersion,
    bookId: book.id,
    title: book.title,
    applied: false,
    backup: '',
    blocked,
    documents: changes.map(({ before }) => ({
      id: before.id,
      title: before.title,
      version: before.version
    })),
    completed: [] as string[]
  }
  if (!apply || !changes.length) return report
  if (blocked.length) throw new Error(`存在未保存草稿，迁移未执行：${blocked.join(', ')}`)
  // Backup and durable progress report precede the first document write.
  const folder = join(
    book.root,
    '.workspace',
    'migrations',
    `templates-v${templateVersion}-${randomUUID()}`
  )
  await fs.mkdir(folder, { recursive: true })
  report.backup = join(folder, 'before.json')
  await atomicWrite(
    report.backup,
    JSON.stringify(
      changes.map(({ before }) => before),
      null,
      2
    )
  )
  const reportPath = join(folder, 'report.json')
  await atomicWrite(reportPath, JSON.stringify(report, null, 2))
  for (const { before, content } of changes) {
    await store.applyAgent(
      {
        bookId: book.id,
        id: before.id,
        kind: before.kind,
        title: before.title,
        content,
        expectedVersion: before.version,
        operationId: randomUUID(),
        sources: []
      },
      () => {}
    )
    report.completed.push(before.id)
    await atomicWrite(reportPath, JSON.stringify(report, null, 2))
  }
  report.applied = true
  await atomicWrite(reportPath, JSON.stringify(report, null, 2))
  return report
}
