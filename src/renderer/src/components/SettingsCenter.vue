<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch
} from 'vue'
import { unwrap, type WorkspacePreferences } from '../../../shared/documents'
import type { AgentConfig, AgentConfigInput } from '../../../shared/agent'
import { defaultHeavySettings } from '../../../shared/heavyAgent'
import type { ToolApiConfig } from '../../../shared/toolApi'

type Section = 'writing' | 'ai' | 'books' | 'agent' | 'heavy'
const props = defineProps<{
  initialSection: Section
  preferences: WorkspacePreferences
  config: AgentConfig
  toolConfig: ToolApiConfig
  hasBook: boolean
  busy: boolean
  agentRunning: boolean
  bookMessage: string
}>()
const emit = defineEmits<{
  close: []
  configured: [config: AgentConfig]
  toolConfigured: [config: ToolApiConfig]
  appearance: [value: Partial<WorkspacePreferences>]
  bookAction: [action: 'exportBook' | 'backup' | 'import']
}>()
const api = window.loom
const section = ref<Section>(props.initialSection)
const aiMode = ref<'agent' | 'tools'>('agent')
const tabs: { id: Section; title: string; description: string }[] = [
  { id: 'writing', title: '写作显示', description: '字体与阅读节奏' },
  { id: 'ai', title: 'AI 接入', description: '连接、模型与默认配置' },
  { id: 'agent', title: 'Agent 偏好', description: '意图识别与替换对照' },
  { id: 'heavy', title: '超重agent', description: '追加指令与章节资料' },
  { id: 'books', title: '作品与备份', description: '导出与本地备份' }
]
const heavyForm = reactive({ ...defaultHeavySettings })
const heavyRoot = ref('')
const heavyBaseline = ref(JSON.stringify(heavyForm))
const heavyRootBaseline = ref('')
const builtinPrompt = ref('')
const heavyLoaded = ref(false)
const heavyError = ref('')
async function loadHeavy(): Promise<void> {
  try {
    const value = unwrap(await api.agent.heavySettings())
    Object.assign(heavyForm, value.settings)
    heavyRoot.value = value.root || ''
    heavyRootBaseline.value = heavyRoot.value
    heavyBaseline.value = JSON.stringify(heavyForm)
    builtinPrompt.value = value.instructions
    heavyLoaded.value = true
    heavyError.value = ''
  } catch (e) {
    heavyError.value = String(e)
    heavyLoaded.value = false
  }
}
onMounted(loadHeavy)
const dialog = ref<HTMLElement>()
const previousFocus = document.activeElement as HTMLElement | null
const config = shallowRef(props.config)
const profileId = ref(config.value.defaultProfileId || 'new')
const toolForm = reactive({ ...props.toolConfig })
const toolBaseline = ref(JSON.stringify(toolForm))
const toolTesting = ref(false)
const toolRevision = ref(0)
const toolProbe = ref<Probe>()
const toolProfile = computed(() =>
  config.value.profiles?.find(
    (profile) => profile.id === (toolForm.profileId || config.value.defaultProfileId)
  )
)
const form = reactive({
  label: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  keepKey: false,
  contextTokens: 32768,
  outputTokens: 4096,
  retryOutputTokens: 8192,
  reasoning: '',
  makeDefault: false
})
const appearance = reactive({
  theme: props.preferences.theme || 'system',
  font: props.preferences.font,
  size: props.preferences.size,
  lineHeight: props.preferences.lineHeight
})
const baseline = ref('')
const agentPreferences = reactive({
  targetRewrite: Boolean(props.preferences.targetRewrite),
  unifiedProposalPreview: Boolean(props.preferences.unifiedProposalPreview)
})
const agentBaseline = ref(JSON.stringify(agentPreferences))
const appearanceBaseline = ref(JSON.stringify(appearance))
const selectedProfile = computed(() => config.value.profiles?.find((p) => p.id === profileId.value))
const isDefault = computed(() => profileId.value === config.value.defaultProfileId)
const status = ref('')
const error = ref('')
const saving = ref(false)
const testing = ref<'connection' | 'tools' | null>(null)
const fetching = ref(false)
const locked = computed(
  () => props.busy || saving.value || Boolean(testing.value) || toolTesting.value || fetching.value
)
const pending = shallowRef<(() => void) | null>(null)
const modelChoices = ref<string[]>([])
const modelStatus = ref('')
let disposed = false
const revision = ref(0)
type Probe = { revision: number; ok: boolean; text: string }
const probes = reactive<{ connection?: Probe; tools?: Probe }>({})

