/**
 * Closing the last leaf of a stacked sidebar section must remove the section,
 * including when that leaf is a never-activated blank placeholder (no view, so
 * no icon/title — rendered as a tiny dot). TabGroup.removeLeaf used to call
 * groupEmptied only when the closed leaf was the active one.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

test("closing a blank leaf removes its empty sidebar section", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sb-empty-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sb-empty-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
    const result = await window.evaluate(async () => {
      const ws = (window as any).app.workspace;
      const sb = ws.rightSidebar;
      const before = sb.groups.length;
      const leaf = ws.getRightLeaf(true); // new stacked section holding a blank leaf
      const during = sb.groups.length;
      await leaf.detach();
      return { before, during, after: sb.groups.length };
    });
    expect(result.during).toBe(result.before + 1);
    expect(result.after).toBe(result.before);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("closing the last real leaf also drops a leftover blank leaf and its section", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sb-empty-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sb-empty-ud-"));
  fs.writeFileSync(path.join(vaultDir, "Note.md"), "# Note\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));
  const app = await electron.launch({ args: [repoRoot, "--user-data-dir=" + userDataDir], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
    const result = await window.evaluate(async () => {
      const ws = (window as any).app.workspace;
      const sb = ws.rightSidebar;
      const before = sb.groups.length;
      const blank = ws.getRightLeaf(true); // new section + blank leaf
      const group = blank.group;
      const real = sb.leaves.find((l: any) => l.view && l.group === sb);
      ws.moveLeaf(real, group); // what restoreSidebar does for built-in panes
      const leavesIn = group.leaves.length;
      await real.detach();
      return { before, leavesIn, after: sb.groups.length };
    });
    expect(result.leavesIn).toBe(2);
    expect(result.after).toBe(result.before);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
