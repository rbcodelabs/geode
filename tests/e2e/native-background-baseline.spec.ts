import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page, type TestInfo } from "@playwright/test";

// Production A830427 only: no private native-layer bundle, B routing, source
// patch, handler replacement, synthetic DOM hide, or focus:false blur waiver.
const repo = path.resolve(__dirname, "../..");
const original = "---\npriority: 2\n---\n\nOriginal source\n";
const otherOriginal = "Other tab content\n";
type Mode = "Reading" | "Live Preview";

async function record(page: Page, vault: string, info: TestInfo, phase: string) {
  const state = await page.evaluate(() => {
    const p = (window as any).__backgroundProbe;
    const native = p.owner.view.renderOwner.writers().find((writer: any) => writer.containerEl === p.root);
    return {
      sameOwner: p.owner.view === p.view, sameRoot: p.root === p.input.closest(".canvas-embed-view"), rootConnected: p.root.isConnected,
      sameParent: p.root.parentElement === p.parent, inputConnected: p.input.isConnected, sameInput: p.cell.querySelector("input") === p.input,
      inputValue: p.input.value, focused: document.activeElement === p.input, ownerHidden: p.owner.leafEl.getBoundingClientRect().height === 0,
      camera: native && { pan: { ...native.pan }, scale: native.scale }, initialCamera: p.camera,
      writes: p.writes, events: p.events, activeFile: (window as any).app.workspace.getActiveLeaf().view.getFile?.()?.path,
      ownerFile: p.view.file?.path, sourceText: p.view.getText(), initialSource: p.source,
      writers: p.owner.view.renderOwner.writers().map((writer: any) => ({ type: writer.viewType, path: writer.file?.path, connected: writer.containerEl?.isConnected })),
    };
  });
  const value = { phase, state, provider: fs.readFileSync(path.join(vault, "Source.md"), "utf8"), otherProvider: fs.readFileSync(path.join(vault, "Other.md"), "utf8") };
  fs.writeFileSync(info.outputPath(`${phase}.json`), JSON.stringify(value, null, 2));
  return value;
}
async function fixture(mode: Mode, info: TestInfo, run: (page: Page, vault: string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "geode-native-background-baseline-"));
  const vault = path.join(directory, "vault"), profile = path.join(directory, "profile"); fs.mkdirSync(vault); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(vault, "Source.md"), original); fs.writeFileSync(path.join(vault, "Other.md"), otherOriginal);
  fs.writeFileSync(path.join(vault, "Tasks.base"), "views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - note.priority\n");
  fs.writeFileSync(path.join(vault, "Host.md"), "![[Tasks.base]]\n");
  fs.writeFileSync(path.join(vault, "Outer.md"), "# Outer\n\n![[Board.canvas]]\n\nEnd\n");
  fs.writeFileSync(path.join(vault, "Board.canvas"), JSON.stringify({ nodes: [{ id: "nested", type: "file", file: "Host.md", x: 0, y: 0, width: 760, height: 600 }], edges: [] }));
  fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repo, `--user-data-dir=${profile}`], cwd: repo }); const page = await app.firstWindow();
  try {
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
    await page.locator('.nav-file-title[data-path="Outer.md"]').click();
    if (mode === "Reading") await page.getByRole("button", { name: "Toggle reading view (Cmd/Ctrl+E)" }).click();
    await page.evaluate(async () => {
      const app = (window as any).app, owner = app.workspace.getActiveLeaf();
      await app.openFile(app.vault.getFileByPath("Other.md"), true);
      (window as any).__backgroundTabs = { owner, other: app.workspace.getActiveLeaf() };
      app.workspace.setActiveLeaf(owner, { focus: false });
    });
    const table = page.locator(".canvas-embed-view:visible .bases-table"); await expect(table).toBeVisible();
    const column = (await table.locator("thead th").allTextContents()).indexOf("note.priority"); expect(column).toBeGreaterThan(-1);
    const cell = table.locator(".bases-data-row", { hasText: "Source" }).locator("td.bases-cell").nth(column);
    await expect(cell).toHaveText("2"); await cell.click(); await page.keyboard.press("Enter");
    const input = cell.locator(".bases-cell-input"); await expect(input).toBeVisible(); await input.fill("9");
    await input.evaluate(input => {
      const app = (window as any).app, owner = (window as any).__backgroundTabs.owner;
      const root = input.closest(".canvas-embed-view")!;
      const native = owner.view.renderOwner.writers().find((writer: any) => writer.containerEl === root);
      const p = (window as any).__backgroundProbe = { owner, view: owner.view, root, parent: root.parentElement, input, cell: input.parentElement,
        source: owner.view.getText(), camera: { pan: { ...native.pan }, scale: native.scale }, writes: [] as unknown[], events: [] as unknown[] };
      const modify = app.vault.modify;
      app.vault.modify = (...args: any[]) => { p.writes.push({ path: args[0].path, text: args[1] }); return Reflect.apply(modify, app.vault, args); };
      for (const event of ["blur", "focusout", "focusin", "keydown", "pointerdown"]) document.addEventListener(event, e => {
        if (p.events.length < 100) p.events.push({ type: event, trusted: e.isTrusted, key: (e as KeyboardEvent).key,
          target: (e.target as HTMLElement)?.className, activeInput: document.activeElement === input, inputConnected: input.isConnected, value: (input as HTMLInputElement).value });
      }, true);
    });
    const entry = await record(page, vault, info, "entry"); expect(entry.provider).toBe(original); expect(entry.state.focused).toBe(true); expect(entry.state.inputValue).toBe("9");
    await page.screenshot({ path: info.outputPath("entry.png") });
    await run(page, vault);
  } finally {
    await record(page, vault, info, "final").catch(() => {}); await page.screenshot({ path: info.outputPath("final.png") }).catch(() => {});
    await app.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}