function loadProfile(): void {
  const p = selectedProfile.value
  Object.assign(form, {
    label: p?.label || '',
    baseUrl: p?.baseUrl || '',
    model: p?.model || '',
    apiKey: '',
    keepKey: Boolean(p?.hasKey),
    contextTokens: p?.contextTokens || 32768,
    outputTokens: p?.outputTokens || 4096,
    retryOutputTokens: p?.retryOutputTokens || 8192,
    reasoning: p?.reasoning || '',
    makeDefault: false
  })
  baseline.value = JSON.stringify(form)
  modelChoices.value = []
  modelStatus.value = ''
  delete probes.connection
  delete probes.tools
}
loadProfile()
watch(
  () => [
    JSON.stringify(form),
    JSON.stringify(appearance),
    JSON.stringify(toolForm),
    JSON.stringify(heavyForm),
    heavyRoot.value,
    JSON.stringify(agentPreferences)
  ],
  () => {
    status.value = ''
    error.value = ''
  },
  { flush: 'sync' }
)
const dirty = computed(() =>
  section.value === 'heavy'
    ? JSON.stringify(heavyForm) !== heavyBaseline.value ||
      heavyRoot.value !== heavyRootBaseline.value
    : section.value === 'agent'
      ? JSON.stringify(agentPreferences) !== agentBaseline.value
      : section.value === 'ai'
        ? aiMode.value === 'tools'
          ? JSON.stringify(toolForm) !== toolBaseline.value
          : JSON.stringify(form) !== baseline.value
        : section.value === 'writing' && JSON.stringify(appearance) !== appearanceBaseline.value
)
const validation = computed(() => {
  if (section.value === 'heavy') {
    if (!heavyLoaded.value) return '配置未加载，请处理读取错误后重试。'
    if (!heavyRoot.value) return 'BookList 配置位置尚未加载。'
    if (
      !Number.isSafeInteger(heavyForm.previousTailChars) ||
      heavyForm.previousTailChars < 1 ||
      heavyForm.previousTailChars > 1000000
    )
      return '前章结尾长度须为 1–1000000 的整数。'
    return ''
  }
  if (section.value === 'writing') {
    if (!Number.isFinite(appearance.size) || appearance.size < 12 || appearance.size > 32)
      return '字号应在 12–32 之间。'
    if (
      !Number.isFinite(appearance.lineHeight) ||
      appearance.lineHeight < 1.2 ||
      appearance.lineHeight > 3
    )
      return '行高应在 1.2–3 之间。'
    return ''
  }
  if (section.value !== 'ai') return ''
  if (aiMode.value === 'tools') {
    return (toolForm.enabled || toolForm.profileId) && !toolProfile.value
      ? '请先保存一份模型配置，再选择工具 API 使用的配置。'
      : ''
  }
  if (!form.baseUrl.trim() || !form.model.trim()) return '请填写 API 地址和模型名称。'
  try {
    const url = new URL(form.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol)) return '请填写有效的 HTTP 或 HTTPS 地址。'
  } catch {
    return '请填写完整的 API 地址。'
  }
  const values = [form.contextTokens, form.outputTokens, form.retryOutputTokens]
  if (values.some((n) => !Number.isInteger(n) || n < 256 || n > 2000000))
    return '模型容量与输出上限须为 256–2000000 之间的整数。'
  if (Math.max(form.outputTokens, form.retryOutputTokens) + 1024 >= form.contextTokens)
    return '上下文容量须大于输出上限，并额外预留超过 1024 tokens。'
  if (
    selectedProfile.value?.hasKey &&
    form.keepKey &&
    !form.apiKey &&
    form.baseUrl.trim() !== selectedProfile.value.baseUrl
  )
    return '地址已变化，请重新填写密钥，或取消保留已有密钥。'
  return ''
})
function configInput(): AgentConfigInput {
  return {
    id: profileId.value,
    label: form.label.trim(),
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    apiKey: form.apiKey || (form.keepKey ? undefined : ''),
    contextTokens: form.contextTokens,
    outputTokens: form.outputTokens,
    retryOutputTokens: form.retryOutputTokens,
    reasoning: form.reasoning,
    makeDefault: form.makeDefault
  }
}
// Test results belong to exactly the connection and model parameters that were tested.
watch(
  () => [
    profileId.value,
    form.baseUrl,
    form.model,
    form.apiKey,
    form.keepKey,
    form.contextTokens,
    form.outputTokens,
    form.retryOutputTokens,
    form.reasoning
  ],
  () => {
    revision.value++
  },
  { flush: 'sync' }
)
watch(
  () => [profileId.value, form.baseUrl, form.apiKey, form.keepKey],
  () => {
    modelChoices.value = []
    modelStatus.value = ''
  },
  { flush: 'sync' }
)

