import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

// Print counts and rule names only. Never print matching text or private paths.
const args = process.argv.slice(2)
const packaged = args.includes('--packaged')
const positional = args.filter((arg) => arg !== '--packaged')
const report = { passed: false, source: null, packaged: null, errors: [] }
const issues = new Map()
const issue = (rule, amount = 1) => issues.set(rule, (issues.get(rule) || 0) + amount)
const sha256 = (data) => createHash('sha256').update(data).digest('hex')
const normalize = (name) => name.replaceAll('\\', '/').replace(/^\/+/, '')
const inside = (parent, child) => {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

const publicRootFiles = new Set([
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.prettierignore',
  '.prettierrc.yaml',
  'electron-builder.json',
  'electron.vite.config.mjs',
  'eslint.config.mjs',
  'LICENSE',
  'package-lock.json',
  'package.json',
  'playwright.config.ts',
  'README.md',
  'THIRD-PARTY-NOTICES.txt',
  'tsconfig.json'
])
const publicDocs = new Set([
  'docs/editor-format.md',
  'docs/provenance.md',
  'docs/third-party-editor-licenses.txt',
  'docs/USER-GUIDE.md',
  'docs/release/BUILDING.md',
  'docs/release/CHANGELOG.md',
  'docs/release/INSTALL.md',
  'docs/release/KNOWN-ISSUES.md'
])
const localOnlyDirectories = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  '.test-artifacts',
  'test-results',
  'playwright-report'
])
const publicSource = (name) =>
  publicRootFiles.has(name) ||
  publicDocs.has(name) ||
  /^(src|scripts|tests)\//.test(name) ||
  name === '.github/workflows/preview-release.yml'
const forbiddenPath = (name, compiled = false) => {
  if (name.split('/').some((part) => part === '..' || part === '.')) return true
  if (
    /(^|\/)(?:\.loom|\.workspace|booklist|loombooklist|agent-turn-logs|logs?|\.test-artifacts|test-results|playwright-report|verification)(\/|$)/i.test(
      name
    )
  )
    return true
  if (
    /(^|\/)(?:book|agent|workspace|tool-api|agent-settings|library|heavy-agent-location)\.json$/i.test(
      name
    )
  )
    return true
  if (/(^|\/)\.env(?:\.|$)|\.(?:log|jsonl|sqlite(?:3)?|db)(?:[-.]|$)/i.test(name)) return true
  if (/\.(?:pem|key|p12|pfx)$/i.test(name)) return true
  if (
    compiled &&
    (/(^|\/)(?:fixtures?|__tests__|tests?)(\/|$)/i.test(name) || /\.map$/i.test(name))
  )
    return true
  return false
}

