<script setup lang="ts">
import { useSettings } from './settingsContext'
const { agentPreferences, locked } = useSettings()
</script>
<template>
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
