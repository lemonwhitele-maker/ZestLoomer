<script setup lang="ts">
import { provide } from 'vue'
import {
  useSettingsController,
  type SettingsProps,
  type SettingsEvents
} from './settings/useSettingsController'
import { settingsKey } from './settings/settingsContext'
import WritingSettings from './settings/WritingSettings.vue'
import AgentSettings from './settings/AgentSettings.vue'
import HeavySettings from './settings/HeavySettings.vue'
import AiSettings from './settings/AiSettings.vue'
import BookSettings from './settings/BookSettings.vue'
const props = defineProps<SettingsProps>()
const emit = defineEmits<SettingsEvents>()
const context = useSettingsController(props, emit)
provide(settingsKey, context)
const {
  section,
  aiMode,
  tabs,
  dialog,
  profileId,
  status,
  error,
  saving,
  locked,
  pending,
  dirty,
  validation,
  save,
  transition,
  changeSection,
  resolvePending,
  keyboard,
  tabKeyboard
} = context
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
          <WritingSettings v-if="section === 'writing'" />
          <AgentSettings v-else-if="section === 'agent'" />
          <HeavySettings v-else-if="section === 'heavy'" />
          <AiSettings v-else-if="section === 'ai'" />
          <BookSettings v-else />
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
<style src="./settings/settings.css"></style>
