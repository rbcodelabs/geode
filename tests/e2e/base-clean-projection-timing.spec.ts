import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

test.describe.configure({ retries: 0 });
const source = "---\npriority: 2\n---\nSource body\n";
const other = "---\npriority: 4\n---\nOther body\n";
for (const schedule of ["metadata-after-save", "metadata-before-save-return"] as const) {
  test(`clean Base convergence with ${schedule} preserves a controlled refused sibling draft`, async ({}, info) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "geode-base-convergence-"));
    const vault = path.join(directory, "vault"), profile = path.join(directory, "profile");
    fs.mkdirSync(vault); fs.mkdirSync(profile);
    fs.writeFileSync(path.join(vault, "Source.md"), source); fs.writeFileSync(path.join(vault, "Other.md"), other);
    fs.writeFileSync(path.join(vault, "Tasks.base"), "views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - note.priority\n");
    fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
    const app = await electron.launch({ args: [path.resolve(__dirname, "../.."), `--user-data-dir=${profile}`] });
    const page = await app.firstWindow();
    try {
      await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
      await page.locator('.nav-file-title[data-path="Tasks.base"]').click();
      await page.evaluate(async () => {
        const app = (window as any).app, owner = app.workspace.getActiveLeaf();
        const file = app.vault.getFileByPath("Tasks.base"), clean = app.workspace.splitActiveLeaf("vertical");
        await app.openFileInLeaf(clean, file);
        const dirty = app.workspace.splitActiveLeaf("vertical"); await app.openFileInLeaf(dirty, file);
        const views = [owner, clean, dirty].map((leaf, index) => {
          if (leaf.view.viewType !== "base") throw Error("Actual Base view required");
          leaf.view.containerEl.dataset.convergenceRole = ["owner", "clean", "dirty"][index];
          return leaf.view;
        });
        (window as any).__baseConvergence = { owner: views[0], clean: views[1], dirty: views[2], leaves: [owner, clean, dirty], events: [], writes: [], phases: [] };
      });
      const root = (role: string) => page.locator(`[data-convergence-role="${role}"]`);
      const cell = (role: string, name: string) => root(role).locator(".bases-data-row").filter({ hasText: name }).locator("td.bases-cell").nth(1);
      for (const role of ["owner", "clean", "dirty"]) { await expect(root(role)).toBeVisible(); await expect(cell(role, "Source.md")).toHaveText("2"); }
      await page.waitForFunction(() => (window as any).app.metadataCache.getCache("Source.md")?.frontmatter?.priority === 2);
      await cell("dirty", "Other.md").click(); await page.keyboard.press("Enter");
      await cell("dirty", "Other.md").locator("input").fill("8");
      await page.evaluate(() => {
        const p = (window as any).__baseConvergence, table = p.dirty.tableView;
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
      await cell("owner", "Source.md").click(); await page.keyboard.press("Enter");
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
            gatedFlushCalls: p.gatedFlushCalls, originalGatedFlushCalls: p.originalGatedFlushCalls, sourceWriteCalls: p.sourceWriteCalls, dirtyRefusal: p.dirtyRefusal, dirtyBlurs: [...p.dirtyBlurs] };
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
      expect(final.dirty).toEqual(held.dirty); expect(final.sourceWriteCalls).toBe(1);
      if (schedule === "metadata-after-save") expect(final.originalGatedFlushCalls).toBe(1);
      expect(final.writes.filter((w: any) => w.path === "Other.md")).toEqual([]);
      expect(fs.readFileSync(path.join(vault, "Other.md"), "utf8")).toBe(other);
      fs.writeFileSync(info.outputPath("final.json"), JSON.stringify(final, null, 2));
    } finally {
      await page.evaluate(() => (window as any).__baseConvergence?.release?.()).catch(() => {});
      const diagnostic = await page.evaluate(() => {
        const p = (window as any).__baseConvergence; return p?.snapshot ? p.snapshot("finally") : { setupIncomplete: true, dirtyRefusal: p?.dirtyRefusal };
      }).catch(error => ({ observationError: String(error) }));
      fs.writeFileSync(info.outputPath("diagnostic.json"), JSON.stringify({ diagnostic, source: fs.readFileSync(path.join(vault, "Source.md"), "utf8"), other: fs.readFileSync(path.join(vault, "Other.md"), "utf8") }, null, 2));
      await page.screenshot({ path: info.outputPath("projection.png") }).catch(() => {});
      await page.evaluate(() => (window as any).__baseConvergence?.cleanup?.()).catch(() => {});
      await app.close(); fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
