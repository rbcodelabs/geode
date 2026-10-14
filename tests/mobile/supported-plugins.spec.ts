import { createHash } from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { chooseSettingsSection } from "./settings-nav";

const mobileUrl = pathToFileURL(path.resolve(__dirname, "../../dist/mobile/index.html")).href;
const externalVaultProofUrl = `${mobileUrl}?external-vault-proof=1`;
const CATALOG_URL = "https://geode.rbcodelabs.com/supported-plugins/v1.json";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const manifest = JSON.stringify({
  id: "fixture-mobile", name: "Fixture Mobile", version: "1.0.0", minAppVersion: "1.0.0",
  description: "supported-catalog fixture", author: "Geode", isDesktopOnly: false,
});
const mainJs = `const { Plugin } = require("obsidian");
module.exports = class extends Plugin { onload() { this.addCommand({ id: "hello", name: "Fixture hello", callback() {} }); } };`;
const stylesCss = ".fixture-mobile-supported { color: rgb(4, 5, 6); }";
const tamperedManifest = JSON.stringify({ ...JSON.parse(manifest), id: "fixture-tampered", name: "Fixture Tampered" });

function plugin(id: string, overrides: Record<string, unknown>, hashes: Record<string, string>) {
  return {
    id,
    name: overrides.name ?? id,
    description: `${id} description`,
    github: { owner: "fixtures", repo: id },
    manifest: { version: "1.0.0", releaseTag: "v1.0.0", minAppVersion: "1.0.0" },
    platforms: ["desktop", "mobile"],
    minimumGeodeVersion: "0.1.0",
    certifiedWithGeodeVersion: "0.1.0",
    artifactHashes: hashes,
    evidenceUrl: `https://github.com/fixtures/${id}/blob/${"b".repeat(40)}/evidence.md`,
    status: "active",
    ...overrides,
  };
}

const catalog = {
  schemaVersion: 1,
  plugins: [
    plugin("fixture-desktop", { name: "Fixture Desktop", platforms: ["desktop"] }, { "manifest.json": sha("d"), "main.js": sha("d") }),
    plugin("fixture-mobile", { name: "Fixture Mobile" }, { "manifest.json": sha(manifest), "main.js": sha(mainJs), "styles.css": sha(stylesCss) }),
    plugin("fixture-future", { name: "Fixture Future", minimumGeodeVersion: "99.0.0" }, { "manifest.json": sha("f"), "main.js": sha("f") }),
    // Catalog certifies different bytes than the release serves.
    plugin("fixture-tampered", { name: "Fixture Tampered" }, { "manifest.json": sha(tamperedManifest), "main.js": sha("the certified bytes") }),
    plugin("fixture-withdrawn", { name: "Fixture Withdrawn", status: "withdrawn" }, { "manifest.json": sha("w"), "main.js": sha("w") }),
  ],
};

const CORS = { "access-control-allow-origin": "*" };

// The shipped mobile CSP (connect-src 'self' wss:) deliberately stays closed:
// on iOS these downloads go through the native CapacitorHttp transport, which
// the WebView CSP does not govern. The browser build used here has no native
// transport, so the harness bypasses CSP for its fixture-only requests.
test.use({ bypassCSP: true });

async function stubNetwork(page: Page, state: { catalogOnline: boolean; releaseRequests: string[] }): Promise<void> {
  await page.route(CATALOG_URL, (route) =>
    state.catalogOnline
      ? route.fulfill({ status: 200, contentType: "application/json", headers: CORS, body: JSON.stringify(catalog) })
      : route.abort("internetdisconnected"));
  await page.route("https://github.com/fixtures/**", (route) => {
    const url = route.request().url();
    state.releaseRequests.push(url);
    const body = url.endsWith("/fixture-mobile/releases/download/v1.0.0/manifest.json") ? manifest
      : url.endsWith("/fixture-mobile/releases/download/v1.0.0/main.js") ? mainJs
      : url.endsWith("/fixture-mobile/releases/download/v1.0.0/styles.css") ? stylesCss
      : url.includes("/fixture-tampered/") ? (url.endsWith("manifest.json") ? tamperedManifest : "malicious bytes")
      : null;
    return body === null
      ? route.fulfill({ status: 404, headers: CORS, body: "not found" })
      : route.fulfill({ status: 200, contentType: "application/octet-stream", headers: CORS, body });
  });
}

async function openCommunitySettings(page: Page): Promise<void> {
  await page.goto(externalVaultProofUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => (window as any).app.commands.execute("open-another-vault"));
  await page.getByRole("button", { name: "Choose folder in Files" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).app?.vault?.root)).toBe("external://browser-provider-proof");
  await openSettingsTab(page);
}

async function openSettingsTab(page: Page): Promise<void> {
  await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "More" }).click();
  await page.locator(".menu.mod-mobile-more").getByText("Settings", { exact: true }).click();
  await chooseSettingsSection(page, "Community plugins & themes");
}

