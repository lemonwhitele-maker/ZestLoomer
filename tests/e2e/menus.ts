import type { Page } from '@playwright/test'
export async function revealMenu(page: Page, name: string): Promise<void> {
  await page.locator('.workspace-header').waitFor()
  const trigger = page.getByRole('button', { name, exact: true })
  if ((await trigger.isVisible()) && (await trigger.getAttribute('aria-expanded')) !== 'true')
    await trigger.click()
}
