<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { AgentMessage, AgentProfile, AgentSnapshot, Proposal } from '../../../../shared/agent'
import { labels } from '../../../../shared/documents'
import AgentProgress from './AgentProgress.vue'
import ProposalCard from './ProposalCard.vue'
import StreamingMessage from './StreamingMessage.vue'

const props = defineProps<{
  profiles: AgentProfile[]
  defaultProfileId?: string
  snapshot: AgentSnapshot
  liveText: string
  toolText: string
  busy: boolean
  hasBook: boolean
  document?: { id: string; title: string }
  selectionText: string
  targetRewrite: boolean
  unifiedProposalPreview: boolean
}>()
const emit = defineEmits<{
  preferences: [id: string, profileId: string, archived: boolean]
  close: []
  create: []
  select: [id: string]
  rename: [id: string, title: string]
  send: [
    id: string,
    text: string,
    options: { document: boolean; selection: boolean; targetRewrite: boolean }
  ]
  cancel: []
  action: [id: string, action: 'apply' | 'reject' | 'undo', hash: string]
  reference: [id: string]
  settings: []
  'export-log': [id: string]
}>()
const selected = ref('')
const drafts = reactive<Record<string, string>>({})
const input = computed({
  get: () => drafts[selected.value] || '',
  set: (text: string) => {
    drafts[selected.value] = text
  }
})
const title = ref('')
const includeDocument = ref(true)
const includeSelection = ref(true)
const composing = ref(false)
const followLatest = ref(true)
const composer = ref<HTMLTextAreaElement>()
const effectiveProfile = computed(() =>
  current.value?.profileId
    ? props.profiles.find((p) => p.id === current.value?.profileId)
    : defaultProfile.value
)
const selectionTooLong = computed(
  () => includeDocument.value && includeSelection.value && props.selectionText.length > 8000
)
function trackScroll(): void {
  const el = messagesElement.value
  if (el) followLatest.value = el.scrollHeight - el.scrollTop - el.clientHeight < 64
}
let scrollFrame: number | undefined
function scheduleLatest(): void {
  if (scrollFrame !== undefined) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = undefined
    if (followLatest.value) latest()
  })
}
onBeforeUnmount(() => {
  if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame)
})
function latest(): void {
  followLatest.value = true
  if (messagesElement.value) messagesElement.value.scrollTop = messagesElement.value.scrollHeight
}
function editRequest(text: string): void {
  if (input.value && input.value !== text) return
  input.value = text
  composer.value?.focus()
}
function keyboardSend(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    if (!event.repeat && !event.isComposing && !composing.value && event.keyCode !== 229) send()
  }
}
const messagesElement = ref<HTMLDivElement>()
const current = computed(() => props.snapshot.conversations.find((c) => c.id === selected.value))
const defaultProfile = computed(() => props.profiles.find((p) => p.id === props.defaultProfileId))
const timeline = computed(() => {
  const entries: { id: string; at: string; message?: AgentMessage; proposal?: Proposal }[] = (
    current.value?.messages || []
  ).map((m, index) => ({
    id: m.id,
    at: m.createdAt || `0000-${String(index).padStart(10, '0')}`,
    message: m
  }))
  for (const p of props.snapshot.proposals.filter((p) => p.conversationId === selected.value))
    entries.push({ id: p.id, at: p.createdAt, proposal: p })
  return entries.sort((a, b) => a.at.localeCompare(b.at))
})
const running = computed(() => Boolean(props.snapshot.active))
watch(
  () => props.snapshot.conversations,
  (items) => {
    if (!items.some((c) => c.id === selected.value))
      selected.value = props.snapshot.active?.conversationId || items.at(-1)?.id || ''
  },
  { immediate: true }
)
watch(current, (c) => {
  title.value = c?.title || ''
})
watch(
  // Snapshot refreshes (including proposal reviews) do not add messages.
  // Watch the values separately so a new snapshot cannot scroll the review away.
  [() => props.liveText, () => current.value?.messages.length],
  async () => {
    await nextTick()
    if (messagesElement.value?.offsetParent !== null && followLatest.value) scheduleLatest()
  }
)
function send(): void {
  if (
    current.value &&
    input.value.trim() &&
    !running.value &&
    !current.value.archived &&
    !props.busy &&
    !composing.value &&
    !selectionTooLong.value &&
    effectiveProfile.value
  )
    emit('send', current.value.id, input.value.trim(), {
      document: includeDocument.value,
      selection: includeSelection.value,
      targetRewrite: props.targetRewrite
    })
}
const visibleCount = ref(40)
const copyStatus = ref('')
async function copyMessage(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    copyStatus.value = '已复制'
  } catch {
    copyStatus.value = '复制失败，请选择文字复制'
  }
}

