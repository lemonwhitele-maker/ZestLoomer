import type { DocumentKind, Result } from './documents'

export interface ImportItem {
  kind: DocumentKind
  title: string
  content: string
}
export interface ImportDraft {
  sourceLabel: string
  bookTitle?: string
  items: ImportItem[]
  warnings: string[]
  rawContent?: string
  sourceFormat?: 'text' | 'markdown'
}
export interface ImportAPI {
  chooseFile(encoding: 'utf8' | 'gb18030'): Promise<Result<ImportDraft | null>>
}
export interface TextImportOptions {
  markdown?: boolean
  split?: boolean
  kind?: DocumentKind
}

/** The source is sliced at line boundaries, preserving its line endings and body whitespace. */
export function parseTextImport(
  source: string,
  sourceLabel: string,
  options: TextImportOptions = {}
): ImportDraft {
  const rawContent = source.replace(/^\uFEFF/, '')
  const markdown = options.markdown ?? /\.(?:md|markdown)$/i.test(sourceLabel)
  const split = options.split ?? !markdown
  const kind = options.kind ?? 'chapters'
  const title =
    sourceLabel.replace(/^.*[\\/]/, '').replace(/\.(?:txt|md|markdown)$/i, '') || '导入文档'
  const warnings: string[] = []
  const draft: ImportDraft = {
    sourceLabel,
    bookTitle: title,
    items: [],
    warnings,
    rawContent,
    sourceFormat: markdown ? 'markdown' : 'text'
  }
  if (!rawContent.trim()) throw new Error('文件没有可导入的文字。')
  if (!split) {
    draft.items = [{ kind, title, content: rawContent }]
    return draft
  }
  const headings: {
    start: number
    body: number
    title: string
    level: number
    chapter: boolean
  }[] = []
  let fenced: { marker: string; length: number } | null = null
  for (const match of rawContent.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    if (!match[0]) continue
    const line = match[0].replace(/[\r\n]+$/, '').trim()
    const fence = markdown ? /^(`{3,}|~{3,})(.*)$/.exec(line) : null
    if (fence) {
      if (!fenced) fenced = { marker: fence[1][0], length: fence[1].length }
      else if (
        fence[1][0] === fenced.marker &&
        fence[1].length >= fenced.length &&
        !fence[2].trim()
      )
        fenced = null
      continue
    }
    if (fenced || line.length > 200) continue
    const md = markdown ? /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?$/.exec(line) : null
    const candidate = md ? md[2].trim() : line
    const numbered =
      /^第[ \t]*[0-9０-９零〇一二三四五六七八九十百千万亿两壹贰叁肆伍陆柒捌玖拾佰仟]+[ \t]*[章节回集部](?:.*)$/.test(
        candidate
      )
    const special =
      /^(?:序章|序言|序幕|楔子|引子|前言|后记|尾声|终章|番外)(?:$|[ \t\u3000:：·—（(0-9０-９一二三四五六七八九十].*)/.test(
        candidate
      )
    const numeric = /^[0-9０-９]{1,6}[.．、][ \t\u3000]+\S/.test(candidate)
    if (!md && !numbered && !special && !numeric) continue
    headings.push({
      start: match.index!,
      body: match.index! + match[0].length,
      title: candidate,
      level: md?.[1].length ?? 0,
      chapter: numbered || special || numeric
    })
  }
  // Plain chapter headings take priority. Otherwise Markdown splits at its highest heading level.
  const chapterHeadings = headings.filter((heading) => heading.chapter)
  const level = Math.min(
    ...headings.filter((heading) => heading.level).map((heading) => heading.level)
  )
  const boundaries = chapterHeadings.length
    ? chapterHeadings
    : headings.filter((heading) => heading.level === level)
  if (!boundaries.length) {
    draft.items = [{ kind, title, content: rawContent }]
    warnings.push('没有识别到章节标题，将整份文件作为一篇导入。')
    return draft
  }
  const prefix = rawContent.slice(0, boundaries[0].start)
  if (prefix.trim()) {
    draft.items.push({ kind, title: `${title} · 开篇文字`, content: prefix })
    warnings.push('第一处章节标题之前的文字已单独保留为“开篇文字”。')
  }
  boundaries.forEach((heading, index) => {
    const content =
      (index === 0 && !prefix.trim() ? prefix : '') +
      rawContent.slice(heading.body, boundaries[index + 1]?.start ?? rawContent.length)
    draft.items.push({ kind, title: heading.title, content })
  })
  warnings.push('已把识别到的标题行作为文档标题，请在预览中核对拆分结果。')
  const titles = new Set<string>()
  for (const item of draft.items) {
    if (titles.has(item.title)) warnings.push(`重复标题“${item.title}”已保留，请核对。`)
    titles.add(item.title)
  }
  return draft
}
