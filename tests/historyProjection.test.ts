import test from 'node:test'
import assert from 'node:assert/strict'
import type { AgentMessage, Conversation, Proposal, ProposalState } from '../src/shared/agent'
import {
  historyProjection,
  summarizeTurn,
  visibleHistory
} from '../src/main/agent/historyProjection'
import { assembleContext, compactMemory } from '../src/main/agent/context'
import { proposalContext } from '../src/main/agent/proposalContext'
import { defaultPolicy, estimateTokens, inputLimit } from '../src/main/agent/budgets'
import { toolDefinitions, BookDocumentAdapter } from '../src/main/agent/documents'
import { rewriteHistory, rewriteTarget } from '../src/main/agent/targetRewrite'
import { taskRequest } from '../src/main/agent/taskScope'
import { ScriptedRuntime } from '../src/main/agent/runtime'
import { DocumentStore } from '../src/main/documents'
import { AgentService } from '../src/main/agent/service'
import fs from 'node:fs/promises'
import { resolve } from 'node:path'
import { logicalLines } from '../src/shared/logicalLines'

function pair(n: number): AgentMessage[] {
  return [
    {
      id: `u${n}`,
      turnId: `t${n}`,
      role: 'user',
      text: `请求${n}：只讨论，不要执行。保留悬念。`,
      sources: []
    },
    {
      id: `a${n}`,
      turnId: `t${n}`,
      role: 'assistant',
      text: '不可作为最终回答的过程文字'.repeat(1000),
      finalResponse: `回答${n}：建议先讨论，尚未执行。`,
      outcome: 'completed',
      sources: []
    }
  ]
}
function conversation(n: number): Conversation {
  return {
    format: 1,
    id: 'conversation_00000000-0000-0000-0000-000000000000',
    bookId: '',
    title: '',
    updatedAt: '',
    messages: [
      ...Array.from({ length: n }, (_, i) => pair(i)).flat(),
      { id: 'current', role: 'user', text: '当前独有请求', sources: [] }
    ],
    summary: '不能复用的旧摘要',
    coveredMessages: 0
  }
}
const payload = (c: Conversation, policy = defaultPolicy) => {
  const messages = assembleContext(c, '规则', {}, policy)
  return {
    messages,
    data: JSON.parse(messages[1].content!.slice(messages[1].content!.indexOf('{')))
  }
}

test('0/1/8/9/20 turns partition exactly once; final response replaces process and old memory', () => {
  for (const n of [0, 1, 8, 9, 20]) {
    const c = conversation(n)
    const p = historyProjection(c.messages, c.id, 'current')
    assert.equal(p.recentTurns.length, Math.min(n, 8))
    assert.equal(p.olderTurns.length + p.recentTurns.length, n)
    assert.equal(new Set([...p.recentTurns, ...p.olderTurns].map((t) => t.turnId)).size, n)
    const { messages, data } = payload(c)
    const sent = JSON.stringify(messages)
    assert.equal(sent.split('当前独有请求').length - 1, 1)
    assert.ok(!sent.includes('过程文字'))
    assert.ok(!sent.includes('不能复用'))
    assert.equal(data.recentTurns.length, Math.min(n, 8))
    assert.equal(c.memory!.format, 2)
    assert.deepEqual(compactMemory(c).discussion, c.memory!.discussion)
  }
})

test('eight long Chinese/Unicode answers retain paired excerpts within serialized budget', () => {
  const c = conversation(20)
  for (const m of c.messages)
    if (m.role === 'assistant')
      m.finalResponse = '只建议；尚未执行。🌿𠮷'.repeat(650) + '不要杀死主角。'
  const policy = { contextTokens: 10500, outputTokens: 512, retryOutputTokens: 512 }
  const { messages, data } = payload(c, policy)
  assert.equal(data.recentTurns.length, 8)
  assert.ok(
    data.recentTurns.every(
      (t: { request: string; response: string }) => t.request && t.response.includes('不要杀死主角')
    )
  )
  assert.ok(
    estimateTokens(JSON.stringify({ messages, tools: toolDefinitions })) <= inputLimit(policy)
  )
  assert.equal(data.omitted.count + data.olderTurns.length, 12)
  assert.equal(c.historyDiagnostic!.fullTurns, 0)
  const p = historyProjection(c.messages, c.id, 'current')
  assert.equal(summarizeTurn(c, p.recentTurns[0]).hit, true)
  p.recentTurns[0].answer!.finalResponse += '补充'
  assert.equal(summarizeTurn(c, p.recentTurns[0]).hit, false)
})

