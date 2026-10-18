import { lstat, realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const inside = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

export default async function afterPack(context) {
  const project = await realpath(context.packager.projectDir)
  const configured = resolve(project, context.packager.config.directories?.output || 'dist')
  if (configured !== resolve(project, 'dist') || (await realpath(configured)) !== configured)
    throw new Error('Preview cleanup requires the configured dist output directory')
  const expected = await realpath(join(configured, 'win-unpacked'))
  const actual = await realpath(context.appOutDir)
  if (
    expected !== join(configured, 'win-unpacked') ||
    actual !== expected ||
    !inside(project, actual)
  )
    throw new Error('Preview cleanup refused an unexpected app output directory')
  const resources = await realpath(join(actual, 'resources'))
  if (resources !== join(actual, 'resources'))
    throw new Error('Preview cleanup refused a redirected resources directory')

  // Only these two Electron/builder metadata files are removed. Never recurse.
  for (const name of ['default_app.asar', 'app-update.yml']) {
    const target = join(resources, name)
    let stat
    try {
      stat = await lstat(target)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(target)) !== target)
      throw new Error('Preview cleanup refused a redirected or non-file resource')
    await unlink(target)
  }
}
