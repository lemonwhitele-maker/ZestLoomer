<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { DocumentMeta } from '../../../shared/documents'
import type { BookPreferences, Placement } from '../../../shared/workspace'
import {
  formatChapterTitle,
  parseChapterTitle,
  validateNamingRule,
  type NamingRule
} from '../../../shared/chapterNaming'

const props = defineProps<{
  documents: DocumentMeta[]
  currentId?: string
  preferences: BookPreferences
  busy: boolean
  error?: string
}>()
const emit = defineEmits<{
  close: []
  submit: [
    payload: {
      items: { title: string; content?: string }[]
      placement: Placement
      naming: NamingRule
    }
  ]
}>()
const form = ref<HTMLFormElement>()
const titleInput = ref<HTMLInputElement>()
const previousFocus = document.activeElement as HTMLElement | null
const title = ref('')
const batch = ref(false)
const batchMode = ref<'count' | 'lines'>('lines')
const lines = ref('')
const count = ref(3)
const hasCurrent = props.documents.some((item) => item.id === props.currentId)
const placement = reactive<Placement>({
  position: hasCurrent ? 'after' : 'end',
  anchorId: hasCurrent ? props.currentId : props.documents[0]?.id
})
const nextNumber =
  Math.max(0, ...props.documents.map((item) => parseChapterTitle(item.title).number || 0)) + 1
const naming = reactive<NamingRule>({
  ...props.preferences.naming,
  start: Math.min(999999, Math.max(nextNumber, props.preferences.naming.start))
})
const customTemplate = ref(Boolean(naming.template))
watch(customTemplate, (enabled) => {
  if (enabled && !naming.template.trim())
    naming.template = `第{${naming.mode === 'hanzi' ? 'cn' : 'n'}}${naming.suffix} {title}`
})
const effectiveNaming = computed<NamingRule>(() => ({
  ...naming,
  template: customTemplate.value ? naming.template : ''
}))
const sourceTitles = computed(() =>
  !batch.value
    ? [title.value]
    : batchMode.value === 'lines'
      ? lines.value
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : Array.from(
          {
            length:
              Number.isInteger(count.value) && count.value >= 1 && count.value <= 100
                ? count.value
                : 0
          },
          () => title.value
        )
)
const validation = computed(() => {
  const ruleError = validateNamingRule(effectiveNaming.value)
  if (ruleError) return ruleError
  if (customTemplate.value && naming.mode !== 'free' && !naming.template.trim())
    return '请填写自定义命名模板。'
  if (
    batch.value &&
    batchMode.value === 'count' &&
    (!Number.isInteger(count.value) || count.value < 1 || count.value > 100)
  )
    return '一次创建数量应为 1–100 的整数。'
  if (!sourceTitles.value.length)
    return batch.value && batchMode.value === 'lines' ? '请每行填写一个标题。' : '请填写标题。'
  if (sourceTitles.value.length > 100) return '一次最多创建 100 个章节。'
  if (effectiveNaming.value.mode === 'free' && sourceTitles.value.some((value) => !value.trim()))
    return '请填写标题。'
  if (
    effectiveNaming.value.mode !== 'free' &&
    naming.start + sourceTitles.value.length - 1 > 999999
  )
    return '最后一个编号不能超过 999999。'
  if (
    (placement.position === 'before' || placement.position === 'after') &&
    !props.documents.some((item) => item.id === placement.anchorId)
  )
    return '请选择插入位置的章节。'
  return ''
})
const preview = computed(() => {
  if (validation.value) return []
  try {
    return sourceTitles.value.map((value, index) =>
      formatChapterTitle(effectiveNaming.value, naming.start + index, value)
    )
  } catch {
    return []
  }
})
const titleError = computed(() =>
  preview.value.some((value) => !value || value.length > 200 || /[\r\n]/.test(value))
    ? '生成后的标题应为 1–200 个字符，不能包含换行。'
    : ''
)
const duplicateTitles = computed(() => {
  const existing = new Set(props.documents.map((item) => item.title.trim()))
  const seen = new Set<string>(),
    duplicate = new Set<string>()
  for (const value of preview.value) {
    if (existing.has(value) || seen.has(value)) duplicate.add(value)
    seen.add(value)
  }
  return [...duplicate]
})

function close(): void {
  if (!props.busy) emit('close')
}
function submit(): void {
  if (props.busy || validation.value || titleError.value || !preview.value.length) return
  emit('submit', {
    items: preview.value.map((value) => ({ title: value })),
    placement: { ...placement },
    naming: { ...effectiveNaming.value }
  })
}
function keydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
  if (event.key !== 'Tab') return
  const candidates = [
    ...(form.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'
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
  titleInput.value?.focus()
})
onBeforeUnmount(() => previousFocus?.focus())
</script>

