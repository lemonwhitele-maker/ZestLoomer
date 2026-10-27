<script setup lang="ts">
import { useSettings } from './settingsContext'
const {
  api,
  aiMode,
  config,
  profileId,
  toolForm,
  toolTesting,
  toolRevision,
  toolProbe,
  toolProfile,
  form,
  selectedProfile,
  isDefault,
  testing,
  fetching,
  locked,
  modelChoices,
  modelStatus,
  revision,
  probes,
  validation,
  changeAiMode,
  testToolApi,
  changeProfile,
  testConfig,
  fetchModels,
  props
} = useSettings()
function chooseProfile(event: Event): void {
  const select = event.target as HTMLSelectElement
  const requested = select.value
  // The native select changes before the guarded transition. Keep it aligned
  // with the active form even when the user chooses to stay in the confirmation.
  select.value = profileId.value
  changeProfile(requested)
}
</script>
<template>
  <h3>AI 接入</h3>
  <div class="ai-mode-picker" aria-label="AI 配置类型">
    <button :aria-pressed="aiMode === 'agent'" :disabled="locked" @click="changeAiMode('agent')">
      Agent API
    </button>
    <button :aria-pressed="aiMode === 'tools'" :disabled="locked" @click="changeAiMode('tools')">
      工具 API
    </button>
  </div>
  <template v-if="aiMode === 'agent'">
    <p class="muted">配置在当前 BookList 内共享；会话可以单独选择。保存备用配置不会改变默认项。</p>
    <div class="profile-picker">
      <label
        >接入配置<select
          aria-label="接入配置"
          :value="profileId"
          :disabled="locked"
          @change="chooseProfile"
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
          selectedProfile?.hasKey ? '已有加密保存的密钥' : '尚未设置；本地无密钥服务可留空'
        }}</span>
        <input
          v-model="form.apiKey"
          aria-label="Agent API 密钥"
          type="password"
          autocomplete="off"
          :placeholder="
            selectedProfile?.hasKey ? '填写新密钥以替换，留空可保留' : '填写服务提供的密钥'
          "
        />
      </label>
      <label v-if="selectedProfile?.hasKey" class="settings-check"
        ><input v-model="form.keepKey" type="checkbox" />保留已有密钥（填写新密钥时将替换）</label
      >
      <p v-if="selectedProfile?.hasKey && !form.keepKey && !form.apiKey" class="field-help">
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
          {{ testing === mode ? '测试中…' : mode === 'connection' ? '测试连接' : '测试工具调用' }}
        </button>
        <span
          v-if="probes[mode]"
          role="status"
          :class="{
            'error-text': !probes[mode]!.ok && probes[mode]!.revision === revision
          }"
          >{{
            probes[mode]!.revision !== revision ? '配置已变更，需要重新测试。' : probes[mode]!.text
          }}</span
        ><span v-else class="muted">未测试</span>
      </div>
      <button v-if="testing" @click="api.agent.cancelTest()">取消测试</button>
    </div>
    <p v-if="props.agentRunning" class="field-help">
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
                  (config.profiles || []).find((p) => p.id === config.defaultProfileId)?.label
                : '使用默认配置（尚未配置）'
            }}
          </option>
          <option v-if="toolForm.profileId && !toolProfile" :value="toolForm.profileId" disabled>
            原配置已不存在，请重新选择
          </option>
          <option v-for="profile in config.profiles || []" :key="profile.id" :value="profile.id">
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
            toolProbe.revision !== toolRevision ? '配置已变更，需要重新测试。' : toolProbe.text
          }}</span
        >
        <span v-else class="muted">未测试</span>
      </div>
      <button v-if="toolTesting" @click="api.tools.cancelTest()">取消测试</button>
    </div>
  </template>
</template>
