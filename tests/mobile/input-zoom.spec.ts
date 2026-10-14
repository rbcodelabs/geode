import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const mobileUrl = pathToFileURL(path.resolve(__dirname, "../../dist/mobile/index.html")).href;

// iOS zooms the page when a focused editable field computes under 16px.
const IOS_ZOOM_THRESHOLD_PX = 16;

async function fontSizePx(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

async function freshMobile(page: Page): Promise<void> {
  await page.goto(mobileUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(async () => {
    const app = (window as any).app;
    await app.openFile(app.vault.getFileByPath("Welcome.md"), false);
  });
  await expect(page.locator(".workspace-center .cm-content").first()).toBeVisible();
}

test("@phone viewport meta pins maximum-scale=1", async ({ page }) => {
  await page.goto(mobileUrl);
  const content = await page.locator('meta[name="viewport"]').getAttribute("content");
  expect(content, "viewport meta content").toMatch(/(^|,)\s*maximum-scale=1(\s*,|$)/);
});

test("@phone CodeMirror editor text is at least 16px so focusing it does not zoom iOS", async ({ page }) => {
  await freshMobile(page);
  const content = await fontSizePx(page, ".workspace-center .cm-content");
  const scroller = await fontSizePx(page, ".workspace-center .cm-scroller");
  expect(content, ".cm-content computed font-size").toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD_PX);
  expect(scroller, ".cm-scroller computed font-size").toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD_PX);
});

test("@phone sidebar search input is at least 16px", async ({ page }) => {
  await freshMobile(page);
  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "Search" }).click();
  await expect(page.locator(".search-input")).toBeVisible();
  expect(await fontSizePx(page, ".search-input"), ".search-input computed font-size")
    .toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD_PX);
});

test("@phone quick switcher input is at least 16px", async ({ page }) => {
  await freshMobile(page);
  await page.evaluate(() => (window as any).app.openQuickSwitcher());
  await expect(page.locator(".prompt-input")).toBeVisible();
  expect(await fontSizePx(page, ".prompt-input"), "quick switcher .prompt-input computed font-size")
    .toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD_PX);
});

test("@phone settings modal text inputs are at least 16px", async ({ page }) => {
  await freshMobile(page);
  await page.evaluate(() => (window as any).app.setting.open());
  const inputs = page.locator(".modal input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]), .modal textarea, .modal select");
  await expect(inputs.first()).toBeVisible();
  const sizes = await inputs.evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
  expect(sizes.length, "settings editable controls found").toBeGreaterThan(0);
  expect(Math.min(...sizes), `settings control font sizes: ${sizes.join(",")}`).toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD_PX);
});

const EDITABLE =
  "input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=button]):not([type=submit]):not([type=file]), textarea, select, [contenteditable]:not([contenteditable=false])";

async function sizesIn(page: Page, scope: string): Promise<Array<{ desc: string; px: number }>> {
  return page.locator(scope).locator(EDITABLE).evaluateAll((els) =>
    els.map((el) => ({
      desc: `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).trim().split(/\s+/).join(".") : ""}`,
      px: parseFloat(getComputedStyle(el).fontSize),
    })));
}

test("@phone note title (.view-header-title) is at least 16px unfocused and focused", async ({ page }) => {
  await freshMobile(page);
  const title = page.locator(".workspace-center .view-header-title").first();
  await expect(title).toBeVisible();
  expect(await title.getAttribute("contenteditable"), "title contenteditable mode").toBe("plaintext-only");
  const unfocused = await fontSizePx(page, ".workspace-center .view-header-title");
  console.log(`title unfocused font-size: ${unfocused}px`);
  expect(unfocused, "title unfocused").toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD_PX);
  await title.click();
  await expect(title).toBeFocused();
  const focused = await fontSizePx(page, ".workspace-center .view-header-title");
  console.log(`title focused font-size: ${focused}px`);
  expect(focused, "title focused").toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD_PX);
});

test("@phone rename-file prompt input is at least 16px", async ({ page }) => {
  await freshMobile(page);
  await page.evaluate(() => {
    const app = (window as any).app;
    app.promptRenameResource(app.vault.getFileByPath("Welcome.md"));
  });
  const input = page.locator(".modal.prompt .prompt-input");
  await expect(input).toBeVisible();
  const px = await fontSizePx(page, ".modal.prompt .prompt-input");
  console.log(`rename prompt font-size: ${px}px`);
  expect(px, "rename .prompt-input").toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD_PX);
});

test("@phone search-web prompt input is at least 16px", async ({ page }) => {
  await freshMobile(page);
  await page.evaluate(() => (window as any).app.searchWeb());
  await expect(page.locator(".modal.prompt .prompt-input")).toBeVisible();
  const px = await fontSizePx(page, ".modal.prompt .prompt-input");
  console.log(`search-web prompt font-size: ${px}px`);
  expect(px, "search-web .prompt-input").toBeGreaterThanOrEqual(IOS_ZOOM_THRESHOLD_PX);
});

test("@phone every editable control in every Settings tab is at least 16px", async ({ page }) => {
  await freshMobile(page);
  await page.evaluate(() => (window as any).app.setting.open());
  const navItems = page.locator(".modal .vertical-tab-nav-item");
  // On mobile the tab strip is hidden behind the section selector but stays in the DOM.
  await expect(navItems.first()).toBeAttached();
  const labels = await navItems.allInnerTexts();
  expect(labels.length, "settings tabs found").toBeGreaterThan(3);
  const offenders: string[] = [];
  const report: string[] = [];
  for (const label of labels) {
    await page.locator(".modal .vertical-tab-nav-item", { hasText: label }).first().evaluate((el) => (el as HTMLElement).click());
    await page.waitForTimeout(150);
    const sizes = await sizesIn(page, ".modal .vertical-tab-content-container");
    report.push(`${label}: [${sizes.map((s) => `${s.desc}=${s.px}`).join(", ")}]`);
    for (const s of sizes) if (s.px < IOS_ZOOM_THRESHOLD_PX) offenders.push(`${label} / ${s.desc} = ${s.px}px`);
  }
  console.log("settings controls by tab:\n" + report.join("\n"));
  expect(offenders, `settings controls under ${IOS_ZOOM_THRESHOLD_PX}px`).toEqual([]);
});
