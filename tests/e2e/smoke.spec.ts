import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultPath = path.join(repoRoot, "test-vault");

/**
 * Boots the built app straight into `test-vault/` by pre-seeding a fresh,
 * isolated userData directory with a `geode.json` that lists it as the last
 * opened vault. `App.start()` (src/renderer/app.ts) auto-opens
 * `recentVaults[0]` on launch, so this sidesteps the native "choose a
 * folder" dialog, which Playwright cannot drive.
 */
async function launchAppAgainstTestVault(): Promise<{
  app: ElectronApplication;
  window: Page;
  userDataDir: string;
  consoleErrors: string[];
}> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-e2e-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [testVaultPath], lastVault: testVaultPath })
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  const consoleErrors: string[] = [];
  const window = await app.firstWindow();
  window.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  window.on("pageerror", (err) => consoleErrors.push(String(err)));

  return { app, window, userDataDir, consoleErrors };
}

test("boots into test-vault, opens a note, and renders Live Preview with no console errors", async () => {
  const { app, window, userDataDir, consoleErrors } = await launchAppAgainstTestVault();

  try {
    // Vault auto-opened: file explorer should list the seeded note.
    const welcomeRow = window.locator('.nav-file-title[data-path="Welcome.md"]');
    await expect(welcomeRow).toBeVisible();
    await welcomeRow.click();

    // Live Preview is the default editing mode (MarkdownView.mode === "live").
    const editorHost = window.locator(".markdown-source-view");
    await expect(editorHost).toBeVisible();
    await expect(window.locator(".cm-editor")).toBeVisible();

    // Frontmatter renders as the integrated properties widget, not raw YAML.
    await expect(window.locator(".metadata-properties")).toBeVisible();

    // Wikilinks render as clickable text (raw "[[" / "]]" hidden).
    const wikilinks = window.locator(".cm-live-wikilink");
    await expect(wikilinks.first()).toBeVisible();
    expect(await wikilinks.count()).toBe(2); // [[Daily Plan]] and [[Projects/Roadmap|...]]
    await expect(wikilinks.first()).toHaveText("Daily Plan");

    // Task list markers render as toggleable checkbox widgets.
    await expect(window.locator(".cm-task-checkbox").first()).toBeVisible();

    // The raw ATX heading marker is hidden away from the cursor (cursor
    // starts inside the collapsed frontmatter widget, not on the heading
    // line), leaving only the heading text visible.
    const editorText = await window.locator(".cm-editor").innerText();
    expect(editorText).toContain("Welcome to Geode");
    expect(editorText).not.toContain("# Welcome to Geode");

    expect(consoleErrors, `Console errors during smoke test: ${consoleErrors.join("\n")}`).toEqual(
      []
    );
  } finally {
    await app.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
