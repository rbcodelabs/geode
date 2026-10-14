import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const mobileUrl = pathToFileURL(path.resolve(__dirname, "../../dist/mobile/index.html")).href;

async function openSettings(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // The sheet slides in; geometry assertions need it at rest.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(mobileUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => (window as any).app.setting.open());
  const modal = page.locator(".modal.mod-settings");
  await expect(modal).toBeVisible();
  await expect(modal.getByRole("heading", { name: "Appearance", exact: true })).toBeVisible();
  return { modal, errors };
}

/** The desktop sidebar's tab list, read from the (possibly hidden) nav so the sheet is compared against the real source of truth. */
function navLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll(".mod-settings .vertical-tab-nav-item")].map((el) => el.textContent ?? ""));
}

test.describe("@phone settings section selector", () => {
  test("replaces the sideways-scrolling tab strip with a single selector row", async ({ page }) => {
    const { modal } = await openSettings(page);
    const selector = modal.getByRole("button", { name: /Appearance/ }).and(modal.locator(".settings-section-selector"));
    await expect(selector).toBeVisible();
    await expect(selector).toHaveAttribute("aria-haspopup", "dialog");
    await expect(selector).toHaveAttribute("aria-expanded", "false");
    await expect(selector).toContainText("Appearance");
    const box = (await selector.boundingBox())!;
    const modalBox = (await modal.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(modalBox.width - 2);
    expect(box.height).toBeGreaterThanOrEqual(44);
    // No strip to swipe: the tab header must not be rendered, and nothing in the settings shell scrolls sideways.
    await expect(modal.locator(".vertical-tab-header")).toBeHidden();
    const overflow = await modal.locator(".modal-content").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    // The selector sits above the content pane.
    const contentBox = (await modal.locator(".vertical-tab-content-container").boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(contentBox.y + 1);
  });

  test("opens a bottom sheet listing every desktop section, current one marked", async ({ page }) => {
    const { modal } = await openSettings(page);
    const selector = modal.locator(".settings-section-selector");
    await selector.click();
    const sheet = page.getByRole("dialog", { name: "Settings sections" });
    await expect(sheet).toBeVisible();
    await expect(selector).toHaveAttribute("aria-expanded", "true");

    const labels = await navLabels(page);
    expect(labels.length).toBeGreaterThan(5);
    const rows = sheet.locator(".settings-section-row-label");
    expect(await rows.allTextContents()).toEqual(labels);
    await expect(sheet.locator('.settings-section-row[aria-current="true"]')).toHaveCount(1);
    await expect(sheet.locator('.settings-section-row[aria-current="true"]')).toHaveText("Appearance");
    // Groups mirror the desktop grouping: the ungrouped built-ins get an "Options" heading.
    await expect(sheet.getByText("Options", { exact: true })).toBeVisible();
    // Focus moves into the sheet.
    expect(await page.evaluate(() => !!document.activeElement?.closest(".settings-section-sheet"))).toBe(true);
  });

  test("sheet stays inside the viewport, respects safe area, and rows are touch sized", async ({ page }) => {
    const { modal } = await openSettings(page);
    await page.evaluate(() => document.documentElement.style.setProperty("--geode-native-safe-area-bottom", "34px"));
    await modal.locator(".settings-section-selector").click();
    const sheet = page.getByRole("dialog", { name: "Settings sections" });
    await expect(sheet).toBeVisible();
    const viewport = page.viewportSize()!;
    const box = (await sheet.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeGreaterThanOrEqual(viewport.height - 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    expect(box.height).toBeLessThanOrEqual(viewport.height * 0.7 + 1);
    // The list scrolls inside the sheet rather than the sheet outgrowing the screen.
    const list = sheet.locator(".settings-section-sheet-body");
    expect(await list.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
    // Scroll to the end: the last row clears the bottom safe area.
    await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const lastRow = (await sheet.locator(".settings-section-row").last().boundingBox())!;
    expect(lastRow.y + lastRow.height).toBeLessThanOrEqual(viewport.height - 34 + 1);
    for (const height of await sheet.locator(".settings-section-row").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))) {
      expect(height).toBeGreaterThanOrEqual(44);
    }
  });

  test("choosing a section switches content, updates the selector label and closes the sheet", async ({ page }) => {
    const { modal } = await openSettings(page);
    const selector = modal.locator(".settings-section-selector");
    await selector.click();
    const sheet = page.getByRole("dialog", { name: "Settings sections" });
    await sheet.locator(".settings-section-row", { hasText: "Hotkeys" }).click();
    await expect(sheet).toBeHidden();
    await expect(modal.getByRole("heading", { name: "Hotkeys", exact: true })).toBeVisible();
    await expect(selector).toContainText("Hotkeys");
    await expect(selector).toHaveAttribute("aria-expanded", "false");
    await selector.click();
    await expect(sheet.locator('.settings-section-row[aria-current="true"]')).toHaveText("Hotkeys");
    // The existing tab semantics survive underneath.
    expect(await page.evaluate(() => document.querySelector(".mod-settings .vertical-tab-nav-item.is-active")?.textContent)).toBe("Hotkeys");
  });

  test("backdrop, Escape and Done dismiss only the sheet and focus returns to the selector", async ({ page }) => {
    const { modal } = await openSettings(page);
    const selector = modal.locator(".settings-section-selector");
    const sheet = page.getByRole("dialog", { name: "Settings sections" });

    await selector.click();
    await expect(sheet).toBeVisible();
    await page.locator(".settings-section-backdrop").click({ position: { x: 10, y: 10 } });
    await expect(sheet).toBeHidden();
    await expect(modal).toBeVisible();
    await expect(selector).toBeFocused();

    await selector.click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(modal).toBeVisible();
    await expect(selector).toBeFocused();
    await expect(selector).toHaveAttribute("aria-expanded", "false");

    await selector.click();
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(sheet).toBeHidden();
    await expect(selector).toBeFocused();

    // With no sheet open, Escape still closes Settings itself.
    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
  });

  test("closing Settings with the sheet open leaves nothing behind", async ({ page }) => {
    const { modal } = await openSettings(page);
    await modal.locator(".settings-section-selector").click();
    await page.evaluate(() => (window as any).app.setting.close());
    await expect(page.locator(".modal.mod-settings")).toHaveCount(0);
    await expect(page.locator(".settings-section-sheet")).toHaveCount(0);
  });
});

test.describe("@tablet settings keeps the sidebar", () => {
  test("shows the vertical tab sidebar and no section selector", async ({ page }) => {
    const { modal } = await openSettings(page);
    await expect(modal.locator(".settings-section-selector")).toBeHidden();
    await expect(modal.locator(".vertical-tab-header")).toBeVisible();
    await modal.locator(".vertical-tab-nav-item", { hasText: "Hotkeys" }).click();
    await expect(modal.locator(".vertical-tab-nav-item.is-active")).toHaveText("Hotkeys");
    await expect(page.locator(".settings-section-sheet")).toBeHidden();
  });
});
