function names(value: string): string[] {
  return value
    .trim()
    .replace(/^\[|\]$/g, '')
    .split(/[,，、;；|｜]/)
    .map((name) =>
      name
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .trim()
    )
    .filter(Boolean)
}

function withoutYamlComment(value: string): string {
  let quote = ''
  let tokenStart = true
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (quote) {
      if (quote === '"' && character === '\\') index++
      else if (character === quote) {
        if (quote === "'" && value[index + 1] === "'") index++
        else quote = ''
      }
      continue
    }
    if (character === '#' && (index === 0 || /\s/.test(value[index - 1])))
      return value.slice(0, index)
    if (tokenStart && (character === "'" || character === '"')) {
      quote = character
      tokenStart = false
    } else if (character === '[' || character === ',') tokenStart = true
    else if (!/\s/.test(character)) tokenStart = false
  }
  return value
}

function yamlName(value: string): string | undefined {
  const name = withoutYamlComment(value).trim()
  if (!name || ['[', ']', '{', '}', ',', '>', '|'].includes(name[0])) return undefined
  if (name.startsWith("'"))
    return /^'(?:[^']|'')*'$/.test(name) ? name.slice(1, -1).replace(/''/g, "'") : undefined
  if (name.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(name)
      return typeof decoded === 'string' ? decoded : undefined
    } catch {
      return undefined
    }
  }
  return /:\s/.test(name) ? undefined : name
}

function yamlArray(value: string): string[] {
  const array = withoutYamlComment(value).trim()
  if (!array.startsWith('[') || !array.endsWith(']')) return []
  const parts: string[] = []
  let part = ''
  let quote = ''
  const body = array.slice(1, -1)
  for (let index = 0; index < body.length; index++) {
    const character = body[index]
    if (quote) {
      part += character
      if (quote === '"' && character === '\\') part += body[++index] ?? ''
      else if (character === quote) {
        if (quote === "'" && body[index + 1] === "'") part += body[++index]
        else quote = ''
      }
      continue
    }
    if (character === ',') {
      parts.push(part)
      part = ''
      continue
    }
    if (!part.trim() && (character === "'" || character === '"')) quote = character
    part += character
  }
  if (quote) return []
  parts.push(part)
  return parts.flatMap((value) => {
    const name = yamlName(value)
    return name ? [name] : []
  })
}

/** Author-written alias fields, migration records, YAML and alias headings. */
export function parseKnowledgeAliases(content: string): string[] {
  const aliases: string[] = []
  const lines = content.split(/\r?\n/)
  let fence: { character: string; length: number } | undefined
  let inYaml = false
  let yamlAliases = false
  let yamlIndent: number | undefined
  let sectionAliases = false

  for (const [index, line] of lines.entries()) {
    if (index === 0 && /^\uFEFF?---\s*$/.test(line)) {
      inYaml = true
      continue
    }
    if (inYaml) {
      if (/^(?:---|\.\.\.)\s*$/.test(line)) {
        inYaml = false
        yamlAliases = false
        continue
      }
      // Frontmatter only contributes its top-level aliases array, never nested
      // fields, prose scalars or Markdown-looking content in another YAML value.
      const field = /^aliases[ \t]*:[ \t]*(.*)$/i.exec(line)
      if (field) {
        const value = withoutYamlComment(field[1]).trim()
        yamlAliases = !value
        yamlIndent = undefined
        if (value) aliases.push(...yamlArray(value))
        continue
      }
      if (yamlAliases && line.trim() && !/^\s*#/.test(line)) {
        const item = /^([ \t]*)-[ \t]+(.*)$/.exec(line)
        if (item && (yamlIndent === undefined || item[1].length === yamlIndent)) {
          yamlIndent = item[1].length
          const name = yamlName(item[2])
          if (name) aliases.push(name)
        } else if (yamlIndent === undefined || /^\s*/.exec(line)![0].length <= yamlIndent)
          yamlAliases = false
      }
      continue
    }
    const fenceMarker = /^\s*(?:>\s*)?(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (
        fenceMarker &&
        fenceMarker[1][0] === fence.character &&
        fenceMarker[1].length >= fence.length &&
        !fenceMarker[2].trim()
      )
        fence = undefined
      continue
    }
    if (fenceMarker) {
      fence = { character: fenceMarker[1][0], length: fenceMarker[1].length }
      sectionAliases = false
      continue
    }

    const heading = /^\s*(?:>\s*)?#{1,6}\s+(.+?)\s*$/.exec(line)
    if (heading) {
      const title = heading[1].replace(/\s+#+$/, '').replace(/^\*\*|\*\*$/g, '')
      sectionAliases = /^(?:别名|别称|化名|aliases)$/i.test(title)
      continue
    }
    if (!line.trim()) continue

    // Pipe-separated fields retain the source record used by migrated documents.
    let labelled = false
    let aliasContinuation = false
    for (const field of line.split(/[|｜]/)) {
      const match =
        /^\s*(?:>\s*)?(?:[-*+]\s+)?(?:\*\*)?(?:别名|别称|化名|aliases)(?:\*\*)?[ \t]*[:：](?:\*\*)?[ \t]*(.*)$/i.exec(
          field
        )
      if (!match) {
        if (aliasContinuation && !/[:：]/.test(field)) aliases.push(...names(field))
        else aliasContinuation = false
        continue
      }
      labelled = true
      aliasContinuation = true
      aliases.push(...names(match[1]))
    }
    if (labelled) continue

    const item = /^\s*(?:>\s*)?[-*+]\s+(.+)$/.exec(line)
    if (sectionAliases) {
      if (item) aliases.push(...names(item[1]))
      else {
        sectionAliases = false
      }
    }
  }
  return [...new Set(aliases)]
}
