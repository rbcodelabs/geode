import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const mobileUrl = pathToFileURL(path.resolve(__dirname, "../../dist/mobile/index.html")).href;
test("@phone @tablet portable Threads labels do not require desktop plugin execution or filesystem authority", async ({ page }, testInfo) => {
  await page.goto(mobileUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeAttached();
  await page.evaluate(async () => {
    const files = window.hostServices!.vaultFiles;
    await files.mkdir(".geode/plugins/claude-threads");
    await files.write(".geode/plugins/claude-threads/manifest.json", JSON.stringify({ id: "claude-threads", name: "Desktop Threads fixture", version: "1.0.0", minAppVersion: "0.1.0", author: "Test", description: "Metadata-only fixture", isDesktopOnly: true }));
    await files.write(".geode/plugins/claude-threads/main.js", 'throw new Error("Desktop plugin must not execute on mobile");');
    await files.write(".geode/plugins/claude-threads/data.json", JSON.stringify({ projects: [{ id: "portable", name: "Portable Project", cwdOverride: "/private/desktop-location", vaultFolder: "notes" }] }));
    await window.geode.writeConfig("plugins", ["claude-threads"]);
    await window.app.pluginManager.initialize();
  });
  const filesButton = page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "Files", exact: true });
  if (await filesButton.isVisible()) await filesButton.click();
  const section = page.locator(".projects-section");
  await expect(section).toContainText("Portable Project");
  await expect(section).toContainText("Available on desktop");
  await expect(section).not.toContainText("desktop-location");
  await expect(section.getByRole("button", { name: "Attach folder…" })).toHaveCount(0);
  expect(await page.evaluate(() => !!window.hostServices!.externalRoots)).toBe(false);
  expect(await page.evaluate(() => window.app.pluginManager.isEnabled("claude-threads"))).toBe(false);
  await section.getByRole("button", { name: "Portable Project", exact: true }).click();
  await expect(section).toContainText("not synchronized");
  await page.screenshot({ path: testInfo.outputPath("portable-threads-projects.png") });
  await page.evaluate(() => window.app.pluginManager.disable("claude-threads"));
  await expect(section).toBeHidden();
});
