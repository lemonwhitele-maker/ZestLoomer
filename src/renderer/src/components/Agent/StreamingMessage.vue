<script setup lang="ts">
// Text is buffered once by the workspace. Scroll ownership remains in AgentPanel.
defineProps<{
  active: boolean
  conversationId: string
  selectedId: string
  liveText: string
  toolText: string
}>()
const tools: Record<string, string> = {
  list_files: '查找书内文档',
  read: '读取资料',
  create: '准备新建提案',
  write: '准备全文修改',
  edit: '准备局部修改'
}
</script>
<template>
  <article v-if="active && conversationId === selectedId" class="agent-message assistant">
    <small>Loom · {{ toolText ? tools[toolText] || '处理中' : '正在回复' }}</small>
    <div class="message-text">{{ liveText || '正在准备…' }}</div>
  </article>
</template>

<style scoped>
.message-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.8;
}
</style>
