<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { DocumentMeta, DocumentKind } from '../../../shared/documents'
import {
  chapterDiagnostics,
  defaultNamingRule,
  formatChapterTitles,
  renumberChapters,
  sortChapters,
  validateNamingRule,
  type NamingRule
} from '../../../shared/chapterNaming'

const props = defineProps<{
  documents: DocumentMeta[]
  busy: boolean
  error?: string
  kind?: DocumentKind
}>()
const noun = computed(() => (props.kind === 'outlines' ? '大纲' : '章节'))
const emit = defineEmits<{
  close: []
  applyOrder: [ids: string[], expectedIds: string[]]
  applyNames: [changes: { id: string; title: string }[]]
}>()
const form = ref<HTMLFormElement>()
const previousFocus = document.activeElement as HTMLElement | null
const action = ref<'order' | 'names'>('order')
const sortMode = ref<'number' | 'natural' | 'created'>(
  props.kind === 'outlines' ? 'natural' : 'number'
)
const namingAction = ref<'renumber' | 'format'>('renumber')
const naming = reactive<NamingRule>({ ...defaultNamingRule, mode: 'number' })
const customTemplate = ref(false)
watch(customTemplate, (enabled) => {
  if (enabled && !naming.template.trim())
    naming.template = `第{${naming.mode === 'hanzi' ? 'cn' : 'n'}}${naming.suffix} {title}`
})
const effectiveNaming = computed<NamingRule>(() => ({
  ...naming,
  template: customTemplate.value ? naming.template : ''
}))
const diagnostics = computed(() => chapterDiagnostics(props.documents))
const sorted = computed(() => sortChapters(props.documents, sortMode.value))
const orderChanged = computed(() =>
  sorted.value.some((item, index) => item.id !== props.documents[index]?.id)
)
function namePreview(): { id: string; title: string }[] {
  return namingAction.value === 'renumber'
    ? renumberChapters(props.documents, effectiveNaming.value)
    : formatChapterTitles(props.documents, effectiveNaming.value)
}
const nameError = computed(() => {
  const validation = validateNamingRule(effectiveNaming.value)
  if (validation) return validation
  if (customTemplate.value && !naming.template.trim()) return '请填写自定义命名模板。'
  try {
    const titles = namePreview()
    return titles.some(
      (item) => !item.title || item.title.length > 200 || /[\r\n]/.test(item.title)
    )
      ? '生成后的标题应为 1–200 个字符，不能包含换行。'
      : ''
  } catch (error) {
    return (error as Error).message
  }
})
const renamed = computed(() => (nameError.value ? [] : namePreview()))
const changes = computed(() =>
  renamed.value.filter((item, index) => item.title !== props.documents[index]?.title)
)
const duplicateNames = computed(() => {
  const seen = new Set<string>(),
    duplicate = new Set<string>()
  for (const item of renamed.value) {
    if (seen.has(item.title)) duplicate.add(item.title)
    seen.add(item.title)
  }
  return [...duplicate]
})
const canApply = computed(
  () =>
    !props.busy &&
    (action.value === 'order' ? orderChanged.value : !nameError.value && changes.value.length > 0)
)
function close(): void {
  if (!props.busy) emit('close')
}
function apply(): void {
  if (!canApply.value) return
  if (action.value === 'order')
    emit(
      'applyOrder',
      sorted.value.map((item) => item.id),
      props.documents.map((item) => item.id)
    )
  else emit('applyNames', changes.value)
}
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
  if (event.key !== 'Tab') return
  const candidates = [
    ...(form.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled)'
    ) || [])
  ].filter((element) => element.offsetParent !== null)
  const first = candidates[0],
    last = candidates.at(-1)
  if (!first) {
    event.preventDefault()
    return
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
onMounted(async () => {
  await nextTick()
  form.value?.querySelector<HTMLElement>('button')?.focus()
})
onBeforeUnmount(() => previousFocus?.focus())
</script>

<template>
  <div class="modal-backdrop" @click.self="close" @keydown="keydown">
    <form
      ref="form"
      class="dialog chapter-organize"
      role="dialog"
      aria-modal="true"
      :aria-label="'整理' + noun"
      @submit.prevent="apply"
    >
      <h2>整理{{ noun }}</h2>
      <p class="muted">
        范围：当前分类的全部 {{ documents.length }} 个{{ noun }}。先检查预览，再应用。
      </p>
      <div class="action-tabs" role="group" aria-label="整理方式">
        <button
          type="button"
          :aria-pressed="action === 'order'"
          :disabled="busy"
          @click="action = 'order'"
        >
          整理顺序</button
        ><button
          v-if="kind !== 'outlines'"
          type="button"
          :aria-pressed="action === 'names'"
          :disabled="busy"
          @click="action = 'names'"
        >
          编号与命名
        </button>
      </div>
      <template v-if="action === 'order'">
        <label
          >排序依据<select v-model="sortMode" :disabled="busy">
            <option v-if="kind !== 'outlines'" value="number">已有章节编号</option>
            <option value="natural">标题自然排序</option>
            <option value="created">创建时间（从早到晚）</option>
          </select></label
        >
        <p v-if="sortMode === 'number'" class="muted">
          按标题中的章号排序，例如第 1、10、2 章变为第 1、2、10 章。无法识别编号的标题保留原位置。
        </p>
        <p class="muted">应用顺序后可在{{ noun }}列表中恢复上次排序。</p>
        <div class="preview-scroll">
          <table class="order-preview" :aria-label="noun + '顺序预览'">
            <thead>
              <tr>
                <th scope="col">位置</th>
                <th scope="col">当前顺序</th>
                <th scope="col">整理后</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(item, index) in sorted"
                :key="item.id"
                :class="{ changed: item.id !== documents[index]?.id }"
              >
                <td>{{ index + 1 }}</td>
                <td>{{ documents[index]?.title }}</td>
                <td>{{ item.title }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="!orderChanged" class="muted" role="status">当前顺序已符合所选规则。</p>
      </template>
      <template v-else>
        <label
          >操作<select v-model="namingAction" :disabled="busy">
            <option value="renumber">按当前顺序连续编号</option>
            <option value="format">统一格式，保留原章号</option>
          </select></label
        >
        <p v-if="namingAction === 'renumber'" class="muted">
          按当前列表顺序连续编号，保留副标题。“序章”“番外”等无法识别编号的标题保持原样，不占用编号。
        </p>
        <p v-else class="muted">
          统一数字或汉字、后缀与补零格式。原有章号、副标题以及无编号标题保留。
        </p>
        <fieldset :disabled="busy">
          <legend>命名规则</legend>
          <div class="field-row">
            <label
              >编号方式<select v-model="naming.mode">
                <option value="number">阿拉伯数字</option>
                <option value="hanzi">汉字</option>
              </select></label
            ><label v-if="namingAction === 'renumber'"
              >起始编号<input
                v-model.number="naming.start"
                type="number"
                min="1"
                max="999999" /></label
            ><label
              >编号后缀<input
                v-model="naming.suffix"
                maxlength="10"
                :disabled="customTemplate" /></label
            ><label v-if="naming.mode === 'number'"
              >补零位数<input v-model.number="naming.padding" type="number" min="0" max="6"
            /></label>
          </div>
          <label class="check"
            ><input v-model="customTemplate" type="checkbox" />自定义命名模板</label
          ><label v-if="customTemplate"
            >模板<input
              v-model="naming.template"
              maxlength="160"
              placeholder="第{n:03}章 {title}"
            /><small class="muted"
              >{n} 数字，{cn} 汉字，{title} 副标题，{n:03}
              三位补零。自定义模板以填写内容为准。</small
            ></label
          >
        </fieldset>
        <div v-if="renamed.length" class="preview-scroll">
          <table aria-label="章节命名预览">
            <thead>
              <tr>
                <th scope="col">原标题</th>
                <th scope="col">新标题</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(item, index) in renamed"
                :key="item.id"
                :class="{ changed: item.title !== documents[index]?.title }"
              >
                <td>{{ documents[index]?.title }}</td>
                <td>{{ item.title }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="!nameError && !changes.length" class="muted" role="status">没有需要更改的标题。</p>
        <p v-if="duplicateNames.length" class="warning">
          预览中有同名标题：{{ duplicateNames.slice(0, 3).join('、') }}。请检查后再应用。
        </p>
        <p v-if="nameError" class="error-text" role="alert">{{ nameError }}</p>
      </template>
      <p
        v-if="diagnostics.unmatched.length && (action === 'names' || sortMode === 'number')"
        class="muted"
        role="status"
      >
        保留 {{ diagnostics.unmatched.length }} 个无编号标题：{{
          diagnostics.unmatched
            .slice(0, 4)
            .map((item) => item.title)
            .join('、')
        }}{{ diagnostics.unmatched.length > 4 ? '等' : '' }}。
      </p>
      <p
        v-if="diagnostics.duplicates.length && (action === 'names' || sortMode === 'number')"
        class="warning"
        role="status"
      >
        重复章号：{{
          diagnostics.duplicates.map((group) => group.number).join('、')
        }}。按章号排序时，同号章节保留彼此的原顺序。
      </p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <p
        v-if="diagnostics.gaps.length && (action === 'names' || sortMode === 'number')"
        class="muted"
        role="status"
      >
        章号间缺少：{{
          diagnostics.gaps
            .slice(0, 8)
            .map((gap) => (gap.start === gap.end ? String(gap.start) : `${gap.start}–${gap.end}`))
            .join('、')
        }}{{ diagnostics.gaps.length > 8 ? '等' : '' }}。仅作提示，不自动补建或改号。
      </p>
      <div class="dialog-actions">
        <button type="button" :disabled="busy" @click="close">取消</button
        ><button type="submit" class="primary" :disabled="!canApply">
          {{ busy ? '应用中…' : action === 'order' ? '应用顺序' : `应用 ${changes.length} 个标题` }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.chapter-organize {
  width: min(780px, calc(100vw - 40px));
  max-height: calc(100vh - 48px);
  overflow-y: auto;
}
.chapter-organize label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 12px 0;
  min-width: 0;
}
.chapter-organize .check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.check input {
  width: auto;
}
.action-tabs {
  display: flex;
  gap: 8px;
  margin: 16px 0;
}
.action-tabs button[aria-pressed='true'] {
  background: var(--accent-soft, #e9eee8);
  border-color: var(--accent, #65795c);
}
.field-row {
  display: flex;
  gap: 12px;
}
.field-row label {
  flex: 1;
}
input,
select {
  width: 100%;
  min-width: 0;
}
fieldset {
  border: 1px solid var(--line, #ddd);
  border-radius: 8px;
  padding: 8px 14px;
}
legend {
  padding: 0 6px;
}
.preview-scroll {
  max-height: 310px;
  overflow: auto;
  border: 1px solid var(--line, #ddd);
  border-radius: 8px;
  margin-top: 14px;
}
table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}
.order-preview th:first-child {
  width: 64px;
}
th,
td {
  text-align: left;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line, #ddd);
  overflow-wrap: anywhere;
}
th {
  background: var(--surface, #f8f7f4);
  position: sticky;
  top: 0;
}
tr.changed td:last-child {
  background: var(--accent-soft, #e9eee8);
}
.warning {
  color: var(--warning, #956329);
  font-size: 13px;
}
@media (max-width: 550px) {
  .field-row {
    flex-wrap: wrap;
  }
  .field-row label {
    flex-basis: 40%;
  }
}
</style>
