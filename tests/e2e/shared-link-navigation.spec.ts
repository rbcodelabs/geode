import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { resolutionFiles } from "../fixtures/shared-link-resolution";

test("desktop reading-view navigation consumes shared alias and tie-break resolution", async ({}, testInfo) => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-shared-link-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-shared-link-user-"));
  const repoRoot = path.resolve(__dirname, "../..");
  for (const [file, text] of Object.entries(resolutionFiles)) {
    fs.mkdirSync(path.dirname(path.join(vaultDir, file)), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, file), text);
  }
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ lastVault: vaultDir, recentVaults: [vaultDir] }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await expect(window.locator('.nav-folder-title[data-path="folder"]')).toBeVisible();
    await window.locator('.nav-folder-title[data-path="folder"]').click();
    await window.locator('.nav-file-title[data-path="folder/Source.md"]').click();
    await window.getByRole("button", { name: /Toggle reading view/ }).click();
    await window.evaluate(() => {
      const cache = (window as any).app.metadataCache;
      const original = cache.getFirstLinkpathDest.bind(cache);
      (window as any).sharedResolutionCalls = [];
      cache.getFirstLinkpathDest = (target: string, source: string) => {
        const result = original(target, source);
        (window as any).sharedResolutionCalls.push({ target, source, path: result?.path ?? null });
        return result;
      };
    });
    await window.locator('.markdown-reading-view a.internal-link[data-href="Other"]').click();
    await expect.poll(() => window.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("Alias.md");
    expect(await window.evaluate(() => (window as any).sharedResolutionCalls)).toContainEqual({ target: "Other", source: "folder/Source.md", path: "Alias.md" });
    await window.evaluate(async () => {
      const app = (window as any).app;
      await app.openLink("Twin", "folder/Source.md", false);
    });
    await expect.poll(() => window.evaluate(() => (window as any).app.workspace.getActiveFile()?.path)).toBe("a/Twin.md");
    expect(await window.evaluate(() => (window as any).sharedResolutionCalls)).toContainEqual({ target: "Twin", source: "folder/Source.md", path: "a/Twin.md" });
    await window.screenshot({ path: testInfo.outputPath("shared-link-navigation.png") });
    // This read-only adoption must not create missing notes or rewrite fixture bytes.
    for (const [file, text] of Object.entries(resolutionFiles)) expect(fs.readFileSync(path.join(vaultDir, file), "utf8")).toBe(text);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
