export interface NamingRule {
  mode: 'free' | 'number' | 'hanzi'
  suffix: string
  start: number
  padding: number
  /** An empty template uses the mode, suffix and padding. */
  template: string
}

export const defaultNamingRule: NamingRule = {
  mode: 'free',
  suffix: '章',
  start: 1,
  padding: 0,
  template: ''
}

const maxNumber = 999999
const digits = '零一二三四五六七八九'

export function validateNamingRule(rule: NamingRule): string | null {
  if (!rule || !['free', 'number', 'hanzi'].includes(rule.mode)) return '请选择有效的命名方式。'
  if (
    typeof rule.suffix !== 'string' ||
    !rule.suffix.trim() ||
    rule.suffix.length > 10 ||
    /[\r\n{}]/.test(rule.suffix)
  )
    return '编号后缀应为 1–10 个字符，不能包含换行或花括号。'
  if (!Number.isInteger(rule.start) || rule.start < 1 || rule.start > maxNumber)
    return '起始编号应为 1–999999 的整数。'
  if (!Number.isInteger(rule.padding) || rule.padding < 0 || rule.padding > 6)
    return '补零位数应为 0–6 的整数。'
  if (
    typeof rule.template !== 'string' ||
    rule.template.length > 160 ||
    /[\r\n]/.test(rule.template)
  )
    return '命名模板应不超过 160 个字符，不能包含换行。'
  if (rule.template) {
    const remainder = rule.template.replace(/\{(?:n|cn|title|n:0?[1-6])\}/g, '')
    if (/[{}]/.test(remainder))
      return '模板只支持 {n}、{cn}、{title} 和 {n:03} 等编号占位符（最多 6 位）。'
    if (!/\{(?:n|cn|n:0?[1-6])\}/.test(rule.template)) return '自定义模板需要包含编号占位符。'
  }
  return null
}

export function chineseNumber(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > maxNumber)
    throw new Error('编号应为 1–999999 的整数。')
  const group = (n: number): string => {
    let result = '',
      pendingZero = false
    for (const [unit, label] of [
      [1000, '千'],
      [100, '百'],
      [10, '十'],
      [1, '']
    ] as const) {
      const digit = Math.floor(n / unit)
      n %= unit
      if (digit) {
        if (pendingZero) result += '零'
        result += digits[digit] + label
        pendingZero = false
      } else if (result && n) pendingZero = true
    }
    return result
  }
  if (value < 10000) return group(value).replace(/^一十/, '十')
  const high = Math.floor(value / 10000),
    low = value % 10000
  return `${group(high)}万${low ? (low < 1000 ? '零' : '') + group(low) : ''}`.replace(
    /^一十/,
    '十'
  )
}

export function formatChapterTitle(rule: NamingRule, number: number, title: string): string {
  const error = validateNamingRule(rule)
  if (error) throw new Error(error)
  const subtitle = title.trim()
  if (rule.mode === 'free') return subtitle
  const cn = chineseNumber(number)
  const n = String(number).padStart(rule.padding, '0')
  if (!rule.template)
    return `第${rule.mode === 'hanzi' ? cn : n}${rule.suffix.trim()}${subtitle ? ` ${subtitle}` : ''}`
  return rule.template
    .replace(/\{(n|cn|title|n:0?[1-6])\}/g, (_token, key: string) => {
      if (key === 'title') return subtitle
      if (key === 'cn') return cn
      if (key === 'n') return n
      return String(number).padStart(Number(key.slice(2)), '0')
    })
    .trim()
}

function readChineseNumber(source: string): number | null {
  const normalized = source.replace(/[〇○]/g, '零').replace(/[两兩]/g, '二')
  if (/^[零一二三四五六七八九]+$/.test(normalized)) {
    const value = Number([...normalized].map((digit) => digits.indexOf(digit)).join(''))
    return value >= 1 && value <= maxNumber ? value : null
  }
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 }
  let value = 0,
    section = 0,
    digit = 0,
    lastUnit = 10000,
    hasDigit = false
  for (const char of normalized) {
    const d = digits.indexOf(char)
    if (d >= 0) {
      if (hasDigit && digit !== 0) return null
      digit = d
      hasDigit = true
      continue
    }
    const unit = units[char]
    if (!unit) return null
    if (unit === 10000) {
      if (value || (!section && !digit)) return null
      value = (section + digit) * unit
      section = 0
      lastUnit = 10000
    } else {
      if (unit >= lastUnit || (!hasDigit && (unit !== 10 || section !== 0))) return null
      section += (hasDigit ? digit : 1) * unit
      lastUnit = unit
    }
    digit = 0
    hasDigit = false
  }
  value += section + digit
  return value >= 1 && value <= maxNumber ? value : null
}