async function save(): Promise<boolean> {
  if (locked.value || (section.value === 'ai' && aiMode.value === 'agent' && props.agentRunning))
    return false
  if (validation.value) {
    error.value = validation.value
    return false
  }
  saving.value = true
  error.value = ''
  status.value = ''
  try {
    if (section.value === 'heavy') {
      const value = unwrap(await api.agent.saveHeavySettings({ ...heavyForm }))
      Object.assign(heavyForm, value.settings)
      heavyBaseline.value = JSON.stringify(heavyForm)
      heavyRootBaseline.value = value.root || ''
      status.value = '已保存，仅影响后续新建对话。'
    } else if (section.value === 'agent') {
      unwrap(
        await api.preferences(
          JSON.parse(JSON.stringify({ ...props.preferences, ...agentPreferences }))
        )
      )
      emit('appearance', { ...agentPreferences })
      agentBaseline.value = JSON.stringify(agentPreferences)
      status.value = 'Agent 偏好已保存。'
    } else if (section.value === 'writing') {
      unwrap(
        await api.preferences(JSON.parse(JSON.stringify({ ...props.preferences, ...appearance })))
      )
      emit('appearance', { ...appearance })
      appearanceBaseline.value = JSON.stringify(appearance)
      status.value = '显示设置已保存。'
    } else if (section.value === 'ai' && aiMode.value === 'tools') {
      const value = unwrap(await api.tools.configure({ ...toolForm }))
      Object.assign(toolForm, value)
      toolBaseline.value = JSON.stringify(toolForm)
      emit('toolConfigured', value)
      status.value = '工具 API 配置已保存。'
    } else if (section.value === 'ai') {
      const previousId = profileId.value
      const validProbes = Object.fromEntries(
        Object.entries(probes).filter(([, probe]) => probe.revision === revision.value)
      )
      const value = unwrap(await api.agent.configure(configInput()))
      config.value = value
      profileId.value = previousId === 'new' ? value.profiles!.at(-1)!.id : previousId
      emit('configured', value)
      loadProfile()
      for (const mode of ['connection', 'tools'] as const) {
        if (validProbes[mode]) probes[mode] = { ...validProbes[mode], revision: revision.value }
      }
      status.value = 'Agent 配置已保存。'
    }
    return true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return false
  } finally {
    saving.value = false
  }
}
function discard(): void {
  if (section.value === 'heavy') {
    Object.assign(heavyForm, JSON.parse(heavyBaseline.value))
    heavyRoot.value = heavyRootBaseline.value
  } else if (section.value === 'agent')
    Object.assign(agentPreferences, JSON.parse(agentBaseline.value))
  else if (section.value === 'ai' && aiMode.value === 'tools')
    Object.assign(toolForm, JSON.parse(toolBaseline.value))
  else if (section.value === 'ai') loadProfile()
  else {
    Object.assign(appearance, JSON.parse(appearanceBaseline.value))
  }
}
function changeAiMode(mode: 'agent' | 'tools'): void {
  if (aiMode.value === mode) return
  transition(() => {
    aiMode.value = mode
    status.value = ''
    error.value = ''
  })
}
watch(
  () => [JSON.stringify(toolForm), config.value],
  () => {
    toolRevision.value++
  },
  { flush: 'sync' }
)
async function testToolApi(): Promise<void> {
  if (locked.value || !toolProfile.value) return
  toolTesting.value = true
  const testedRevision = toolRevision.value
  try {
    const result = unwrap(await api.tools.test({ ...toolForm }))
    toolProbe.value = {
      revision: testedRevision,
      ok: true,
      text: `${result.message} · ${result.model} · ${result.elapsedMs} ms`
    }
  } catch (e) {
    toolProbe.value = {
      revision: testedRevision,
      ok: false,
      text: e instanceof Error ? e.message : String(e)
    }
  } finally {
    toolTesting.value = false
  }
}
function transition(action: () => void): void {
  if (locked.value) return
  if (dirty.value) {
    pending.value = action
    void nextTick(() => dialog.value?.querySelector<HTMLButtonElement>('[data-continue]')?.focus())
  } else action()
}
function changeSection(id: Section): void {
  if (section.value === id) return
  transition(() => {
    section.value = id
    error.value = ''
    status.value = ''
  })
}
function changeProfile(id: string): void {
  if (id === profileId.value) return
  transition(() => {
    profileId.value = id
    loadProfile()
    error.value = ''
    status.value = ''
  })
}
async function resolvePending(choice: 'save' | 'discard' | 'stay'): Promise<void> {
  if (choice === 'save' && !(await save())) return
  if (choice === 'discard') discard()
  const action = pending.value
  pending.value = null
  if (choice !== 'stay') action?.()
  await nextTick()
  dialog.value?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
}
async function testConfig(mode: 'connection' | 'tools'): Promise<void> {
  if (locked.value) return
  if (validation.value) {
    error.value = validation.value
    return
  }
  testing.value = mode
  error.value = ''
  const testedRevision = revision.value
  try {
    const r = unwrap(await api.agent.test(configInput(), mode))
    probes[mode] = {
      revision: testedRevision,
      ok: true,
      text: `${r.message} · ${r.elapsedMs} ms · ${new Date(r.testedAt).toLocaleTimeString('zh-CN')}`
    }
  } catch (e) {
    probes[mode] = {
      revision: testedRevision,
      ok: false,
      text: e instanceof Error ? e.message : String(e)
    }
  } finally {
    testing.value = null
  }
}
async function fetchModels(): Promise<void> {
  if (locked.value) return
  fetching.value = true
  error.value = ''
  try {
    const choices = unwrap(await api.agent.models(configInput()))
    if (!disposed) {
      modelChoices.value = choices
      modelStatus.value = choices.length
        ? `已获取 ${choices.length} 个模型，也可以手动填写。`
        : '服务未返回模型列表，请手动填写。'
    }
  } catch (e) {
    error.value = `${e instanceof Error ? e.message : String(e)}；仍可手动填写模型。`
  } finally {
    fetching.value = false
  }
}
function keyboard(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (pending.value) void resolvePending('stay')
    else transition(() => emit('close'))
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    if (!pending.value && dirty.value) void save()
  }
  if (event.key !== 'Tab') return
  const container = pending.value
    ? dialog.value?.querySelector('[role="alertdialog"]')
    : dialog.value
  const items = Array.from(
    container?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]'
    ) || []
  ).filter((el) => el.getClientRects().length)
  if (!items.length) {
    event.preventDefault()
    return
  }
  const first = items[0],
    last = items.at(-1)!
  if (
    !items.includes(document.activeElement as HTMLElement) ||
    (event.shiftKey && document.activeElement === first) ||
    (!event.shiftKey && document.activeElement === last)
  ) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  }
}
function tabKeyboard(event: KeyboardEvent): void {
  const buttons = Array.from(
    dialog.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]') || []
  )
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (index < 0 || !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const target =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[target]?.focus()
}
onMounted(() => {
  dialog.value?.focus()
  dialog.value?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
})
onBeforeUnmount(() => {
  disposed = true
  if (testing.value) void api.agent.cancelTest()
  if (toolTesting.value) void api.tools.cancelTest()
  previousFocus?.focus()
})
</script>

