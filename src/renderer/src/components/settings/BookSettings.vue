<script setup lang="ts">
import { useSettings } from './settingsContext'
const { props, emit } = useSettings()
</script>
<template>
  <h3>作品与备份</h3>
  <p class="muted">对当前打开的作品操作；备份不包含应用的 API 密钥。</p>
  <div class="backup-card">
    <h4>导入文档</h4>
    <p>预览 TXT 或 Markdown 内容，再选择导入到当前或新作品。</p>
    <button :disabled="props.busy" @click="emit('bookAction', 'import')">导入文档</button>
  </div>
  <div class="backup-card">
    <h4>导出全部正文</h4>
    <p>将所有正文章节导出为文本，方便阅读和交稿。</p>
    <button :disabled="props.busy || !props.hasBook" @click="emit('bookAction', 'exportBook')">
      导出全部正文
    </button>
  </div>
  <div class="backup-card">
    <h4>备份完整作品</h4>
    <p>保留作品资料与工作记录，完成后校验备份内容。</p>
    <button :disabled="props.busy || !props.hasBook" @click="emit('bookAction', 'backup')">
      备份完整作品
    </button>
  </div>
  <p v-if="!props.hasBook" class="field-help">请先新建或打开作品。</p>
  <p v-if="props.bookMessage" role="status">{{ props.bookMessage }}</p>
</template>
