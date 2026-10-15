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
    const retainedInputs = await page.evaluate(() => [(window as any).__firstFailedLayerInput, (window as any).__layerProbe?.input].filter(Boolean).map(input => ({ connected: input.isConnected, value: input.value, focused: document.activeElement === input, occurrence: input.closest(".native-prototype-record")?.dataset.occurrence }))).catch(error => String(error));
    const geometry = await page.evaluate(() => ({
      heightMeasurements: (window as any).__heightMeasurements,
      mixedHeightGeometry: (window as any).__mixedHeightGeometry,
      validationCalls: (window as any).__layerValidationCalls,
      retirementAttempts: (window as any).__layerRetirementAttempts,
      resumes: (window as any).__layerResumeCounts,
      childMutations: (window as any).__layerChildMutations,
      cameras: (window as any).nativeLayerHarness?.native.map((view: any) => ({ pan: view.pan, scale: view.scale })),
      records: [...document.querySelectorAll<HTMLElement>(".native-prototype-record")].map(root => ({
        id: root.dataset.occurrence, rect: root.getBoundingClientRect().toJSON(), clip: getComputedStyle(root).clipPath, zIndex: getComputedStyle(root).zIndex,
        buttons: [...root.querySelectorAll("button")].filter(button => /Retry Base save|Return to embed/.test(button.textContent ?? "")).map(button => {
          const rect = button.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return { text: button.textContent, rect: rect.toJSON(), hit: hit ? { tag: hit.tagName, className: hit.className, occurrence: hit.closest<HTMLElement>(".native-prototype-record")?.dataset.occurrence } : null };
        }),
      })),
    })).catch(error => String(error));
    const evidence = { probe, retainedInputs, geometry, provider: fs.readFileSync(path.join(vault, "Source.md"), "utf8"), other: fs.readFileSync(path.join(vault, "Other.md"), "utf8"), state: await page.evaluate(() => (window as any).nativeLayerHarness?.snapshot()).catch(error => String(error)) };
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

test("trusted Return pointer activation preserves the unfinished native draft and source bytes", async ({}, info) => {
  await withPrototype(info, async (page, vault) => {
    const input = await edit(page); await capture(page, input); await scrollAway(page); await unchanged(page, vault);
    await record(page).getByRole("button", { name: "Return to embed" }).click();
    await expect.poll(() => page.evaluate(() => (window as any).nativeLayerHarness.layer.snapshot().records[0]?.state)).toBe("inline");
    await unchanged(page, vault);
  });
});

test("a retained native Return remains pointer reachable when a later occurrence is inline", async ({}, info) => {
  const doc = source.slice(0, 2000) + "\n![[Board.canvas]]\n\n" + "Tail paragraph.\n\n".repeat(400);
  await withPrototype(info, async (page, vault) => {
    const input = await edit(page); await capture(page, input);
    await page.evaluate(() => { const h = (window as any).nativeLayerHarness; h.editor.scrollDOM.scrollTop = h.editor.lineBlockAt(h.editor.state.doc.toString().indexOf("![[Board.canvas]]", 100)).top; });
    await expect(record(page, 2).locator(".bases-table")).toBeVisible(); await unchanged(page, vault);
    const button = record(page).getByRole("button", { name: "Return to embed" }); await expect(button).toBeVisible();
    expect(await button.evaluate(button => {
      const rect = button.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === button || button.contains(hit);
    })).toBe(true);
    await button.click();
    await expect.poll(() => page.evaluate(() => (window as any).nativeLayerHarness.layer.snapshot().records.find((item: any) => item.id === 1)?.state)).toBe("inline");
    await unchanged(page, vault);
  }, doc);
});