export function parseChapterTitle(title: string): { number: number | null; subtitle: string } {
  const trimmed = title.trim()
  const match =
    trimmed.match(
      /^(?:第\s*)?([0-9０-９]+|[零〇○一二两兩三四五六七八九十百千万]+)\s*(?:章|回|节|節|话|話|集|篇|卷|部)[\s:：、.．\-—]*(.*)$/
    ) || trimmed.match(/^([0-9０-９]+)[\s.．、:：\-—]+(.+)$/)
  if (!match) return { number: null, subtitle: trimmed }
  const source = match[1].replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xff10))
  const value = /^\d+$/.test(source) ? Number(source) : readChineseNumber(source)
  if (value === null || !Number.isSafeInteger(value) || value < 1 || value > maxNumber)
    return { number: null, subtitle: trimmed }
  return { number: value, subtitle: match[2].trim() }
}

export interface ChapterItem {
  id: string
  title: string
  createdAt?: string
}
export interface ChapterDiagnostics {
  unmatched: ChapterItem[]
  duplicates: { number: number; items: ChapterItem[] }[]
  /** Missing ranges between recognized chapter numbers; custom starting numbers are respected. */
  gaps: { start: number; end: number }[]
}

export function chapterDiagnostics(items: readonly ChapterItem[]): ChapterDiagnostics {
  const unmatched: ChapterItem[] = [],
    groups = new Map<number, ChapterItem[]>()
  for (const item of items) {
    const number = parseChapterTitle(item.title).number
    if (number === null) unmatched.push(item)
    else groups.set(number, [...(groups.get(number) || []), item])
  }
  const numbers = [...groups.keys()].sort((a, b) => a - b)
  const gaps: ChapterDiagnostics['gaps'] = []
  for (let index = 1; index < numbers.length; index++) {
    const previous = numbers[index - 1],
      current = numbers[index]
    if (current - previous > 1) gaps.push({ start: previous + 1, end: current - 1 })
  }
  return {
    unmatched,
    gaps,
    duplicates: [...groups]
      .filter(([, group]) => group.length > 1)
      .map(([number, group]) => ({ number, items: group }))
  }
}

/** Only recognized chapter slots are sorted; prologues and extras keep their positions. */
export function sortChapters<T extends ChapterItem>(
  items: readonly T[],
  mode: 'number' | 'natural' | 'created'
): T[] {
  const stable = items.map((item, index) => ({
    item,
    index,
    number: parseChapterTitle(item.title).number
  }))
  if (mode === 'number') {
    const numbered = stable
      .filter((entry) => entry.number !== null)
      .sort((a, b) => a.number! - b.number! || a.index - b.index)
    let index = 0
    return stable.map((entry) => (entry.number === null ? entry.item : numbered[index++].item))
  }
  const collator = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' })
  return stable
    .sort((a, b) => {
      const compare =
        mode === 'natural'
          ? collator.compare(a.item.title, b.item.title)
          : (a.item.createdAt || '').localeCompare(b.item.createdAt || '')
      return compare || a.index - b.index
    })
    .map((entry) => entry.item)
}

/** Unnumbered titles are intentionally left intact and do not consume a number. */
export function renumberChapters<T extends ChapterItem>(
  items: readonly T[],
  rule: NamingRule
): { id: string; title: string }[] {
  const error = validateNamingRule(rule)
  if (error) throw new Error(error)
  let number = rule.start
  return items.map((item) => {
    const parsed = parseChapterTitle(item.title)
    return {
      id: item.id,
      title:
        parsed.number === null || rule.mode === 'free'
          ? item.title
          : formatChapterTitle(rule, number++, parsed.subtitle)
    }
  })
}

/** Format recognized chapter titles while retaining their existing chapter numbers. */
export function formatChapterTitles<T extends ChapterItem>(
  items: readonly T[],
  rule: NamingRule
): { id: string; title: string }[] {
  const error = validateNamingRule(rule)
  if (error) throw new Error(error)
  return items.map((item) => {
    const parsed = parseChapterTitle(item.title)
    return {
      id: item.id,
      title:
        parsed.number === null || rule.mode === 'free'
          ? item.title
          : formatChapterTitle(rule, parsed.number, parsed.subtitle)
    }
  })
}
