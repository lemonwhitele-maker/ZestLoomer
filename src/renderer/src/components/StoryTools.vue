<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { unwrap, type DocumentMeta, type DocumentKind } from '../../../shared/documents'
import type {
  ChapterOutlineBinding,
  ChapterOutlineBindings,
  ForeshadowRow,
  ForeshadowContent,
  StoryTarget
} from '../../../shared/storyLinks'
const props = defineProps<{
  bookId: string
  kind: DocumentKind
  documentId?: string
  documents: DocumentMeta[]
}>()
const emit = defineEmits<{ open: [id: string]; saved: [id: string]; source: [id: string] }>()
const api = window.zestloomer
const error = ref('')
const matchNotice = ref('')
const loading = ref(false)
const creating = ref(false)
const binding = ref<ChapterOutlineBinding>()
const bindings = ref<ChapterOutlineBindings>()
const selected = ref('')
const filter = ref('')
const rows = ref<
  (ForeshadowRow & {
    edit?: ForeshadowContent
    saving?: boolean
    failure?: string
    active?: keyof ForeshadowContent
  })[]
>([])
const nextOffset = ref<number | null>(0)
let request = 0
const tableScroll = ref<HTMLElement>()
let tablePosition = 0
watch(
  () => props.kind,
  () => {
    if (tableScroll.value) tablePosition = tableScroll.value.scrollTop
  }
)
const chapters = computed(() =>
  props.documents.filter((doc) => doc.kind === 'chapters' && !doc.trashedAt)
)
const choices = computed(() =>
  props.documents.filter(
    (doc) => doc.kind === (props.kind === 'chapters' ? 'outlines' : 'chapters') && !doc.trashedAt
  )
)
const visible = computed(() =>
  rows.value.filter(
    (row) => dirty(row) || (row.edit?.content ?? row.document.content).includes(filter.value)
  )
)
const dirty = (row: (typeof rows.value)[number]) =>
  Boolean(row.edit && JSON.stringify(row.edit) !== JSON.stringify(row.fields))
