import fs from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DocumentStore } from '../../src/main/documents'
import { AgentService } from '../../src/main/agent/service'
import { counters } from './counters'
import { generateFixtures } from './generate-fixtures'

async function run() {
  const size = process.argv[2] || 'S'
  const samples = Number(process.argv[3] || 10)
  if (!Number.isInteger(samples) || samples < 1 || samples > 1000)
    throw new Error('samples must be 1–1000')
  const root = await generateFixtures(size)
  const store = new DocumentStore()
  const book = await store.openBook(root)
  const service = new AgentService(store, () => {
    throw new Error('measurement never calls a model')
  })
  const agent = await service.safeSnapshot(book.id)
  const docs = await store.list(book.id)
  const expected = size === 'S' ? [150, 40, 0] : size === 'M' ? [1500, 400, 20] : [2, 0, 0]
  const actual = [
    docs.length,
    agent.conversations.reduce((sum, c) => sum + c.messages.length, 0),
    agent.proposals.length
  ]
  if (JSON.stringify(actual) !== JSON.stringify(expected) || agent.warnings?.length)
    throw new Error(
      `fixture failed authoritative validation: ${JSON.stringify({ expected, actual, warnings: agent.warnings })}`
    )
  counters.enabled = true
  const results = []
  for (const [name, operation] of [
    ['list', () => store.orderedList(book.id)],
    ['stats', () => store.stats(book.id)],
    ['search', () => store.search(book.id, 'unlikely-audit-needle')]
  ] as const) {
    await operation()
    counters.reset()
    const durations: number[] = []
    for (let i = 0; i < samples; i++) {
      const start = performance.now()
      await operation()
      durations.push(performance.now() - start)
    }
    durations.sort((a, b) => a - b)
    results.push({
      name,
      samples,
      p50Ms: durations[Math.ceil(samples * 0.5) - 1],
      p95Ms: durations[Math.ceil(samples * 0.95) - 1],
      counters: counters.snapshot()
    })
  }
  const file = join(root, 'measurement.json')
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        platform: process.platform,
        node: process.version,
        dataset: size,
        actual,
        scope: 'data layer, warmed application cache; not window latency or cold disk',
        results
      },
      null,
      2
    )
  )
  console.log(file)
  console.log(JSON.stringify(results, null, 2))
}
run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
