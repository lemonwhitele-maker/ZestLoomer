<script setup lang="ts">
defineProps<{ modern: boolean; focus: boolean; resizing: boolean; agentWidth: number }>()
</script>

<template>
  <div
    class="workspace"
    :class="{ 'modern-workspace': modern, 'focus-mode': focus, resizing }"
    :style="{ '--agent-width': agentWidth + 'px' }"
  >
    <slot />
  </div>
</template>
