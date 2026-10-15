import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test.describe.configure({ retries: 0 });
const source = "---\npriority: 2\n---\nSource body\n";
const other = "---\npriority: 4\n---\nOther body\n";
for (const schedule of ["metadata-after-save", "metadata-before-save-return"] as const) {
  test(`nested Canvas Base convergence with ${schedule} preserves a controlled refused sibling draft`, async ({}, info) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "geode-base-nested-convergence-"));
    const vault = path.join(directory, "vault"), profile = path.join(directory, "profile");
    fs.mkdirSync(vault); fs.mkdirSync(profile);
    fs.writeFileSync(path.join(vault, "Source.md"), source); fs.writeFileSync(path.join(vault, "Other.md"), other);
    fs.writeFileSync(path.join(vault, "Tasks.base"), "views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - note.priority\n");
    fs.writeFileSync(path.join(vault, "Host.md"), "![[Tasks.base]]\n");
    fs.writeFileSync(path.join(vault, "Outer.md"), "# Outer\n\n![[Board.canvas]]\n");
    fs.writeFileSync(path.join(vault, "Board.canvas"), JSON.stringify({ nodes: [{ id: "nested", type: "file", file: "Host.md", x: 0, y: 0, width: 640, height: 600 }], edges: [] }));
    fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
    const app = await electron.launch({ args: [path.resolve(__dirname, "../.."), `--user-data-dir=${profile}`] });
    const page = await app.firstWindow();
    try {
      await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1920, 1080));
      await page.locator('.nav-file-title[data-path="Outer.md"]').click();
      await page.getByRole("button", { name: "Toggle reading view (Cmd/Ctrl+E)" }).click();
      await expect(page.locator(".canvas-embed-view .bases-table")).toBeVisible();
      await page.evaluate(async () => {
        const app = (window as any).app, owner = app.workspace.getActiveLeaf();
        const file = app.vault.getFileByPath("Tasks.base"), clean = app.workspace.splitActiveLeaf("vertical");
        await app.openFileInLeaf(clean, file);
        const dirty = app.workspace.splitActiveLeaf("vertical"); await app.openFileInLeaf(dirty, file);
        const views = [owner, clean, dirty].map((leaf, index) => {
          const view = index === 0 ? leaf.view.renderOwner.writers().find((writer: any) => writer.viewType === "base" && writer.file?.path === "Tasks.base") : leaf.view;
          if (!view || view.viewType !== "base") throw Error("Actual Base view required");
          view.containerEl.dataset.convergenceRole = ["owner", "clean", "dirty"][index];
          return view;
        });
        (window as any).__baseConvergence = { owner: views[0], clean: views[1], dirty: views[2], leaves: [owner, clean, dirty], events: [], writes: [], phases: [] };
      });
      const root = (role: string) => page.locator(`[data-convergence-role="${role}"]`);
      const cell = (role: string, name: string) => root(role).locator(".bases-data-row").filter({ hasText: name }).locator("td.bases-cell").nth(1);
      for (const role of ["owner", "clean", "dirty"]) { await expect(root(role)).toBeVisible(); await expect(cell(role, "Source.md")).toHaveText("2"); }
      await page.waitForFunction(() => (window as any).app.metadataCache.getCache("Source.md")?.frontmatter?.priority === 2);
      // One ordinary pre-edit navigation step; this does not claim automatic exposure.
      const wheel = await page.locator(".canvas-embed-view .canvas-surface").evaluate(surface => {
        const p = (window as any).__baseConvergence;
        const canvas = p.leaves[0].view.renderOwner.writers().find((writer: any) => writer.viewType === "canvas" && writer.surfaceEl === surface);
        if (!canvas) throw Error("Exact actual Canvas required");
        const r = surface.getBoundingClientRect();
        let left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
        for (let ancestor = surface.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor), rect = ancestor.getBoundingClientRect();
          if (style.overflowX !== "visible") { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
          if (style.overflowY !== "visible") { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
        }
        const samples = [];
        for (const y of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const x of [0.1, 0.3, 0.5, 0.7, 0.9]) {
          const point = { x: left + (right - left) * x, y: top + (bottom - top) * y }, hit = document.elementFromPoint(point.x, point.y);
          samples.push({ ...point, owned: right > left && bottom > top && hit?.closest(".canvas-surface") === surface, tag: hit?.tagName, className: (hit as HTMLElement)?.className });
        }
        p.wheelCanvas = canvas; p.wheelRoot = canvas.containerEl;
        const data = p.setupWheel = { before: { pan: { ...canvas.pan }, scale: canvas.scale }, samples, chosen: samples.find(point => point.owned) ?? null, events: [] as unknown[] };
        surface.addEventListener("wheel", event => data.events.push({ trusted: event.isTrusted, deltaY: (event as WheelEvent).deltaY }), { capture: true, once: true });
        return data;
      });
      fs.writeFileSync(info.outputPath("wheel-before.json"), JSON.stringify(wheel, null, 2)); expect(wheel.chosen).not.toBeNull();
      await page.mouse.move(wheel.chosen!.x, wheel.chosen!.y); await page.mouse.wheel(0, 120);
      await expect.poll(() => page.evaluate(() => (window as any).__baseConvergence.wheelCanvas.pan.y)).not.toBe(wheel.before.pan.y);
      const wheelAfter = await page.evaluate(() => {
        const p = (window as any).__baseConvergence;
        return p.setupWheel.after = { pan: { ...p.wheelCanvas.pan }, scale: p.wheelCanvas.scale, sameRoot: p.wheelCanvas.containerEl === p.wheelRoot && p.wheelRoot.isConnected, events: p.setupWheel.events };
      });
      fs.writeFileSync(info.outputPath("wheel-after.json"), JSON.stringify(wheelAfter, null, 2));
      expect(wheelAfter.sameRoot).toBe(true); expect(wheelAfter.pan.x).toBe(wheel.before.pan.x); expect(wheelAfter.scale).toBe(wheel.before.scale);
      expect(wheelAfter.events).toEqual([{ trusted: true, deltaY: 120 }]);
      expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source); expect(fs.readFileSync(path.join(vault, "Other.md"), "utf8")).toBe(other);
      const clickCell = async (role: string, name: string) => {
        const hit = await cell(role, name).evaluate(el => {
          const rect = el.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          const actual = document.elementFromPoint(x, y);
          const p = (window as any).__baseConvergence;
          const value = { role: el.closest("[data-convergence-role]")?.getAttribute("data-convergence-role"), rect: rect.toJSON(), x, y,
            owned: !!actual && el.contains(actual), tag: actual?.tagName, className: (actual as HTMLElement)?.className };
          (p.hits ??= []).push(value);
          el.addEventListener("pointerdown", event => (p.trustedCells ??= []).push({ role: value.role, trusted: event.isTrusted }), { once: true });
          return value;
        });
        expect(hit.owned).toBe(true); await page.mouse.click(hit.x, hit.y);
      };
      await clickCell("dirty", "Other.md"); await page.keyboard.press("Enter");
      await cell("dirty", "Other.md").locator("input").fill("8");
      await page.evaluate(() => {
        const p = (window as any).__baseConvergence, table = p.dirty.tableView;
        const outer = p.leaves[0].view;
        p.canvas = outer.renderOwner.writers().find((writer: any) => writer.viewType === "canvas" && writer.file?.path === "Board.canvas");
        if (!p.canvas) throw Error("Actual production Canvas required");
        p.ownerCapture = { outer, text: outer.getText(), root: p.owner.containerEl, parent: p.owner.containerEl.parentElement,
          canvas: p.canvas, canvasRoot: p.canvas.containerEl, pan: { ...p.canvas.pan }, scale: p.canvas.scale };
        p.dirtyCapture = { table, session: table.editSession, edit: p.dirty.sourceEdit, input: table.editSession.input,
          root: p.dirty.containerEl, parent: p.dirty.containerEl.parentElement };
        // Controlled actual admission refusal, not a complete sync-conflict setup.
        p.dirty.sourceConflictReadOnly = true;
        p.dirtyBlurs = [];
        table.editSession.input.addEventListener("blur", event => p.dirtyBlurs.push({ trusted: event.isTrusted, connected: table.editSession?.input === p.dirtyCapture.input, value: p.dirtyCapture.input.value }));
        const original = table.callbacks.onEditCell;
        table.callbacks.onEditCell = (...args: unknown[]) => {
          const attempt = Reflect.apply(original, table.callbacks, args);
          void attempt.then(() => { p.dirtyUnexpectedSave = true; }, error => { p.dirtyRefusal = String(error); });
          return attempt;
        };
      });
      await clickCell("owner", "Source.md"); await page.keyboard.press("Enter");
      await cell("owner", "Source.md").locator("input").fill("9");
      await page.waitForFunction(() => String((window as any).__baseConvergence.dirtyRefusal).includes("Resolve Base source conflict"));
      expect(fs.readFileSync(path.join(vault, "Other.md"), "utf8")).toBe(other);
      await page.evaluate(schedule => {
        const p = (window as any).__baseConvergence, app = (window as any).app, cache = app.metadataCache;
        const emit = (name: string, fields: Record<string, unknown> = {}) => p.events.push({ seq: p.events.length + 1, name, ...fields });
        let releaseFlush!: () => void, releaseAck!: () => void, published!: () => void;
        const flushGate = new Promise<void>(resolve => { releaseFlush = resolve; });
        const ackGate = new Promise<void>(resolve => { releaseAck = resolve; });
        const publication = new Promise<void>(resolve => { published = resolve; });
        p.release = () => { releaseFlush(); releaseAck(); };
        const realFlush = cache.flush, realModify = app.vault.modify;
        p.gatedFlushCalls = 0; p.originalGatedFlushCalls = 0; p.sourceWriteCalls = 0;
        p.changedRef = cache.on("changed", (file: any, text: string, metadata: any) => {
          if (file.path !== "Source.md") return;
          const priority = cache.getFileCache(file)?.frontmatter?.priority;
          emit("changed", { path: file.path, payload: metadata.frontmatter?.priority, priority, text });
          if (priority === 9 && metadata.frontmatter?.priority === 9) { p.metadataPublished = true; published(); }
        });
        p.resolvedRef = cache.on("resolved", () => {
          const priority = cache.getCache("Source.md")?.frontmatter?.priority;
          emit("resolved", { priority });
          if (p.metadataPublished && priority === 9) p.metadataResolved = true;
        });
        cache.flush = async function (...args: unknown[]) {
          if (schedule === "metadata-after-save" && !p.gatedFlushCalls && this.dirty.has("Source.md")) {
            p.gatedFlushCalls++; emit("flush-held", { workerEntry: this.workerEntries.has("Source.md"), backgroundActive: this.backgroundIndexerActive });
            await flushGate; p.originalGatedFlushCalls++; emit("flush-release"); return Reflect.apply(realFlush, this, args);
          }
          emit("flush", { sourceDirty: this.dirty.has("Source.md"), workerEntry: this.workerEntries.has("Source.md"), backgroundActive: this.backgroundIndexerActive });
          return Reflect.apply(realFlush, this, args);
        };
        app.vault.modify = async function (...args: any[]) {
          p.writes.push({ path: args[0].path, text: args[1] });
          if (args[0].path !== "Source.md") return Reflect.apply(realModify, this, args);
          p.sourceWriteCalls++; emit("modify-start"); const value = await Reflect.apply(realModify, this, args); emit("modify-actual-return");
          if (schedule === "metadata-before-save-return") { await publication; p.ackHeld = true; emit("ack-held"); await ackGate; emit("ack-release"); }
          return value;
        };
        p.snapshot = (name: string) => {
          const d = p.dirtyCapture;
          const view = (v: any) => ({ sourceEdit: !!v.sourceEdit, tableEdit: !!v.tableView.editIdentity, refreshPending: v.projectionRefreshPending,
            pendingWrites: v.sourcePersistsInFlight.size, ownerPending: v.renderOwner.pending.size,
            sourceCell: [...v.containerEl.querySelectorAll(".bases-data-row")].find((row: any) => row.cells[0].textContent === "Source.md")?.cells[1].textContent,
            query: v.lastResult?.rows.find((row: any) => row.file.path === "Source.md")?.properties["note.priority"] });
          return { name, cache: cache.getCache("Source.md")?.frontmatter?.priority, owner: view(p.owner), clean: view(p.clean),
            dirty: { sameTable: p.dirty.tableView === d.table, sameSession: d.table.editSession === d.session, sameEdit: p.dirty.sourceEdit === d.edit,
              connected: d.input.isConnected, sameInput: d.session.input === d.input && d.input.parentElement === d.session.cell,
              value: d.input.value, root: p.dirty.containerEl === d.root && d.root.isConnected, parent: d.root.parentElement === d.parent },
            backgroundActive: cache.backgroundIndexerActive, workerEntry: cache.workerEntries.has("Source.md"), events: [...p.events], writes: [...p.writes],
            gatedFlushCalls: p.gatedFlushCalls, originalGatedFlushCalls: p.originalGatedFlushCalls, sourceWriteCalls: p.sourceWriteCalls, dirtyRefusal: p.dirtyRefusal, dirtyBlurs: [...p.dirtyBlurs], hits: p.hits, trustedCells: p.trustedCells, setupWheel: p.setupWheel,
            nested: { sameOuter: p.leaves[0].view === p.ownerCapture.outer, outerText: p.ownerCapture.outer.getText(), initialText: p.ownerCapture.text,
              root: p.owner.containerEl === p.ownerCapture.root && p.ownerCapture.root.isConnected, parent: p.ownerCapture.root.parentElement === p.ownerCapture.parent,
              sameCanvas: p.canvas === p.ownerCapture.canvas, canvasConnected: p.ownerCapture.canvasRoot.isConnected,
              pan: { ...p.canvas.pan }, initialPan: p.ownerCapture.pan, scale: p.canvas.scale, initialScale: p.ownerCapture.scale } };
        };
        p.cleanup = () => { p.release(); cache.flush = realFlush; app.vault.modify = realModify; cache.offref(p.changedRef); cache.offref(p.resolvedRef); };
      }, schedule);
      await page.keyboard.press("Enter");
      if (schedule === "metadata-after-save") {
        await page.waitForFunction(() => { const p = (window as any).__baseConvergence; return p.gatedFlushCalls === 1 && p.owner.sourcePersistsInFlight.size === 0 && !p.owner.tableView.editIdentity; });
      } else await page.waitForFunction(() => (window as any).__baseConvergence.ackHeld === true);
      const held = await page.evaluate(() => (window as any).__baseConvergence.snapshot("held"));
      fs.writeFileSync(info.outputPath("held.json"), JSON.stringify(held, null, 2));
      expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source.replace("priority: 2", "priority: 9"));
      expect(held.dirty).toEqual({ sameTable: true, sameSession: true, sameEdit: true, connected: true, sameInput: true, value: "8", root: true, parent: true });
      expect(held.sourceWriteCalls).toBe(1);
      expect(held.dirtyBlurs).toEqual([{ trusted: true, connected: true, value: "8" }]);
      if (schedule === "metadata-after-save") expect(held.cache).toBe(2);
      else expect(held.cache).toBe(9);
      await page.evaluate(() => (window as any).__baseConvergence.release());
      // Read-only convergence; no forced query/render, synthetic cache or app action in the predicate.
      await expect.poll(() => page.evaluate(() => {
        const p = (window as any).__baseConvergence, s = p.snapshot("poll");
        return { published: p.metadataPublished, resolved: p.metadataResolved, cache: s.cache, owner: s.owner.sourceCell, clean: s.clean.sourceCell,
          pending: s.owner.pendingWrites, editing: s.owner.tableEdit };
      })).toEqual({ published: true, resolved: true, cache: 9, owner: "9", clean: "9", pending: 0, editing: false });
      const final = await page.evaluate(() => (window as any).__baseConvergence.snapshot("final"));
      expect(final.trustedCells).toEqual([{ role: "dirty", trusted: true }, { role: "owner", trusted: true }]);
      for (const state of [held, final]) {
        expect(state.nested).toMatchObject({ sameOuter: true, root: true, parent: true, sameCanvas: true, canvasConnected: true });
        expect(state.nested.outerText).toBe(state.nested.initialText);
        expect(state.nested.pan).toEqual(state.nested.initialPan); expect(state.nested.scale).toBe(state.nested.initialScale);
      }
      expect(final.dirty).toEqual(held.dirty); expect(final.sourceWriteCalls).toBe(1);
      if (schedule === "metadata-after-save") expect(final.originalGatedFlushCalls).toBe(1);
      expect(final.writes.filter((w: any) => w.path === "Other.md")).toEqual([]);
      expect(fs.readFileSync(path.join(vault, "Other.md"), "utf8")).toBe(other);
      fs.writeFileSync(info.outputPath("final.json"), JSON.stringify(final, null, 2));
    } finally {
      await page.evaluate(() => (window as any).__baseConvergence?.release?.()).catch(() => {});
      const diagnostic = await page.evaluate(() => {
        const p = (window as any).__baseConvergence; return p?.snapshot ? p.snapshot("finally") : { setupIncomplete: true, dirtyRefusal: p?.dirtyRefusal, hits: p?.hits, trustedCells: p?.trustedCells, setupWheel: p?.setupWheel };
      }).catch(error => ({ observationError: String(error) }));
      fs.writeFileSync(info.outputPath("diagnostic.json"), JSON.stringify({ diagnostic, source: fs.readFileSync(path.join(vault, "Source.md"), "utf8"), other: fs.readFileSync(path.join(vault, "Other.md"), "utf8") }, null, 2));
      await page.screenshot({ path: info.outputPath("projection.png") }).catch(() => {});
      await page.evaluate(() => (window as any).__baseConvergence?.cleanup?.()).catch(() => {});
      await app.close(); fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