<template>
  <div class="modal-backdrop settings-backdrop" @keydown.stop="keyboard">
    <section
      ref="dialog"
      class="settings-center"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-label="设置中心"
    >
      <header class="settings-heading">
        <div>
          <h2>设置</h2>
          <span class="muted">按分类管理，保存后生效</span>
        </div>
        <button aria-label="关闭设置" :disabled="locked" @click="transition(() => emit('close'))">
          ×
        </button>
      </header>
      <div class="settings-body" :inert="Boolean(pending)">
        <nav
          class="settings-nav"
          role="tablist"
          aria-label="设置分类"
          aria-orientation="vertical"
          @keydown="tabKeyboard"
        >
          <button
            v-for="tab in tabs"
            :id="`settings-tab-${tab.id}`"
            :key="tab.id"
            role="tab"
            :aria-selected="section === tab.id"
            :tabindex="section === tab.id ? 0 : -1"
            :aria-controls="`settings-${tab.id}`"
            :disabled="locked"
            @click="changeSection(tab.id)"
          >
            <strong>{{ tab.title }}</strong
            ><small>{{ tab.description }}</small>
          </button>
        </nav>
        <div
          :id="`settings-${section}`"
          class="settings-content"
          role="tabpanel"
          :aria-labelledby="`settings-tab-${section}`"
        >
          <template v-if="section === 'writing'">
            <h3>写作显示</h3>
            <p class="muted">应用于所有作品，只改变显示，不改变文档内容。</p>
            <fieldset :disabled="locked" class="settings-fields">
              <label
                >主题<select v-model="appearance.theme" aria-label="写作主题">
                  <option value="system">跟随系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select></label
              >
              <label
                >字体<select v-model="appearance.font">
                  <option value="Microsoft YaHei">微软雅黑</option>
                  <option value="SimSun">宋体</option>
                  <option value="KaiTi">楷体</option>
                  <option value="Consolas">Consolas</option>
                </select></label
              >
              <div class="settings-grid">
                <label
                  >字号（12–32）<input
                    v-model.number="appearance.size"
                    aria-label="字号"
                    type="number"
                    min="12"
                    max="32"
                /></label>
                <label
                  >行高（1.2–3）<input
                    v-model.number="appearance.lineHeight"
                    aria-label="行高"
                    type="number"
                    min="1.2"
                    max="3"
                    step="0.1"
                /></label>
              </div>
            </fieldset>
            <div class="appearance-preview">
              <small>显示预览</small>
              <p
                :style="{
                  fontFamily: appearance.font,
                  fontSize: `${Math.max(12, Math.min(32, appearance.size || 18))}px`,
                  lineHeight: Math.max(1.2, Math.min(3, appearance.lineHeight || 1.9))
                }"
              >
                暮色落在窗沿，远处的灯一盏盏亮起。<br />故事从这里继续。
              </p>
            </div>
          </template>
          <template v-else-if="section === 'agent'">
            <h3>Agent 偏好</h3>
            <p class="muted">应用于所有作品，保存后生效。</p>
            <fieldset :disabled="locked" class="settings-fields">
              <label class="settings-check"
                ><input
                  v-model="agentPreferences.targetRewrite"
                  type="checkbox"
                />启用意图识别与目标改写（实验）</label
              >
              <p class="field-help">
                先检查是否需要改写，再结合本会话最多 8
                轮成功对话整理目标，与原始请求一起发送。使用当前模型，可能增加两次模型请求；从下一条消息开始生效。
              </p>
              <label class="settings-check"
                ><input
                  v-model="agentPreferences.unifiedProposalPreview"
                  type="checkbox"
                />合并替换前后对照</label
              >
              <p class="field-help">
                每份修改提案只显示一个修改前文本框和一个修改后文本框，保留换行及修改之间的原文，不再按段拆成多组。关闭后按差异分组显示。
              </p>
            </fieldset>
          </template>
          <template v-else-if="section === 'heavy'">
            <h3>超重agent</h3>
            <p>
              保存影响后续新建对话，已有对话保持原配置。当前 BookList
              内所有作品共用设置，每轮刷新当前作品资料。
            </p>
            <p v-if="heavyError" role="alert" class="error-text">{{ heavyError }}</p>
            <button v-if="!heavyLoaded" @click="loadHeavy">重新加载配置</button>
            <fieldset class="settings-fields" :disabled="!heavyLoaded || saving">
              <p>配置保存在当前 BookList：{{ heavyRoot }}</p>
              <label class="settings-check"
                ><input v-model="heavyForm.appendPrompt" type="checkbox" />追加 prompt</label
              >
              <label
                >追加指令<textarea v-model="heavyForm.prompt" aria-label="追加指令" rows="7" />
              </label>
              <p v-if="heavyForm.appendPrompt && !heavyForm.prompt" class="field-help">
                尚未填写追加指令。
              </p>
              <label class="settings-check"
                ><input v-model="heavyForm.chapterOutline" type="checkbox" />追加本章大纲全文</label
              >
              <label class="settings-check"
                ><input v-model="heavyForm.chapterContext" type="checkbox" />追加本章上下文（最多
                8000 字符中心窗口）</label
              >
              <label class="settings-check"
                ><input
                  v-model="heavyForm.previousContext"
                  type="checkbox"
                />追加前文资料（前三章大纲及上一章结尾）</label
              >
              <label
                >上一章结尾字符数<input
                  v-model.number="heavyForm.previousTailChars"
                  type="number"
                  min="1"
                  max="1000000"
              /></label>
            </fieldset>
            <p class="field-help">
              按 Unicode 码点计数；完整显式选区不受 8000
              窗口限制。资料超出模型容量时停止发送，不截断大纲或追加指令。
            </p>
            <p class="field-help">
              超重agent 设置与 API 配置统一保存在 BookList/.loom
              下；对话保存在各作品目录内。备份整个 BookList 可一并保留，单作品备份不包含书库设置。
            </p>
            <details>
              <summary>内置 system prompt（只读）</summary>
              <pre class="prompt-preview">{{ builtinPrompt }}</pre>
              <p>此处直接展示运行内置指令；本轮资料、选区和历史另行装配，可在运行日志追溯。</p>
            </details>
          </template>
          <template v-else-if="section === 'ai'">
            <h3>AI 接入</h3>
            <div class="ai-mode-picker" aria-label="AI 配置类型">
              <button
                :aria-pressed="aiMode === 'agent'"
                :disabled="locked"
                @click="changeAiMode('agent')"
              >
                Agent API
              </button>
              <button
                :aria-pressed="aiMode === 'tools'"
                :disabled="locked"
                @click="changeAiMode('tools')"
              >
                工具 API
              </button>
            </div>
            <template v-if="aiMode === 'agent'">
              <p class="muted">
                配置在当前 BookList 内共享；会话可以单独选择。保存备用配置不会改变默认项。
              </p>
              <div class="profile-picker">
                <label
                  >接入配置<select
                    aria-label="接入配置"
                    :value="profileId"
                    :disabled="locked"
                    @change="changeProfile(($event.target as HTMLSelectElement).value)"
                  >
                    <option value="new">＋ 新增配置</option>
                    <option v-for="p in config.profiles || []" :key="p.id" :value="p.id">
                      {{ p.label }}{{ p.id === config.defaultProfileId ? ' · 默认' : '' }}
                    </option>
                  </select></label
                >
                <span v-if="isDefault" class="config-badge">当前默认</span>
              </div>
              <fieldset :disabled="locked" class="settings-fields">
                <label
                  >配置名称<input v-model="form.label" maxlength="100" placeholder="例如：日常写作"
                /></label>
                <label
                  >API 地址<input
                    v-model="form.baseUrl"
                    aria-label="Agent API 地址"
                    placeholder="https://服务地址/v1"
                    maxlength="2000"
                /></label>
                <p class="field-help">
                  支持 OpenAI Chat Completions 兼容接口；可填基础地址或完整 /chat/completions 地址。
                </p>
                <label
                  >模型
                  <div class="model-field">
                    <input
                      v-model="form.model"
                      aria-label="Agent 模型"
                      maxlength="200"
                      placeholder="选择或填写模型名称"
                    /><button type="button" :disabled="!form.baseUrl.trim()" @click="fetchModels">
                      {{ fetching ? '获取中…' : '获取模型列表' }}
                    </button>
                  </div></label
                >
                <select
                  v-if="modelChoices.length"
                  class="model-choice"
                  aria-label="已获取的模型"
                  :value="modelChoices.includes(form.model) ? form.model : ''"
                  @change="form.model = ($event.target as HTMLSelectElement).value"
                >
                  <option value="" disabled>选择服务返回的模型</option>
                  <option v-for="m in modelChoices" :key="m" :value="m">{{ m }}</option>
                </select>
                <p v-if="modelStatus" class="field-help" role="status">{{ modelStatus }}</p>
                <label
                  >API 密钥
                  <span class="field-help">{{
                    selectedProfile?.hasKey
                      ? '已有加密保存的密钥'
                      : '尚未设置；本地无密钥服务可留空'
                  }}</span>
                  <input
                    v-model="form.apiKey"
                    aria-label="Agent API 密钥"
                    type="password"
                    autocomplete="off"
                    :placeholder="
                      selectedProfile?.hasKey
                        ? '填写新密钥以替换，留空可保留'
                        : '填写服务提供的密钥'
                    "
                  />
                </label>
                <label v-if="selectedProfile?.hasKey" class="settings-check"
                  ><input
                    v-model="form.keepKey"
                    type="checkbox"
                  />保留已有密钥（填写新密钥时将替换）</label
                >
                <p
                  v-if="selectedProfile?.hasKey && !form.keepKey && !form.apiKey"
                  class="field-help"
                >
                  保存后将清除这份配置的密钥。
                </p>
                <label v-if="!isDefault && config.profiles?.length" class="settings-check"
                  ><input v-model="form.makeDefault" type="checkbox" />保存后设为默认配置</label
                >
                <p v-else class="field-help">
                  {{
                    isDefault
                      ? '使用默认配置的会话，会从下一条消息开始使用保存后的参数。'
                      : '第一份配置将自动成为默认配置。'
                  }}
                </p>
                <details class="advanced-settings">
                  <summary>模型容量与推理设置</summary>
                  <p class="field-help">
                    按服务实际支持填写。tokens 是模型容量单位，容量估算不等于账单用量。
                  </p>
                  <div class="settings-grid">
                    <label
                      >上下文容量（tokens）<input
                        v-model.number="form.contextTokens"
                        type="number"
                        min="256"
                        max="2000000"
                    /></label>
                    <label
                      >输出上限（tokens）<input
                        v-model.number="form.outputTokens"
                        type="number"
                        min="256"
                        max="2000000"
                    /></label>
                    <label
                      >截断重试上限（tokens）<input
                        v-model.number="form.retryOutputTokens"
                        type="number"
                        min="256"
                        max="2000000"
                    /></label>
                    <label
                      >推理强度<select v-model="form.reasoning">
                        <option value="">服务默认</option>
                        <option value="none">关闭（none）</option>
                        <option value="minimal">最低（minimal）</option>
                        <option value="low">低（low）</option>
                        <option value="medium">中（medium）</option>
                        <option value="high">高（high）</option>
                        <option value="xhigh">很高（xhigh）</option>
                      </select></label
                    >
                  </div>
                  <p class="field-help">服务不支持调整推理强度时，请使用“服务默认”。</p>
                </details>
              </fieldset>
              <div class="connection-checks">
                <strong>验证当前填写的配置</strong>
                <p class="field-help">测试不保存配置、不读取作品；聊天和工具调用分别验证。</p>
                <div v-for="mode in ['connection', 'tools'] as const" :key="mode" class="probe-row">
                  <button :disabled="locked || Boolean(validation)" @click="testConfig(mode)">
                    {{
                      testing === mode
                        ? '测试中…'
                        : mode === 'connection'
                          ? '测试连接'
                          : '测试工具调用'
                    }}
                  </button>
                  <span
                    v-if="probes[mode]"
                    role="status"
                    :class="{
                      'error-text': !probes[mode]!.ok && probes[mode]!.revision === revision
                    }"
                    >{{
                      probes[mode]!.revision !== revision
                        ? '配置已变更，需要重新测试。'
                        : probes[mode]!.text
                    }}</span
                  ><span v-else class="muted">未测试</span>
                </div>
                <button v-if="testing" @click="api.agent.cancelTest()">取消测试</button>
              </div>
              <p v-if="agentRunning" class="field-help">
                Agent 正在运行；可以编辑配置，任务结束后再保存。
              </p>
            </template>
            <template v-else>
              <h4>工具 API · 对话自动标题</h4>
              <p class="muted">对话完成后，用选择的模型自动生成标题。配置选择独立于 Agent 会话。</p>
              <fieldset :disabled="locked" class="settings-fields">
                <label class="settings-check"
                  ><input v-model="toolForm.enabled" type="checkbox" />启用工具 API</label
                >
                <label
                  >工具 API 配置
                  <select v-model="toolForm.profileId" aria-label="工具 API 配置">
                    <option value="">
                      {{
                        config.defaultProfileId
                          ? '使用默认配置：' +
                            (config.profiles || []).find((p) => p.id === config.defaultProfileId)
                              ?.label
                          : '使用默认配置（尚未配置）'
                      }}
                    </option>
                    <option
                      v-if="toolForm.profileId && !toolProfile"
                      :value="toolForm.profileId"
                      disabled
                    >
                      原配置已不存在，请重新选择
                    </option>
                    <option
                      v-for="profile in config.profiles || []"
                      :key="profile.id"
                      :value="profile.id"
                    >
                      {{ profile.label }} · {{ profile.model }}
                    </option>
                  </select>
                </label>
                <p v-if="toolProfile" class="field-help">当前模型：{{ toolProfile.model }}</p>
                <p class="field-help">
                  只发送本轮请求和最终回答的简短片段。手动修改过的标题会保留；关闭或请求失败时使用本地标题。
                </p>
              </fieldset>
              <button :disabled="locked" @click="changeAiMode('agent')">管理已保存配置</button>
              <div class="connection-checks">
                <strong>验证选择的配置</strong>
                <p class="field-help">测试使用已保存的连接参数，不保存开关和选择。</p>
                <div class="probe-row">
                  <button :disabled="locked || !toolProfile" @click="testToolApi">
                    {{ toolTesting ? '测试中…' : '测试工具 API' }}
                  </button>
                  <span
                    v-if="toolProbe"
                    role="status"
                    :class="{ 'error-text': !toolProbe.ok && toolProbe.revision === toolRevision }"
                    >{{
                      toolProbe.revision !== toolRevision
                        ? '配置已变更，需要重新测试。'
                        : toolProbe.text
                    }}</span
                  >
                  <span v-else class="muted">未测试</span>
                </div>
                <button v-if="toolTesting" @click="api.tools.cancelTest()">取消测试</button>
              </div>
            </template>
          </template>
          <template v-else>
            <h3>作品与备份</h3>
            <p class="muted">对当前打开的作品操作；备份不包含应用的 API 密钥。</p>
            <div class="backup-card">
              <h4>导入文档</h4>
              <p>预览 TXT 或 Markdown 内容，再选择导入到当前或新作品。</p>
              <button :disabled="busy" @click="emit('bookAction', 'import')">导入文档</button>
            </div>
            <div class="backup-card">
              <h4>导出全部正文</h4>
              <p>将所有正文章节导出为文本，方便阅读和交稿。</p>
              <button :disabled="busy || !hasBook" @click="emit('bookAction', 'exportBook')">
                导出全部正文
              </button>
            </div>
            <div class="backup-card">
              <h4>备份完整作品</h4>
              <p>保留作品资料与工作记录，完成后校验备份内容。</p>
              <button :disabled="busy || !hasBook" @click="emit('bookAction', 'backup')">
                备份完整作品
              </button>
            </div>
            <p v-if="!hasBook" class="field-help">请先新建或打开作品。</p>
            <p v-if="bookMessage" role="status">{{ bookMessage }}</p>
          </template>
        </div>
      </div>
      <footer class="settings-footer" :inert="Boolean(pending)">
        <div class="settings-feedback">
          <span v-if="error" role="alert" class="error-text">{{ error }}</span
          ><span v-else-if="status" role="status">{{ status }}</span
          ><span v-else-if="dirty && validation" role="status">{{ validation }}</span
          ><span v-else>{{
            dirty
              ? '有未保存的修改'
              : section === 'ai' && aiMode === 'agent' && profileId === 'new'
                ? '填写配置后点击保存'
                : '所有修改已保存'
          }}</span>
        </div>
        <button :disabled="locked" @click="transition(() => emit('close'))">关闭</button>
        <button
          v-if="section !== 'books'"
          class="primary"
          :disabled="
            locked ||
            !dirty ||
            Boolean(validation) ||
            (section === 'ai' && aiMode === 'agent' && agentRunning)
          "
          @click="save"
        >
          {{
            saving
              ? '保存中…'
              : section === 'ai'
                ? aiMode === 'tools'
                  ? '保存工具 API 配置'
                  : '保存 Agent 配置'
                : section === 'heavy'
                  ? '保存超重agent 设置'
                  : section === 'agent'
                    ? '保存 Agent 偏好'
                    : '保存显示设置'
          }}
        </button>
      </footer>
      <div
        v-if="pending"
        class="settings-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label="未保存的修改"
      >
        <strong>还有未保存的修改</strong>
        <p>保存后继续，或放弃这次修改。也可以留在这里继续编辑。</p>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
        <div class="row">
          <button data-continue :disabled="locked" @click="resolvePending('stay')">继续编辑</button
          ><button :disabled="locked" @click="resolvePending('discard')">放弃修改</button
          ><button
            class="primary"
            :disabled="
              locked ||
              Boolean(validation) ||
              (section === 'ai' && aiMode === 'agent' && agentRunning)
            "
            @click="resolvePending('save')"
          >
            保存并继续
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.prompt-preview {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
}
textarea {
  width: 100%;
  resize: vertical;
}
.ai-mode-picker {
  display: flex;
  gap: 8px;
  margin: 12px 0 18px;
}
.ai-mode-picker button[aria-pressed='true'] {
  background: var(--selected-bg);
  color: var(--accent-text);
}
.settings-center {
  width: 880px;
  max-width: 96vw;
  height: min(760px, 90vh);
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  background: var(--surface);
  border-radius: 16px;
  box-shadow: 0 20px 80px #18271633;
}
.settings-heading {
  height: 82px;
  flex-shrink: 0;
  padding: 18px 24px;
}
.settings-heading h2 {
  margin: 0 0 5px;
  font-size: 21px;
}
.settings-heading button {
  font-size: 20px;
}
.settings-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.settings-nav {
  width: 176px;
  flex-shrink: 0;
  padding: 18px 12px;
  background: var(--button-bg);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.settings-nav button {
  text-align: left;
  padding: 13px 12px;
  white-space: normal;
  background: transparent;
}
.settings-nav button[aria-selected='true'] {
  background: var(--line);
  color: var(--accent-text);
}
.settings-nav strong,
.settings-nav small {
  display: block;
}
.settings-nav strong {
  font-size: 14px;
  font-weight: 500;
}
.settings-nav small {
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted-text);
}
.settings-content {
  min-width: 0;
  flex: 1;
  overflow-y: auto;
  padding: 22px 28px;
}
.settings-content h3 {
  margin: 0 0 8px;
  font-size: 19px;
  font-weight: 500;
}
.settings-content > .muted {
  margin: 0 0 22px;
  line-height: 1.8;
}
.settings-fields {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.settings-content label {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-bottom: 16px;
  font-size: 13px;
}
.settings-content input,
.settings-content select {
  width: 100%;
}
.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.field-help {
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted-text);
  margin: -6px 0 16px;
}
label .field-help {
  margin: 0;
}
.profile-picker {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px 0;
  margin-bottom: 20px;
  background: var(--button-bg);
  border-radius: 8px;
}
.profile-picker label {
  flex: 1;
  min-width: 0;
}
.config-badge {
  font-size: 11px;
  white-space: nowrap;
  color: var(--accent-text);
}
.model-field {
  display: flex;
  gap: 8px;
}
.model-field input {
  flex: 1;
  min-width: 0;
}
.model-field button {
  font-size: 12px;
}
.model-choice {
  margin: -6px 0 16px;
}
.settings-content .settings-check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.settings-check input {
  width: auto;
}
.advanced-settings {
  border-top: 1px solid var(--line);
  padding-top: 16px;
  margin: 8px 0 20px;
}
summary {
  cursor: pointer;
  font-size: 13px;
}
.advanced-settings[open] summary {
  margin-bottom: 18px;
}
.connection-checks {
  background: var(--button-bg);
  padding: 16px;
  border-radius: 8px;
  font-size: 13px;
}
.connection-checks .field-help {
  margin: 8px 0 14px;
}
.probe-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 9px 0;
}
.probe-row button {
  width: 118px;
  flex-shrink: 0;
  font-size: 12px;
}
.probe-row span {
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.appearance-preview {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 20px;
  margin-top: 15px;
}
.appearance-preview small {
  color: var(--muted-text);
}
.appearance-preview p {
  margin: 18px 0 8px;
}
.backup-card {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 20px;
  margin: 20px 0;
}
.backup-card h4 {
  margin: 0;
  font-weight: 500;
}
.backup-card p {
  font-size: 13px;
  line-height: 1.8;
  color: var(--muted-text);
}
.settings-footer {
  align-items: center;
  min-height: 76px;
  padding: 14px 24px;
  background: var(--surface);
}
.settings-footer button {
  font-size: 13px;
  padding: 9px 14px;
}
.settings-check input {
  accent-color: var(--accent);
}
.settings-feedback {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.settings-confirm {
  position: absolute;
  inset: 0;
  z-index: 2;
  background: var(--surface);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
  text-align: center;
}
.settings-confirm p {
  font-size: 13px;
  line-height: 1.8;
}
@media (max-width: 950px) {
  .settings-content {
    padding: 20px;
  }
  .settings-nav {
    width: 152px;
  }
}
</style>
