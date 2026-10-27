<script setup lang="ts">
import { computed, ref, shallowRef, watch, onBeforeUnmount } from 'vue'
import type { Proposal } from '../../../../shared/agent'
import { counters } from '../../../../shared/perf'
import { proposalPreview } from '../../proposalPreview'

const props = defineProps<{
  proposal: Proposal
  busy: boolean
  running: boolean
  labels: Record<string, string>
  unifiedPreview: boolean
}>()

const emit = defineEmits<{
  action: [id: string, action: 'apply' | 'reject' | 'undo', hash: string]
}>()

const stateLabels = {
  pending: '等待审阅',
  applying: '正在应用',
  applied: '已应用',
  rejected: '已拒绝',
  stale: '已失效',
  conflicted: '版本冲突',
  failed: '应用失败',
  undone: '已撤销'
}

const diffCache = new Map<string, ReturnType<typeof proposalPreview>>()
const expanded = ref(false)
const fullContent = ref(false)
const large = computed(
  () => (props.proposal.before?.content.length || 0) + props.proposal.content.length > 100000
)
const workerResult = shallowRef<ReturnType<typeof proposalPreview>>()
const workerError = ref('')
let worker: Worker | undefined
function stopWorker(): void {
  worker?.terminate()
  worker = undefined
}
watch(
  [
    expanded,
    () => props.proposal.candidateHash,
    () => props.proposal.before?.version,
    () => props.unifiedPreview
  ],
  () => {
    stopWorker()
    workerResult.value = undefined
    workerError.value = ''
    if (!large.value || !expanded.value) return
    try {
      const active = new Worker(new URL('../../proposalDiff.worker.ts', import.meta.url), {
        type: 'module'
      })
      worker = active
      active.onmessage = (event) => {
        if (worker !== active) return
        workerResult.value = event.data
        stopWorker()
      }
      active.onerror = () => {
        if (worker !== active) return
        workerError.value = '差异计算失败，可收起后重试，或查看完整内容。'
        stopWorker()
      }
      active.postMessage({
        before: props.proposal.before?.content || '',
        after: props.proposal.content,
        unified: props.unifiedPreview
      })
    } catch {
      stopWorker()
      workerError.value = '差异计算不可用，请查看完整内容。'
    }
  }
)
onBeforeUnmount(stopWorker)

const diff = computed(() => {
  if (large.value) return workerResult.value
  const key = `${props.proposal.candidateHash}:${props.proposal.before?.version || 'none'}:${props.unifiedPreview}`
  if (!diffCache.has(key)) {
    if (diffCache.size >= 4) diffCache.delete(diffCache.keys().next().value!)
    counters.countProposalDiff()
    diffCache.set(
      key,
      proposalPreview(
        props.proposal.before?.content || '',
        props.proposal.content,
        props.unifiedPreview
      )
    )
  }
  return diffCache.get(key)!
})
const highlighted = computed(() => diff.value?.highlighted || [])

function proposalAction(action: 'apply' | 'reject' | 'undo'): void {
  emit('action', props.proposal.id, action, props.proposal.candidateHash)
}
</script>

<template>
  <section class="proposal-card">
    <strong
      >{{ proposal.operation === 'create' ? '新建' : '修改' }}{{ labels[proposal.kind] }}：{{
        proposal.title
      }}</strong
    ><small>{{ stateLabels[proposal.state] }}</small>
    <p v-if="proposal.reason">{{ proposal.reason }}</p>
    <p v-if="proposal.paragraphNormalization">已统一候选正文的段落换行，请一并审阅。</p>
    <small>{{ proposal.createdAt }} · {{ proposal.turnId }}</small>
    <button v-if="large" :aria-expanded="expanded" @click="expanded = !expanded">
      {{ expanded ? '收起差异 / 取消计算' : '展开大文档差异' }}
    </button>
    <p v-if="large && expanded && !diff" role="status">{{ workerError || '正在计算差异…' }}</p>
    <template v-if="diff && (!large || expanded)">
      <p v-if="diff.coarse">差异较大，显示变化范围的前后对照；超长段落以整段标注。</p>
      <p v-if="diff.truncated">仅显示前 80 组差异，请展开完整内容核对其余修改。</p>
      <small v-if="proposal.before">高亮显示变化的词句；↵ 表示变化的换行。</small>
      <div v-for="(h, index) in diff.hunks" :key="index" class="proposal-diff">
        <div v-if="proposal.before">
          <small>修改前 · 第 {{ h.oldLine }} 行</small>
          <pre
            class="diff-before"
          ><template v-if="h.before"><span v-for="(span, n) in highlighted[index].before" :key="n" :class="{ 'diff-changed': span.changed, 'diff-newline': span.newline }">{{ span.text }}</span></template><template v-else>（空）</template></pre>
        </div>
        <div>
          <small>{{ proposal.before ? '修改后' : '新建内容' }}</small>
          <pre
            class="diff-after"
          ><template v-if="h.after"><span v-for="(span, n) in highlighted[index].after" :key="n" :class="{ 'diff-changed': span.changed, 'diff-newline': span.newline }">{{ span.text }}</span></template><template v-else>（空）</template></pre>
        </div>
      </div>
    </template>
    <details @toggle="fullContent = ($event.target as HTMLDetailsElement).open">
      <summary>查看完整内容</summary>
      <template v-if="fullContent">
        <pre v-if="proposal.before">
修改前：
{{ proposal.before.content }}</pre
        >
        <pre>
候选内容：
{{ proposal.content }}</pre
        >
      </template>
    </details>
    <p v-if="proposal.failure" class="error-text">{{ proposal.failure }}</p>
    <div class="proposal-actions">
      <button
        v-if="proposal.state === 'pending' || proposal.state === 'failed'"
        class="primary"
        :disabled="busy || running"
        @click="proposalAction('apply')"
      >
        {{ proposal.state === 'failed' ? '重试应用' : '接受修改' }}
      </button>
      <button
        v-if="proposal.state === 'pending' || proposal.state === 'failed'"
        :disabled="busy || running"
        @click="proposalAction('reject')"
      >
        拒绝
      </button>
      <button
        v-if="proposal.state === 'applied'"
        :disabled="busy || running"
        @click="proposalAction('undo')"
      >
        撤销这次修改
      </button>
    </div>
  </section>
</template>

<style scoped>
.proposal-card strong {
  display: block;
  margin-bottom: 5px;
}
.proposal-card p {
  line-height: 1.7;
}
.proposal-card pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 280px;
  overflow: auto;
  font-size: 12px;
  font-family: inherit;
  padding: 8px;
}
.diff-before {
  background: var(--danger-bg);
}
.diff-after {
  background: var(--selected-bg);
}
.diff-changed {
  background: color-mix(in srgb, currentColor 18%, transparent);
  border-radius: 2px;
  font-weight: 650;
}
.diff-newline::before {
  content: '↵';
  opacity: 0.7;
}
.proposal-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
</style>