test('legacy, withdrawal and failure rules agree across context, rewrite, continuation and history tools', () => {
  const c = conversation(3)
  c.messages[2].contextVisibility = 'withdrawn'
  c.messages[5].outcome = 'failed'
  c.messages[5].failureProgress = {
    completedModelRounds: 0,
    executedToolCalls: 0,
    createdProposalIds: []
  }
  c.messages.at(-1)!.text = '继续'
  const p = historyProjection(c.messages, c.id, 'current')
  assert.deepEqual(
    p.recentTurns.map((t) => t.turnId),
    ['t0']
  )
  assert.equal(p.excludedEvents.length, 2)
  assert.ok(p.excludedEvents.every((e) => !e.request))
  assert.deepEqual(
    rewriteHistory(c.messages).map((t) => t.turnId),
    ['t0']
  )
  assert.equal(taskRequest(c.messages), c.messages[0].text)
  const text = visibleHistory(c.messages, c.id, 'current').text
  assert.ok(!text.includes('请求1') && !text.includes('请求2') && !text.includes('过程文字'))
  const legacy = conversation(1)
  delete legacy.messages[1].finalResponse
  delete legacy.messages[1].outcome
  assert.equal(historyProjection(legacy.messages, legacy.id, 'current').olderTurns[0].legacy, true)
  assert.ok(JSON.stringify(payload(legacy).messages).includes('旧记录无可验证最终回答'))
  assert.equal(rewriteHistory(legacy.messages).length, 0)
})

test('mid-run failed request remains an explicit unresolved event, never a successful answer', () => {
  const c = conversation(1)
  c.messages[1].outcome = 'failed'
  c.messages[1].failureProgress = {
    completedModelRounds: 1,
    executedToolCalls: 1,
    createdProposalIds: []
  }
  const p = historyProjection(c.messages, c.id, 'current')
  assert.equal(p.recentTurns.length, 0)
  assert.equal(p.excludedEvents[0].request, c.messages[0].text)
  assert.ok(!JSON.stringify(payload(c).messages).includes('过程文字'))
})

function proposal(state: ProposalState = 'pending'): Proposal {
  return {
    format: 1,
    id: 'proposal_00000000-0000-0000-0000-000000000000',
    bookId: '',
    conversationId: '',
    turnId: 't0',
    operation: 'create',
    targetId: '',
    kind: 'notes',
    title: '候选',
    before: null,
    content: '完整候选。🌿\n不能省略。',
    candidateHash: '',
    sources: [],
    reason: '',
    state,
    createdAt: ''
  }
}

test('all proposal states share revision and lossless content in main, rewrite and paginated read', async () => {
  const statuses = ['待审阅', '应用中', '已采纳', '已拒绝', '已撤销', '已失效', '冲突', '应用失败']
  const states: ProposalState[] = [
    'pending',
    'applying',
    'applied',
    'rejected',
    'undone',
    'stale',
    'conflicted',
    'failed'
  ]
  const revisions = new Set<string>()
  for (let i = 0; i < states.length; i++) {
    const p = proposal(states[i])
    const snapshot = proposalContext([p], p.id)
    revisions.add(snapshot.revision)
    assert.equal(snapshot.index[0].status, statuses[i])
    const c = conversation(1)
    c.messages.at(-1)!.text = p.id
    const messages = assembleContext(c, '规则', {}, defaultPolicy, undefined, snapshot)
    assert.ok(JSON.stringify(messages).includes(statuses[i]))
    await rewriteTarget(
      new ScriptedRuntime((messages) => {
        const data = JSON.parse(messages[1].content!)
        assert.equal(data.proposals.revision, snapshot.revision)
        assert.equal(data.proposals.index[0].status, statuses[i])
        assert.equal(data.proposals.contents[0].new_text, p.content)
        return { text: '{"needsRewrite":false,"reason":"完整"}', calls: [] }
      }),
      c.messages,
      new AbortController().signal,
      () => ({}),
      snapshot
    )
    const adapter = new BookDocumentAdapter(
      new DocumentStore(),
      '',
      {},
      '',
      () => [],
      undefined,
      false,
      () => snapshot
    )
    const read = (await adapter.read({ path: snapshot.index[0].path })) as { text: string }
    assert.equal(JSON.parse(read.text).new_text, p.content)
    assert.equal(JSON.parse(read.text).revision, snapshot.revision)
  }
  assert.equal(revisions.size, states.length)
})

test('required oversized proposals and fixed raw prompts fail explicitly; raw snapshots stay intact', () => {
  const p = proposal()
  p.content = '超长中文'.repeat(10000)
  const c = conversation(8)
  c.messages.at(-1)!.text = p.id
  const snapshot = proposalContext([p], p.id)
  assert.throws(
    () => assembleContext(c, '规则', {}, defaultPolicy, undefined, snapshot),
    /必需提案.*proposal_/
  )
  assert.equal(p.content.length, 40000)
  c.messages.at(-1)!.text = '超长中文'.repeat(10000)
  assert.throws(() => payload(c), /超出模型预算/)
})

