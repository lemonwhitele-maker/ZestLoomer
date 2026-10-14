/** Local lexical ranking only. Offsets always address the original text. */
export function rankText(
  title: string,
  text: string,
  query: string
): {
  score: number
  start: number
  end: number
  excerpt: string
  fragments: { start: number; end: number; text: string }[]
} | null {
  const normalize = (s: string) => s.toLocaleLowerCase()
  const terms = [...new Set(normalize(query).match(/[\p{L}\p{N}]+/gu) || [])]
  if (!terms.length) return null
  const body = normalize(text),
    heading = normalize(title)
  let score = 0,
    first = -1
  for (const term of terms) {
    const at = body.indexOf(term)
    if (heading.includes(term)) score += 12
    if (at >= 0) {
      score += 4
      if (first < 0 || at < first) first = at
    }
    if (at < 0 && !heading.includes(term) && /\p{Script=Han}/u.test(term) && term.length > 2) {
      const pairs = [
        ...new Set(
          Array.from(term)
            .slice(0, -1)
            .map((c, i) => c + Array.from(term)[i + 1])
        )
      ]
      for (const pair of pairs) {
        const pos = body.indexOf(pair)
        if (pos >= 0) {
          score += 0.5
          if (first < 0 || pos < first) first = pos
        }
        if (heading.includes(pair)) score += 1
      }
    }
  }
  if (!score) return null
  if (body.includes(normalize(query))) score += 8
  const start = Math.max(0, first - 60),
    end = Math.min(text.length, Math.max(0, first) + 240)
  const positions: number[] = []
  for (const term of terms) {
    let at = body.indexOf(term)
    for (let n = 0; at >= 0 && n < 8; n++) {
      positions.push(at)
      at = body.indexOf(term, at + Math.max(1, term.length))
    }
  }
  const fragments: { start: number; end: number; text: string }[] = []
  for (const at of positions.sort((a, b) => a - b)) {
    const from = Math.max(0, at - 60),
      to = Math.min(text.length, at + 180)
    if (fragments.some((f) => from <= f.end && to >= f.start)) continue
    fragments.push({ start: from, end: to, text: text.slice(from, to) })
    if (fragments.length === 3) break
  }
  return { score, start, end, excerpt: text.slice(start, end), fragments }
}
