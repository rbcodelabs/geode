import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

/**
 * Covers the "Try the sample vault" entry point (src/renderer/app.ts's
 * `showVaultPicker`, src/main/main.ts's `explore-sample-vault` IPC handler,
 * src/main/starter-vault.ts's `copyStarterVault`) that opens the bundled
 * `resources/starter-vault/` prototype from the vault picker screen.
 *
 * `GEODE_DOCUMENTS_DIR` (added alongside the handler) redirects
 * `app.getPath("documents")` to a scratch dir so this never touches a real
 * developer's Documents folder.
 */
test("Try the sample vault opens the bundled starter vault with its theme and first file", async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-starter-vault-ud-"));
  const documentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-starter-vault-docs-"));
  // No geode.json written: a genuinely fresh launch with no recent vaults, so
  // the vault-picker screen (not an auto-opened vault) is what appears.

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, GEODE_DOCUMENTS_DIR: documentsDir },
  });

  try {
    const window = await app.firstWindow();
    await expect(window.locator(".vault-picker")).toBeVisible();
    const openFolderButton = window.getByRole("button", { name: "Open folder as vault" });
    const exploreButton = window.getByRole("button", { name: "Try the sample vault" });
    await expect(openFolderButton).toBeVisible();
    await expect(exploreButton).toBeVisible();

    await exploreButton.click();

    // The starter vault's Start here.md becomes the active file, and its
    // pre-seeded .geode/app.json (theme: light, cssTheme: Ivory) takes visual
    // effect immediately.
    await expect.poll(() =>
      window.evaluate(() => (window as any).app.workspace?.getActiveFile()?.path ?? null),
    ).toBe("Start here.md");
    await expect(window.locator("body.theme-light")).toHaveCount(1);
    await expect(window.locator('style#geode-active-theme[data-theme="Ivory"]')).toHaveCount(1);

    const destVault = path.join(documentsDir, "Geode Starter Vault");
    expect(fs.existsSync(path.join(destVault, "Start here.md"))).toBe(true);
    // The copied app.json (theme: light, cssTheme: Ivory) is what made the
    // theme assertions above pass. (copyStarterVault's unit tests separately
    // cover that only app.json is copied out of .geode/ — by the time the
    // live app has opened this vault, it has already written back its own
    // full settings object, plus runtime state like metadata-cache/, same as
    // any vault, so this only checks the two seeded fields survived.)
    expect(JSON.parse(fs.readFileSync(path.join(destVault, ".geode", "app.json"), "utf8"))).toMatchObject({
      theme: "light",
      cssTheme: "Ivory",
    });

    // A second click after edits must reuse the existing copy, never wipe it.
    fs.writeFileSync(path.join(destVault, "My edit.md"), "# kept\n");
    const second = await window.evaluate(() => (window as any).geode.exploreSampleVault());
    expect(second).toEqual({ path: destVault, created: false });
    expect(fs.existsSync(path.join(destVault, "My edit.md"))).toBe(true);
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(documentsDir, { recursive: true, force: true });
  }
});
