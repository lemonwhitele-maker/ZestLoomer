import fs from 'node:fs/promises'
import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { SourceOffsets } from '../../src/renderer/src/editorSource'
import { countWords } from '../../src/shared/wordCount'
import { proposalDiff } from '../../src/shared/proposalDiff'

function originalOffset(source: string, position: number) {
  let extra = 0
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    if (match.index - extra >= position) break
    extra += match[0].length - 1
  }
  return position + extra
}
function measure(action: () => unknown) {
  for (let n = 0; n < 5; n++) action()
  const samples = Array.from({ length: 30 }, () => {
    const start = performance.now()
    action()
    return performance.now() - start
  }).sort((a, b) => a - b)
  return { p50: samples[15], p95: samples[28], raw: samples }
}
const source = '甲😀乙\r\n丙\n丁\r末尾\u00a0'.repeat(5000)
const position = source.replace(/\r\n|\r/g, '\n').length - 2
const index = new SourceOffsets(source)
const prefix = '相同段落\r\n'.repeat(10000)
const report = {
  machine: os.hostname(),
  cpu: os.cpus()[0].model,
  platform: os.release(),
  node: process.version,
  samples: 30,
  sourceUTF16: source.length,
  note: 'CPU microbenchmarks, not keyboard-to-paint or whole-application measurements. Mapping construction is reported separately.',
  offsetBefore100Queries: measure(() => {
    for (let i = 0; i < 100; i++) originalOffset(source, position - i)
  }),
  offsetAfter100Queries: measure(() => {
    for (let i = 0; i < 100; i++) index.offset(position - i)
  }),
  offsetIndexConstruction: measure(() => new SourceOffsets(source)),
  wordsBefore: measure(() => Array.from(source.replace(/\s/g, '')).length),
  wordsAfter: measure(() => countWords(source)),
  diffLocalChange20000Lines: measure(() =>
    proposalDiff(prefix + '旧\n' + prefix, prefix + '新\n' + prefix)
  ),
  diffLargeSingleLine: measure(() => proposalDiff('甲'.repeat(200000), '乙'.repeat(200000)))
}
await fs.mkdir('docs/p1', { recursive: true })
await fs.writeFile('docs/p1/cpu-measurements.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, (_key, value) => (Array.isArray(value) ? undefined : value), 2))
