<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { labels, kinds, unwrap, type DocumentKind } from '../../../shared/documents'
import { parseTextImport, type ImportAPI, type ImportDraft } from '../../../shared/imports'

const props = defineProps<{ busy: boolean; hasBook: boolean; error?: string }>()
const emit = defineEmits<{ close: []; submit: [draft: ImportDraft, newBookTitle?: string] }>()
const api = (window.loom as typeof window.loom & { imports: ImportAPI }).imports
const encoding = ref<'utf8' | 'gb18030'>('utf8')
const loading = ref(false)
const dialog = ref<HTMLElement>()
const localError = ref('')
const draft = ref<ImportDraft | null>(null)
const selected = ref<number[]>([])
const previewIndex = ref(0)
const split = ref(true)
const fileKind = ref<DocumentKind>('chapters')
const destination = ref<'current' | 'new'>(props.hasBook ? 'current' : 'new')
const bookTitle = ref('')
const selectedCount = computed(() => selected.value.length)
const preview = computed(() => draft.value?.items[previewIndex.value])
const locked = computed(() => props.busy || loading.value)
const allSelected = computed(
  () => Boolean(draft.value?.items.length) && selected.value.length === draft.value!.items.length
)
const canSubmit = computed(
  () =>
    !locked.value &&
    selectedCount.value > 0 &&
    (destination.value === 'current' ? props.hasBook : Boolean(bookTitle.value.trim()))
)
onMounted(() => dialog.value?.focus())

function setDraft(value: ImportDraft): void {
  draft.value = value
  selected.value = value.items.map((_, index) => index)
  previewIndex.value = 0
  bookTitle.value = value.bookTitle || value.sourceLabel
  split.value = value.sourceFormat !== 'markdown'
  fileKind.value = 'chapters'
}
async function choose(): Promise<void> {
  if (locked.value) return
  loading.value = true
  localError.value = ''
  try {
    const value = unwrap(await api.chooseFile(encoding.value))
    if (value) setDraft(value)
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
  }
}
function reparse(): void {
  if (!draft.value || draft.value.rawContent === undefined || locked.value) return
  try {
    const next = parseTextImport(draft.value.rawContent, draft.value.sourceLabel, {
      markdown: draft.value.sourceFormat === 'markdown',
      split: split.value,
      kind: fileKind.value
    })
    draft.value = next
    selected.value = next.items.map((_, index) => index)
    previewIndex.value = 0
    localError.value = ''
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : String(cause)
  }
}
function toggleAll(): void {
  selected.value = allSelected.value ? [] : draft.value?.items.map((_, index) => index) || []
}
function submit(): void {
  if (!canSubmit.value || !draft.value) return
  const indices = new Set(selected.value)
  const value: ImportDraft = {
    sourceLabel: draft.value.sourceLabel,
    bookTitle: draft.value.bookTitle,
    warnings: [...draft.value.warnings],
    sourceFormat: draft.value.sourceFormat,
    items: draft.value.items
      .filter((_, index) => indices.has(index))
      .map((item) => ({ ...item, title: item.title.trim() }))
  }
  if (
    value.items.some(
      (item) => !item.title || item.title.length > 200 || /[\r\n\0]/.test(item.title)
    )
  ) {
    localError.value = '请为每篇选中的文档填写 1–200 字且不换行的标题。'
    return
  }
  emit('submit', value, destination.value === 'new' ? bookTitle.value.trim() : undefined)
}
</script>

