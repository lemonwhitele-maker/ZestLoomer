export interface HeavyAgentSettings {
  schemaVersion: 1
  revision: number
  appendPrompt: boolean
  prompt: string
  chapterOutline: boolean
  chapterContext: boolean
  previousContext: boolean
  previousTailChars: number
}
export const defaultHeavySettings: HeavyAgentSettings = {
  schemaVersion: 1,
  revision: 0,
  appendPrompt: false,
  prompt: '',
  chapterOutline: false,
  chapterContext: false,
  previousContext: false,
  previousTailChars: 2000
}
export interface HeavySettingsView {
  root: string | null
  settings: HeavyAgentSettings
  instructions: string
}
export interface HeavyContextBlock {
  purpose: string
  id: string
  title: string
  version: string
  draft: boolean
  start: number
  end: number
  total: number
  complete: boolean
  content: string
}
export interface HeavyTurnSnapshot {
  settings: HeavyAgentSettings
  chapterOrder?: string[]
  bindings?: import('./storyLinks').ChapterOutlineBindings
  automaticWindow?: { start: number; end: number }
  prefix: HeavyContextBlock[]
  current: HeavyContextBlock[]
  notices: string[]
}
