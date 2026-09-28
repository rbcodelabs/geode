import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "../..");

test("explorer moves files and folders, preserves contents, and rejects unsafe drops", async ({}, testInfo) => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-explorer-move-vault-"));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-explorer-move-user-"));
  fs.mkdirSync(path.join(vaultDir, "Destination"));
  fs.mkdirSync(path.join(vaultDir, "Folder", "Child"), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Keep this content\n");
  fs.writeFileSync(path.join(vaultDir, "Folder", "Child", "Nested.md"), "Nested content");
  fs.writeFileSync(path.join(vaultDir, "Collision.md"), "original");
  fs.writeFileSync(path.join(vaultDir, "Destination", "Collision.md"), "destination");
  fs.writeFileSync(path.join(userDir, "geode.json"), JSON.stringify({ lastVault: vaultDir, recentVaults: [vaultDir] }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDir}`], cwd: repoRoot });
  try {
    const page = await app.firstWindow();
    const row = (p: string) => page.locator(`.nav-item[data-path="${p}"]`);
    await row("Note.md").click();
    const transfer = await page.evaluateHandle(() => new DataTransfer());
    await row("Note.md").dispatchEvent("dragstart", { dataTransfer: transfer });
    await row("Destination").dispatchEvent("dragover", { dataTransfer: transfer });
    await expect(row("Destination")).toHaveClass(/is-drop-target/);
    await page.screenshot({ path: testInfo.outputPath("folder-drop-highlight.png") });
    await row("Note.md").dispatchEvent("dragend", { dataTransfer: transfer });
    await expect(row("Destination")).not.toHaveClass(/is-drop-target/);
    await transfer.dispose();
    await row("Note.md").dragTo(row("Destination"));
    await expect.poll(() => fs.existsSync(path.join(vaultDir, "Destination", "Note.md"))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, "Note.md"))).toBe(false);
    expect(fs.readFileSync(path.join(vaultDir, "Destination", "Note.md"), "utf8")).toBe("# Keep this content\n");
    await expect(row("Destination/Note.md")).toBeVisible();
    await row("Destination/Note.md").dragTo(page.locator(".nav-vault-name"));
    await expect.poll(() => fs.existsSync(path.join(vaultDir, "Note.md"))).toBe(true);

    await row("Collision.md").dragTo(row("Destination"));
    await expect(page.locator(".notice").filter({ hasText: "already exists" })).toBeVisible();
    expect(fs.readFileSync(path.join(vaultDir, "Collision.md"), "utf8")).toBe("original");
    expect(fs.readFileSync(path.join(vaultDir, "Destination", "Collision.md"), "utf8")).toBe("destination");

    // A newly-created file can exist on disk before the explorer's index catches up.
    await page.evaluate(() => {
      const vault = (window as any).app.vault;
      const original = vault.adapter.exists.bind(vault.adapter);
      vault.adapter.exists = (p: string) => p === "Destination/Note.md" ? Promise.resolve(true) : original(p);
      (window as any).__restoreExists = () => { vault.adapter.exists = original; };
    });
    await row("Note.md").dragTo(row("Destination"));
    await expect(page.locator(".notice").filter({ hasText: '"Note.md" already exists' })).toBeVisible();
    expect(fs.existsSync(path.join(vaultDir, "Note.md"))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, "Destination", "Note.md"))).toBe(false);
    await page.evaluate(() => (window as any).__restoreExists());

    await page.evaluate(() => {
      const app = (window as any).app;
      const original = app.renameFileWithLinkUpdate;
      app.renameFileWithLinkUpdate = async () => { throw new Error("Permission denied"); };
      (window as any).__restoreRename = () => { app.renameFileWithLinkUpdate = original; };
    });
    await row("Note.md").dragTo(row("Destination"));
    await expect(page.locator(".notice").filter({ hasText: "Permission denied" })).toBeVisible();
    expect(fs.existsSync(path.join(vaultDir, "Note.md"))).toBe(true);
    await page.evaluate(() => (window as any).__restoreRename());

    await row("Folder").click();
    await row("Folder").dragTo(row("Folder/Child"));
    expect(fs.existsSync(path.join(vaultDir, "Folder", "Child", "Nested.md"))).toBe(true);
    await row("Folder").dragTo(row("Destination"));
    await expect.poll(() => fs.existsSync(path.join(vaultDir, "Destination", "Folder", "Child", "Nested.md"))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, "Folder"))).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  }
});
