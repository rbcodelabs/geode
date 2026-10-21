import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function writeArtifact(dir: string, id: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "artifact.json"), JSON.stringify({
    schemaVersion: 1, id, title: id, entry: "index.html", runtime: "static",
    createdByThreadId: "thread-explorer",
    viewport: { preset: "desktop", width: 1440, height: 900 },
    permissions: { network: "none", clipboard: false },
  }));
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><title>${id}</title><main id="out">${id}</main>`);
}

test("artifact folders open from the file explorer and the command, defaulting to fill", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "geode-artifact-explorer-e2e-"));
  const userDataDir = path.join(temp, "user-data");
  const vaultPath = path.join(temp, "vault");
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(path.join(vaultPath, "Notes"), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, "Notes", "Plain.md"), "# plain\n");
  writeArtifact(path.join(vaultPath, "Artifacts", "dash"), "explorer-dash");
  writeArtifact(path.join(vaultPath, "Artifacts", "board"), "explorer-board");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  try {
    await expect(window.locator(".workspace")).toBeVisible();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
    await window.waitForFunction(() => (window as any).app?.vault?.getAbstractFileByPath("Artifacts/dash/artifact.json"));

    const row = (p: string) => window.locator(`.nav-folder-title[data-path="${p}"]`);
    // Plain folders are not artifacts; the Artifacts container is not one either.
    await expect(row("Notes")).not.toHaveClass(/is-artifact/);
    await row("Artifacts").click();
    await expect(row("Artifacts/dash")).toHaveClass(/is-artifact/);
    await expect(row("Artifacts/board")).toHaveClass(/is-artifact/);

    // Clicking the artifact folder opens it, fill by default (no clipping), without expanding it.
    await row("Artifacts/dash").click();
    const dashFrame = window.locator('.artifact-view-frame[src="geode-artifact://explorer-dash/index.html"]');
    await expect(dashFrame).toBeVisible();
    await expect(dashFrame).toHaveCSS("width", /^(?!1440px)/);
    await expect(window.locator('.artifact-view [data-viewport="fill"]')).toHaveClass(/is-active/);
    // Viewport choices are an icon-only segmented control with accessible names and pressed state.
    const group = window.getByRole("group", { name: "Viewport size" });
    await expect(group.getByRole("button")).toHaveCount(4);
    await expect(group.getByRole("button", { name: "Fill pane viewport" })).toHaveAttribute("aria-pressed", "true");
    await expect(group.getByRole("button", { name: "Mobile viewport" })).toHaveAttribute("aria-pressed", "false");
    await expect(group.locator('[data-viewport="mobile"] svg')).toHaveCount(1);
    await expect(group.locator('[data-viewport="mobile"]')).toHaveText("");
    await expect(window.locator('.nav-folder[class*="is-open"] > .nav-folder-title[data-path="Artifacts/dash"]')).toHaveCount(0);

    // Clicking it again focuses the same tab rather than opening a duplicate.
    await row("Artifacts/dash").click();
    await expect(window.locator(".artifact-view-frame")).toHaveCount(1);

    // The command opens another one from a picker.
    await window.evaluate(() => (window as any).app.commands.executeCommandById("open-artifact"));
    await window.locator(".prompt-input, .prompt input").first().fill("board");
    await window.keyboard.press("Enter");
    await expect(window.locator('.artifact-view-frame[src="geode-artifact://explorer-board/index.html"]')).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