defineExpose({
  send,
  clearInput: (id: string, text: string) => {
    if (drafts[id]?.trim() === text) drafts[id] = ''
  },
  select: (id: string) => {
    selected.value = id
  }
})
</script>

<template>
  <aside class="agent-panel" aria-label="Agent 对话">
    <header>
      <strong>Agent 对话</strong>
      <div class="row">
        <button
          :disabled="busy || !current?.lastTurn || snapshot.active?.conversationId === selected"
          title="导出当前会话最近一轮的完整输入上下文、模型回复和工具结果"
          @click="current && emit('export-log', current.id)"
        >
          导出本轮日志
        </button>
        <button @click="emit('settings')">AI 设置</button
        ><button aria-label="收起 Agent" @click="emit('close')">×</button>
      </div>
    </header>
    <div class="agent-controls">
      <select
        v-model="selected"
        aria-label="选择会话"
        :disabled="busy"
        @change="emit('select', selected)"
      >
        <option v-if="!snapshot.conversations.length" value="">尚无会话</option>
        <option v-for="c in snapshot.conversations" :key="c.id" :value="c.id">
          {{ c.archived ? '[已归档] ' : '' }}{{ c.title }}
        </option>
      </select>
      <button :disabled="!hasBook || busy" @click="emit('create')">新对话</button>
      <details v-if="current" class="conversation-menu">
        <summary aria-label="会话选项" title="改名、归档与运行记录">···</summary>
        <div class="conversation-menu-content">
          <form class="agent-title" @submit.prevent="emit('rename', current.id, title)">
            <input v-model="title" maxlength="200" aria-label="会话标题" /><button
              :disabled="busy || !title.trim()"
            >
              改名
            </button>
          </form>
          <button
            :disabled="running || busy"
            @click="emit('preferences', current.id, current.profileId || '', !current.archived)"
          >
            {{ current.archived ? '恢复会话' : '归档会话' }}
          </button>
          <details v-if="current.memory">
            <summary>会话记忆（讨论记录）</summary>
            <p class="muted">
              以下是较早讨论的摘录，可能已省略部分内容，不代表书稿事实；本轮还会按容量带上近期对话。
            </p>
            <strong>最近目标</strong>
            <p>{{ current.memory.objective?.text || '尚无记录' }}</p>
            <template v-for="group in ['preferences', 'todos', 'discussion'] as const" :key="group">
              <strong>{{
                { preferences: '写作偏好', todos: '待办线索', discussion: '讨论摘录' }[group]
              }}</strong>
              <ul v-if="current.memory[group].length">
                <li v-for="item in current.memory[group]" :key="item.messageId">
                  {{ item.role === 'user' ? '你' : 'Loom' }}：{{ item.text }}
                </li>
              </ul>
              <p v-else>尚无记录</p>
            </template>
            <strong>曾引用的资料（使用前需重新核对）</strong>
            <button
              v-for="source in current.memory.sources"
              :key="source.id"
              @click="emit('reference', source.id)"
            >
              {{ source.title }}
            </button>
          </details>
          <details v-if="current.diagnostics?.length">
            <summary>运行记录</summary>
            <pre>{{ current.diagnostics }}</pre>
          </details>
        </div>
      </details>
    </div>
    <p v-for="warning in snapshot.warnings || []" :key="warning" role="status">{{ warning }}</p>
    <div v-if="current" class="agent-controls">
      <select
        aria-label="会话模型"
        :value="current.profileId || ''"
        :disabled="running || busy"
        @change="
          emit(
            'preferences',
            current.id,
            ($event.target as HTMLSelectElement).value,
            Boolean(current.archived)
          )
        "
      >
        <option value="">
          {{
            defaultProfile
              ? `默认 · ${defaultProfile.label} · ${defaultProfile.model}`
              : '尚未配置模型'
          }}
        </option>
        <option v-for="p in profiles" :key="p.id" :value="p.id">
          {{ p.label }} · {{ p.model }}
        </option>
      </select>
    </div>
    <div ref="messagesElement" class="agent-messages" @scroll="trackScroll">
      <p v-if="!current" class="muted">
        新建一个对话，与故事一起思考。尚未确定的想法建议保存在速记。
      </p>
      <button v-if="timeline.length > visibleCount" @click="visibleCount += 40">
        显示更早消息
      </button>
      <p role="status">{{ copyStatus }}</p>
      <template v-for="entry in timeline.slice(-visibleCount)" :key="entry.id">
        <article
          v-for="m in entry.message ? [entry.message] : []"
          :key="m.id"
          :class="['agent-message', m.role]"
        >
          <small>{{ m.role === 'user' ? '你' : 'Loom' }}</small>
          <div class="message-text">{{ m.text }}</div>
          <details v-if="m.context" class="sent-context">
            <summary>发送时的上下文 · {{ m.context.document?.title || '未附带当前文档' }}</summary>
            <p>模型：{{ m.context.model }}</p>
            <p>目标改写：{{ m.context.workspace.targetRewrite ? '开启' : '关闭' }}</p>
            <template v-if="m.rewrite">
              <p>{{ m.rewrite.reason }}</p>
              <p>
                使用 {{ m.rewrite.historyTurnIds.length }} 轮有效对话<span
                  v-if="m.rewrite.omittedTurns"
                  >，预算不足省略 {{ m.rewrite.omittedTurns }} 轮</span
                >。
              </p>
              <pre v-if="m.rewrite.target">{{ JSON.stringify(m.rewrite.target, null, 2) }}</pre>
            </template>
            <p v-if="m.context.document">
              文档：{{ m.context.document.title }} · 保存版本
              {{ m.context.document.version.slice(0, 12) }}
            </p>
            <pre v-if="m.context.workspace.selection">{{ m.context.workspace.selection.text }}</pre>
            <p v-else>未附带选区</p>
            <p>文档位置与选区在发送时固定；历史讨论按容量整理，Agent 可按任务读取书内资料。</p>
          </details>
          <button @click="copyMessage(m.text)">复制</button
          ><button
            v-if="m.role === 'user'"
            :disabled="running || busy || current?.archived"
            @click="input = m.text"
          >
            再次编辑
          </button>
          <div v-if="m.sources.length" class="agent-sources">
            <button
              v-for="source in m.sources"
              :key="source.id"
              :title="'读取版本 ' + source.version.slice(0, 12)"
              @click="emit('reference', source.id)"
            >
              {{ source.title }}
            </button>
          </div>
        </article>
        <ProposalCard
          v-for="p in entry.proposal ? [entry.proposal] : []"
          :key="p.id"
          :proposal="p"
          :busy="busy"
          :running="running"
          :labels="labels"
          :unified-preview="unifiedProposalPreview"
          @action="(id, action, hash) => emit('action', id, action, hash)"
        />
      </template>
      <StreamingMessage
        :active="Boolean(snapshot.active)"
        :conversation-id="snapshot.active?.conversationId || ''"
        :selected-id="selected"
        :live-text="liveText"
        :tool-text="toolText"
      />
    </div>
    <button v-if="!followLatest" class="latest-button" @click="latest">回到最新消息</button>
    <AgentProgress
      v-if="current"
      :conversation="current"
      :proposals="snapshot.proposals"
      :active="snapshot.active?.conversationId === selected"
      :live-text="liveText"
      :can-edit="!input || input === current.messages.filter((m) => m.role === 'user').at(-1)?.text"
      @edit="editRequest"
      @settings="emit('settings')"
    />
    <form class="agent-input" @submit.prevent="send">
      <details class="context-preview">
        <summary>
          发送上下文 · {{ includeDocument && document ? document.title : '不附带文档'
          }}{{
            includeDocument && includeSelection && selectionText
              ? ` · 选中 ${Array.from(selectionText).length} 字符`
              : ''
          }}
        </summary>
        <div class="context-options">
          <label
            ><input
              v-model="includeDocument"
              type="checkbox"
              :disabled="!document"
            />附带当前文档位置</label
          >
          <label v-if="selectionText"
            ><input
              v-model="includeSelection"
              type="checkbox"
              :disabled="!includeDocument"
            />附带选区原文</label
          >
          <pre v-if="includeDocument && includeSelection && selectionText">{{ selectionText }}</pre>
          <p>
            当前文档会在发送前保存。文档位置用于定位，全文由 Agent 按需读取。关闭附带内容不会限制
            Agent 查阅书内其他资料。
          </p>
          <p>会话记忆和近期对话会按模型容量整理后使用。可在会话选项中查看记忆。</p>
        </div>
      </details>
      <p class="model-hint">
        本次模型：{{
          effectiveProfile
            ? `${effectiveProfile.label} · ${effectiveProfile.model}`
            : '尚未配置，请打开 AI 设置'
        }}
      </p>
      <p v-if="selectionTooLong" class="error-text">
        选区超过 8000 字符，请缩小选区或取消附带选区。
      </p>
      <div v-if="current && !input" class="starters">
        <button
          type="button"
          @click="editRequest('请查阅当前文档及相关人物、设定，指出不一致之处，先不要修改。')"
        >
          检查一致性
        </button>
        <button
          v-if="selectionText && includeDocument && includeSelection"
          type="button"
          @click="editRequest('请润色选区，保持原意和叙事视角，并提出修改提案。')"
        >
          润色选区
        </button>
        <button
          type="button"
          @click="
            editRequest('请整理当前文档中的构想，区分已明确的内容与仍需讨论的问题，先不要修改。')
          "
        >
          整理构想
        </button>
      </div>
      <textarea
        ref="composer"
        v-model="input"
        aria-label="给 Agent 的消息"
        placeholder="讨论情节，或请 Loom 查阅并修改资料…"
        maxlength="16000"
        :disabled="!current || current.archived || busy"
        @compositionstart="composing = true"
        @compositionend="composing = false"
        @keydown="keyboardSend"
      />
      <div class="row">
        <small class="muted">{{
          running ? '可继续写草稿，任务结束后发送。' : 'Ctrl+Enter 发送 · 修改需接受后保存。'
        }}</small
        ><button v-if="running" type="button" :disabled="busy" @click="emit('cancel')">
          取消任务</button
        ><button
          v-else
          class="primary"
          :disabled="
            !current ||
            current.archived ||
            !input.trim() ||
            busy ||
            composing ||
            selectionTooLong ||
            !effectiveProfile
          "
        >
          发送
        </button>
      </div>
    </form>
  </aside>
