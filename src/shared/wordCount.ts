/** Existing word semantics: Unicode code points excluding ECMAScript whitespace. */
export function countWords(text: string): number {
  let count = 0
  let previousHigh = false
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    // ECMAScript WhiteSpace + LineTerminator, including NBSP and BOM.
    if (
      (code >= 0x09 && code <= 0x0d) ||
      code === 0x20 ||
      code === 0xa0 ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000 ||
      code === 0xfeff
    )
      continue
    // Removing whitespace first can join otherwise isolated surrogate halves.
    if (!(previousHigh && code >= 0xdc00 && code <= 0xdfff)) count++
    previousHigh = code >= 0xd800 && code <= 0xdbff
  }
  return count
}
