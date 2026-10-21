import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const mobileUrl = pathToFileURL(path.resolve(__dirname, "../../dist/mobile/index.html")).href;

async function openNote(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(mobileUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "Files" }).click();
  await page.locator('.nav-file-title[data-path="Welcome.md"]').click();
  await expect(page.locator(".cm-content")).toBeVisible();
}

test("@phone status line keeps breathing room above the bottom navigation", async ({ page }) => {
  await openNote(page);
  const item = page.locator(".status-bar .status-bar-item", { hasText: /words/ });
  await expect(item).toBeVisible();
  const itemBox = (await item.boundingBox())!;
  const navBox = (await page.getByRole("navigation", { name: "Mobile navigation" }).boundingBox())!;
  expect(navBox.y - (itemBox.y + itemBox.height)).toBeGreaterThanOrEqual(8);
});

test("@phone open drawer never leaves a clipped page toolbar icon peeking beside it", async ({ page }) => {
  await openNote(page);
  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "Files" }).click();
  const drawer = page.locator(".workspace-sidebar.mod-left");
  await expect(drawer).toHaveClass(/is-mobile-drawer-open/);
  await page.waitForTimeout(300); // let the slide-in transition settle
  const edge = (await drawer.boundingBox())!.x + (await drawer.boundingBox())!.width;
  const icons = page.locator(".workspace-center .view-header .clickable-icon");
  const count = await icons.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const icon = icons.nth(i);
    const visible = await icon.evaluate((el) => getComputedStyle(el).visibility !== "hidden");
    const box = (await icon.boundingBox())!;
    const straddles = box.x < edge && box.x + box.width > edge;
    // Either hidden outright, or fully clear of the drawer edge: a half-covered icon is the defect.
    expect(!visible || !straddles, `icon ${i} straddles drawer edge`).toBe(true);
    expect(!visible || box.x >= edge || box.x + box.width <= edge).toBe(true);
  }
});

test("@phone bottom navigation outer tabs clear the rounded display corners", async ({ page }) => {
  await page.goto(mobileUrl);
  const nav = page.getByRole("navigation", { name: "Mobile navigation" });
  const buttons = nav.getByRole("button");
  const count = await buttons.count();
  expect(count).toBeGreaterThanOrEqual(2);
  const viewportWidth = page.viewportSize()!.width;
  const first = (await buttons.first().boundingBox())!;
  const last = (await buttons.nth(count - 1).boundingBox())!;
  expect(first.x).toBeGreaterThanOrEqual(12);
  expect(viewportWidth - (last.x + last.width)).toBeGreaterThanOrEqual(12);
});

test("@phone New Tab picker keeps side gutters and hides keyboard hints", async ({ page }) => {
  await page.goto(mobileUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const picker = page.locator(".new-tab-picker");
  await expect(picker).toBeVisible();
  const box = (await picker.boundingBox())!;
  const viewportWidth = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(12);
  expect(viewportWidth - (box.x + box.width)).toBeGreaterThanOrEqual(12);
  await expect(page.locator(".empty-state-action-hint").first()).toBeHidden();
});

test("@phone New Tab shows the gem mark, and the bottom nav has a single hairline", async ({ page }) => {
  await page.goto(mobileUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const gem = page.locator(".empty-state-gem");
  await expect(gem).toBeVisible();
  expect((await gem.boundingBox())!.width).toBeCloseTo(44, 0);
  const inputHeight = (await page.locator(".new-tab-picker-input").boundingBox())!.height;
  expect(inputHeight).toBeGreaterThanOrEqual(48);
  const statusBorder = await page
    .locator(".status-bar")
    .evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(statusBorder).toBe("0px");
  const navBorder = await page
    .getByRole("navigation", { name: "Mobile navigation" })
    .evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(navBorder).toBe("1px");
});

test("@phone New Tab gem is hidden when body is not in mobile mode", async ({ page }) => {
  await page.goto(mobileUrl);
  await page.evaluate(() => document.body.classList.remove("is-mobile"));
  await expect(page.locator(".empty-state-gem")).toBeHidden();
});
