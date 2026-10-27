import { dirtyFields } from './dirtyFields'

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

import { unwrap, type WorkspacePreferences } from '../../../../shared/documents'

import type { AgentConfig, AgentConfigInput } from '../../../../shared/agent'

import { defaultHeavySettings } from '../../../../shared/heavyAgent'

import type { ToolApiConfig } from '../../../../shared/toolApi'
export type Section = 'writing' | 'ai' | 'books' | 'agent' | 'heavy'
export type SettingsProps = {
  initialSection: Section
  preferences: WorkspacePreferences
  config: AgentConfig
  toolConfig: ToolApiConfig
  hasBook: boolean
  busy: boolean
  agentRunning: boolean
  bookMessage: string
}
export type SettingsEvents = {
  close: []
  configured: [config: AgentConfig]
  toolConfigured: [config: ToolApiConfig]
  appearance: [value: Partial<WorkspacePreferences>]
  bookAction: [action: 'exportBook' | 'backup' | 'import']
}
export type SettingsEmit = <K extends keyof SettingsEvents>(
  event: K,
  ...args: SettingsEvents[K]
) => void
export function useSettingsController(props: SettingsProps, emit: SettingsEmit) {
  const api = window.zestloomer

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

  const selectedProfile = computed(() =>
    config.value.profiles?.find((p) => p.id === profileId.value)
  )

  const isDefault = computed(() => profileId.value === config.value.defaultProfileId)

  const status = ref('')

  const error = ref('')

  const saving = ref(false)

  const testing = ref<'connection' | 'tools' | null>(null)

  const fetching = ref(false)

  const locked = computed(
    () =>
      props.busy || saving.value || Boolean(testing.value) || toolTesting.value || fetching.value
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
    () => [form, appearance, toolForm, heavyForm, heavyRoot.value, agentPreferences],
    () => {
      status.value = ''
      error.value = ''
    },
    { flush: 'sync', deep: true }
  )

  const writingDirty = dirtyFields(appearance, appearanceBaseline)
  const agentDirty = dirtyFields(agentPreferences, agentBaseline)
  const aiDirty = dirtyFields(form, baseline)
  const toolDirty = dirtyFields(toolForm, toolBaseline)
  const heavyDirty = dirtyFields(heavyForm, heavyBaseline)
  const dirty = computed(() => {
    if (section.value === 'heavy')
      return heavyDirty.value || heavyRoot.value !== heavyRootBaseline.value
    if (section.value === 'agent') return agentDirty.value
    if (section.value === 'ai') return aiMode.value === 'tools' ? toolDirty.value : aiDirty.value
    return section.value === 'writing' && writingDirty.value
  })
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
    () => [...Object.values(toolForm), config.value],
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
      void nextTick(() =>
        dialog.value?.querySelector<HTMLButtonElement>('[data-continue]')?.focus()
      )
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
  return {
    api,
    section,
    aiMode,
    tabs,
    heavyForm,
    heavyRoot,
    heavyBaseline,
    heavyRootBaseline,
    builtinPrompt,
    heavyLoaded,
    heavyError,
    loadHeavy,
    dialog,
    previousFocus,
    config,
    profileId,
    toolForm,
    toolBaseline,
    toolTesting,
    toolRevision,
    toolProbe,
    toolProfile,
    form,
    appearance,
    baseline,
    agentPreferences,
    agentBaseline,
    appearanceBaseline,
    selectedProfile,
    isDefault,
    status,
    error,
    saving,
    testing,
    fetching,
    locked,
    pending,
    modelChoices,
    modelStatus,
    disposed,
    revision,
    probes,
    loadProfile,
    dirty,
    validation,
    configInput,
    save,
    discard,
    changeAiMode,
    testToolApi,
    transition,
    changeSection,
    changeProfile,
    resolvePending,
    testConfig,
    fetchModels,
    keyboard,
    tabKeyboard,
    props,
    emit
  }
}