test('edit block projection reconstructs repeated lines, inserts, deletes and Unicode without changing originals', () => {
  for (const [before, after] of [
    ['同句。\n中间。\n同句。\n', '改句。\n中间。\n改句。\n'],
    ['开头。\n结尾。', '开头。\n新增🌿𠮷。\n结尾。'],
    ['保留。\n删除。\n', '保留。\n'],
    ['第一段\r\n第二段', '第一段\n第二段\n']
  ]) {
    const p = {
      ...proposal(),
      operation: 'edit' as const,
      before: { content: before },
      content: after
    } as Proposal
    const frozen = JSON.stringify(p)
    const snapshot = proposalContext([p], p.id)
    const blocks = snapshot.contents[0]
    assert.ok(Array.isArray(blocks.old_text) && Array.isArray(blocks.new_text))
    let restored = before
    const lines = logicalLines(before)
    for (const [i, location] of [...snapshot.index[0].locations!.entries()].reverse()) {
      const offset = lines[location.oldLine - 1]?.start ?? before.length
      const old: string = blocks.old_text[i]
      assert.equal(restored.slice(offset, offset + old.length), old)
      restored =
        restored.slice(0, offset) + blocks.new_text[i] + restored.slice(offset + old.length)
    }
    assert.equal(restored, after)
    assert.equal(JSON.stringify(p), frozen)
  }
})

test('tiny budgets omit whole turns with a readable mapping and exact omission count', () => {
  const c = conversation(20)
  for (const m of c.messages)
    if (m.role === 'assistant') m.finalResponse = '长篇建议，尚未执行。'.repeat(500)
  const baseline = estimateTokens(
    JSON.stringify({ messages: payload(conversation(0)).messages, tools: toolDefinitions })
  )
  const policy = { contextTokens: baseline + 1280 + 900, outputTokens: 256, retryOutputTokens: 256 }
  const { messages, data } = payload(c, policy)
  assert.ok(data.recentTurns.length < 8)
  assert.equal(data.recentTurns.length + data.olderTurns.length + data.omitted.count, 20)
  assert.equal(new Set(c.historyDiagnostic!.omittedTurnIds as string[]).size, data.omitted.count)
  assert.ok(data.omitted.path.endsWith('.history.json'))
  assert.ok(
    estimateTokens(JSON.stringify({ messages, tools: toolDefinitions })) <= inputLimit(policy)
  )
})

test('persisted apply/undo survive restart and reach both rewrite and main model with the same revision', async () => {
  await fs.mkdir(resolve('.test-artifacts'), { recursive: true })
  const root = await fs.mkdtemp(resolve('.test-artifacts/loom039-'))
  const store = new DocumentStore()
  const book = await store.createBook(root, '提案历史回归')
  const writer = new AgentService(
    store,
    () =>
      new ScriptedRuntime((_messages, step) =>
        step === 0
          ? {
              text: '',
              calls: [
                {
                  id: 'create',
                  name: 'create',
                  arguments: JSON.stringify({
                    directory: 'book/notes/',
                    title: '草案',
                    content: '当时的完整提案。'
                  })
                }
              ]
            }
          : { text: '建议已生成，尚未采纳。', calls: [] }
      )
  )
  const c = await writer.create(book.id, '提案测试')
  await writer.start(book.id, c.id, '新建速记提案', {})
  await writer.idle()
  const p = (await writer.snapshot(book.id)).proposals[0]
  assert.ok(p)
  for (const [action, status] of [
    ['apply', '已采纳'],
    ['undo', '已撤销']
  ] as const) {
    await writer.action(book.id, p.id, action, p.candidateHash)
    let revision = ''
    let mainSeen = false
    let rewriteSeen = false
    const restarted = new AgentService(
      store,
      () =>
        new ScriptedRuntime((messages, _step) => {
          if (messages.length === 2 && messages[0].content!.includes('请求澄清预处理器')) {
            const data = JSON.parse(messages[1].content!)
            assert.equal(data.proposals.index[0].status, status)
            revision = data.proposals.revision
            rewriteSeen = true
            return { text: '{"needsRewrite":false,"reason":"明确引用"}', calls: [] }
          }
          const history = messages.find((m) => m.content?.startsWith('历史讨论背景'))!.content!
          const data = JSON.parse(history.slice(history.indexOf('{')))
          assert.equal(data.proposals.revision, revision)
          assert.equal(data.proposals.index[0].status, status)
          mainSeen = true
          return { text: '已核对最新状态。', calls: [] }
        })
    )
    await restarted.start(book.id, c.id, `核对 ${p.id}`, { targetRewrite: true })
    await restarted.idle()
    assert.ok(mainSeen && rewriteSeen)
  }
  const persisted = await store.agentRecords<Conversation>(book.id, 'conversations')
  assert.ok(persisted[0].historySummaries)
})
