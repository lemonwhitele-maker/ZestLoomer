import { computed, type Ref } from 'vue'

/** Parse only when a saved baseline changes; field edits never serialize whole forms. */
export function dirtyFields<T extends object>(form: T, baseline: Ref<string>) {
  const saved = computed(() => JSON.parse(baseline.value || '{}') as T)
  return computed(() =>
    (Object.keys(form) as (keyof T)[]).some((key) => form[key] !== saved.value[key])
  )
}
