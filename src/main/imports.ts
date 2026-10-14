import fs from 'node:fs/promises'
import { basename } from 'node:path'
import { parseTextImport, type ImportDraft } from '../shared/imports'

const maxFileBytes = 20 * 1024 * 1024

export function decodeImportText(bytes: Uint8Array, encoding: 'utf8' | 'gb18030'): string {
  if (!['utf8', 'gb18030'].includes(encoding)) throw new Error('请选择有效的文本编码。')
  try {
    const label =
      bytes[0] === 0xff && bytes[1] === 0xfe
        ? 'utf-16le'
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? 'utf-16be'
          : bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
            ? 'utf-8'
            : encoding === 'utf8'
              ? 'utf-8'
              : 'gb18030'
    return new TextDecoder(label, { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    throw new Error(
      encoding === 'utf8'
        ? '文件不是有效的 UTF-8 文本，可切换为 GB18030 后重新选择。'
        : '文件无法按 GB18030 读取，请核对文件编码。'
    )
  }
}

export async function readTextImport(
  path: string,
  encoding: 'utf8' | 'gb18030' = 'utf8'
): Promise<ImportDraft> {
  if (!/\.(?:txt|md|markdown)$/i.test(path)) throw new Error('请选择 TXT 或 Markdown 文件。')
  const stat = await fs.lstat(path)
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error('请选择普通文本文件，不能使用文件链接。')
  if (stat.size > maxFileBytes) throw new Error('文件超过 20 MB，请分成较小的文件后导入。')
  return parseTextImport(decodeImportText(await fs.readFile(path), encoding), basename(path))
}
