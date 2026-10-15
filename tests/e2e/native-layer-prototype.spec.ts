import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page, type TestInfo } from "@playwright/test";
const repo = path.resolve(__dirname, "../..");
const original = "---\npriority: 2\n---\n\nOriginal source\n";
const secondOriginal = "---\npriority: 4\n---\n\nOther source\n";
const source = "Prototype introduction\n\n![[Board.canvas]]\n\n" + "Paragraph for actual CM viewport movement.\n\n".repeat(400);
async function withPrototype(info: TestInfo, run: (page: Page, vault: string, app: ElectronApplication) => Promise<void>, document = source, beforeMount?: (page: Page) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "geode-native-layer-prototype-")); const vault = path.join(directory, "vault"); const profile = path.join(directory, "profile");
  fs.mkdirSync(vault); fs.mkdirSync(profile); fs.writeFileSync(path.join(vault, "Source.md"), original); fs.writeFileSync(path.join(vault, "Other.md"), secondOriginal);
  fs.writeFileSync(path.join(vault, "Tasks.base"), "views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - note.priority\n");
  fs.writeFileSync(path.join(vault, "Host.md"), "![[Tasks.base]]\n"); fs.writeFileSync(path.join(vault, "Outer.md"), "Plain prototype owner\n");
  fs.writeFileSync(path.join(vault, "Board.canvas"), JSON.stringify({ nodes: [{ id: "native", type: "file", file: "Host.md", x: -50, y: -60, width: 650, height: 330 }], edges: [] }));
  fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repo, `--user-data-dir=${profile}`], cwd: repo }); const page = await app.firstWindow();
  try {
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
    await page.locator('.nav-file-title[data-path="Outer.md"]').click();
    await page.addScriptTag({ url: pathToFileURL(path.join(repo, "dist/native-layer-prototype.js")).href });
    if (beforeMount) await beforeMount(page);
    await page.evaluate(source => { (window as any).mountNativeLayerPrototype(source); }, document);
    await run(page, vault, app);
  } finally {
    const probe = await page.evaluate(() => { const p = (window as any).__layerProbe; return p ? { inputConnected: p.input.isConnected, value: p.input.value, rootConnected: p.root.isConnected, parentStable: p.root.parentElement === p.parent, focused: document.activeElement === p.input, blurCount: p.blur } : null; }).catch(error => String(error));
    const evidence = { probe, provider: fs.readFileSync(path.join(vault, "Source.md"), "utf8"), other: fs.readFileSync(path.join(vault, "Other.md"), "utf8"), state: await page.evaluate(() => (window as any).nativeLayerHarness?.snapshot()).catch(error => String(error)) };
    fs.writeFileSync(info.outputPath("final-state.json"), JSON.stringify(evidence, null, 2));
    await page.screenshot({ path: info.outputPath("prototype.png") }).catch(() => {});
    await app.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}
