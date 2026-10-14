import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const filename = `Loom-${version}-win-x64-setup.exe`
const destination = resolve(root, '../安装包', `Loom-${version}`)
await mkdir(destination, { recursive: true })
await copyFile(resolve(root, 'dist', filename), resolve(destination, filename))
for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.txt']) {
  await copyFile(resolve(root, file), resolve(destination, file))
}
for (const file of ['INSTALL.md', 'CHANGELOG.md', 'KNOWN-ISSUES.md']) {
  await copyFile(resolve(root, 'docs/release', file), resolve(destination, file))
}
const files = [
  filename,
  'LICENSE',
  'THIRD-PARTY-NOTICES.txt',
  'INSTALL.md',
  'CHANGELOG.md',
  'KNOWN-ISSUES.md'
]
const checksums = await Promise.all(
  files.map(async (file) => {
    const data = await readFile(resolve(destination, file))
    return `${createHash('sha256').update(data).digest('hex')}  ${file}`
  })
)
await writeFile(resolve(destination, 'SHA256SUMS.txt'), checksums.join('\n') + '\n')
console.log(`Windows release files: ${destination}`)
