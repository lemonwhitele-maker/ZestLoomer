<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { unwrap, type DocumentSnapshot } from '../../../shared/documents'
import type { HistoryEntry, WorkspaceAPI } from '../../../shared/workspace'

const props = defineProps<{
  bookId: string
  document: DocumentSnapshot
  busy: boolean
  error?: string
}>()
const emit = defineEmits<{ close: []; restore: [entryId: string] }>()
const api = (window.zestloomer as typeof window.zestloomer & { workspace: WorkspaceAPI }).workspace
const entries = ref<HistoryEntry[]>([])
const selected = ref<HistoryEntry | null>(null)
const loading = ref(false)
const dialog = ref<HTMLElement>()
const localError = ref('')
const locked = computed(() => props.busy || loading.value)
let loadId = 0
let readId = 0
onMounted(() => dialog.value?.focus())
function time(value: string): string {
  return new Date(value).toLocaleString('zh-CN')
}
async function choose(entry: HistoryEntry): Promise<void> {
  const token = ++readId
  const bookId = props.bookId,
    id = props.document.id
  loading.value = true
  localError.value = ''
  try {
    const value = unwrap(await api.historyRead(bookId, id, entry.entryId))
    if (token === readId && bookId === props.bookId && id === props.document.id)
      selected.value = value
  } catch (cause) {
    if (token === readId) localError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (token === readId) loading.value = false
  }
}
async function load(): Promise<void> {
  const token = ++loadId
  ++readId
  const bookId = props.bookId,
    id = props.document.id
  selected.value = null
  entries.value = []
  loading.value = true
  localError.value = ''
  try {
    const value = unwrap(await api.history(bookId, id))
    if (token !== loadId || bookId !== props.bookId || id !== props.document.id) return
    entries.value = value
    if (value[0]) await choose(value[0])
  } catch (cause) {
    if (token === loadId) localError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (token === loadId) loading.value = false
  }
}
watch(
  () => [props.bookId, props.document.id, props.document.version],
  () => {
    void load()
  },
  { immediate: true }
)
</script>

<template>
  <div class="history-backdrop" @keydown.esc.stop="!locked && emit('close')">
    <section
      ref="dialog"
      class="history-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="文档历史版本"
      tabindex="-1"
    >
      <header>
        <h2>历史版本 · {{ document.title }}</h2>
        <button :disabled="locked" aria-label="关闭历史版本" @click="emit('close')">×</button>
      </header>
      <p class="muted">
        选择一份已保存记录与当前版本对照。恢复会生成新的保存版本，当前内容也会保留在历史中。
      </p>
      <p v-if="localError || props.error" class="error" role="alert">
        {{ localError || props.error }}
      </p>
      <p v-if="loading" role="status">正在读取历史版本…</p>
      <div class="history-content">
        <section class="history-list" aria-label="保存记录">
          <button
            v-for="entry in entries"
            :key="entry.entryId"
            :disabled="locked"
            :class="{ active: selected?.entryId === entry.entryId }"
            @click="choose(entry)"
          >
            <strong>{{ time(entry.savedAt) }}</strong
            ><span>{{ entry.title }}</span
            ><small
              >{{ entry.words }} 字{{
                entry.version === document.version ? ' · 当前版本' : ''
              }}</small
            >
          </button>
          <p v-if="!loading && !entries.length" class="muted empty">
            暂无历史记录。之后保存的修改会记录在这里。
          </p>
        </section>
        <section class="version-comparison" aria-label="版本内容对照">
          <label
            >选中的历史版本<span class="muted">{{
              selected ? `${selected.title} · ${time(selected.savedAt)}` : '请选择保存记录'
            }}</span
            ><textarea :value="selected?.content ?? ''" readonly aria-label="历史版本正文" />
          </label>
          <label
            >当前已保存版本<span class="muted">{{ document.title }}</span
            ><textarea :value="document.content" readonly aria-label="当前版本正文" />
          </label>
        </section>
      </div>
      <footer>
        <button :disabled="locked" @click="emit('close')">关闭</button
        ><button
          class="primary"
          :disabled="
            locked ||
            !selected ||
            selected.content === undefined ||
            Boolean(document.trashedAt || document.readonlyExample)
          "
          @click="selected && emit('restore', selected.entryId)"
        >
          {{ busy ? '正在恢复…' : '恢复所选版本' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.history-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: #18231c66;
  display: grid;
  place-items: center;
  padding: 24px;
}
.history-dialog {
  width: min(1180px, 100%);
  max-height: calc(100vh - 48px);
  overflow: auto;
  background: var(--surface);
  color: var(--text-color);
  padding: 24px;
  border-radius: 14px;
  box-shadow: 0 16px 60px #0003;
}
header,
footer {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: 21px;
  overflow-wrap: anywhere;
}
footer {
  justify-content: flex-end;
  margin-top: 18px;
}
button,
textarea {
  font: inherit;
}
button {
  padding: 7px 12px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--button-bg);
  color: var(--subtle-text);
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.primary {
  background: var(--accent);
  color: #fff;
}
.muted,
small {
  color: var(--muted-text);
  font-weight: normal;
}
.error {
  color: var(--danger);
}
.history-content {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  min-height: 380px;
}
.history-list {
  max-height: 470px;
  overflow: auto;
  background: var(--panel-bg);
  padding: 8px;
}
.history-list button {
  display: grid;
  gap: 7px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 0;
  margin-bottom: 5px;
}
.history-list button.active {
  background: var(--selected-bg);
}
.history-list span {
  overflow-wrap: anywhere;
}
.empty {
  padding: 12px;
}
.version-comparison {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding: 12px;
}
.version-comparison label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-weight: 600;
  min-width: 0;
}
.version-comparison label span {
  font-size: 13px;
}
textarea {
  width: 100%;
  box-sizing: border-box;
  flex: 1;
  min-height: 260px;
  resize: vertical;
  border: 1px solid var(--line);
  background: var(--surface);
  padding: 12px;
  line-height: 1.8;
  color: var(--text-color);
  font-weight: normal;
}
@media (max-width: 900px) {
  .history-content {
    grid-template-columns: 1fr;
  }
  .history-list {
    max-height: 150px;
  }
  .history-dialog {
    padding: 16px;
  }
}
@media (max-width: 650px) {
  .version-comparison {
    grid-template-columns: 1fr;
  }
}
</style>
