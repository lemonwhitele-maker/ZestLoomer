<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
defineProps<{ label: string; keepOpen?: boolean; badge?: string }>()
const root = ref<HTMLElement>()
const trigger = ref<HTMLButtonElement>()
const opened = ref(false)
function close(restore = false): void {
  opened.value = false
  if (restore) trigger.value?.focus()
}
async function toggle(): Promise<void> {
  opened.value = !opened.value
  if (opened.value) {
    await nextTick()
    root.value
      ?.querySelector<HTMLElement>(
        '.action-menu-panel button:not(:disabled), .action-menu-panel input, .action-menu-panel select'
      )
      ?.focus()
  }
}
function outside(event: PointerEvent): void {
  if (!root.value?.contains(event.target as Node)) close()
}
function keyboard(event: KeyboardEvent): void {
  if (!event.isComposing && event.keyCode !== 229 && event.key === 'Escape' && opened.value) {
    event.preventDefault()
    event.stopPropagation()
    close(true)
  }
}
onMounted(() => document.addEventListener('pointerdown', outside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside))
</script>

<template>
  <div
    ref="root"
    class="action-menu"
    @keydown="keyboard"
    @focusout="
      (event) => {
        if (event.relatedTarget && !root?.contains(event.relatedTarget as Node)) close()
      }
    "
  >
    <button ref="trigger" :aria-label="label" :aria-expanded="opened" @click="toggle">
      {{ label }}<span v-if="badge"> · {{ badge }}</span>
    </button>
    <div
      v-if="opened"
      class="action-menu-panel"
      :aria-label="label"
      @click="
        (event) => {
          if (!keepOpen && (event.target as HTMLElement).closest('button:not(:disabled)'))
            close(true)
        }
      "
    >
      <slot />
    </div>
  </div>
</template>
