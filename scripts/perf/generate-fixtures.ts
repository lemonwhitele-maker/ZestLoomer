import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import type { DocumentKind, DocumentSnapshot } from '../../src/shared/documents'
import type { Proposal } from '../../src/shared/agent'
import { proposalCandidateHash } from '../../src/main/agent/proposalHash'

function mulberry32(a: number) {
  return function () {
    let t = (a += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
let rand = mulberry32(12345)

function randomUUID() {
  const hex = '0123456789abcdef'
  let uuid = ''
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      uuid += '-'
    } else if (i === 14) {
      uuid += '4'
    } else if (i === 19) {
      uuid += hex[Math.floor(rand() * 4) + 8]
    } else {
      uuid += hex[Math.floor(rand() * 16)]
    }
  }
  return uuid
}

function writeAtomic(filePath: string, data: string) {
  const tmpPath = filePath + '.tmp'
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(tmpPath, data, 'utf-8')
  fs.renameSync(tmpPath, filePath)
}

function generateContent(length: number, specialChars = false): string {
  let content = ''
  const words = [
    'the',
    'quick',
    'brown',
    'fox',
    'jumps',
    'over',
    'lazy',
    'dog',
    'and',
    'then',
    'runs',
    'away',
    'fast'
  ]
  const chinese = [
    '这',
    '是',
    '一',
    '个',
    '测',
    '试',
    '文',
    '档',
    '我',
    '们',
    '在',
    '这',
    '里',
    '写',
    '一',
    '些',
    '内',
    '容'
  ]
  const emojis = ['😀', '🚀', '🌟', '📚', '🔥', '🐛', '✨', '🎈', '🎉', '🍎']

  while (content.length < length) {
    if (specialChars) {
      const r = rand()
      if (r < 0.4) content += words[Math.floor(rand() * words.length)] + ' '
      else if (r < 0.8) content += chinese[Math.floor(rand() * chinese.length)]
      else if (r < 0.9) content += emojis[Math.floor(rand() * emojis.length)]
      else if (r < 0.95) content += '\n'
      else content += '\r\n'
    } else {
      content += words[Math.floor(rand() * words.length)] + ' '
      if (rand() < 0.05) content += '\n'
    }
  }
  return content.slice(0, length)
}

export async function generateFixtures(
  size: string,
  parent = path.resolve('.test-artifacts/perf')
): Promise<string> {
  if (!['S', 'M', 'Long'].includes(size)) {
    throw new Error('Usage: tsx generate-fixtures.ts [S|M|Long]')
  }

  rand = mulberry32(12345 + ['S', 'M', 'Long'].indexOf(size))
  fs.mkdirSync(parent, { recursive: true })
  const outDir = fs.mkdtempSync(path.join(parent, `${size}-`))

  const bookId = `book_${randomUUID()}`
  const book = {
    id: bookId,
    title: `Perf Test Book ${size}`,
    format: 1
  }
  writeAtomic(path.join(outDir, 'book.json'), JSON.stringify(book, null, 2))

  let chaptersCount = 0
  let notesCount = 0
  let charactersCount = 0
  let settingsCount = 0
  let messagesCount = 0
  let proposalsCount = 0
  let isLong = false

  if (size === 'S') {
    chaptersCount = 100
    charactersCount = 25
    settingsCount = 25
    messagesCount = 40
  } else if (size === 'M') {
    chaptersCount = 1000
    charactersCount = 250
    settingsCount = 250
    messagesCount = 400
    proposalsCount = 20
  } else if (size === 'Long') {
    isLong = true
    chaptersCount = 2
  }

  const now = '2026-01-01T00:00:00.000Z'
  let orderCounter = 1
  const generateDoc = (kind: DocumentKind, length: number, useSpecialChars: boolean = false) => {
    const id = `doc_${randomUUID()}`
    const generation = randomUUID()
    const docPath = path.join(outDir, kind, id)
    const content = generateContent(length, useSpecialChars)
    const ext = kind === 'chapters' ? 'txt' : 'md'
    writeAtomic(path.join(docPath, `content.${ext}`), content)

    const meta = {
      id,
      kind,
      title: `Test ${kind} ${orderCounter}`,
      order: orderCounter++,
      createdAt: now,
      updatedAt: now,
      generation,
      trashedAt: null
    }
    writeAtomic(path.join(docPath, 'meta.json'), JSON.stringify(meta, null, 2))
    const snapshot = { ...meta, content }
    return {
      ...snapshot,
      version: createHash('sha256')
        .update(JSON.stringify(snapshot, null, 2) + '\n')
        .digest('hex')
    }
  }

  const docs: DocumentSnapshot[] = []
  if (isLong) {
    docs.push(generateDoc('chapters', 50000, true))
    docs.push(generateDoc('chapters', 200000, true))
  } else {
    for (let i = 0; i < chaptersCount; i++) docs.push(generateDoc('chapters', 5000))
    for (let i = 0; i < notesCount; i++) docs.push(generateDoc('notes', 1000))
    for (let i = 0; i < charactersCount; i++) docs.push(generateDoc('characters', 1000))
    for (let i = 0; i < settingsCount; i++) docs.push(generateDoc('settings', 1000))
  }

  const convId = `conversation_${randomUUID()}`
  if (messagesCount > 0) {
    const messages = []
    for (let i = 0; i < messagesCount; i++) {
      messages.push({
        id: `msg_${randomUUID()}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: generateContent(200),
        sources: [],
        createdAt: now,
        turnId: `turn_${randomUUID()}`,
        outcome: 'completed'
      })
    }
    const conv = {
      format: 1,
      id: convId,
      bookId,
      title: 'Test Conversation',
      updatedAt: now,
      messages,
      summary: 'Summary',
      coveredMessages: 0
    }
    writeAtomic(
      path.join(outDir, '.workspace', 'conversations', `${convId}.json`),
      JSON.stringify(conv, null, 2)
    )
  }

  if (proposalsCount > 0) {
    for (let i = 0; i < proposalsCount; i++) {
      const propId = `proposal_${randomUUID()}`
      const doc = docs[i % docs.length]
      const prop: Proposal = {
        format: 1,
        id: propId,
        bookId,
        conversationId: convId,
        turnId: `turn_${randomUUID()}`,
        operation: 'edit',
        targetId: doc ? doc.id : `doc_${randomUUID()}`,
        kind: doc ? doc.kind : 'chapters',
        title: 'Test Proposal',
        before: doc,
        content: generateContent(500),
        candidateHash: '',
        sources: [],
        reason: 'Reason',
        state: 'pending',
        createdAt: now
      }
      prop.candidateHash = proposalCandidateHash(prop)
      writeAtomic(
        path.join(outDir, '.workspace', 'proposals', `${propId}.json`),
        JSON.stringify(prop, null, 2)
      )
    }
  }

  return outDir
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  generateFixtures(process.argv[2])
    .then((root) => console.log(`Generated dataset in ${root}`))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
