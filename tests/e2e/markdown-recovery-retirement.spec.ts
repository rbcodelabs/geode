import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page, type TestInfo } from "@playwright/test";
const repoRoot = path.resolve(__dirname, "../..");
const provider = "Provider version\n";
const local = "Unsaved local recovery\n";
async function isolated(info: TestInfo, run: (page: Page, vault: string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "geode-markdown-recovery-close-")); const vault = path.join(directory, "vault"); const profile = path.join(directory, "profile");
  fs.mkdirSync(vault); fs.mkdirSync(profile); fs.writeFileSync(path.join(vault, "Note.md"), provider);
  fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${profile}`], cwd: repoRoot }); const page = await app.firstWindow();
  try {
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
    await page.locator('.nav-file-title[data-path="Note.md"]').click();
    await run(page, vault);
  } finally {
    fs.writeFileSync(info.outputPath("final-provider.txt"), fs.readFileSync(path.join(vault, "Note.md"), "utf8"));
    await page.screenshot({ path: info.outputPath("recovery-state.png") }).catch(() => {});
    await app.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}
async function preserve(page: Page): Promise<string> {
  return page.evaluate(async ({ local, provider }) => {
    const app = (window as any).app; const leaf = app.workspace.getActiveLeaf(); const view = leaf.view;
    (window as any).__recoveryLeaf = leaf; (window as any).__recoveryView = view;
    view.editor.dispatch({ changes: { from: 0, to: view.editor.state.doc.length, insert: local } });
    await app.preserveConflict(view, view.file, provider, view.file.path);
    return view.recoveryReceipt.destination.path;
  }, { local, provider });
}
async function close(page: Page): Promise<string | null> {
  return page.evaluate(async () => { try { await (window as any).__recoveryLeaf.detach(); return null; } catch (error) { return String(error); } });
}
async function retained(page: Page, text = local) {
  expect(await page.evaluate(() => { const view = (window as any).__recoveryView; return { text: view.getText(), connected: view.editor?.dom.isConnected, readOnly: view.isConflictReadOnly() }; })).toEqual({ text, connected: true, readOnly: true });
}
test("an actual exact conflict copy permits ordinary close without changing provider bytes", async ({}, info) => {
  await isolated(info, async (page, vault) => {
    const copy = await preserve(page); expect(fs.readFileSync(path.join(vault, copy), "utf8")).toBe(local);
    expect(fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe(provider);
    expect(await close(page)).toBeNull(); expect(fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe(provider);
    expect(await page.evaluate(() => (window as any).__recoveryView.editor)).toBeNull();
  });
});
test("a changed recovery copy refuses close and a repaired copy permits a later close", async ({}, info) => {
  await isolated(info, async (page, vault) => {
    const copy = await preserve(page); fs.writeFileSync(path.join(vault, copy), "Altered copy\n");
    expect(await close(page)).toMatch(/recovery copy/); await retained(page); expect(fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe(provider);
    fs.writeFileSync(path.join(vault, copy), local); expect(await close(page)).toBeNull(); expect(fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe(provider);
  });
});
test("local changes after a real receipt refuse close with connected recovery controls", async ({}, info) => {
  await isolated(info, async (page, vault) => {
    const copy = await preserve(page); const newer = "Newer unpreserved local\n";
    await page.evaluate(newer => { const view = (window as any).__recoveryView; view.editor.dispatch({ changes: { from: 0, to: view.editor.state.doc.length, insert: newer } }); }, newer);
    expect(await close(page)).toMatch(/recovery/); await retained(page, newer);
    expect(fs.readFileSync(path.join(vault, copy), "utf8")).toBe(local); expect(fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe(provider);
  });
});

test("actual clean reconcile refreshes a paused note and resumes autosave", async ({}, info) => {
  await isolated(info, async (page, vault) => {
    await page.evaluate(async () => {
      const app = (window as any).app; await app.reconcileVault("manual");
      // Force the explicit reconciliation path instead of the fast watcher.
      app.handleExternalModify = async () => {};
      const view = app.workspace.getActiveLeaf().view; const accept = view.acceptExternalText.bind(view);
      (window as any).__heldReplacements = [];
      view.acceptExternalText = async (text: string) => { (window as any).__heldReplacements.push(view.autosavePaused); return accept(text); };
    });
    const remote = "Clean external replacement\n"; fs.writeFileSync(path.join(vault, "Note.md"), remote);
    await page.evaluate(async () => { await (window as any).app.reconcileVault("manual"); });
    expect(await page.evaluate(() => { const view = (window as any).app.workspace.getActiveLeaf().view; return { text: view.getText(), held: (window as any).__heldReplacements, autosavePaused: view.autosavePaused, vaultSwitching: view.vaultSwitching }; })).toEqual({ text: remote, held: [true], autosavePaused: false, vaultSwitching: false });
    expect(fs.readFileSync(path.join(vault, "Note.md"), "utf8")).toBe(remote);
  });
});
