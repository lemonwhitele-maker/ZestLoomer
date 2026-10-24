/** New variables take precedence; LOOM_* remains a supported compatibility input. */
export function environmentValue(
  suffix: string,
  env: Record<string, string | undefined> = process.env
): string | undefined {
  return env[`ZESTLOOMER_${suffix}`] ?? env[`LOOM_${suffix}`]
}