<template>
  <div class="import-backdrop" @keydown.esc.stop="!locked && emit('close')">
    <section
      ref="dialog"
      class="import-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="导入文字资料"
      tabindex="-1"
    >
      <header>
        <h2>导入文字资料</h2>
        <button :disabled="locked" aria-label="关闭导入" @click="emit('close')">×</button>
      </header>
      <p class="muted">先选择来源并核对预览，再把选中的文档加入作品。原文件会完整保留。</p>
      <div class="source-actions">
        <label
          >文本编码<select v-model="encoding" :disabled="locked" aria-label="导入文本编码">
            <option value="utf8">UTF-8（通常使用）</option>
            <option value="gb18030">GB18030（旧中文文本）</option>
          </select></label
        >
        <button :disabled="locked" @click="choose()">选择 TXT / Markdown</button>
      </div>
      <p v-if="loading" role="status">正在读取来源…</p>
      <p v-if="localError || props.error" class="error" role="alert">
        {{ localError || props.error }}
      </p>
      <template v-if="draft">
        <div class="source-options">
          <strong>{{ draft.sourceLabel }}</strong>
          <template v-if="draft.rawContent !== undefined">
            <label
              ><input
                v-model="split"
                type="checkbox"
                :disabled="locked"
                @change="reparse"
              />按章节标题拆分{{
                draft.sourceFormat === 'markdown' ? '（也识别 Markdown 标题）' : ''
              }}</label
            >
            <label
              >导入分类<select v-model="fileKind" :disabled="locked" @change="reparse">
                <option v-for="kind in kinds" :key="kind" :value="kind">{{ labels[kind] }}</option>
              </select></label
            >
          </template>
        </div>
        <div class="import-preview">
          <section class="import-items" aria-label="待导入文档">
            <div class="selection-row">
              <button :disabled="locked" @click="toggleAll">
                {{ allSelected ? '取消全选' : '全选' }}</button
              ><span>已选 {{ selectedCount }} / {{ draft.items.length }} 篇</span>
            </div>
            <div
              v-for="(item, index) in draft.items"
              :key="index"
              class="import-item"
              :class="{ active: previewIndex === index }"
            >
              <input
                v-model="selected"
                :value="index"
                type="checkbox"
                :disabled="locked"
                :aria-label="'导入 ' + item.title"
              />
              <button class="item-name" :disabled="locked" @click="previewIndex = index">
                <span>{{ item.title }}</span
                ><small
                  >{{ labels[item.kind] }} ·
                  {{ Array.from(item.content.replace(/\s/g, '')).length }} 字</small
                >
              </button>
            </div>
          </section>
          <section v-if="preview" class="text-preview" aria-label="来源内容预览">
            <label
              >文档标题<input
                v-model="preview.title"
                :disabled="locked"
                maxlength="200"
                aria-label="导入文档标题"
            /></label>
            <textarea :value="preview.content" readonly aria-label="导入正文预览" />
          </section>
        </div>
        <details v-if="draft.warnings.length" class="import-warnings" open>
          <summary>需要核对的事项（{{ draft.warnings.length }}）</summary>
          <ul>
            <li v-for="(warning, index) in draft.warnings" :key="index">{{ warning }}</li>
          </ul>
        </details>
        <div class="destination">
          <label
            >导入到<select v-model="destination" :disabled="locked">
              <option v-if="hasBook" value="current">当前作品（追加到各分类末尾）</option>
              <option value="new">新作品</option>
            </select></label
          >
          <label v-if="destination === 'new'"
            >新作品名称<input
              v-model="bookTitle"
              :disabled="locked"
              maxlength="200"
              aria-label="导入新作品名称"
          /></label>
        </div>
      </template>
      <footer>
        <button :disabled="locked" @click="emit('close')">取消</button
        ><button class="primary" :disabled="!canSubmit" @click="submit">
          {{ busy ? '正在导入…' : `导入${selectedCount ? ' ' + selectedCount + ' 篇' : ''}` }}
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.import-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: #18231c66;
  display: grid;
  place-items: center;
  padding: 24px;
}
.import-dialog {
  width: min(1020px, 100%);
  max-height: calc(100vh - 48px);
  overflow: auto;
  padding: 24px;
  background: var(--surface);
  color: var(--text-color);
  border-radius: 14px;
  box-shadow: 0 16px 60px #0003;
}
header,
footer,
.source-actions,
.source-options,
.selection-row,
.destination {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
header {
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: 21px;
}
footer {
  justify-content: flex-end;
  margin-top: 18px;
}
label {
  display: flex;
  align-items: center;
  gap: 8px;
}
button,
input,
select,
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
input:not([type='checkbox']),
select {
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: var(--surface);
  color: var(--text-color);
}
.muted,
small {
  color: var(--muted-text);
}
.error {
  color: var(--danger);
}
.source-options {
  margin: 18px 0 12px;
}
.source-options strong {
  margin-right: auto;
}
.import-preview {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) 2fr;
  height: 340px;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}
.import-items {
  overflow: auto;
  background: var(--panel-bg);
}
.selection-row {
  padding: 10px;
  position: sticky;
  top: 0;
  background: var(--panel-bg);
}
.import-item {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  gap: 6px;
}
.import-item.active {
  background: var(--selected-bg);
}
.item-name {
  text-align: left;
  display: grid;
  gap: 4px;
  background: transparent;
  border: 0;
  min-width: 0;
  flex: 1;
}
.item-name span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.text-preview {
  display: flex;
  flex-direction: column;
  padding: 12px;
  gap: 10px;
  min-width: 0;
}
.text-preview input {
  flex: 1;
}
textarea {
  flex: 1;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  resize: none;
  border: 1px solid var(--line);
  padding: 12px;
  background: var(--surface);
  line-height: 1.7;
  color: var(--text-color);
}
.import-warnings {
  margin: 14px 0;
  background: var(--warning-bg);
  color: var(--warning);
  padding: 10px 14px;
  border-radius: 6px;
}
.import-warnings ul {
  max-height: 100px;
  overflow: auto;
  margin-bottom: 0;
  padding-left: 20px;
  font-size: 13px;
  line-height: 1.6;
}
.destination {
  margin-top: 14px;
}
@media (max-width: 760px) {
  .import-preview {
    grid-template-columns: 1fr;
    height: auto;
  }
  .import-items {
    max-height: 170px;
  }
  .text-preview {
    height: 230px;
  }
  .import-dialog {
    padding: 16px;
  }
}
</style>
