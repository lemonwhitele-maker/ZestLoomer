import { inject, type InjectionKey } from 'vue'
import type { useSettingsController } from './useSettingsController'
export const settingsKey: InjectionKey<ReturnType<typeof useSettingsController>> =
  Symbol('settings')
export function useSettings() {
  const context = inject(settingsKey)
  if (!context) throw new Error('Missing settings scope')
  return context
}
