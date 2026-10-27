<script setup lang="ts">
import { useSettings } from './settingsContext'
const { appearance, locked } = useSettings()
</script>
<template>
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