function cancel(row: (typeof rows.value)[number]) {
  if (row.fields) row.edit = { ...row.fields }
  row.failure = ''
  row.active = undefined
  error.value = ''
}
function settled(): boolean {
  const okay = !creating.value && !rows.value.some((row) => dirty(row) || row.saving)
  if (!okay) error.value = '请先逐行保存或取消伏笔修改，再切换文档或关闭窗口。'
  return okay
}
async function activate(row: (typeof rows.value)[number], field: keyof ForeshadowContent) {
  row.active = field
  await nextTick()
  tableScroll.value
    ?.querySelector<HTMLElement>(`[data-row="${row.document.id}"] [data-editor]`)
    ?.focus()
}
async function addRow() {
  if (loading.value) return
  creating.value = true
  loading.value = true
  error.value = ''
  try {
    const created = unwrap(await api.create(props.bookId, 'foreshadows', '伏笔', 'blank'))
    const row = {
      document: created.document,
      fields: { content: '', startChapterId: null, endChapterId: null }
    }
    rows.value.push({ ...row, edit: { ...row.fields } })
    filter.value = ''
    emit('saved', created.document.id)
    await nextTick()
    tableScroll.value
      ?.querySelector(`[data-row="${created.document.id}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    creating.value = false
    loading.value = false
  }
}
defineExpose({ settled, addRow })
async function refresh() {
  if (!settled()) return
  const token = ++request
  error.value = ''
  loading.value = true
  try {
    if (props.kind === 'foreshadows') {
      const page = unwrap(await api.story.foreshadows(props.bookId, 0, 100))
      while (page.nextOffset !== null && page.rows.length < rows.value.length) {
        const next = unwrap(await api.story.foreshadows(props.bookId, page.nextOffset, 100))
        page.rows.push(...next.rows)
        page.nextOffset = next.nextOffset
      }
      if (token !== request || !settled()) return
      rows.value = page.rows.map((row) => ({
        ...row,
        edit: row.fields ? { ...row.fields } : undefined
      }))
      nextOffset.value = page.nextOffset
      await nextTick()
      if (tableScroll.value) tableScroll.value.scrollTop = tablePosition
    } else if (props.documentId && ['chapters', 'outlines'].includes(props.kind)) {
      const story = unwrap(await api.story.read(props.bookId, [props.documentId]))[0]
      const state = unwrap(await api.story.bindings(props.bookId))
      if (token !== request) return
      if (
        story.chapterOutlineBinding?.state !== 'error' &&
        story.chapterOutlineBinding?.revision !== state.revision
      )
        throw new Error('关系加载期间已变化，请刷新关系')
      binding.value = story.chapterOutlineBinding
      if (story.automaticBindingNotice) error.value = story.automaticBindingNotice
      bindings.value = state
      selected.value = binding.value?.state === 'bound' ? binding.value.target.id : ''
    }
  } catch (e) {
    if (token !== request) return
    bindings.value = undefined
    error.value = (e as Error).message
  } finally {
    if (token === request) loading.value = false
  }
}
async function more() {
  if (nextOffset.value === null || loading.value) return
  loading.value = true
  try {
    const page = unwrap(await api.story.foreshadows(props.bookId, nextOffset.value, 100))
    rows.value.push(
      ...page.rows
        .filter((row) => !rows.value.some((existing) => existing.document.id === row.document.id))
        .map((row) => ({ ...row, edit: row.fields ? { ...row.fields } : undefined }))
    )
    nextOffset.value = page.nextOffset
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
async function save(row: (typeof rows.value)[number]) {
  if (!row.edit || row.saving) return
  row.saving = true
  row.failure = ''
  try {
    row.document = unwrap(
      await api.save({
        bookId: props.bookId,
        id: row.document.id,
        title: row.document.title,
        expectedVersion: row.document.version,
        content: JSON.stringify(row.edit, null, 2) + '\n'
      })
    )
    row.fields = { ...row.edit }
    row.error = undefined
    row.active = undefined
    error.value = ''
    emit('saved', row.document.id)
  } catch (e) {
    row.failure = (e as Error).message
  } finally {
    row.saving = false
  }
}
async function changeBinding() {
  if (loading.value || !bindings.value || !props.documentId) return
  const bookId = props.bookId
  const documentId = props.documentId
  loading.value = true
  error.value = ''
  matchNotice.value = ''
  try {
    const currentPair = bindings.value.bindings.find((pair) => pair.outlineId === props.documentId)
    if (
      props.kind === 'outlines' &&
      currentPair &&
      selected.value &&
      selected.value !== currentPair.chapterId
    )
      throw new Error('此大纲已有正文绑定，请先明确解除，再关联其他正文。')
    const chapterId =
      props.kind === 'chapters' ? props.documentId : selected.value || currentPair?.chapterId
    if (!chapterId) return
    unwrap(
      await api.story.bind({
        bookId: props.bookId,
        chapterId,
        outlineId:
          props.kind === 'chapters'
            ? selected.value || null
            : selected.value
              ? props.documentId
              : null,
        expectedRevision: bindings.value.revision
      })
    )
    await refresh()
  } catch (e) {
    if (props.bookId === bookId && props.documentId === documentId) {
      const failure = (e as Error).message
      selected.value = binding.value?.state === 'bound' ? binding.value.target.id : ''
      await refresh()
      error.value = failure + '；关联未保存，请重新选择。' + (error.value ? ` ${error.value}` : '')
    }
  } finally {
    loading.value = false
  }
}
async function matchByNumber() {
  if (loading.value) return
  await refresh()
  if (!bindings.value || binding.value?.state === 'error') return
  loading.value = true
  matchNotice.value = ''
  error.value = ''
  try {
    const result = unwrap(await api.story.match(props.bookId, bindings.value.revision))
    matchNotice.value =
      `已新增 ${result.added.length} 组绑定。` +
      (result.ambiguousNumbers.length
        ? `重复章号 ${result.ambiguousNumbers.join('、')} 已跳过。`
        : '') +
      (result.occupiedNumbers.length
        ? `章号 ${result.occupiedNumbers.join('、')} 已有其他绑定，保持不变。`
        : '')
    await refresh()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
function chapterLabel(id: string | null, target?: StoryTarget | null) {
  if (!id) return '未指定'
  const doc = props.documents.find((doc) => doc.id === id)
  return doc
    ? `${doc.title}${doc.trashedAt ? '（已回收）' : ''}`
    : target?.title
      ? `${target.title}（缺失）`
      : '章节缺失'
}
watch(
  () => [
    props.bookId,
    props.kind,
    props.documentId,
    props.documents.map((doc) => doc.updatedAt + doc.trashedAt).join('|')
  ],
  () => {
    if (!creating.value && !rows.value.some((row) => dirty(row) || row.saving)) void refresh()
  },
  { immediate: true }
)
</script>

<template>
  <section
    v-if="['chapters', 'outlines', 'foreshadows'].includes(kind)"
    class="story-tools"
    :class="{ 'foreshadow-page': kind === 'foreshadows' }"
    aria-label="映射与伏笔管理"
  >
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="matchNotice && kind !== 'foreshadows'" role="status">{{ matchNotice }}</p>
    <template v-if="kind !== 'foreshadows' && documentId">
      <div class="story-row">
        <strong>{{ kind === 'chapters' ? '对应大纲' : '对应正文' }}</strong>
        <span v-if="binding?.state === 'unbound'">未绑定</span>
        <span v-else-if="binding?.state === 'error'">关系异常：{{ binding.message }}</span>
        <button
          v-else-if="binding?.state === 'bound'"
          :disabled="binding.target.state === 'missing'"
          @click="emit('open', binding.target.id)"
        >
          {{ binding.target.title || '目标缺失'
          }}{{
            binding.target.state === 'trashed'
              ? '（已回收）'
              : binding.target.state === 'missing'
                ? '（缺失）'
                : ''
          }}
          ↗
        </button>
        <select
          v-model="selected"
          aria-label="选择关联文档"
          :disabled="loading || !bindings || binding?.state === 'error'"
          @change="changeBinding"
        >
          <option value="">解除／不绑定</option>
          <option v-for="doc in choices" :key="doc.id" :value="doc.id">{{ doc.title }}</option>
        </select>
        <button :disabled="loading" @click="matchByNumber">自动匹配</button>
      </div>
      <small>新建或改名后按唯一章号自动关联；手动选择后自动保存，已有绑定保持不变。</small>
    </template>
    <template v-else-if="kind === 'foreshadows'">
      <div class="foreshadow-toolbar">
        <div>
          <h1>伏笔</h1>
          <p>点击单元格填写内容与章节，逐行保存。</p>
        </div>
        <button class="primary" :disabled="loading" aria-label="新建伏笔" @click="addRow">
          ＋ 新增一行
        </button>
      </div>
      <div class="story-row">
        <input v-model="filter" placeholder="筛选伏笔内容…" aria-label="筛选伏笔" />
        <span class="row-count">已加载 {{ rows.length }} 条</span>
        <button :disabled="loading" @click="refresh">刷新表格</button>
      </div>
      <div
        ref="tableScroll"
        class="story-table-scroll"
        @scroll="tablePosition = tableScroll?.scrollTop ?? 0"
      >
        <table>
          <thead>
            <tr>
              <th>伏笔内容</th>
              <th>开始章节</th>
              <th>结束章节</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in visible"
              :key="row.document.id"
              :data-row="row.document.id"
              :class="{ modified: dirty(row) }"
            >
              <template v-if="row.edit">
                <td>
                  <textarea
                    v-if="row.active === 'content'"
                    v-model="row.edit.content"
                    data-editor
                    :disabled="row.saving"
                    aria-label="伏笔内容"
                    @keydown.esc="row.active = undefined"
                    @keydown.ctrl.enter.prevent="save(row)"
                  />
                  <button
                    v-else
                    class="cell-value content-value"
                    :class="{ placeholder: !row.edit.content }"
                    :disabled="row.saving"
                    aria-label="编辑伏笔内容"
                    @click="activate(row, 'content')"
                  >
                    {{ row.edit.content || '点击填写伏笔内容…' }}
                  </button>
                </td>
                <td v-for="field in ['startChapterId', 'endChapterId'] as const" :key="field">
                  <select
                    v-if="row.active === field"
                    v-model="row.edit[field]"
                    data-editor
                    :disabled="row.saving"
                    :aria-label="field === 'startChapterId' ? '开始章节' : '结束章节'"
                    @change="row.active = undefined"
                    @blur="row.active = undefined"
                    @keydown.esc="row.active = undefined"
                  >
                    <option :value="null">未指定</option>
                    <option
                      v-if="row.edit[field] && !chapters.some((doc) => doc.id === row.edit![field])"
                      :value="row.edit[field]"
                    >
                      {{ chapterLabel(row.edit[field]) }}
                    </option>
                    <option v-for="chapter in chapters" :key="chapter.id" :value="chapter.id">
                      {{ chapter.title }}
                    </option>
                  </select>
                  <button
                    v-else
                    class="cell-value"
                    :class="{ placeholder: !row.edit[field] }"
                    :disabled="row.saving"
                    :aria-label="field === 'startChapterId' ? '编辑开始章节' : '编辑结束章节'"
                    @click="activate(row, field)"
                  >
                    {{
                      chapterLabel(
                        row.edit[field],
                        field === 'startChapterId' ? row.startChapter : row.endChapter
                      )
                    }}
                  </button>
                  <button
                    v-if="row.edit[field] && documents.some((doc) => doc.id === row.edit![field])"
                    class="chapter-link"
                    :aria-label="
                      chapterLabel(
                        row.edit[field],
                        field === 'startChapterId' ? row.startChapter : row.endChapter
                      ) + ' ↗'
                    "
                    @click="emit('open', row.edit[field]!)"
                  >
                    ↗
                  </button>
                </td>
                <td>
                  <button v-if="dirty(row) || row.saving" :disabled="row.saving" @click="save(row)">
                    保存此行</button
                  ><button
                    v-if="dirty(row) || row.saving"
                    :disabled="row.saving"
                    @click="cancel(row)"
                  >
                    取消修改</button
                  ><button @click="emit('source', row.document.id)">原文／历史</button>
                  <p v-if="row.failure" role="alert">{{ row.failure }}</p>
                </td>
              </template>
              <td v-else colspan="4">
                {{ row.document.title }}：{{ row.error }}
                <button @click="emit('source', row.document.id)">打开原文修复</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!rows.length">暂无伏笔，点击“＋ 新增一行”开始填写。</p>
      <p v-if="rows.length && !visible.length">没有匹配的伏笔。</p>
      <button v-if="nextOffset !== null" :disabled="loading" @click="more">加载更多</button>
    </template>
  </section>
</template>

<style scoped>
.story-tools {
  padding: 12px 20px;
  border-bottom: 1px solid var(--line);
}
.story-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.story-table-scroll {
  overflow: auto;
  max-height: 45vh;
  margin-top: 10px;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  padding: 8px;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--line);
}
td:first-child {
  width: 40%;
  min-width: 180px;
}
textarea {
  width: 100%;
  min-height: 76px;
  resize: vertical;
  box-sizing: border-box;
}
select {
  max-width: 220px;
}
td button,
td select {
  display: block;
  margin-bottom: 5px;
}
[role='alert'] {
  color: var(--danger);
}
.foreshadow-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 24px 28px;
  border: 0;
}
.foreshadow-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
h1 {
  margin: 0;
  font-size: 24px;
}
.foreshadow-toolbar p,
.row-count {
  color: var(--muted-text);
  font-size: 12px;
}
.foreshadow-toolbar p {
  margin: 6px 0 0;
}
.foreshadow-page .story-table-scroll {
  flex: 1;
  max-height: none;
  margin-top: 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
}
th {
  position: sticky;
  top: 0;
  background: var(--panel-bg);
  z-index: 1;
  font-size: 12px;
  font-weight: 500;
}
.foreshadow-page table {
  min-width: 620px;
}
.foreshadow-page td {
  padding: 10px;
}
.foreshadow-page td:first-child {
  width: 48%;
}
.cell-value {
  width: 100%;
  min-height: 38px;
  text-align: left;
  background: transparent;
  border-color: transparent;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.cell-value:hover {
  background: var(--panel-bg);
  border-color: var(--line);
}
.placeholder {
  color: var(--muted-text);
}
.content-value {
  line-height: 1.6;
}
.modified {
  background: #b58a1510;
}
.chapter-link {
  font-size: 11px;
}
.foreshadow-page td:last-child {
  min-width: 96px;
}
.foreshadow-page td:last-child button {
  font-size: 11px;
}
.foreshadow-page td:last-child button {
  display: inline-block;
  margin-right: 4px;
}
.foreshadow-page td:not(:first-child) .cell-value {
  display: inline-block;
  width: calc(100% - 30px);
}
.foreshadow-page .chapter-link {
  display: inline-block;
  padding: 4px;
  background: transparent;
  border-color: transparent;
}
</style>
