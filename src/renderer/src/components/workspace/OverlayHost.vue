<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
const host = ref<HTMLElement>()
let observer: MutationObserver | undefined
let previous: HTMLElement | null = null
let active: HTMLElement | null = null
const controls = (dialog: HTMLElement) =>
  [
    ...dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'
    )
  ].filter((node) => node.getClientRects().length)
function sync(): void {
  const dialogs = [
    ...(host.value?.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]') || [])
  ].filter((node) => node.getClientRects().length)
  const next = dialogs.at(-1) || null
  if (next === active) return
  if (!active && next) previous = document.activeElement as HTMLElement
  active = next
  if (next && !next.contains(document.activeElement)) {
    next.tabIndex = -1
    ;(controls(next)[0] || next).focus()
  } else if (!next) {
    if (previous?.isConnected) previous.focus()
    previous = null
  }
}
function keydown(event: KeyboardEvent): void {
  if (!active || event.key !== 'Tab') return
  const items = controls(active)
  const first = items[0] || active
  const last = items.at(-1) || active
  if (
    !active.contains(document.activeElement) ||
    (event.shiftKey && document.activeElement === first) ||
    (!event.shiftKey && document.activeElement === last)
  ) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  }
}
onMounted(() => {
  observer = new MutationObserver(sync)
  observer.observe(host.value!, { childList: true, subtree: true })
  document.addEventListener('keydown', keydown)
  sync()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  document.removeEventListener('keydown', keydown)
  if (previous?.isConnected) previous.focus()
})
</script>
<template>
  <Teleport to="body"
    ><div ref="host" class="overlay-host"><slot /></div
  ></Teleport>
</template>
