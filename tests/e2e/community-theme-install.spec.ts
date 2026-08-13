import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * Fake GitHub serving a THEME the way theme repos actually ship it: raw files
 * on the default branch (manifest.json + theme.css), no release. Exercises the
 * resolver's raw-default-branch path and the apply-after-install flow.
 */
const THEME_MANIFEST = { name: "Sample Theme", version: "1.0.0", author: "geode-tests" };
const THEME_CSS = ":root { --sample-theme-marker: 1; }\n.theme-dark { --background-primary: #101014; }\n";

async function startFakeGithub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    // Theme repos have no releases; return an empty list so "auto" would still
    // fall through to raw (the test selects Theme explicitly, but be robust).
    if (url === "/repos/geode-tests/sample-theme/releases") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    if (url === "/geode-tests/sample-theme/HEAD/manifest.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(THEME_MANIFEST));
      return;
    }
    if (url === "/geode-tests/sample-theme/HEAD/theme.css") {
      res.writeHead(200, { "content-type": "text/css" });
      res.end(THEME_CSS);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function launchApp(githubUrl: string): Promise<{
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  vaultPath: string;
  consoleErrors: string[];
}> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-e2e-"));
  const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), "geode-vault-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath })
  );
  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, GEODE_GITHUB_API_BASE: githubUrl, GEODE_GITHUB_RAW_BASE: githubUrl },
  });
  const consoleErrors: string[] = [];
  const window = await app.firstWindow();
  window.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  window.on("pageerror", (err) => consoleErrors.push(String(err)));
  return { app, window, userDataDir, vaultPath, consoleErrors };
}

test("installs a theme from (fake) GitHub raw files and applies it", async () => {
  const github = await startFakeGithub();
  const { app, window, userDataDir, vaultPath, consoleErrors } = await launchApp(github.url);

  try {
    await expect(window.locator(".workspace")).toBeVisible();
    await window.waitForFunction(
      () => Boolean((window as unknown as { app?: { commands?: unknown } }).app?.commands)
    );

    await window.evaluate(() => (window as unknown as { app: any }).app.commands.execute("community-add"));
    const modal = window.locator(".mod-community-install");
    await expect(modal).toBeVisible();

    await modal.locator(".community-repo-input").fill("geode-tests/sample-theme");
    await modal.locator(".community-type-select").selectOption("theme");
    await modal.locator(".community-enable-checkbox").check(); // apply after install
    await modal.locator(".community-install-btn").click();
    await expect(modal).toBeHidden();

    // Files landed under .geode/themes/<name>/.
    const themeDir = path.join(vaultPath, ".geode", "themes", "Sample Theme");
    await expect
      .poll(() => fs.existsSync(path.join(themeDir, "theme.css")), { timeout: 5000 })
      .toBe(true);
    expect(fs.existsSync(path.join(themeDir, "manifest.json"))).toBe(true);

    // community.json recorded the theme.
    const cfg = JSON.parse(fs.readFileSync(path.join(vaultPath, ".geode", "community.json"), "utf8"));
    expect(cfg.items).toHaveLength(1);
    expect(cfg.items[0]).toMatchObject({
      repo: "geode-tests/sample-theme",
      type: "theme",
      id: "Sample Theme",
      installedVersion: "1.0.0",
      source: "raw",
      autoUpdate: false,
    });

    // The theme is applied: active in the theme manager and injected as a <style>.
    const active = await window.evaluate(() =>
      (window as unknown as { app: any }).app.themeManager.activeTheme
    );
    expect(active).toBe("Sample Theme");
    await expect(window.locator("style#geode-community-theme")).toHaveCount(1);

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    await github.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});
