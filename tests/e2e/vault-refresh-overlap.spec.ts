import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

// A refresh requested while another scan is already running must still see changes made after that scan began. Before the
// fix the second request was folded into the running scan, so a symlink created in between was never reported and the
// "Vault refresh failed" banner never appeared (the flake in vault-refresh-errors.spec.ts on the macOS runner).
test("a refresh requested during a running scan still reports a change made after that scan began", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "geode-e2e-refresh-overlap-"));
  const vault = path.join(root, "vault");
  const userData = path.join(root, "user-data");
  fs.mkdirSync(vault); fs.mkdirSync(userData);
  fs.writeFileSync(path.join(vault, "Welcome.md"), "# Welcome\nExisting note bytes");
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const repo = path.resolve(__dirname, "../..");
  const app = await electron.launch({ args: [repo, `--user-data-dir=${userData}`], cwd: repo, env: { ...process.env, GEODE_TEST_VAULT_IO_DELAY_MS: "600" } });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();
    // Scan 1 lists the vault root after ~600 ms and then spends another ~600 ms on Welcome.md. Create the symlink after the
    // listing but before the scan finishes.
    await page.evaluate(() => { (window as any).__firstRefresh = (window as any).app.reconcileVault("manual"); });
    await page.waitForTimeout(900);
    fs.symlinkSync("missing", path.join(vault, "Unsupported.md"));
    await page.evaluate(() => (window as any).app.reconcileVault("manual"));
    await page.evaluate(() => (window as any).__firstRefresh);
    await expect(page.locator(".vault-reconcile-state")).toContainText("Vault refresh failed. Your previous file list is unchanged.");
    expect(fs.readFileSync(path.join(vault, "Welcome.md"), "utf8")).toBe("# Welcome\nExisting note bytes");
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