test("keyboard Return activation remains available after deliberate focus transfer", async ({}, info) => {
  await withPrototype(info, async (page, vault) => {
    const input = await edit(page); await capture(page, input);
    await page.evaluate(() => { const app = (window as any).app; const modify = app.vault.modify.bind(app.vault); app.vault.modify = (file: any, text: string) => file.path === "Source.md" ? Promise.reject(new Error("synthetic keyboard recovery failure")) : modify(file, text); });
    await input.press("Enter"); await expect(record(page).getByRole("button", { name: "Retry Base save" })).toBeVisible();
    await scrollAway(page);
    const button = record(page).getByRole("button", { name: "Return to embed" });
    // Explicit focus transfer is allowed to blur the editor. It is not the
    // scroll/Return pointer invariant; the injected write failure retains it.
    await button.focus(); await expect(button).toBeFocused(); await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => (window as any).nativeLayerHarness.layer.snapshot().records[0]?.state)).toBe("inline");
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original);
    expect(await page.evaluate(() => { const p = (window as any).__layerProbe; return { connected: p.input.isConnected, value: p.input.value }; })).toEqual({ connected: true, value: "9" });
    await expect(record(page).getByRole("button", { name: "Retry Base save" })).toBeVisible();
  });
});

test("actual owner close refuses an unfinished native draft then closes once after Cancel", async ({}, info) => {
  await withPrototype(info, async (page, vault) => {
    const input = await edit(page); await capture(page, input); await scrollAway(page);
    const refusal = await page.evaluate(async () => { try { await (window as any).nativeLayerHarness.close(); return null; } catch (error) { return String(error); } });
    expect(refusal).toMatch(/draft|edit|finish/i); await unchanged(page, vault);
    await input.press("Escape");
    await page.evaluate(async () => { await (window as any).nativeLayerHarness.close(); });
    expect(await page.evaluate(() => { const h = (window as any).nativeLayerHarness; return { connected: h.host.isConnected, closes: h.snapshot().closes }; })).toEqual({ connected: false, closes: 1 });
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original);
  });
});

test("dark narrow desktop geometry retains the original draft and exposes Return", async ({}, info) => {
  await withPrototype(info, async (page, vault, app) => {
    const input = await edit(page); await capture(page, input);
    await page.evaluate(() => (window as any).app.setTheme("obsidian"));
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(760, 740); });
    await expect(page.locator("body")).toHaveClass(/theme-dark/); await scrollAway(page); await unchanged(page, vault);
    const button = record(page).getByRole("button", { name: "Return to embed" }); await expect(button).toBeVisible();
    expect(await button.evaluate(button => { const rect = button.getBoundingClientRect(); return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === button; })).toBe(true);
    await page.screenshot({ path: info.outputPath("dark-narrow-retained.png") });
  });
});

test("clean actual viewport churn retires old native chains before reacquiring the source", async ({}, info) => {
  await withPrototype(info, async (page, vault) => {
    await expect(record(page).locator(".bases-table")).toBeVisible();
    await page.evaluate(() => { const h = (window as any).nativeLayerHarness; (window as any).__firstLayerRoot = h.layer.layer.querySelector(".native-prototype-record"); h.editor.scrollDOM.scrollTop = h.editor.scrollDOM.scrollHeight; });
    await expect.poll(() => page.evaluate(() => (window as any).nativeLayerHarness.snapshot().closes)).toBe(1);
    expect(await page.evaluate(() => (window as any).__firstLayerRoot.isConnected)).toBe(false);
    await page.evaluate(() => { (window as any).nativeLayerHarness.editor.scrollDOM.scrollTop = 0; });
    await expect(record(page).locator(".bases-table")).toBeVisible();
    expect(await page.evaluate(() => { const h = (window as any).nativeLayerHarness; return { allocations: h.layer.allocations, canvases: h.scope.writers().filter((writer: any) => writer.viewType === "canvas").length, bases: h.scope.writers().filter((writer: any) => writer.viewType === "base").length }; })).toEqual({ allocations: 2, canvases: 1, bases: 1 });
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original);
  });
});

