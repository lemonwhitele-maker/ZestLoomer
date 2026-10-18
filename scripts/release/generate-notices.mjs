import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'))
const sections = [
  'Loom — third-party notices',
  '51mazi: https://github.com/xiaoshengxianjun/51mazi — Copyright (c) 2025 小圣贤君; MIT text preserved in LICENSE.',
  '51mazi_chatbox: https://github.com/lemonwhitele-maker/51mazi_chatbox — Agent collaboration and template design reference; see docs/provenance.md.',
  'Generated from the locked installed runtime dependencies and bundled Vue renderer dependencies.',
  'The original application MIT notice is preserved in LICENSE.',
  'Electron 39.2.7 includes Chromium, Node.js and other components. Full upstream notices are shipped beside LoomPreview.exe as LICENSE.electron.txt and LICENSES.chromium.html.',
  'The Loom logo is an existing application asset.'
]
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path || (entry.dev && !/node_modules\/(vue|@vue\/[^/]+)$/.test(path))) continue
  const directory = resolve(root, path)
  const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
  const licenses = (await readdir(directory)).filter((name) =>
    /^(licen[cs]e|copying)(\.|$|-)/i.test(name)
  )
  if (!licenses.length) throw new Error(`Missing license text: ${pkg.name}`)
  sections.push(
    `\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${pkg.license || entry.license || 'See license text'}`
  )
  for (const name of licenses) sections.push(await readFile(resolve(directory, name), 'utf8'))
}
await writeFile(resolve(root, 'THIRD-PARTY-NOTICES.txt'), sections.join('\n\n') + '\n')