// Test directories receive exactly the same credential rules as production code.
const credentialRules = [
  ['openai-style-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{30,}/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
  [
    'literal-credential',
    /(?:["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|encryptedKey|password|authorization)["']?)\s*[:=]\s*["'](?:Bearer\s+)?[A-Za-z0-9_+/=.-]{24,}["']/gi
  ]
]
let privateMarkers = []
try {
  const markers = JSON.parse(process.env.LOOM_AUDIT_PRIVATE_MARKERS_JSON || '[]')
  if (!Array.isArray(markers) || markers.some((marker) => typeof marker !== 'string' || !marker))
    issue('source:invalid-private-markers')
  else privateMarkers = markers
} catch {
  issue('source:invalid-private-markers')
}
const isText = (name) =>
  /\.(?:[cm]?js|ts|vue|json|md|txt|html?|css|ya?ml|xml|svg|d\.ts)$/i.test(name) ||
  publicRootFiles.has(name) ||
  /(^|\/)(?:LICENSE|COPYING|NOTICE)(?:[.-].*)?$/i.test(name)
const syntheticTestPaths = new Set(
  ['/outside', '/secret', '//notes//new'].map((suffix) => 'C:' + suffix)
)
function scan(data, name, scope) {
  const text = data.toString(isText(name) ? 'utf8' : 'latin1')
  for (const [rule, pattern] of credentialRules) {
    pattern.lastIndex = 0
    const matches = [...text.matchAll(pattern)]
    if (matches.length) issue(`${scope}:${rule}`, matches.length)
  }
  if (!isText(name)) return
  if (privateMarkers.some((marker) => marker && text.includes(marker)))
    issue(`${scope}:private-book-reference`)
  // Only the exact synthetic paths already used by the path-boundary tests are exempt.
  const paths = [...text.matchAll(/\b[A-Za-z]:[\\/][^\s"'`<>\])},;]*/g)]
  for (const hit of paths) {
    const path = hit[0].replaceAll('\\', '/')
    if (scope === 'source' && name.startsWith('tests/') && syntheticTestPaths.has(path)) continue
    issue(`${scope}:machine-absolute-path`)
  }
  if (/\/(?:Users|home)\/[A-Za-z0-9_.-]+\//.test(text)) issue(`${scope}:machine-home-path`)
  // Local registry tokens may use arbitrary formats, so audit npm config separately.
  if (name === '.npmrc' && /(?:_authToken|_auth|password)\s*=/.test(text))
    issue(`${scope}:npm-credential-config`)
}

async function enumerate(directory, prefix = '', skipLocal = false) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (skipLocal && !prefix && localOnlyDirectories.has(entry.name)) continue
    if (entry.isSymbolicLink()) {
      issue('source:symlink')
      continue
    }
    if (entry.isDirectory())
      result.push(...(await enumerate(join(directory, entry.name), name, skipLocal)))
    else if (entry.isFile()) result.push(name)
    else issue('source:nonregular-file')
  }
  return result
}

async function sourceAudit(root) {
  let names
  let listing = 'filesystem'
  const gitRoot = spawnSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (gitRoot.status === 0 && resolve(gitRoot.stdout.trim()) === root) {
    const git = spawnSync(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024
      }
    )
    if (git.status !== 0) throw new Error('git-manifest-failed')
    names = [...new Set(git.stdout.split('\0').filter(Boolean).map(normalize))]
    listing = 'git-index-and-unignored-files'
    // Also catch unexpected untracked files that .gitignore could conceal, outside known build output.
    const visible = await enumerate(root, '', true)
    for (const name of visible)
      if (!names.includes(name)) {
        if (!publicSource(name) || forbiddenPath(name)) issue('source:ignored-nonpublic-file')
        else names.push(name)
      }
  } else names = await enumerate(root, '', true)
  names.sort()
  let bytes = 0
  const manifest = []
  for (const name of names) {
    const allowed = publicSource(name)
    const privatePath = forbiddenPath(name)
    if (!allowed) issue('source:outside-upload-allowlist')
    if (privatePath) issue('source:private-file-path')
    // A bad filename is enough to reject the upload; do not open private data.
    if (!allowed || privatePath) continue
    if (/\.map$/i.test(name)) issue('source:source-map')
    const full = resolve(root, name)
    if (!inside(root, full)) {
      issue('source:path-escape')
      continue
    }
    const stat = await lstat(full)
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(root, await realpath(full))) {
      issue('source:nonregular-or-escaping-file')
      continue
    }
    const data = await readFile(full)
    bytes += data.length
    scan(data, name, 'source')
    manifest.push(`${sha256(data)}  ${name}\n`)
  }
  const cfg = JSON.parse(await readFile(join(root, 'electron-builder.json'), 'utf8'))
  if (JSON.stringify(cfg.files) !== JSON.stringify(['out/**/*', 'package.json']))
    issue('source:builder-files-allowlist')
  if (cfg.asar !== true) issue('source:builder-asar-required')
  const expectedResources = new Set([
    'LICENSE',
    'docs/third-party-editor-licenses.txt',
    'THIRD-PARTY-NOTICES.txt'
  ])
  const resources = cfg.extraResources || []
  if (
    resources.length !== expectedResources.size ||
    new Set(resources.map((item) => item?.from)).size !== expectedResources.size ||
    resources.some(
      (item) =>
        !item ||
        typeof item !== 'object' ||
        !expectedResources.has(item.from) ||
        typeof item.to !== 'string' ||
        !/^licenses\/[^/]+\.txt$/.test(item.to) ||
        item.filter !== undefined
    )
  )
    issue('source:builder-resources-allowlist')
  if (cfg.extraFiles !== undefined && (!Array.isArray(cfg.extraFiles) || cfg.extraFiles.length))
    issue('source:builder-extra-files')
  return {
    files: names.length,
    bytes,
    manifestSha256: sha256(manifest.join('')),
    listing,
    config: cfg
  }
}

async function packagedAudit(root, config) {
  const output = resolve(root, config.directories?.output || 'dist')
  if (!inside(root, output)) throw new Error('packaged-output-escapes-source-root')
  const unpacked = join(output, 'win-unpacked')
  const resources = join(unpacked, 'resources')
  const archive = join(resources, 'app.asar')
  if (!inside(root, await realpath(resources)) || !inside(root, await realpath(archive)))
    throw new Error('packaged-input-escapes-source-root')
  const require = createRequire(join(root, 'package.json'))
  const asar = require(require.resolve(join(root, 'node_modules', '@electron', 'asar')))
  const entries = asar.listPackage(archive).map(normalize)
  let files = 0
  let bytes = 0
  const required = new Set([
    'package.json',
    'out/main/index.js',
    'out/preload/index.cjs',
    'out/renderer/index.html'
  ])
  const manifest = []
  for (const name of entries) {
    if (!name) continue
    if (
      !(
        name === 'out' ||
        name === 'node_modules' ||
        name === 'package.json' ||
        /^(out|node_modules)\//.test(name)
      )
    ) {
      issue('packaged:outside-asar-allowlist')
      continue
    }
    if (forbiddenPath(name, true)) {
      issue('packaged:private-file-path')
      continue
    }
    // @electron/asar indexes paths with the host separator, including on Windows.
    const nativeName = name.replaceAll('/', sep)
    const stat = asar.statFile(archive, nativeName, false)
    if (stat.link) {
      issue('packaged:asar-link')
      continue
    }
    if (stat.files) continue
    if (stat.unpacked && !inside(resources, await realpath(join(archive + '.unpacked', name)))) {
      issue('packaged:unpacked-path-escape')
      continue
    }
    const data = asar.extractFile(archive, nativeName)
    scan(data, name, 'packaged')
    manifest.push(`${sha256(data)}  ${name}\n`)
    required.delete(name)
    files++
    bytes += data.length
  }
  if (required.size) issue('packaged:missing-app-entrypoint', required.size)
  let resourceFiles = 0
  for (const name of await enumerate(resources)) {
    if (name === 'app.asar') continue
    const isUnpacked = name.startsWith('app.asar.unpacked/')
    const payloadName = isUnpacked ? name.slice('app.asar.unpacked/'.length) : name
    const license = /^licenses\/[^/]+\.txt$/.test(name)
    if (!isUnpacked && !license) issue('packaged:unexpected-resource')
    if (isUnpacked && !/^(out|node_modules)\//.test(payloadName))
      issue('packaged:unexpected-unpacked-file')
    if (forbiddenPath(payloadName, true)) issue('packaged:private-resource-path')
    const data = await readFile(join(resources, name))
    scan(data, name, 'packaged')
    resourceFiles++
  }
  for (const name of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
    const data = await readFile(join(unpacked, name))
    scan(data, name, 'packaged')
    resourceFiles++
  }
  return {
    asarFiles: files,
    asarBytes: bytes,
    resourceFiles,
    manifestSha256: sha256(manifest.sort().join('')),
    asarSha256: sha256(await readFile(archive))
  }
}

try {
  if (positional.length !== 1 || args.some((arg) => arg.startsWith('--') && arg !== '--packaged'))
    throw new Error('usage-sourceRoot-optional-packaged')
  const root = await realpath(resolve(positional[0]))
  const source = await sourceAudit(root)
  const { config, ...publicSourceReport } = source
  report.source = publicSourceReport
  if (packaged) report.packaged = await packagedAudit(root, config)
} catch (error) {
  // Error messages from fs and archive libraries can contain private paths; suppress them.
  report.errors.push(
    error?.code ||
      (error?.message?.match(/^[a-z][a-z0-9-]+$/) ? error.message : 'audit-execution-failed')
  )
}
report.checks = [...issues]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([rule, count]) => ({ rule, count }))
report.passed = report.errors.length === 0 && report.checks.length === 0
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.passed ? 0 : 1