test("two failed retained native chains recover their original files through real rail and Retry controls", async ({}, info) => {
  const doc = source.slice(0, 2000) + "\n![[Board.canvas]]\n\n" + "Tail paragraph.\n\n".repeat(400);
  await withPrototype(info, async (page, vault) => {
    await page.evaluate(() => {
      const app = (window as any).app; const modify = app.vault.modify.bind(app.vault);
      (window as any).__failedLayerFiles = new Set(["Source.md", "Other.md"]);
      app.vault.modify = (file: any, text: string) => (window as any).__failedLayerFiles.has(file.path) ? Promise.reject(new Error(`synthetic ${file.path} failure`)) : modify(file, text);
    });
    const first = await edit(page); await first.evaluate(input => { (window as any).__firstFailedLayerInput = input; });
    await first.press("Enter"); await expect(record(page, 1).getByRole("button", { name: "Retry Base save" })).toBeVisible();
    await page.evaluate(() => { const h = (window as any).nativeLayerHarness; h.editor.scrollDOM.scrollTop = h.editor.lineBlockAt(h.editor.state.doc.toString().indexOf("![[Board.canvas]]", 100)).top; });
    const second = await edit(page, 2, "Other", "8"); await capture(page, second);
    await second.press("Enter"); await expect(record(page, 2).getByRole("button", { name: "Retry Base save" })).toBeVisible();
    await scrollAway(page);
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original);
    expect(fs.readFileSync(path.join(vault, "Other.md"), "utf8")).toBe(secondOriginal);
    expect(await page.evaluate(() => { const first = (window as any).__firstFailedLayerInput; const second = (window as any).__layerProbe.input; return { independent: first !== second, firstConnected: first.isConnected, firstValue: first.value, secondConnected: second.isConnected, secondValue: second.value }; })).toEqual({ independent: true, firstConnected: true, firstValue: "9", secondConnected: true, secondValue: "8" });
    const rail = page.getByLabel("Scroll retained embedded edits");
    // Deliberate rail focus may blur the failed editor. Scroll is still performed
    // by trusted keyboard/wheel input; no private offset or editor entry is used.
    await rail.focus(); await page.keyboard.press("Home");
    await expect.poll(() => rail.evaluate(element => element.scrollTop)).toBe(0);
    const firstReturn = record(page, 1).getByRole("button", { name: "Return to embed" });
    expect(await firstReturn.evaluate(button => { const rect = button.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return hit === button || button.contains(hit); })).toBe(true);
    await firstReturn.click();
    await expect.poll(() => page.evaluate(() => (window as any).nativeLayerHarness.layer.snapshot().records.find((item: any) => item.id === 1)?.state)).toBe("inline");
    await page.evaluate(() => { (window as any).__failedLayerFiles.delete("Source.md"); });
    await record(page, 1).getByRole("button", { name: "Retry Base save" }).click();
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original.replace("priority: 2", "priority: 9"));
    expect(fs.readFileSync(path.join(vault, "Other.md"), "utf8")).toBe(secondOriginal);
    expect(await page.evaluate(() => ({ pending: (window as any).nativeLayerHarness.scope.hasUnacknowledgedWrites, connected: (window as any).__layerProbe.input.isConnected, value: (window as any).__layerProbe.input.value }))).toEqual({ pending: true, connected: true, value: "8" });
    await rail.focus(); await rail.hover(); await page.mouse.wheel(0, -1000);
    await expect.poll(() => rail.evaluate(element => element.scrollTop)).toBe(0);
    const secondRetry = record(page, 2).getByRole("button", { name: "Retry Base save" });
    expect(await secondRetry.evaluate(button => { const rect = button.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return hit === button || button.contains(hit); })).toBe(true);
    await page.screenshot({ path: info.outputPath("independent-failed-recovery.png") });
    await page.evaluate(() => { (window as any).__failedLayerFiles.delete("Other.md"); });
    await secondRetry.click();
    await expect.poll(() => fs.readFileSync(path.join(vault, "Other.md"), "utf8")).toBe(secondOriginal.replace("priority: 4", "priority: 8"));
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original.replace("priority: 2", "priority: 9"));
    await expect.poll(() => page.evaluate(() => (window as any).nativeLayerHarness.scope.hasUnacknowledgedWrites)).toBe(false);
  }, doc);
});

