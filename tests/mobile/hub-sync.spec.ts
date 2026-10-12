import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Page } from "@playwright/test";

const mobileUrl = pathToFileURL(path.resolve(__dirname, "../../dist/mobile/index.html")).href;

/**
 * The browser proof host has no guarded sync or Keychain, so (like the phone's Capacitor host) give it both before the app
 * reads them: a stand-in `syncSafety` (enough to register the built-in hub provider) and an in-memory `secrets.app`
 * recorded on `window.__appSecrets` so the test can see exactly where the token went.
 */
async function withPhoneSyncHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let installed: unknown;
    const secrets = new Map<string, string>();
    (window as unknown as { __appSecrets: Map<string, string> }).__appSecrets = secrets;
    Object.defineProperty(window, "hostServices", {
      configurable: true,
      get: () => installed,
      set: (host: Record<string, unknown>) => {
        host.syncSafety = {
          claimOwner: async () => "lease", releaseOwner: async () => {}, apply: async () => { throw new Error("not used"); },
          storage: async (_t: string, _b: string, request: { action: string }) => request.action === "load-operations" ? [] : undefined,
          onPrepare: () => () => {}, onRelease: () => () => {},
        };
        host.secrets = {
          ...(host.secrets as object), appAvailable: true,
          app: { get: async (key: string) => secrets.get(key) ?? null, set: async (key: string, value: string) => { secrets.set(key, value); }, remove: async (key: string) => { secrets.delete(key); } },
        };
        installed = host;
      },
    });
  });
  await page.goto(mobileUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
}

test("@phone the Sync tab offers the HTTPS hub on a phone, fits the screen, and keeps the token out of web storage", async ({ page }, testInfo) => {
  await withPhoneSyncHost(page);
  const nav = page.getByRole("navigation", { name: "Mobile navigation" });
  await nav.getByRole("button", { name: "More" }).click();
  await page.locator(".menu.mod-mobile-more").getByText("Settings", { exact: true }).click();
  const modal = page.locator(".modal.mod-settings");
  await expect(modal).toBeVisible();
  await modal.getByText("Sync", { exact: true }).first().click();

  await page.getByRole("combobox", { name: "Sync provider" }).selectOption("geode.hub");
  const type = page.getByRole("combobox", { name: "Hub type" });
  await expect(type).toBeVisible();
  await expect(type.locator("option")).toHaveText(["HTTPS hub"]);
  const url = page.getByRole("textbox", { name: "Hub URL" });
  const token = page.getByLabel("Hub token");
  await expect(url).toBeVisible();
  await expect(token).toBeVisible();
  await expect(page.getByLabel("Hub ssh host")).toBeHidden();
  await expect(page.getByLabel("Hub store path")).toBeHidden();
  await expect(token).toBeEnabled();
  await expect(page.locator("[data-hub-secure-storage]")).not.toContainText("unavailable");

  // Everything stays inside the phone's width: no horizontal scroll in the settings pane, no control past the right edge.
  const viewport = page.viewportSize()!;
  for (const control of [type, url, token, page.getByRole("button", { name: "Test connection" })]) {
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  // A hub URL must stay readable: the field uses most of the phone's width, not a sliver of it.
  expect((await url.boundingBox())!.width).toBeGreaterThan(viewport.width * 0.6);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

  await url.fill("https://claude-box.example.ts.net");
  await token.fill("phone-token-0123456789");
  await token.blur();
  await expect(page.locator("[data-hub-result]")).toContainText("Hub settings saved");
  await expect(token).toHaveAttribute("placeholder", "Token saved on this device");
  await expect(token).toHaveValue("");

  const where = await page.evaluate(() => ({
    secrets: [...(window as unknown as { __appSecrets: Map<string, string> }).__appSecrets],
    web: JSON.stringify({ ...localStorage }) + document.cookie,
  }));
  expect(where.secrets).toEqual([["hub-token/claude-box.example.ts.net", "phone-token-0123456789"]]);
  expect(where.web).not.toContain("phone-token-0123456789");
  await token.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("phone-hub-sync.png") });
});

test("@phone without secure storage the HTTPS hub refuses a token instead of keeping it anywhere", async ({ page }) => {
  await page.addInitScript(() => {
    let installed: unknown;
    Object.defineProperty(window, "hostServices", {
      configurable: true, get: () => installed,
      set: (host: Record<string, unknown>) => {
        host.syncSafety = { claimOwner: async () => "lease", releaseOwner: async () => {}, apply: async () => { throw new Error("not used"); }, storage: async () => [], onPrepare: () => () => {}, onRelease: () => () => {} };
        installed = host;
      },
    });
  });
  await page.goto(mobileUrl);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const nav = page.getByRole("navigation", { name: "Mobile navigation" });
  await nav.getByRole("button", { name: "More" }).click();
  await page.locator(".menu.mod-mobile-more").getByText("Settings", { exact: true }).click();
  await page.locator(".modal.mod-settings").getByText("Sync", { exact: true }).first().click();
  await page.getByRole("combobox", { name: "Sync provider" }).selectOption("geode.hub");
  await expect(page.locator("[data-hub-secure-storage]")).toContainText("Secure storage is unavailable");
  await expect(page.getByLabel("Hub token")).toBeDisabled();
});
