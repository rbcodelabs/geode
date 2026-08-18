import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("restores one live File Explorer in the center group after relaunch", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-builtin-layout-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-builtin-layout-ud-"));
  fs.writeFileSync(path.join(vaultDir, "A.md"), "# A\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  const launch = () => electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });

  try {
    let app = await launch();
    let win = await app.firstWindow();
    await expect(win.locator('[data-type="file-explorer"]').first()).toBeVisible();
    await win.evaluate(() => {
      const workspace = (window as any).app.workspace;
      const leaf = workspace.getLeavesOfType("file-explorer")[0];
      workspace.moveLeaf(leaf, workspace.activeGroup);
    });
    await expect(win.locator('.workspace-center .workspace-leaf-content[data-type="file-explorer"]')).toBeVisible();
    await expect.poll(() => {
      const file = path.join(vaultDir, ".geode", "workspace.json");
      return fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).version === 2;
    }).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await app.close();

    app = await launch();
    win = await app.firstWindow();
    await expect(win.locator('.workspace-center .workspace-leaf-content[data-type="file-explorer"]')).toBeVisible();
    expect(await win.locator('.workspace-leaf-content[data-type="file-explorer"]').count()).toBe(1);
    expect(await win.locator('.workspace-sidebar .workspace-leaf-content[data-type="file-explorer"]').count()).toBe(0);
    await app.close();
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