test("actual native partial destruction stays inert and visible without Return or implicit retry", async ({}, info) => {
  await withPrototype(info, async (page, vault) => {
    await expect(record(page).locator(".bases-table")).toBeVisible();
    await page.evaluate(() => {
      const h = (window as any).nativeLayerHarness; const options = h.native[0].renderOwner.options; const close = options.close;
      options.close = async () => { await close(); (window as any).__actualLayerDestructorFinished = true; throw new Error("synthetic failure after actual native destructor"); };
      h.remove(1);
    });
    await expect(page.getByRole("alert")).toContainText("teardown failed");
    await expect(record(page).getByRole("button", { name: "Return to embed" })).toBeHidden();
    expect(await record(page).evaluate(root => root.inert)).toBe(true);
    expect(await page.evaluate(() => ({ finished: (window as any).__actualLayerDestructorFinished, closes: (window as any).nativeLayerHarness.snapshot().closes }))).toEqual({ finished: true, closes: 1 });
    await page.evaluate(() => { const h = (window as any).nativeLayerHarness; h.editor.scrollDOM.scrollTop = h.editor.scrollDOM.scrollHeight; });
    await page.waitForFunction(() => (window as any).nativeLayerHarness.editor.scrollDOM.scrollTop > 500);
    expect(await page.evaluate(() => ({ allocations: (window as any).nativeLayerHarness.layer.allocations, closes: (window as any).nativeLayerHarness.snapshot().closes }))).toEqual({ allocations: 1, closes: 1 });
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original);
  });
});

test("read-only native close validation refusal preserves real controls until explicit Cancel after recovery", async ({}, info) => {
  await withPrototype(info, async (page, vault) => {
    await expect(record(page).locator(".bases-table")).toBeVisible();
    await page.evaluate(() => {
      const h = (window as any).nativeLayerHarness;
      (window as any).__layerResumeCounts = {};
      for (const writer of h.scope.writers()) {
        const options = writer.renderOwner.options; const resume = options.resume;
        options.resume = () => { const counts = (window as any).__layerResumeCounts; counts[writer.viewType] = (counts[writer.viewType] ?? 0) + 1; return resume?.(); };
      }
      const lifetime = h.layer.records.get(1).lifetime; const retire = lifetime.retire.bind(lifetime);
      lifetime.retire = () => { (window as any).__layerRetirementAttempts = ((window as any).__layerRetirementAttempts ?? 0) + 1; return retire(); };
      new MutationObserver(records => { (window as any).__layerChildMutations = ((window as any).__layerChildMutations ?? 0) + records.length; }).observe(h.layer.layer.querySelector(".native-prototype-content"), { subtree: true, childList: true });
      h.native[0].renderOwner.options.validateClose = async () => { (window as any).__layerValidationCalls = ((window as any).__layerValidationCalls ?? 0) + 1; if (!(window as any).__layerValidationRecovered) throw new Error("synthetic read-only validation failure"); };
      h.remove(1);
    });
    await page.waitForFunction(() => (window as any).__layerValidationCalls > 0);
    await expect(record(page)).toContainText("source removed");
    expect(await record(page).evaluate(root => root.inert)).toBe(false);
    expect(await page.evaluate(() => (window as any).nativeLayerHarness.snapshot().closes)).toBe(0);
    const input = await edit(page); await capture(page, input); await unchanged(page, vault);
    await page.evaluate(() => { (window as any).__layerValidationRecovered = true; });
    await input.press("Escape");
    await expect.poll(() => page.evaluate(() => (window as any).__layerProbe.root.isConnected)).toBe(false);
    expect(await page.evaluate(() => (window as any).nativeLayerHarness.snapshot().closes)).toBe(1);
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original);
  });
});