const record = (page: Page, id = 1) => page.locator(`.native-prototype-record[data-occurrence="${id}"]`);
async function edit(page: Page, id = 1, file = "Source", value = "9"): Promise<Locator> {
  const cell = record(page, id).locator(".bases-data-row", { hasText: `${file}.md` }).locator("td.bases-cell").nth(1);
  await expect(cell).toBeVisible(); await cell.click(); await page.keyboard.press("Enter");
  const input = cell.locator(".bases-cell-input"); await expect(input).toBeVisible(); await input.fill(value);
  return input;
}
async function capture(page: Page, input: Locator) {
  await input.evaluate(input => {
    const root = input.closest(".native-prototype-record")!;
    const probe = { input, root, parent: root.parentElement, blur: 0 };
    input.addEventListener("blur", () => { probe.blur++; }); (window as any).__layerProbe = probe;
  });
}
async function unchanged(page: Page, vault: string, value = "9") {
  expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original);
  expect(await page.evaluate(() => {
    const probe = (window as any).__layerProbe;
    return { connected: probe.input.isConnected, rootConnected: probe.root.isConnected, sameParent: probe.root.parentElement === probe.parent, focused: document.activeElement === probe.input, value: probe.input.value, blur: probe.blur };
  })).toEqual({ connected: true, rootConnected: true, sameParent: true, focused: true, value, blur: 0 });
}
async function scrollAway(page: Page) {
  await page.evaluate(() => { const editor = (window as any).nativeLayerHarness.editor; editor.scrollDOM.scrollTop = editor.scrollDOM.scrollHeight; });
  await expect.poll(() => page.evaluate(() => (window as any).nativeLayerHarness.editor.scrollDOM.scrollTop)).toBeGreaterThan(500);
  await expect.poll(() => page.evaluate(() => (window as any).nativeLayerHarness.layer.snapshot().records[0]?.state)).toBe("retained");
}
test("actual nested draft survives CM virtualization with the same connected root and original bytes", async ({}, info) => {
  await withPrototype(info, async (page, vault) => {
    const input = await edit(page); await capture(page, input); await scrollAway(page); await unchanged(page, vault);
    expect(await page.evaluate(() => (window as any).nativeLayerHarness.snapshot().connectedBeforeMount)).toBe(true);
    await page.screenshot({ path: info.outputPath("retained-before-save.png") });
    await page.evaluate(() => (window as any).nativeLayerHarness.layer.returnToOccurrence(1));
    await expect.poll(() => page.evaluate(() => (window as any).nativeLayerHarness.layer.snapshot().records[0]?.state)).toBe("inline");
    await unchanged(page, vault); await input.press("Enter");
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original.replace("priority: 2", "priority: 9"));
    await expect(record(page).locator(".bases-data-row", { hasText: "Source.md" }).locator("td.bases-cell").nth(1)).toHaveText("9");
  });
});
test("actual resize and Electron zoom keep source, undo and focused native identity stable", async ({}, info) => {
  await withPrototype(info, async (page, vault, app) => {
    const input = await edit(page); await capture(page, input);
    const before = await page.evaluate(() => (window as any).nativeLayerHarness.editor.state.doc.toString());
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1000, 740); window.webContents.setZoomFactor(1.1); });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(1000); await unchanged(page, vault);
    expect(await page.evaluate(() => (window as any).nativeLayerHarness.editor.state.doc.toString())).toBe(before);
    expect(await page.evaluate(() => (window as any).nativeLayerHarness.undo())).toBe(false);
    expect(await page.evaluate(() => (window as any).nativeLayerHarness.layer.measurements)).toBeLessThan(100);
  });
});
test("real source removal retains the original native draft without Return until actual Cancel", async ({}, info) => {
  await withPrototype(info, async (page, vault) => {
    const input = await edit(page); await capture(page, input); await page.evaluate(() => (window as any).nativeLayerHarness.remove(1));
    await expect(record(page).getByRole("button", { name: "Return to embed" })).toBeHidden(); await expect(record(page)).toContainText("source removed");
    await unchanged(page, vault); await input.press("Escape");
    await expect.poll(() => page.evaluate(() => (window as any).__layerProbe.root.isConnected)).toBe(false);
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original);
    expect(await page.evaluate(() => (window as any).nativeLayerHarness.snapshot().closes)).toBe(1);
  });
});
test("actual failed Base write keeps original Retry reachable after scrolling and acknowledges only its save", async ({}, info) => {
  await withPrototype(info, async (page, vault) => {
    const input = await edit(page); await capture(page, input);
    await page.evaluate(() => { const app = (window as any).app; (window as any).__originalLayerModify = app.vault.modify.bind(app.vault); app.vault.modify = (file: any, text: string) => file.path === "Source.md" ? Promise.reject(new Error("synthetic row failure")) : (window as any).__originalLayerModify(file, text); });
    await input.press("Enter"); await expect(record(page).getByRole("button", { name: "Retry Base save" })).toBeVisible();
    await expect(input).toBeFocused(); await capture(page, input);
    await scrollAway(page); await unchanged(page, vault);
    await page.evaluate(() => { (window as any).app.vault.modify = (window as any).__originalLayerModify; });
    await record(page).getByRole("button", { name: "Retry Base save" }).click();
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original.replace("priority: 2", "priority: 9"));
    await expect.poll(() => page.evaluate(() => (window as any).nativeLayerHarness.scope.hasUnacknowledgedWrites)).toBe(false);
  });
});
test("two identical occurrences allocate independent native chains and keep the first unfinished root", async ({}, info) => {
  const doc = source.slice(0, 2000) + "\n![[Board.canvas]]\n\n" + "Tail paragraph.\n\n".repeat(400);
  await withPrototype(info, async (page, vault) => {
    const input = await edit(page); await capture(page, input);
    await page.evaluate(() => { const h = (window as any).nativeLayerHarness; h.editor.scrollDOM.scrollTop = h.editor.lineBlockAt(h.editor.state.doc.toString().indexOf("![[Board.canvas]]", 100)).top; });
    await expect(record(page, 2).locator(".bases-table")).toBeVisible(); await unchanged(page, vault);
    expect(await page.evaluate(() => { const h = (window as any).nativeLayerHarness; return { independent: h.native[0] !== h.native[1] && h.native[0].renderOwner !== h.native[1].renderOwner, canvases: h.scope.writers().filter((w: any) => w.viewType === "canvas").length, bases: h.scope.writers().filter((w: any) => w.viewType === "base").length }; })).toEqual({ independent: true, canvases: 2, bases: 2 });
  }, doc);
});
test("a removed pending actual Canvas mount settles before close and never publishes late content", async ({}, info) => {
  await withPrototype(info, async (page, vault) => {
    await page.waitForFunction(() => (window as any).__layerReadEntered === true);
    expect(await page.evaluate(() => (window as any).nativeLayerHarness.snapshot().connectedBeforeMount)).toBe(true);
    await page.evaluate(() => (window as any).nativeLayerHarness.remove(1));
    await page.evaluate(() => (window as any).__releaseLayerRead());
    await expect.poll(() => page.evaluate(() => (window as any).nativeLayerHarness.layer.snapshot().records.length)).toBe(0);
    expect(await page.evaluate(() => { const h = (window as any).nativeLayerHarness; return { closes: h.snapshot().closes, file: h.native[0].file, connected: h.native[0].containerEl.isConnected }; })).toEqual({ closes: 1, file: null, connected: false });
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original);
  }, source, async page => {
    await page.evaluate(() => { const app = (window as any).app; const read = app.vault.read.bind(app.vault); app.vault.read = async (file: any) => { if (file.path === "Board.canvas") { (window as any).__layerReadEntered = true; await new Promise<void>(resolve => { (window as any).__releaseLayerRead = resolve; }); } return read(file); }; });
  });
});
