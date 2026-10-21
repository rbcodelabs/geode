import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
test.setTimeout(120_000);

test("Settings > Sync shows a live pairing code over real IPC, refuses non-HTTPS hubs, and cancels", async ({}, testInfo) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "geode-pairing-e2e-"));
  const vault = path.join(base, "vault"), profile = path.join(base, "profile");
  fs.mkdirSync(vault, { recursive: true }); fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${profile}`], cwd: repoRoot, env: { ...process.env, GEODE_HEADLESS: "1" } });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => (window as any).app?.sync?.listProviders().some((p: any) => p.id === "geode.hub"));
    const openSync = async () => {
      await page.evaluate(() => (window as any).app.setting.openTabById("sync"));
      const modal = page.locator('.modal.mod-settings[aria-label="Settings"]');
      await expect(modal.getByRole("heading", { name: "Sync" })).toBeVisible();
      return modal;
    };
    let modal = await openSync();
    await modal.getByRole("combobox", { name: "Sync provider" }).selectOption("geode.hub");
    // Folder hub (default): the card is shown but refuses with the explanatory message.
    await modal.getByRole("button", { name: "Show pairing code" }).click();
    await expect(modal.locator("[data-pairing-status]")).toContainText("HTTPS hub");
    await expect(modal.locator("[data-pairing-qr]")).toHaveCount(0);
    // Switch to an HTTPS hub.
    await modal.getByRole("combobox", { name: "Hub type" }).selectOption("http");
    await modal.getByRole("textbox", { name: "Hub URL" }).fill("https://hub.example.test");
    await page.evaluate(async () => { await (window as any).app.hubSyncProvider?.setConfig({ schema: 1, target: { kind: "http", url: "https://hub.example.test" }, create: false }); });
    modal = await openSync();
    await modal.getByRole("button", { name: "Show pairing code" }).click();
    await expect(modal.locator("[data-pairing-qr] svg")).toBeVisible({ timeout: 15_000 });
    const code = (await modal.locator("[data-pairing-code]").textContent()) ?? "";
    expect(code.length).toBeGreaterThan(20);
    expect(code).not.toMatch(/token|secret|bearer/i);
    await expect(modal.locator("[data-pairing-countdown]")).toContainText(/Expires in [0-3]:\d\d/);
    await page.screenshot({ path: process.env.PAIRING_SHOT ?? testInfo.outputPath("pairing-card.png") });
    await modal.locator("[data-pairing-cancel]").click();
    await expect(modal.locator("[data-pairing-status]")).toContainText("cancelled");
    await expect(modal.locator("[data-pairing-qr]")).toHaveCount(0);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(base, { recursive: true, force: true });
  }
});
