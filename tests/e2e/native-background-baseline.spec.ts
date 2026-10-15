import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page, type TestInfo } from "@playwright/test";

// Exact six-case negative baseline port from 14d251a onto combined 0a6a9e1.
// Additional actual-caller controls below do not alter those six assertions.
// No private bundle, source patch, synthetic DOM hide, or blur waiver.
const repo = path.resolve(__dirname, "../..");
const original = "---\npriority: 2\n---\n\nOriginal source\n";
const otherOriginal = "Other tab content\n";
type Mode = "Reading" | "Live Preview";

async function record(page: Page, vault: string, info: TestInfo, phase: string) {
  const state = await page.evaluate(() => {
    const p = (window as any).__backgroundProbe;
    const native = p.owner.view.renderOwner.writers().find((writer: any) => writer.containerEl === p.root);
    return {
      mode: p.view.mode, distinctLeaves: p.owner !== (window as any).__backgroundTabs.other,
      basePersists: p.base.sourcePersistsInFlight.size, basePending: p.base.renderOwner.pending.size,
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
async function fixture(mode: Mode, info: TestInfo, run: (page: Page, vault: string) => Promise<void>, options: { split?: boolean } = {}) {
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
    if (options.split) await page.evaluate(() => {
      const tabs = (window as any).__backgroundTabs;
      (window as any).__backgroundMoveTarget = (window as any).app.workspace.addGroup(tabs.owner.group);
    });
    const table = page.locator(".canvas-embed-view:visible .bases-table"); await expect(table).toBeVisible();
    // Real pre-edit wheel pan; sample the actual visible clip and prove this
    // exact Canvas camera moved before attempting the obscured cell.
    const surface = page.locator(".canvas-embed-view:visible .canvas-surface");
    const wheel = await surface.evaluate(el => {
      const r = el.getBoundingClientRect(); let left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), clip = parent.getBoundingClientRect();
        if (style.overflowX !== "visible") { left = Math.max(left, clip.left); right = Math.min(right, clip.right); }
        if (style.overflowY !== "visible") { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom); }
      }
      const samples = [];
      for (const y of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const x of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const point = { x: left + (right - left) * x, y: top + (bottom - top) * y }, hit = document.elementFromPoint(point.x, point.y);
        samples.push({ ...point, owned: right > left && bottom > top && hit?.closest(".canvas-surface") === el, target: (hit as HTMLElement)?.className });
      }
      const app = (window as any).app, owner = (window as any).__backgroundTabs.owner;
      const canvas = owner.view.renderOwner.writers().find((writer: any) => writer.viewType === "canvas" && writer.surfaceEl === el);
      if (!canvas) throw Error("Exact production Canvas writer required");
      const probe = (window as any).__backgroundPan = { canvas, surface: el, before: { pan: { ...canvas.pan }, scale: canvas.scale }, events: [] as unknown[] };
      el.addEventListener("wheel", event => { probe.events.push({ trusted: event.isTrusted, deltaY: (event as WheelEvent).deltaY, sameSurface: (event.target as HTMLElement)?.closest(".canvas-surface") === el }); }, { capture: true, once: true });
      return { rect: r.toJSON(), clipped: { left, top, right, bottom }, samples, chosen: samples.find(sample => sample.owned) ?? null, before: probe.before };
    });
    fs.writeFileSync(info.outputPath("pan-before.json"), JSON.stringify(wheel, null, 2)); expect(wheel.chosen).not.toBeNull();
    await page.mouse.move(wheel.chosen!.x, wheel.chosen!.y); await page.mouse.wheel(0, -100);
    await expect.poll(() => page.evaluate(() => (window as any).__backgroundPan.canvas.pan.y)).not.toBe(wheel.before.pan.y);
    const pan = await page.evaluate(() => { const p = (window as any).__backgroundPan; return { pan: { ...p.canvas.pan }, scale: p.canvas.scale, events: p.events }; });
    fs.writeFileSync(info.outputPath("pan-after.json"), JSON.stringify(pan, null, 2));
    expect(pan.pan.x).toBe(wheel.before.pan.x); expect(pan.scale).toBe(wheel.before.scale);
    expect(pan.events).toEqual([{ trusted: true, deltaY: -100, sameSurface: true }]);
    expect(await page.evaluate(() => (window as any).__backgroundTabs.owner.view.mode)).toBe(mode === "Reading" ? "reading" : "live");
    expect(await page.evaluate(() => (window as any).__backgroundTabs.owner !== (window as any).__backgroundTabs.other)).toBe(true);
    const column = (await table.locator("thead th").allTextContents()).indexOf("note.priority"); expect(column).toBeGreaterThan(-1);
    const cell = table.locator(".bases-data-row", { hasText: "Source" }).locator("td.bases-cell").nth(column);
    await expect(cell).toHaveText("2"); await cell.click(); await page.keyboard.press("Enter");
    const input = cell.locator(".bases-cell-input"); await expect(input).toBeVisible(); await input.fill("9");
    await input.evaluate(input => {
      const app = (window as any).app, owner = (window as any).__backgroundTabs.owner;
      const root = input.closest(".canvas-embed-view")!;
      const native = owner.view.renderOwner.writers().find((writer: any) => writer.containerEl === root);
      const p = (window as any).__backgroundProbe = { owner, view: owner.view, root, parent: root.parentElement, input, cell: input.parentElement,
        base: owner.view.renderOwner.writers().find((writer: any) => writer.viewType === "base" && writer.file?.path === "Tasks.base"),
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
async function settled(page: Page) {
  // Observe actual nested writer admission/settlement, never drain or replace a
  // handler. Two animation frames alone can precede async read -> modify.
  await expect.poll(() => page.evaluate(() => {
    const base = (window as any).__backgroundProbe.base;
    return { persists: base.sourcePersistsInFlight.size, pending: base.renderOwner.pending.size };
  })).toEqual({ persists: 0, pending: 0 });
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
      await settled(page);
      const hidden = await record(page, vault, info, "hidden"); await page.screenshot({ path: info.outputPath("hidden.png") });
      await returned(page); await settled(page); const back = await record(page, vault, info, "returned");
      // Browser blur is recorded separately and is allowed. Application writes,
      // input/root/parent loss and changed draft/provider are NOT waived.
      for (const witness of [hidden, back]) {
        expect(witness.provider).toBe(original); expect(witness.otherProvider).toBe(otherOriginal); expect(witness.state.writes).toEqual([]);
        expect(witness.state).toMatchObject({ mode: mode === "Reading" ? "reading" : "live", distinctLeaves: true, basePersists: 0, basePending: 0, sameOwner: true, sameRoot: true, rootConnected: true, sameParent: true, inputConnected: true, sameInput: true, inputValue: "9" });
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

// ADR0048 C1a: use actual Workspace boundaries, never a synthetic hide handler.
async function preserved(page: Page, vault: string, info: TestInfo, phase: string) {
  await settled(page);
  const value = await record(page, vault, info, phase);
  expect(value.provider).toBe(original); expect(value.otherProvider).toBe(otherOriginal);
  expect(value.state.writes).toEqual([]);
  expect(value.state).toMatchObject({ sameOwner: true, sameRoot: true, rootConnected: true, sameParent: true, inputConnected: true, sameInput: true, inputValue: "9" });
  expect(value.state.camera).toEqual(value.state.initialCamera);
  expect(value.state.sourceText).toBe(value.state.initialSource);
  return value;
}
for (const mode of ["Reading", "Live Preview"] as const) {
  test(`${mode} repeated programmatic activation preserves the exact session and never steals foreground focus`, async ({}, info) => {
    await fixture(mode, info, async (page, vault) => {
      await page.evaluate(() => {
        const workspace = (window as any).app.workspace, tabs = (window as any).__backgroundTabs;
        workspace.setActiveLeaf(tabs.owner, { focus: false });
        workspace.setActiveLeaf(tabs.owner, { focus: false });
        workspace.setActiveLeaf(tabs.other, { focus: false });
        workspace.setActiveLeaf(tabs.other, { focus: false });
      });
      await expect.poll(() => page.evaluate(() => (window as any).__backgroundTabs.owner.leafEl.getBoundingClientRect().height)).toBe(0);
      await preserved(page, vault, info, "repeated-hidden");
      await page.locator(".workspace-leaf.mod-active .cm-content").click();
      await page.evaluate(() => { (window as any).__backgroundForeground = document.activeElement; });
      await returned(page);
      await preserved(page, vault, info, "repeated-returned");
      expect(await page.evaluate(() => document.activeElement === (window as any).__backgroundProbe.input)).toBe(false);
    });
  });
  test(`${mode} explicit programmatic focus true keeps ordinary blur-save`, async ({}, info) => {
    await fixture(mode, info, async (page, vault) => {
      await page.evaluate(() => { (window as any).app.workspace.setActiveLeaf((window as any).__backgroundTabs.other, { focus: true }); });
      await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original.replace("priority: 2", "priority: 9"));
      await settled(page); const value = await record(page, vault, info, "focus-true");
      expect(value.state.inputConnected).toBe(false);
      expect(value.state.writes.filter((entry: any) => entry.path === "Source.md")).toHaveLength(1);
    });
  });
  test(`${mode} public no-focus call inside trusted key handler still preserves the draft`, async ({}, info) => {
    await fixture(mode, info, async (page, vault) => {
      await page.evaluate(() => {
        document.addEventListener("keydown", event => {
          if (event.key !== "F8") return;
          const tabs = (window as any).__backgroundTabs;
          (window as any).__backgroundTrustedActivation = event.isTrusted;
          (window as any).app.workspace.setActiveLeaf(tabs.other, { focus: false });
        }, { once: true });
      });
      await page.keyboard.press("F8");
      expect(await page.evaluate(() => (window as any).__backgroundTrustedActivation)).toBe(true);
      await expect.poll(() => page.evaluate(() => (window as any).__backgroundTabs.owner.leafEl.getBoundingClientRect().height)).toBe(0);
      await preserved(page, vault, info, "trusted-no-focus-hidden");
      await returned(page); await preserved(page, vault, info, "trusted-no-focus-returned");
    });
  });
  test(`${mode} dirty cross-container move refuses before extraction or destination activation`, async ({}, info) => {
    await fixture(mode, info, async (page, vault) => {
      const moved = await page.evaluate(() => {
        const workspace = (window as any).app.workspace, owner = (window as any).__backgroundTabs.owner;
        const from = owner.group, target = (window as any).__backgroundMoveTarget;
        const active = target.active, sourceActive = from.active, parent = owner.leafEl.parentElement;
        const events: string[] = []; const ref = workspace.on("layout-change", () => events.push("layout-change"));
        workspace.moveLeaf(owner, target);
        workspace.offref(ref);
        return { sameGroup: owner.group === from, sameParent: owner.leafEl.parentElement === parent,
          sourceActive: from.active === sourceActive, destinationActive: target.active === active,
          inSource: from.leaves.includes(owner), inTarget: target.leaves.includes(owner), events };
      });
      await record(page, vault, info, "move-attempt");
      expect(moved).toMatchObject({ sameGroup: true, sameParent: true, sourceActive: true, destinationActive: true, inSource: true, inTarget: false });
      await preserved(page, vault, info, "move-refused");
    }, { split: true });
  });
}

for (const mode of ["Reading", "Live Preview"] as const) {
  test(`${mode} hidden unfinished draft still refuses ordinary close without replacing roots`, async ({}, info) => {
    await fixture(mode, info, async (page, vault) => {
      await page.evaluate(() => { (window as any).app.workspace.setActiveLeaf((window as any).__backgroundTabs.other, { focus: false }); });
      await settled(page);
      const close = await page.evaluate(async () => {
        const owner = (window as any).__backgroundTabs.owner;
        try { await owner.detach(); return { refused: false, message: "" }; }
        catch (error) { return { refused: true, message: String(error) }; }
      });
      await record(page, vault, info, "hidden-close-attempt");
      expect(close.refused).toBe(true); expect(close.message).toMatch(/draft|finish|cancel/i);
      await returned(page); await preserved(page, vault, info, "hidden-close-refused-returned");
    });
  });
  test(`${mode} preserved hidden draft remains explicitly cancelable after reveal`, async ({}, info) => {
    await fixture(mode, info, async (page, vault) => {
      await page.evaluate(() => { (window as any).app.workspace.setActiveLeaf((window as any).__backgroundTabs.other, { focus: false }); });
      await returned(page); await preserved(page, vault, info, "before-explicit-cancel");
      const input = page.locator(".canvas-embed-view:visible .bases-cell-input");
      await input.click(); await page.keyboard.press("Escape");
      await settled(page); const value = await record(page, vault, info, "explicit-cancel");
      expect(value.provider).toBe(original); expect(value.state.writes).toEqual([]);
      expect(await page.evaluate(() => (window as any).__backgroundProbe.base.tableView.editIdentity)).toBeNull();
    });
  });
}
