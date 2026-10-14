<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { Conversation, Proposal } from '../../../../shared/agent'

const props = defineProps<{
  conversation: Conversation
  proposals: Proposal[]
  active: boolean
  liveText: string
  canEdit: boolean
}>()
const emit = defineEmits<{ edit: [text: string]; settings: [] }>()
const clock = ref(Date.now())
const timer = setInterval(() => {
  clock.value = Date.now()
}, 1000)
onBeforeUnmount(() => clearInterval(timer))
const turn = computed(() => props.conversation.lastTurn)
const records = computed(() =>
  (props.conversation.diagnostics || []).filter((d) => d.turnId === turn.value?.id)
)
const last = computed(() => records.value.at(-1))
const proposals = computed(() => props.proposals.filter((p) => p.turnId === turn.value?.id))
const pending = computed(() => proposals.value.filter((p) => p.state === 'pending').length)
const reads = computed(
  () =>
    records.value.filter((d) => d.phase === 'tool.completed' && d.tool === 'read' && !d.code).length
)
const elapsed = computed(() => {
  const start = turn.value?.startedAt
  const finish = props.active ? clock.value : Date.parse(turn.value?.finishedAt || '')
  return start && Number.isFinite(finish)
    ? Math.max(0, Math.floor((finish - Date.parse(start)) / 1000))
    : null
})
const toolLabels: Record<string, string> = {
  list_files: '查找资料',
  read: '读取资料',
  create: '准备新建提案',
  write: '准备全文修改',
  edit: '准备局部修改'
}
const phase = computed(() => {
  if (!props.active)
    return {
      completed: pending.value ? '已完成，等待审阅' : '本轮已完成',
      cancelled: '本轮已取消',
      failed: '本轮未完成',
      running: '正在同步任务状态'
    }[turn.value?.state || 'running']
  if (last.value?.phase === 'tool.started')
    return toolLabels[last.value.tool || ''] || '正在处理资料'
  if (last.value?.phase.startsWith('rewrite.check.')) return '正在检查是否需要改写目标'
  if (last.value?.phase.startsWith('rewrite.target.')) return '正在改写目标'
  if (last.value?.phase === 'tool.completed')
    return last.value.code ? '资料处理遇到问题，正在尝试继续' : '正在整理资料'
  return props.liveText ? '正在组织回复' : '正在思考与准备'
})
const request = computed(
  () =>
    props.conversation.messages.find((m) => m.turnId === turn.value?.id && m.role === 'user')
      ?.text || ''
)
function recordLabel(phase: string, tool?: string): string {
  if (phase.startsWith('rewrite.check.'))
    return `目标改写检查：${recordLabel(phase.slice('rewrite.check.'.length))}`
  if (phase.startsWith('rewrite.target.'))
    return `目标改写：${recordLabel(phase.slice('rewrite.target.'.length))}`
  return (
    {
      'turn.started': '任务开始',
      'model.started': '请求模型',
      'model.completed': '模型已回复',
      'request.started': '发送模型请求',
      'request.completed': '模型请求成功',
      'request.failed': '模型请求失败',
      'evidence.delivered': '读取结果已送达模型',
      'turn.completed': '任务完成',
      'tool.started': `${toolLabels[tool || ''] || '处理资料'}：开始`,
      'tool.completed': `${toolLabels[tool || ''] || '处理资料'}：结束`,
      'turn.failed': '任务中止'
    }[phase] || phase
  )
}
</script>

<template>
  <section v-if="turn" class="agent-progress" aria-label="本轮进度">
    <div class="progress-heading">
      <strong role="status">{{ phase }}</strong
      ><span v-if="elapsed !== null">{{ elapsed }} 秒</span>
    </div>
    <p>
      已完成 {{ reads }} 次读取 · {{ proposals.length }} 项提案<span v-if="pending">
        · {{ pending }} 项待审阅</span
      >
    </p>
    <template v-if="!active && (turn.state === 'failed' || turn.state === 'cancelled')">
      <p>可调整请求后重试，或检查 AI 设置。</p>
      <div class="actions">
        <button
          :disabled="!canEdit || conversation.archived"
          :title="canEdit ? '' : '请先处理输入区已有草稿'"
          @click="emit('edit', request)"
        >
          编辑后重试</button
        ><button @click="emit('settings')">检查 AI 设置</button>
      </div>
    </template>
    <details v-if="records.length">
      <summary>本轮运行明细</summary>
      <p v-if="turn.state === 'failed'">范围过大时，每次只处理一篇文档或一段选区。</p>
      <p>读取次数是成功的工具调用次数；是否完整覆盖原文，以回复中的引用和范围提示为准。</p>
      <ol>
        <li v-for="(record, index) in records" :key="index">
          <span>{{ recordLabel(record.phase, record.tool) }}</span
          ><small v-if="record.attempt"> · 第 {{ record.attempt }} 次请求</small
          ><small v-if="record.elapsedMs !== undefined">
            · {{ (record.elapsedMs / 1000).toFixed(1) }} 秒</small
          ><small v-if="record.code"> · {{ record.code }}</small>
        </li>
      </ol>
      <details>
        <summary>诊断数据</summary>
        <pre>{{ records }}</pre>
      </details>
    </details>
  </section>
</template>

<style scoped>
.agent-progress {
  flex-shrink: 0;
  max-height: 18%;
  overflow: auto;
  border-top: 1px solid var(--line);
  background: var(--button-bg);
  padding: 10px 12px;
  font-size: 11px;
  line-height: 1.6;
}
.progress-heading {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
p {
  margin: 4px 0;
}
summary {
  cursor: pointer;
}
ol {
  padding-left: 20px;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 10px;
}
.actions {
  display: flex;
  gap: 6px;
  margin: 6px 0;
}
button {
  font-size: 11px;
}
</style>