test("@phone @tablet lists supported plugins honestly and installs the tested release without enabling it", async ({ page }) => {
  const state = { catalogOnline: true, releaseRequests: [] as string[] };
  await stubNetwork(page, state);
  await openCommunitySettings(page);

  const catalogEl = page.locator(".supported-plugin-catalog");
  await expect(catalogEl.locator(".supported-plugin-item")).toHaveCount(4);
  await expect(catalogEl).not.toContainText("Fixture Withdrawn");
  await expect(catalogEl).not.toContainText("Latest (unverified)");

  // Desktop-only entries are shown, labelled, and not installable.
  const desktop = catalogEl.locator('[data-plugin-id="fixture-desktop"]');
  await expect(desktop).toContainText("Desktop only");
  await expect(desktop.getByRole("button")).toHaveCount(0);
  // Version-gated entries explain why, and cannot install.
  const future = catalogEl.locator('[data-plugin-id="fixture-future"]');
  await expect(future).toContainText("Requires Geode 99.0.0 or newer");
  await expect(future.getByRole("button")).toHaveCount(0);

  // Touch targets: Install buttons meet the 44px minimum on phone and tablet.
  for (const install of await catalogEl.getByRole("button", { name: "Install" }).all()) {
    expect((await install.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }

  // Hash mismatch: rejected, nothing written to the vault.
  const tampered = catalogEl.locator('[data-plugin-id="fixture-tampered"]');
  await tampered.getByRole("button", { name: "Install" }).click();
  await expect(tampered.locator(".supported-plugin-status")).toContainText("Integrity check failed");
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.exists(".geode/plugins/fixture-tampered"))).toBe(false);
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.exists(".geode/plugins/fixture-tampered/main.js"))).toBe(false);

  // Tested release installs, is recorded, and is NOT enabled.
  const row = catalogEl.locator('[data-plugin-id="fixture-mobile"]');
  await row.getByRole("button", { name: "Install" }).click();
  await expect(row.locator(".supported-plugin-status")).toContainText("Installed Fixture Mobile 1.0.0");
  expect(state.releaseRequests.filter((url) => url.includes("/fixture-mobile/")).sort()).toEqual([
    "https://github.com/fixtures/fixture-mobile/releases/download/v1.0.0/main.js",
    "https://github.com/fixtures/fixture-mobile/releases/download/v1.0.0/manifest.json",
    "https://github.com/fixtures/fixture-mobile/releases/download/v1.0.0/styles.css",
  ]);
  expect(await page.evaluate(() => window.hostServices!.vaultFiles.read(".geode/plugins/fixture-mobile/main.js"))).toBe(mainJs);
  const community = await page.evaluate(() => window.hostServices!.config.read("community"));
  expect(community).toMatchObject({ items: [{ repo: "fixtures/fixture-mobile", id: "fixture-mobile", installedVersion: "1.0.0", source: "release", ref: "v1.0.0", pinnedVersion: "1.0.0", autoUpdate: false }] });
  expect(await page.evaluate(() => (window as any).app.pluginManager.isEnabled("fixture-mobile"))).toBe(false);
  expect(await page.evaluate(() => (window as any).app.commands.has("fixture-mobile:hello"))).toBe(false);
  await expect(page.locator('style[data-plugin-id="fixture-mobile"]')).toHaveCount(0);

  // The newly tracked community row must not overflow its card.
  const tracked = page.locator('.community-list .community-item[data-repo="fixtures/fixture-mobile"]');
  expect(await tracked.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

  // The explicit opt-in is the existing mobile plugin row's Enable action.
  const installed = page.locator('.community-list .mobile-plugin-item[data-plugin-id="fixture-mobile"]');
  await expect(installed).toContainText("Mobile compatible");
  await installed.getByRole("button", { name: "Enable" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).app.commands.has("fixture-mobile:hello"))).toBe(true);
});

test("@phone falls back to the cached catalog when the network is unavailable", async ({ page }) => {
  const state = { catalogOnline: true, releaseRequests: [] as string[] };
  await stubNetwork(page, state);
  await openCommunitySettings(page);
  await expect(page.locator(".supported-plugin-catalog .supported-plugin-item")).toHaveCount(4);

  state.catalogOnline = false;
  await page.reload();
  await openSettingsTab(page);
  await expect(page.locator(".supported-plugin-catalog .supported-catalog-state")).toContainText("using cached catalog");
  await expect(page.locator(".supported-plugin-catalog .supported-plugin-item")).toHaveCount(4);
});

test("@phone shows the failure reason when the catalog is unavailable and nothing is cached", async ({ page }) => {
  await page.route(CATALOG_URL, (route) => route.fulfill({ status: 503, headers: CORS, body: "down" }));
  await openCommunitySettings(page);
  const state = page.locator(".supported-plugin-catalog .supported-catalog-state");
  await expect(state).toContainText("Supported plugins are temporarily unavailable");
  await expect(state).toContainText("Download failed (HTTP 503)");
  await expect(page.locator(".supported-plugin-catalog .supported-plugin-item")).toHaveCount(0);
});
