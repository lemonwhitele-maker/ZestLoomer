<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { labels, unwrap, type DocumentMeta } from '../../../shared/documents'
import type { SearchHit } from '../../../shared/workspace'

const props = defineProps<{ bookId: string; documents: DocumentMeta[]; busy: boolean }>()
const emit = defineEmits<{ close: []; open: [id: string, line?: number] }>()
const query = ref('')
const mode = ref<'titles' | 'content'>('titles')
const input = ref<HTMLInputElement>()
const resultsList = ref<HTMLElement>()
const hits = ref<SearchHit[]>([])
const loading = ref(false)
const error = ref('')
const index = ref(0)
let request = 0
let timer: ReturnType<typeof setTimeout> | undefined
const results = computed(() =>
  mode.value === 'content'
    ? hits.value
    : props.documents
        .filter(
          (doc) =>
            !doc.trashedAt &&
            doc.title.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())
        )
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.order - b.order)
        .slice(0, 100)
        .map((doc) => ({ ...doc, line: 0, excerpt: '' }))
)
watch([query, mode], () => {
  clearTimeout(timer)
  void window.zestloomer.workspace.cancelSearch(props.bookId).catch(() => {})
  const token = ++request
  index.value = 0
  hits.value = []
  error.value = ''
  loading.value = false
  if (mode.value !== 'content' || !query.value.trim()) return
  loading.value = true
  timer = setTimeout(async () => {
    try {
      const value = unwrap(
        await window.zestloomer.workspace.search(props.bookId, query.value.trim())
      )
      if (token === request) hits.value = value
    } catch (e) {
      if (token === request) error.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (token === request) loading.value = false
    }
  }, 250)
})
function keyboard(event: KeyboardEvent): void {
  if (event.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    if (!props.busy) emit('close')
    return
  }
  // Buttons and individual results retain their native keyboard activation.
  if (event.target !== input.value) return
  if (['ArrowDown', 'ArrowUp'].includes(event.key) && results.value.length) {
    event.preventDefault()
    index.value =
      (index.value + (event.key === 'ArrowDown' ? 1 : -1) + results.value.length) %
      results.value.length
    void nextTick(() => {
      resultsList.value
        ?.querySelectorAll<HTMLElement>('.quick-result')
        [index.value]?.scrollIntoView({ block: 'nearest' })
    })
  }
  if (event.key === 'Enter' && results.value[index.value] && !props.busy) {
    event.preventDefault()
    const hit = results.value[index.value]
    emit('open', hit.id, hit.line || undefined)
  }
}
onMounted(() => {
  void nextTick(() => input.value?.focus())
})
onBeforeUnmount(() => {
  request++
  clearTimeout(timer)
  void window.zestloomer.workspace.cancelSearch(props.bookId).catch(() => {})
})
</script>

<template>
  <div class="modal-backdrop" @keydown="keyboard">
    <section
      class="dialog quick-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="快速打开与全文搜索"
    >
      <h2>快速打开</h2>
      <div class="row search-tabs">
        <button :aria-pressed="mode === 'titles'" @click="mode = 'titles'">按标题</button>
        <button :aria-pressed="mode === 'content'" @click="mode = 'content'">全书全文</button>
      </div>
      <input
        ref="input"
        v-model="query"
        aria-label="快速搜索"
        :placeholder="mode === 'titles' ? '输入标题…' : '搜索作品里的文字…'"
      />
      <p class="muted">↑↓ 选择 · Enter 打开 · Esc 关闭</p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <div ref="resultsList" class="quick-results" role="list">
        <button
          v-for="(hit, itemIndex) in results"
          :key="hit.id + ':' + hit.line"
          class="quick-result"
          :class="{ active: itemIndex === index }"
          :disabled="busy"
          @click="emit('open', hit.id, hit.line || undefined)"
        >
          <strong>{{ hit.title }}</strong
          ><small>{{ labels[hit.kind] }}{{ hit.line ? ' · 第 ' + hit.line + ' 行' : '' }}</small>
          <span v-if="hit.excerpt">{{ hit.excerpt }}</span>
        </button>
        <p v-if="loading" role="status">正在查找…</p>
        <p v-else-if="!results.length" class="muted">
          {{
            query.trim()
              ? '没有找到匹配内容'
              : mode === 'content'
                ? '输入文字后搜索全书'
                : '作品里还没有文档'
          }}
        </p>
      </div>
      <div class="dialog-actions">
        <button :disabled="busy" @click="emit('close')">关闭</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.quick-dialog {
  width: min(680px, 92vw);
}
.quick-dialog > input {
  width: 100%;
  box-sizing: border-box;
}
.search-tabs {
  margin-bottom: 12px;
}
.search-tabs [aria-pressed='true'] {
  background: var(--selected-bg, #e1e7d9);
}
.quick-results {
  max-height: 48vh;
  overflow: auto;
  display: grid;
  gap: 6px;
}
.quick-result {
  text-align: left;
  display: grid;
  gap: 5px;
  padding: 12px;
  background: transparent;
}
.quick-result.active {
  background: var(--selected-bg, #e1e7d9);
}
.quick-result small,
.quick-result span {
  color: var(--muted-text, #73796d);
}
.quick-result span {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