<template>
  <div class="modal-backdrop" @click.self="close" @keydown="keydown">
    <form
      ref="form"
      class="dialog chapter-create"
      role="dialog"
      aria-modal="true"
      aria-label="新建章节"
      @submit.prevent="submit"
    >
      <h2>新建章节</h2>
      <label class="check"
        ><input v-model="batch" type="checkbox" :disabled="busy" />批量创建</label
      >
      <div v-if="batch" class="field-row">
        <label
          >创建方式<select v-model="batchMode" :disabled="busy">
            <option value="lines">每行一个标题</option>
            <option value="count">按数量创建</option>
          </select></label
        >
        <label v-if="batchMode === 'count'"
          >数量<input v-model.number="count" type="number" min="1" max="100" :disabled="busy"
        /></label>
      </div>
      <label v-show="!batch || batchMode === 'count'"
        >{{ naming.mode === 'free' ? '标题' : '副标题（可留空）'
        }}<input
          ref="titleInput"
          v-model="title"
          aria-label="新标题"
          maxlength="200"
          :disabled="busy"
      /></label>
      <label v-if="batch && batchMode === 'lines'"
        >标题列表<textarea
          v-model="lines"
          rows="5"
          aria-label="批量标题"
          :disabled="busy"
          placeholder="每行一个标题；编号由下方规则生成"
        />
      </label>
      <p v-if="batch && batchMode === 'count' && naming.mode === 'free'" class="muted">
        自由命名会按数量创建同名章节。需要不同标题时，可选择逐行填写或添加编号。
      </p>
      <div class="field-row">
        <label
          >插入位置<select v-model="placement.position" :disabled="busy">
            <option value="start">列表开头</option>
            <option value="end">列表末尾</option>
            <option value="before" :disabled="!documents.length">指定章节之前</option>
            <option value="after" :disabled="!documents.length">指定章节之后</option>
          </select></label
        >
        <label v-if="placement.position === 'before' || placement.position === 'after'"
          >参照章节<select v-model="placement.anchorId" :disabled="busy">
            <option v-for="item in documents" :key="item.id" :value="item.id">
              {{ item.title }}
            </option>
          </select></label
        >
      </div>
      <fieldset :disabled="busy">
        <legend>命名规则</legend>
        <label
          >命名方式<select v-model="naming.mode">
            <option value="free">自由标题</option>
            <option value="number">阿拉伯数字编号</option>
            <option value="hanzi">汉字编号</option>
          </select></label
        >
        <template v-if="naming.mode !== 'free'">
          <div class="field-row">
            <label
              >起始编号<input v-model.number="naming.start" type="number" min="1" max="999999"
            /></label>
            <label
              >编号后缀<input
                v-model="naming.suffix"
                maxlength="10"
                placeholder="章、回、节"
                :disabled="customTemplate"
            /></label>
            <label v-if="naming.mode === 'number'"
              >补零位数<input v-model.number="naming.padding" type="number" min="0" max="6"
            /></label>
          </div>
          <label class="check"
            ><input v-model="customTemplate" type="checkbox" />自定义命名模板</label
          >
          <label v-if="customTemplate"
            >模板<input
              v-model="naming.template"
              maxlength="160"
              placeholder="第{n:03}章 {title}"
            /><small class="muted"
              >{n} 数字，{cn} 汉字，{title} 副标题，{n:03}
              三位补零。自定义模板以填写内容为准。</small
            ></label
          >
        </template>
      </fieldset>
      <section class="preview" aria-label="新建预览" aria-live="polite">
        <h3>
          预览<span v-if="preview.length"> · {{ preview.length }} 个章节</span>
        </h3>
        <ol v-if="preview.length">
          <li v-for="(value, index) in preview" :key="index">{{ value }}</li>
        </ol>
        <p v-else class="muted">{{ validation || '填写标题后显示预览。' }}</p>
      </section>
      <p v-if="duplicateTitles.length" class="warning" role="status">
        标题重复：{{ duplicateTitles.slice(0, 3).join('、')
        }}{{ duplicateTitles.length > 3 ? '等' : '' }}。仍可创建。
      </p>
      <p v-if="titleError || error" class="error-text" role="alert">{{ error || titleError }}</p>
      <div class="dialog-actions">
        <button type="button" :disabled="busy" @click="close">取消</button
        ><button
          class="primary"
          type="submit"
          :disabled="busy || Boolean(validation || titleError) || !preview.length"
        >
          {{ busy ? '创建中…' : '创建' }}
        </button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.chapter-create {
  width: min(650px, calc(100vw - 40px));
  max-height: calc(100vh - 48px);
  overflow-y: auto;
}
.chapter-create label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 10px 0;
  min-width: 0;
}
.chapter-create label.check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.check input {
  width: auto;
}
.field-row {
  display: flex;
  gap: 14px;
}
.field-row > label {
  flex: 1;
}
fieldset {
  border: 1px solid var(--line, #ddd);
  border-radius: 8px;
  padding: 8px 14px;
  margin: 16px 0;
}
legend {
  padding: 0 6px;
}
select,
textarea,
input {
  min-width: 0;
  width: 100%;
}
textarea {
  resize: vertical;
}
.preview {
  background: var(--surface, #f8f7f4);
  border: 1px solid var(--line, #ddd);
  padding: 12px 16px;
  border-radius: 8px;
}
.preview h3 {
  margin: 0 0 8px;
  font-size: 14px;
}
.preview ol {
  margin: 0;
  padding-left: 28px;
  max-height: 170px;
  overflow-y: auto;
}
.preview li {
  padding: 3px 0;
  overflow-wrap: anywhere;
}
.warning {
  color: var(--warning, #956329);
  font-size: 13px;
}
@media (max-width: 550px) {
  .field-row {
    flex-direction: column;
    gap: 0;
  }
}
</style>
