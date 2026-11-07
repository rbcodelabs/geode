import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("typing / opens the command menu; picking a command removes the trigger and runs it", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-slash-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-slash-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Slash.md"), "Hello\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: { ...process.env, GEODE_HEADLESS: "1" },
  });
  try {
    const window = await app.firstWindow();
    await expect(window.locator(".workspace")).toBeVisible();
    await window.locator('.nav-file-title[data-path="Slash.md"]').click();
    const content = window.locator(".cm-content");
    await expect(content).toBeVisible();
    await content.click();
    await window.keyboard.press("Meta+ArrowDown");
    await window.keyboard.press("End");
    await window.keyboard.press("Enter");

    const popup = window.locator(".cm-tooltip-autocomplete");

    // Space cancels the menu without running anything.
    await window.keyboard.type("/");
    await expect(popup).toBeVisible();
    await expect(popup.locator("li").first()).toBeVisible();
    await window.keyboard.type("x ");
    await expect(popup).toBeHidden();
    await window.keyboard.press("Backspace");
    await window.keyboard.press("Backspace");
    await window.keyboard.press("Backspace");

    // Mid-word slash does not open the menu.
    await window.keyboard.type("a/");
    await expect(popup).toBeHidden();
    await window.keyboard.press("Backspace");
    await window.keyboard.press("Backspace");

    // Fuzzy-filter the registry and run a command with Enter.
    await window.keyboard.type("/trv");
    await expect(popup).toBeVisible();
    await expect(popup.locator("li").first()).toContainText("Toggle reading view");
    await window.keyboard.press("Enter");

    await expect(window.locator(".markdown-reading-view")).toBeVisible();
    await expect(popup).toBeHidden();

    // The trigger text was removed from the document before the command ran.
    await expect.poll(() => fs.readFileSync(path.join(vaultDir, "Slash.md"), "utf8")).not.toContain("/");
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
