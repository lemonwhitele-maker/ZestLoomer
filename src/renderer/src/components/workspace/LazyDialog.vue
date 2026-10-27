<script setup lang="ts">
import { markRaw, onMounted, shallowRef, ref, type Component } from 'vue'
defineOptions({ inheritAttrs: false })
const props = defineProps<{ loader: () => Promise<{ default: Component }> }>()
const emit = defineEmits<{ close: [] }>()
const loaded = shallowRef<Component>()
const error = ref(false)
let failedModule: URL | undefined
let failedStyle: URL | undefined
let attempt = 0
function localAsset(message: string, prefix: string): URL | undefined {
  if (!message.startsWith(prefix)) return
  try {
    const asset = new URL(message.slice(prefix.length).trim(), document.baseURI)
    const base = new URL(document.baseURI)
    if (asset.protocol !== base.protocol || asset.origin !== base.origin) return
    if (base.protocol === 'file:' && !asset.pathname.startsWith(new URL('.', base).pathname)) return
    return asset
  } catch {
    return
  }
}
async function load(): Promise<void> {
  error.value = false
  try {
    if (failedStyle) {
      const style = failedStyle
      document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach((link) => {
        if (link.href === style.href) link.remove()
      })
      await new Promise<void>((resolve, reject) => {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = style.href
        link.onload = () => resolve()
        link.onerror = () => {
          link.remove()
          reject(new Error('Unable to preload CSS for ' + style.href))
        }
        document.head.append(link)
      })
      failedStyle = undefined
    }
    // Chromium caches failed dynamic imports; a new URL retries the same local asset.
    if (failedModule) {
      const url = new URL(failedModule)
      url.searchParams.set('zest-retry', String(++attempt))
      loaded.value = markRaw((await import(/* @vite-ignore */ url.href)).default)
    } else loaded.value = markRaw((await props.loader()).default)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    failedModule =
      localAsset(message, 'Failed to fetch dynamically imported module:') || failedModule
    failedStyle = localAsset(message, 'Unable to preload CSS for ') || failedStyle
    error.value = true
  }
}
onMounted(load)
</script>
<template>
  <component :is="loaded" v-if="loaded" v-bind="$attrs" @close="emit('close')" />
  <div v-else class="modal-backdrop">
    <section class="dialog" role="dialog" aria-modal="true" aria-label="加载窗口">
      <p role="status">{{ error ? '窗口加载失败，请重试。' : '正在打开…' }}</p>
      <div class="dialog-actions">
        <button v-if="error" @click="load">重试</button>
        <button @click="emit('close')">取消</button>
      </div>
    </section>
  </div>
</template>
