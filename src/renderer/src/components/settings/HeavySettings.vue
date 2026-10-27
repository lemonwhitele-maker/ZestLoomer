<script setup lang="ts">
import { useSettings } from './settingsContext'
const { heavyForm, heavyRoot, builtinPrompt, heavyLoaded, heavyError, loadHeavy, saving } =
  useSettings()
</script>
<template>
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
    <label>追加指令<textarea v-model="heavyForm.prompt" aria-label="追加指令" rows="7" /></label>
    <p v-if="heavyForm.appendPrompt && !heavyForm.prompt" class="field-help">尚未填写追加指令。</p>
    <label class="settings-check"
      ><input v-model="heavyForm.chapterOutline" type="checkbox" />追加本章大纲全文</label
    >
    <label class="settings-check"
      ><input v-model="heavyForm.chapterContext" type="checkbox" />追加本章上下文（最多 8000
      字符中心窗口）</label
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
    超重agent 设置与 API 配置统一保存在书库配置目录（新书库为 .zestloomer，旧书库兼容 .loom）
    下；对话保存在各作品目录内。备份整个 BookList 可一并保留，单作品备份不包含书库设置。
  </p>
  <details>
    <summary>内置 system prompt（只读）</summary>
    <pre class="prompt-preview">{{ builtinPrompt }}</pre>
    <p>此处直接展示运行内置指令；本轮资料、选区和历史另行装配，可在运行日志追溯。</p>
  </details>
</template>
