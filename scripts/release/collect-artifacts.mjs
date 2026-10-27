import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error(`Invalid release version: ${version}`)
const filename = `ZestLoomer-${version}-win-x64-setup.exe`
const archive = `ZestLoomer-${version}-win-x64.zip`
const destination = resolve(root, 'dist/release', `ZestLoomer-${version}`)
await mkdir(destination, { recursive: true })
for (const file of [filename, archive]) {
  await copyFile(resolve(root, 'dist', file), resolve(destination, file))
}
for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.txt']) {
  await copyFile(resolve(root, file), resolve(destination, file))
}
for (const file of ['INSTALL.md', 'KNOWN-ISSUES.md']) {
  await copyFile(resolve(root, 'docs/release', file), resolve(destination, file))
}
const changelog = (await readFile(resolve(root, 'docs/release/CHANGELOG.md'), 'utf8')).replace(
  /检查结果见 \[本次验证记录\]\(\.\.\/verification\/[^)]+\)。/g,
  '验证范围与限制见 [已知问题](KNOWN-ISSUES.md)。'
)
await writeFile(resolve(destination, 'CHANGELOG.md'), changelog)
const guide = (await readFile(resolve(root, 'docs/USER-GUIDE.md'), 'utf8'))
  .replaceAll('](../README.md)', '](README.md)')
  .replaceAll('](release/INSTALL.md)', '](INSTALL.md)')
await writeFile(resolve(destination, 'USER-GUIDE.md'), guide)
await writeFile(
  resolve(destination, 'README.md'),
  `# ZestLoomer ${version} · Windows x64 临时预览版

本地小说写作工作区，支持正文、大纲、人物、设定、速记与 AI 对话。

- [Windows 安装包](${filename})：运行安装程序后启动 ZestLoomer。
- [免安装 ZIP](${archive})：完整解压后运行 ZestLoomer.exe。
- [安装与升级](INSTALL.md)：首次使用、旧 Loom 数据兼容与试用说明。
- [相对旧版的功能迭代](CHANGELOG.md)：本次预览版新增内容。
- [已知问题与验证范围](KNOWN-ISSUES.md)：试用前可查看的限制。
- [完整使用指南](USER-GUIDE.md)：写作、AI 接入、提案、备份与快捷键。
- [MIT 许可证](LICENSE)与[第三方声明](THIRD-PARTY-NOTICES.txt)。
- [SHA-256 清单](SHA256SUMS.txt)：核对交付文件的完整性。

首次启动选择书库；独立试用时请选择空书库或原书库完整副本。未配置 AI 时仍可使用本地写作功能。
`
)
const files = [
  filename,
  archive,
  'README.md',
  'USER-GUIDE.md',
  'LICENSE',
  'THIRD-PARTY-NOTICES.txt',
  'INSTALL.md',
  'CHANGELOG.md',
  'KNOWN-ISSUES.md'
]
// The release notes are self-contained; reject accidentally broken local links.
for (const file of files.filter((name) => name.endsWith('.md'))) {
  const content = await readFile(resolve(destination, file), 'utf8')
  for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0]
    if (!target || /^https?:\/\//i.test(target)) continue
    if (!files.includes(target) && target !== 'SHA256SUMS.txt')
      throw new Error(`Missing release link target in ${file}: ${target}`)
  }
}
const checksums = await Promise.all(
  files.map(async (file) => {
    const data = await readFile(resolve(destination, file))
    return `${createHash('sha256').update(data).digest('hex')}  ${file}`
  })
)
await writeFile(resolve(destination, 'SHA256SUMS.txt'), checksums.join('\n') + '\n')
console.log(`Windows release files: ${destination}`)
