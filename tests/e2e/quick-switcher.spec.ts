import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");
const testVaultFixturePath = path.join(repoRoot, "test-vault");

/**
 * Regression coverage for the quick switcher only searching Markdown files
 * (`Vault.getMarkdownFiles()`), so existing non-Markdown vault files like
 * `.base` and `.canvas` were invisible via Cmd/Ctrl+O even though they're
 * real, openable files. `QuickSwitcherModal.getItems()` must source from
 * `Vault.getFiles()` instead.
 *
 * Uses a throwaway copy of `test-vault/` (same convention as bases.spec.ts)
 * so the `.base` fixture never lands in the checked-in shared vault.
 */
function makeVaultCopy(): string {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-quick-switcher-e2e-"));
  fs.cpSync(testVaultFixturePath, vaultDir, { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, "Email Action Items.base"),
    "views:\n  - type: table\n    name: Table\n"
  );
  fs.mkdirSync(path.join(vaultDir, ".geode"), { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, ".geode", "bookmarks.json"),
    JSON.stringify({
      items: [
        {
          type: "group",
          id: "reading",
          title: "Reading",
          expanded: false,
          items: [
            {
              type: "link",
              id: "guide",
              title: "  Saved Web Guide  ",
              url: "https://example.com/saved-guide",
            },
            {
              type: "link",
              id: "untitled-reference",
              title: "   ",
              url: "https://reference.example/untitled-resource",
            },
          ],
        },
      ],
    }),
  );
  return vaultDir;
}

test("quick switcher finds and opens a non-Markdown vault file (.base)", async () => {
  const vaultDir = makeVaultCopy();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-quick-switcher-e2e-ud-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir })
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const window = await app.firstWindow();
    const consoleErrors: string[] = [];
    window.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    window.on("pageerror", (err) => consoleErrors.push(String(err)));

    await expect(window.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();

    await window.keyboard.press("ControlOrMeta+o");
    const promptInput = window.locator(".modal .prompt-input");
    await expect(promptInput).toBeVisible();

    await promptInput.fill("Email Action");

    // This is the actual regression: before the fix, getItems() only
    // returned Markdown files, so the .base fixture never matched.
    const result = window.locator(".prompt-result-title", { hasText: "Email Action Items" });
    await expect(result).toBeVisible();

    await window.keyboard.press("Enter");

    await expect(window.locator(".modal .prompt-input")).toHaveCount(0);
    await expect(window.locator(".view-header-title").first()).toHaveText("Email Action Items");
    await expect(window.locator(".bases-table-container")).toBeVisible();

    expect(consoleErrors, `Console errors: ${consoleErrors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("quick switcher finds a nested website bookmark by title and opens it", async () => {
  const vaultDir = makeVaultCopy();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-quick-switcher-e2e-ud-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const window = await app.firstWindow();
    await expect(window.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();

    await window.keyboard.press("ControlOrMeta+o");
    const promptInput = window.locator(".modal .prompt-input");
    await expect(promptInput).toHaveAttribute("placeholder", "Find a file or website bookmark…");
    await promptInput.fill("Saved Web Guide");

    const result = window.locator(".prompt-result", { hasText: "Saved Web Guide" });
    await expect(result).toContainText("https://example.com/saved-guide");
    await result.click();

    await expect(window.locator(".web-view-frame")).toBeVisible();
    await expect(window.locator(".web-view-address")).toHaveValue("https://example.com/saved-guide");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("quick switcher finds an untitled website bookmark by URL and uses the URL as its label", async () => {
  const vaultDir = makeVaultCopy();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-quick-switcher-e2e-ud-"));
  fs.writeFileSync(
    path.join(userDataDir, "geode.json"),
    JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }),
  );

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
  });

  try {
    const window = await app.firstWindow();
    await expect(window.locator('.nav-file-title[data-path="Welcome.md"]')).toBeVisible();

    await window.keyboard.press("ControlOrMeta+o");
    const promptInput = window.locator(".modal .prompt-input");
    await promptInput.fill("untitled-resource");

    const result = window.locator(".prompt-result", { hasText: "https://reference.example/untitled-resource" });
    await expect(result.locator(".prompt-result-title")).toHaveText("https://reference.example/untitled-resource");
    await expect(result.locator(".prompt-result-path")).toBeEmpty();
    await result.click();

    await expect(window.locator(".web-view-frame")).toBeVisible();
    await expect(window.locator(".web-view-address")).toHaveValue("https://reference.example/untitled-resource");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
