<script setup lang="ts">
import { computed } from 'vue'
import type { Proposal } from '../../../../shared/agent'
import { counters } from '../../../../shared/perf'
import { proposalDiff } from '../../../../shared/proposalDiff'

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

const diffCache = new Map<string, ReturnType<typeof proposalDiff>>()

const diff = computed(() => {
  const key = `${props.proposal.candidateHash}:${props.proposal.before?.version || 'none'}:${props.unifiedPreview}`
  if (!diffCache.has(key)) {
    counters.countProposalDiff()
    diffCache.set(
      key,
      proposalDiff(
        props.proposal.before?.content || '',
        props.proposal.content,
        props.unifiedPreview
      )
    )
  }
  return diffCache.get(key)!
})

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
    <small>{{ proposal.createdAt }} · {{ proposal.turnId }}</small>
    <p v-if="diff.coarse">文档较大，显示完整前后对照。</p>
    <div v-for="(h, index) in diff.hunks" :key="index" class="proposal-diff">
      <div v-if="proposal.before">
        <small>修改前 · 第 {{ h.oldLine }} 行</small>
        <pre class="diff-before">{{ h.before || '（空）' }}</pre>
      </div>
      <div>
        <small>{{ proposal.before ? '修改后' : '新建内容' }}</small>
        <pre class="diff-after">{{ h.after || '（空）' }}</pre>
      </div>
    </div>
    <details>
      <summary>查看完整内容</summary>
      <pre v-if="proposal.before">
修改前：
{{ proposal.before.content }}</pre
      >
      <pre>
候选内容：
{{ proposal.content }}</pre
      >
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
.proposal-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
</style>