test("normal outside CM typing and undo preserve source semantics after deliberate native blur", async ({}, info) => {
  await withPrototype(info, async (page, vault) => {
    const input = await edit(page); await capture(page, input);
    const doc = await page.evaluate(() => (window as any).nativeLayerHarness.editor.state.doc.toString());
    const introduction = page.locator(".native-layer-prototype-host .cm-line", { hasText: "Prototype introduction" });
    await introduction.click();
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original.replace("priority: 2", "priority: 9"));
    await page.keyboard.press("Home"); await page.keyboard.type("Outside ");
    await expect.poll(() => page.evaluate(() => (window as any).nativeLayerHarness.editor.state.doc.toString())).toBe(`Outside ${doc}`);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
    await expect.poll(() => page.evaluate(() => (window as any).nativeLayerHarness.editor.state.doc.toString())).toBe(doc);
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original.replace("priority: 2", "priority: 9"));
    expect(fs.readFileSync(path.join(vault, "Other.md"), "utf8")).toBe(secondOriginal);
  });
});
test("measured native frame height converges with its CM placeholder after delayed loading and resize", async ({}, info) => {
  await withPrototype(info, async (page, vault) => {
    try {
      await expect.poll(() => page.evaluate(() => (window as any).__heightReadEntered)).toBe(true);
      await record(page).evaluate(root => { (window as any).__heightRoot = root; root.style.height = "360px"; });
      await page.evaluate(() => (window as any).__releaseHeightRead());
      const input = await edit(page); await capture(page, input);
      const before = await page.evaluate(() => (window as any).nativeLayerHarness.editor.state.doc.toString());
      const lifetime = await page.evaluate(() => { const layer = (window as any).nativeLayerHarness.layer; return { allocations: layer.allocations, retirements: layer.retirements }; });
      for (const height of [400, 240]) {
        await record(page).evaluate((root, height) => { root.style.height = `${height}px`; }, height);
        const measure = () => page.evaluate(() => {
          const root = (window as any).__heightRoot as HTMLElement;
          const anchor = document.querySelector<HTMLElement>('.native-layer-placeholder[data-occurrence="1"]')!;
          const geometry = { root: root.getBoundingClientRect().toJSON(), anchor: anchor.getBoundingClientRect().toJSON(),
            sameRoot: root === (window as any).__layerProbe.root,
            source: (window as any).nativeLayerHarness.editor.state.doc.toString(),
            measurements: (window as any).nativeLayerHarness.layer.measurements,
            allocations: (window as any).nativeLayerHarness.layer.allocations, retirements: (window as any).nativeLayerHarness.layer.retirements };
          const observations = ((window as any).__heightMeasurements ??= []);
          observations.push({ root: geometry.root, anchor: geometry.anchor, measurements: geometry.measurements });
          if (observations.length > 12) observations.shift();
          return geometry;
        });
        await expect.poll(async () => {
          const geometry = await measure();
          return Math.abs(geometry.anchor.height - geometry.root.height) <= 1 &&
            Math.abs(geometry.anchor.top - geometry.root.top) <= 1 && Math.abs(geometry.anchor.left - geometry.root.left) <= 1;
        }).toBe(true);
        const geometry = await measure();
        expect(geometry.sameRoot).toBe(true);
        expect(geometry.root.height).toBe(height);
        expect(Math.abs(geometry.anchor.height - geometry.root.height)).toBeLessThanOrEqual(1);
        expect(Math.abs(geometry.anchor.top - geometry.root.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(geometry.anchor.left - geometry.root.left)).toBeLessThanOrEqual(1);
        expect(geometry.source).toBe(before); expect(geometry.measurements).toBeLessThan(100);
        expect({ allocations: geometry.allocations, retirements: geometry.retirements }).toEqual(lifetime);
        await unchanged(page, vault);
      }
      expect(await page.evaluate(() => (window as any).nativeLayerHarness.undo())).toBe(false);
    } finally { await page.evaluate(() => (window as any).__releaseHeightRead?.()); }
  }, source, async page => {
    await page.evaluate(() => {
      const app = (window as any).app; const read = app.vault.read.bind(app.vault);
      app.vault.read = async (file: any) => {
        if (file.path === "Board.canvas") {
          (window as any).__heightReadEntered = true;
          await new Promise<void>(resolve => { (window as any).__releaseHeightRead = resolve; });
        }
        return read(file);
      };
    });
  });
});
test("unequal retained native frames preserve spacing, focused exposure and real recovery controls", async ({}, info) => {
  const doc = source.slice(0, 2000) + "\n![[Board.canvas]]\n\n" + "Tail paragraph.\n\n".repeat(400);
  await withPrototype(info, async (page, vault) => {
    await page.evaluate(() => {
      const app = (window as any).app; const modify = app.vault.modify.bind(app.vault);
      (window as any).__mixedFailedFiles = new Set(["Source.md", "Other.md"]);
      app.vault.modify = (file: any, text: string) => (window as any).__mixedFailedFiles.has(file.path)
        ? Promise.reject(new Error(`synthetic mixed-height ${file.path} failure`)) : modify(file, text);
    });
    const first = await edit(page); await first.evaluate(input => { (window as any).__firstFailedLayerInput = input; (window as any).__mixedFirstRoot = input.closest(".native-prototype-record"); (window as any).__mixedFirstParent = (window as any).__mixedFirstRoot.parentElement; });
    await first.press("Enter"); await expect(record(page, 1).getByRole("button", { name: "Retry Base save" })).toBeVisible();
    await page.evaluate(() => { const h = (window as any).nativeLayerHarness; h.editor.scrollDOM.scrollTop = h.editor.lineBlockAt(h.editor.state.doc.toString().indexOf("![[Board.canvas]]", 100)).top; });
    const second = await edit(page, 2, "Other", "8");
    await second.press("Enter"); await expect(record(page, 2).getByRole("button", { name: "Retry Base save" })).toBeVisible();
    await expect(second).toBeFocused(); await capture(page, second);
    await record(page, 1).evaluate(root => { root.style.height = "400px"; });
    await record(page, 2).evaluate(root => { root.style.height = "200px"; });
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".native-prototype-record")].map(root => root.getBoundingClientRect().height))).toEqual([400, 200]);
    await scrollAway(page); await unchanged(page, vault, "8");
    await expect.poll(() => page.evaluate(() => (window as any).nativeLayerHarness.layer.snapshot().records.map((item: any) => item.state))).toEqual(["retained", "retained"]);
    expect(await page.evaluate(() => {
      const first = (window as any).__firstFailedLayerInput; const second = (window as any).__layerProbe;
      return { independent: first !== second.input, firstConnected: first.isConnected, firstValue: first.value,
        firstRoot: first.closest(".native-prototype-record") === (window as any).__mixedFirstRoot,
        firstParent: (window as any).__mixedFirstRoot.parentElement === (window as any).__mixedFirstParent,
        secondConnected: second.input.isConnected, secondValue: second.input.value,
        secondRoot: second.input.closest(".native-prototype-record") === second.root, secondParent: second.root.parentElement === second.parent };
    })).toEqual({ independent: true, firstConnected: true, firstValue: "9", firstRoot: true, firstParent: true,
      secondConnected: true, secondValue: "8", secondRoot: true, secondParent: true });
    const geometry = await page.evaluate(() => {
      const roots = [...document.querySelectorAll<HTMLElement>(".native-prototype-record")].map(root => root.getBoundingClientRect().toJSON());
      const rail = document.querySelector<HTMLElement>('[aria-label="Scroll retained embedded edits"]')!;
      const snapshot = { roots, cameras: (window as any).nativeLayerHarness.native.map((view: any) => ({ pan: { ...view.pan }, scale: view.scale })), rail: rail.getBoundingClientRect().toJSON(), scrollHeight: rail.scrollHeight, clientHeight: rail.clientHeight };
      (window as any).__mixedHeightGeometry = snapshot; return snapshot;
    });
    expect(geometry.roots.map(root => root.height)).toEqual([400, 200]);
    expect(geometry.roots[1].top - geometry.roots[0].bottom).toBeGreaterThanOrEqual(8);
    expect(geometry.scrollHeight).toBe(616);
    expect(geometry.scrollHeight).toBeGreaterThan(geometry.clientHeight);
    expect(geometry.roots[1].top).toBeGreaterThanOrEqual(geometry.rail.top);
    expect(geometry.roots[1].bottom).toBeLessThanOrEqual(geometry.rail.bottom + 1);
    const rail = page.getByLabel("Scroll retained embedded edits");
    await rail.focus(); await page.keyboard.press("Home"); await expect.poll(() => rail.evaluate(element => element.scrollTop)).toBe(0);
    const firstReturn = record(page, 1).getByRole("button", { name: "Return to embed" });
    expect(await firstReturn.evaluate(button => { const rect = button.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return hit === button || button.contains(hit); })).toBe(true);
    await firstReturn.click(); await page.evaluate(() => (window as any).__mixedFailedFiles.delete("Source.md"));
    await record(page, 1).getByRole("button", { name: "Retry Base save" }).click();
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original.replace("priority: 2", "priority: 9"));
    expect(fs.readFileSync(path.join(vault, "Other.md"), "utf8")).toBe(secondOriginal);
    expect(await page.evaluate(() => {
      const p = (window as any).__layerProbe;
      return { connected: p.input.isConnected, value: p.input.value, sameRoot: p.input.closest(".native-prototype-record") === p.root,
        sameParent: p.root.parentElement === p.parent };
    })).toEqual({ connected: true, value: "8", sameRoot: true, sameParent: true });
    await rail.focus(); await rail.hover(); await page.mouse.wheel(0, -1000);
    const note = record(page, 2).locator(".canvas-node-note");
    const wheelPoint = await note.evaluate(note => {
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
      for (let ancestor: HTMLElement | null = note; ancestor; ancestor = ancestor.parentElement) {
        const rect = ancestor.getBoundingClientRect(); const style = getComputedStyle(ancestor);
        if (ancestor === note || style.overflowX !== "visible") { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
        if (ancestor === note || style.overflowY !== "visible") { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
      }
      const owner = note.closest(".native-prototype-record");
      for (let row = 1; row <= 5; row++) for (let column = 1; column <= 5; column++) {
        const x = left + (right - left) * column / 6, y = top + (bottom - top) * row / 6;
        const hit = document.elementFromPoint(x, y);
        if (right > left && bottom > top && hit && note.contains(hit) && hit.closest(".native-prototype-record") === owner) {
          const point = { x, y, hit: { tag: hit.tagName, className: hit.className }, bounds: { left, top, right, bottom } };
          (window as any).__mixedHeightGeometry.wheelPoint = point; return point;
        }
      }
      return null;
    });
    expect(wheelPoint).not.toBeNull();
    if (!wheelPoint) throw new Error("No visible owned note region accepts trusted wheel input");
    await page.mouse.move(wheelPoint.x, wheelPoint.y); await page.mouse.wheel(0, -1000);
    const secondRetry = record(page, 2).getByRole("button", { name: "Retry Base save" });
    expect(await secondRetry.evaluate(button => { (window as any).__mixedHeightGeometry.camerasAfterTrustedWheel = (window as any).nativeLayerHarness.native.map((view: any) => ({ pan: { ...view.pan }, scale: view.scale })); const rect = button.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); return hit === button || button.contains(hit); })).toBe(true);
    await page.evaluate(() => (window as any).__mixedFailedFiles.delete("Other.md")); await secondRetry.click();
    await expect.poll(() => fs.readFileSync(path.join(vault, "Other.md"), "utf8")).toBe(secondOriginal.replace("priority: 4", "priority: 8"));
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original.replace("priority: 2", "priority: 9"));
  }, doc);
});
