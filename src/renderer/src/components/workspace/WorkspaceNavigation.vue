<script setup lang="ts">
import {
  kinds,
  labels,
  type Book,
  type DocumentKind,
  type DocumentMeta
} from '../../../../shared/documents'
import zestloomerLogo from '../../../../shared/assets/zestloomer-logo-44.png'
import zestloomerLogo2x from '../../../../shared/assets/zestloomer-logo-88.png'
import zestloomerLogo3x from '../../../../shared/assets/zestloomer-logo-132.png'
defineProps<{
  modern: boolean
  focus: boolean
  agentVisible: boolean
  busy: boolean
  currentBook: Book | null
  books: Book[]
  kind: DocumentKind
  documents: DocumentMeta[]
}>()
const emit = defineEmits<{
  book: [id: string]
  kind: [kind: DocumentKind]
  newBook: []
  openBook: []
  renameBook: []
  quickOpen: []
  import: []
  agent: []
  settings: []
}>()
</script>
<template>
  <nav v-show="!focus" class="sidebar" aria-label="创作分区">
    <div v-if="!modern" class="brand">
      <img
        class="brand-logo"
        :src="zestloomerLogo"
        :srcset="`${zestloomerLogo2x} 2x, ${zestloomerLogo3x} 3x`"
        alt="ZestLoomer Logo"
        width="44"
        height="44"
      />
      <div class="brand-name">ZestLoomer</div>
    </div>
    <div v-if="!modern" class="book-controls">
      <select
        aria-label="当前作品"
        :value="currentBook?.id || ''"
        :disabled="busy"
        @change="emit('book', ($event.target as HTMLSelectElement).value)"
      >
        <option v-if="!currentBook" value="">尚未打开作品</option>
        <option v-for="book in books" :key="book.id" :value="book.id">{{ book.title }}</option>
      </select>
      <div class="row">
        <button :disabled="busy" @click="emit('newBook')">新建作品</button
        ><button :disabled="busy" @click="emit('openBook')">打开作品</button>
      </div>
      <div class="row book-tools">
        <button :disabled="busy || !currentBook" @click="emit('renameBook')">修改作品名称</button>
        <button :disabled="busy || !currentBook" @click="emit('quickOpen')">快速打开</button>
        <button :disabled="busy" @click="emit('import')">导入</button>
      </div>
    </div>
    <button
      v-for="item in kinds"
      :key="item"
      :class="{ selected: kind === item }"
      :disabled="busy || !currentBook"
      :aria-current="kind === item ? 'page' : undefined"
      @click="emit('kind', item)"
    >
      {{ labels[item] }}
      <span class="nav-count">{{
        documents.filter((doc) => doc.kind === item && !doc.trashedAt).length || ''
      }}</span>
    </button>
    <button class="agent-toggle" :aria-expanded="agentVisible" @click="emit('agent')">
      Agent 对话 <span>{{ agentVisible ? '−' : '+' }}</span>
    </button>
    <div class="sidebar-bottom">
      <button @click="emit('settings')">设置</button><span>本地写作 · 自动保存</span>
    </div>
  </nav>
</template>
