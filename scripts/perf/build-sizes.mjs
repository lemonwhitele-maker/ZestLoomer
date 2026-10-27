import fs from 'node:fs/promises'
import path from 'node:path'
async function metrics(dir) {
  const files = await fs.readdir(path.join(dir, 'assets'))
  const js = []
  for (const file of files.filter((f) => f.endsWith('.js')))
    js.push({ file, bytes: (await fs.stat(path.join(dir, 'assets', file))).size })
  return {
    entryBytes: js.filter((f) => f.file.startsWith('index-')).reduce((s, f) => s + f.bytes, 0),
    totalJS: js.reduce((s, f) => s + f.bytes, 0),
    chunks: js
  }
}
const mode = process.argv[2]
const output = 'docs/p0/build-sizes.json'
let report = {}
try {
  report = JSON.parse(await fs.readFile(output, 'utf8'))
} catch {
  /* First measurement starts a new report. */
}
report[mode] = await metrics(process.argv[3] || 'out/renderer')
await fs.mkdir(path.dirname(output), { recursive: true })
await fs.writeFile(output, JSON.stringify(report, null, 2))
