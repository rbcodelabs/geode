import type { Page } from "@playwright/test";

/**
 * Switch the open Settings modal to a section the way a user on this device does:
 * through the bottom sheet where the section selector is shown (phones), otherwise the sidebar.
 */
export async function chooseSettingsSection(page: Page, label: string): Promise<void> {
  const selector = page.locator(".modal.mod-settings .settings-section-selector");
  if (await selector.isVisible()) {
    await selector.click();
    await page.getByRole("dialog", { name: "Settings sections" }).locator(".settings-section-row", { hasText: label }).click();
  } else {
    await page.locator(".modal.mod-settings .vertical-tab-nav-item", { hasText: label }).click();
  }
}
