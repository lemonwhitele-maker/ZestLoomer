import type { DocumentKind } from './documents'
import { lineSeparator, normalizeLineEndings } from './lineEndings'

export type TemplateChoice = 'basic' | 'blank'
export const templates = {
  characters: '### 核心定位\n\n### 外貌与衣着\n\n### 当前状态\n\n### 事实与经历\n',
  settings: '### 定义\n\n### 规则与边界\n\n### 具体内容与记录\n'
} as const
export function initialContent(kind: DocumentKind, choice: TemplateChoice): string {
  if (kind === 'foreshadows')
    return JSON.stringify({ content: '', startChapterId: null, endChapterId: null }, null, 2) + '\n'
  return choice === 'basic' && (kind === 'characters' || kind === 'settings') ? templates[kind] : ''
}

export const templateVersion = 2
const headings = {
  characters: ['核心定位', '外貌与衣着', '当前状态', '事实与经历'],
  settings: ['定义', '规则与边界', '具体内容与记录']
} as const

// Only known historical headings are renamed; no inference about story facts.
export function consistentTemplate(kind: DocumentKind, content: string): string {
  if (kind !== 'characters' && kind !== 'settings') return content
  const required: readonly string[] = headings[kind]
  const aliases: Record<string, string> =
    kind === 'characters'
      ? { 外貌特征: '外貌与衣着', 已确认事实: '事实与经历' }
      : { 已确认事实: '具体内容与记录' }
  const sections = new Map<string, string[]>()
  const prefix: string[] = []
  let current = prefix
  let fence = ''
  for (const line of normalizeLineEndings(content, '\n').split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = marker
      else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        /^\s*[`~]+\s*$/.test(line)
      )
        fence = ''
      current.push(line)
      continue
    }
    const match = !fence && /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line)
    const heading = match ? (aliases[match[1]] ?? match[1]) : ''
    if (required.includes(heading)) {
      const body = sections.get(heading) ?? []
      if (sections.has(heading)) body.push('')
      sections.set(heading, body)
      current = body
    } else current.push(line)
  }
  if (fence) current.push(fence)
  // Keep preambles (including aliases/source records) visible and untouched in meaning.
  // Unstructured prose goes into the record section without guessing its category.
  let preamble = prefix.join('\n').trim()
  if (!sections.size && preamble) {
    sections.set(required.at(-1)!, [preamble])
    preamble = ''
  }
  const result =
    [
      ...(preamble ? [preamble] : []),
      ...required.map((heading) => {
        const body = (sections.get(heading) ?? []).join('\n').trim()
        return `### ${heading}${body ? `\n\n${body}` : ''}`
      })
    ].join('\n\n') + '\n'
  return normalizeLineEndings(result, lineSeparator(content))
}

export function validateTemplate(kind: DocumentKind, content: string): boolean {
  return consistentTemplate(kind, content) === content
}