</template>

<style scoped>
.context-preview,
.sent-context,
.model-hint {
  font-size: 11px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.context-preview summary,
.sent-context summary {
  cursor: pointer;
}
.context-options {
  max-height: min(120px, 14vh);
  overflow: auto;
  padding: 8px 0;
}
.context-options label {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0;
}
.context-options input {
  width: auto;
}
.context-options pre,
.sent-context pre {
  white-space: pre-wrap;
  max-height: 120px;
  overflow: auto;
  font-family: inherit;
}
.starters {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 6px;
}
.starters button,
.latest-button {
  font-size: 11px;
}
.conversation-menu-content p,
.conversation-menu-content li {
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.agent-panel {
  width: var(--agent-width, 380px);
  flex: 0 0 var(--agent-width, 380px);
  min-width: 300px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.agent-controls {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--line);
}
.agent-controls select {
  flex: 1;
  min-width: 130px;
}
.agent-panel header {
  padding: 0 12px;
  min-height: 52px;
  height: 52px;
  flex-shrink: 0;
}
.agent-panel header button {
  font-size: 12px;
}
.conversation-menu {
  position: relative;
}
.conversation-menu > summary {
  list-style: none;
  cursor: pointer;
  padding: 7px 10px;
  border-radius: 6px;
  background: var(--button-bg);
}
.conversation-menu-content {
  position: absolute;
  top: 38px;
  right: 0;
  z-index: 25;
  width: 310px;
  max-width: 80vw;
  max-height: 350px;
  overflow: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  box-shadow: 0 8px 24px #28302222;
}
.conversation-menu-content summary {
  cursor: pointer;
  font-size: 12px;
}
.conversation-menu-content pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
}
.agent-title {
  width: 100%;
  display: flex;
  gap: 6px;
}
.agent-title input {
  flex: 1;
  min-width: 0;
}
.agent-messages {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px;
}
.agent-message {
  padding: 12px;
  margin-bottom: 12px;
  border-radius: 8px;
  background: var(--surface);
}
.agent-message.user {
  background: var(--selected-bg);
}
.agent-message small,
.proposal-card > small {
  display: block;
  color: var(--muted-text);
  font-size: 11px;
  margin-bottom: 6px;
}
.message-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.8;
}
.agent-sources {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 10px;
}
.agent-sources button {
  font-size: 11px;
  background: var(--button-bg);
}
.proposal-card {
  background: var(--surface);
  border: 1px solid var(--line);
  padding: 12px;
  border-radius: 8px;
  margin-bottom: 12px;
  font-size: 12px;
}
.agent-input {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 40%;
  overflow: hidden;
  padding: 12px;
  border-top: 1px solid var(--line);
}
.agent-input textarea {
  width: 100%;
  flex-shrink: 0;
  height: 80px;
  min-height: 64px;
  resize: none;
}
.agent-input .context-preview {
  min-height: 24px;
  overflow: auto;
}
.agent-input .model-hint {
  margin: 0;
  flex-shrink: 0;
}
.agent-input .row {
  flex-shrink: 0;
  justify-content: space-between;
  margin-top: 8px;
}
.agent-input small {
  font-size: 10px;
}
</style>
