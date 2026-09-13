import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { _electron as electron, expect, test } from "@playwright/test";
const root = path.resolve(__dirname, "../..");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("one sync owner protects dirty editors across same-vault windows", async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sync-guard-vault-")); const profile = fs.mkdtempSync(path.join(os.tmpdir(), "geode-sync-guard-profile-"));
  fs.writeFileSync(path.join(vault, "Note.md"), "old"); fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [root, `--user-data-dir=${profile}`], cwd: root });
  try {
    const first = await app.firstWindow(); await first.waitForFunction(() => Boolean((window as any).app?.workspace));
    const windowReady = app.waitForEvent("window");
    await app.evaluate(({ BrowserWindow }, preload) => { const first = BrowserWindow.getAllWindows()[0]; const next = new BrowserWindow({ show: false, webPreferences: { preload, nodeIntegration: true, contextIsolation: false, sandbox: false } }); void next.loadURL(first.webContents.getURL()); }, path.join(root, "dist/preload.js"));
    const second = await windowReady; await second.waitForFunction(() => Boolean((window as any).app?.workspace));
    const token = await first.evaluate(() => (window as any).app.host.syncSafety.claimOwner()); expect(token).toBeTruthy();
    expect(await second.evaluate(() => (window as any).app.host.syncSafety.claimOwner())).toBeNull();
    await second.evaluate(async () => { const app = (window as any).app; await app.openFile(app.vault.getFileByPath("Note.md")); const view = app.workspace.activeLeaf.view; view.editor.dispatch({ changes: { from: 0, to: view.editor.state.doc.length, insert: "dirty" } }); });
    const apply = (expectedHash: string) => first.evaluate(({ token, expectedHash, operationId }) => (window as any).app.host.syncSafety.apply(token, { operationId, path: "Note.md", expectedHash, kind: "write", data: new TextEncoder().encode("remote").buffer }), { token, expectedHash, operationId: randomUUID() });
    await expect(apply(hash("old"))).rejects.toThrow(/dirty|unsaved/i);
    expect(fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe("old");
    await expect.poll(() => second.evaluate(() => document.body.inert)).toBe(false);
    await second.evaluate(() => (window as any).app.workspace.activeLeaf.view.flush());
    await apply(hash("dirty"));
    expect(fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe("remote");
    await expect.poll(() => second.evaluate(() => (window as any).app.workspace.activeLeaf.view.getText())).toBe("remote");
    await second.evaluate(() => {
      const workspace = (window as any).app.workspace;
      const hold = workspace.holdAutosave.bind(workspace);
      (window as any).originalHold = hold;
      workspace.holdAutosave = async (token: string) => { const result = await hold(token); (window as any).guardPrepared = true; await new Promise(resolve => { (window as any).releaseGuard = resolve; }); return result; };
    });
    const interrupted = apply(hash("remote"));
    const rejection = expect(interrupted).rejects.toThrow(/window|changed|closed/i);
    await second.waitForFunction(() => (window as any).guardPrepared);
    const thirdReady = app.waitForEvent("window");
    await app.evaluate(({ BrowserWindow }, preload) => { const first = BrowserWindow.getAllWindows()[0]; const next = new BrowserWindow({ show: false, webPreferences: { preload, nodeIntegration: true, contextIsolation: false, sandbox: false } }); void next.loadURL(first.webContents.getURL()); }, path.join(root, "dist/preload.js"));
    const third = await thirdReady; await third.waitForFunction(() => Boolean((window as any).app?.workspace));
    await second.evaluate(() => (window as any).releaseGuard()); await rejection;
    expect(fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe("remote");
    await second.evaluate(() => {
      const app = (window as any).app; app.workspace.holdAutosave = (window as any).originalHold;
      (window as any).originalReconcile = app.reconcileVault.bind(app); app.reconcileVault = async () => {};
    });
    await expect(apply(hash("remote"))).rejects.toThrow(/refresh incomplete/i);
    expect(await second.evaluate(() => document.body.inert)).toBe(false);
    expect(await second.evaluate(() => (window as any).app.workspace.activeLeaf.view.containerEl.inert)).toBe(true);
    await second.evaluate(async () => { const app = (window as any).app; app.reconcileVault = (window as any).originalReconcile; await app.reconcileVault("manual"); });
    expect(await second.evaluate(() => (window as any).app.workspace.activeLeaf.view.containerEl.inert)).toBe(false);
  } finally { await app.close(); fs.rmSync(vault, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); }
});
