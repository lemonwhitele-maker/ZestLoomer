import type { Result } from './documents'
import type { ConnectionTestResult } from './agent'

export interface ToolApiConfig {
  enabled: boolean
  /** Empty follows the application's default saved profile. */
  profileId: string
}
export const defaultToolApiConfig: ToolApiConfig = { enabled: false, profileId: '' }
export interface ToolAPI {
  config(): Promise<Result<ToolApiConfig>>
  configure(input: ToolApiConfig): Promise<Result<ToolApiConfig>>
  test(input: ToolApiConfig): Promise<Result<ConnectionTestResult>>
  cancelTest(): Promise<Result<void>>
}