async function returned(page: Page) {
  await page.evaluate(() => { const app = (window as any).app; app.workspace.setActiveLeaf((window as any).__backgroundTabs.owner, { focus: false }); });
  await expect(page.locator(".canvas-embed-view:visible")).toBeVisible();
}
for (const mode of ["Reading", "Live Preview"] as const) {
  test(`${mode} programmatic background hide preserves the original nested draft without an application save`, async ({}, info) => {
    await fixture(mode, info, async (page, vault) => {
      await page.evaluate(() => { const app = (window as any).app; app.workspace.setActiveLeaf((window as any).__backgroundTabs.other, { focus: false }); });
      await expect.poll(() => page.evaluate(() => (window as any).__backgroundTabs.owner.leafEl.getBoundingClientRect().height)).toBe(0);
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const hidden = await record(page, vault, info, "hidden"); await page.screenshot({ path: info.outputPath("hidden.png") });
      await returned(page); const back = await record(page, vault, info, "returned");
      // Browser blur is recorded separately and is allowed. Application writes,
      // input/root/parent loss and changed draft/provider are NOT waived.
      for (const witness of [hidden, back]) {
        expect(witness.provider).toBe(original); expect(witness.otherProvider).toBe(otherOriginal); expect(witness.state.writes).toEqual([]);
        expect(witness.state).toMatchObject({ sameOwner: true, sameRoot: true, rootConnected: true, sameParent: true, inputConnected: true, sameInput: true, inputValue: "9" });
        expect(witness.state.camera).toEqual(witness.state.initialCamera); expect(witness.state.sourceText).toBe(witness.state.initialSource);
      }
    });
  });
  test(`${mode} trusted pointer tab transfer retains ordinary nested blur-save behavior`, async ({}, info) => {
    await fixture(mode, info, async (page, vault) => {
      await page.locator('.workspace-tab-header[aria-label="Other"]').click();
      await page.locator(".workspace-leaf.mod-active .cm-content").click();
      await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original.replace("priority: 2", "priority: 9"));
      await returned(page); const back = await record(page, vault, info, "trusted-pointer-returned");
      expect(back.state.rootConnected).toBe(true); expect(back.state.sameParent).toBe(true); expect(back.state.camera).toEqual(back.state.initialCamera);
      expect(back.otherProvider).toBe(otherOriginal);
      expect(back.state.events.some((event: any) => event.type === "pointerdown" && event.trusted && String(event.target).includes("workspace-tab-header"))).toBe(true);
    });
  });
  test(`${mode} trusted keyboard departure retains ordinary nested blur-save behavior`, async ({}, info) => {
    await fixture(mode, info, async (page, vault) => {
      // Actual Tab deliberately leaves the input before any programmatic hide.
      // This is keyboard focus transfer, not a claim that Enter activates tabs.
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement === (window as any).__backgroundProbe.input)).toBe(false);
      await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original.replace("priority: 2", "priority: 9"));
      const back = await record(page, vault, info, "trusted-keyboard-departure");
      expect(back.state.rootConnected).toBe(true); expect(back.state.sameParent).toBe(true); expect(back.otherProvider).toBe(otherOriginal);
      expect(back.state.events.some((event: any) => event.type === "keydown" && event.trusted && event.key === "Tab")).toBe(true);
    });
  });
}
