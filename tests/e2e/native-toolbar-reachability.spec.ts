import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "../.."), original = "---\npriority: 2\n---\n\nOriginal source\n";
for (const mode of ["exposed pointer", "keyboard fourth row"] as const) test(`unfiltered native table remains reachable through ${mode}`, async ({}, info) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "geode-toolbar-reachability-")), vault = path.join(directory, "vault"), profile = path.join(directory, "profile");
  fs.mkdirSync(vault); fs.mkdirSync(profile);
  const board = JSON.stringify({ nodes: [{ id: "owned", type: "file", x: 0, y: 0, width: 760, height: 600, file: "Host.md" }], edges: [] });
  const files = { "Source.md": original, "Other.md": "# Heading\n\nDestination\n", "Unrelated.md": "# Unrelated\n", "Outer.md": "# Outer\n\n![[Board.canvas]]\n", "Host.md": "![[Tasks.base]]\n", "Tasks.base": "views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - note.priority\n", "Board.canvas": board, "Recovery.canvas": board };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(vault, name), text);
  fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const application = await electron.launch({ args: [repoRoot, `--user-data-dir=${profile}`], cwd: repoRoot }), page = await application.firstWindow();
  const snapshot = async (name: string) => page.evaluate(name => {
    const root = document.querySelector<HTMLElement>(".canvas-embed-view")!;
    const owner = (window as any).app.workspace.getActiveLeaf(), canvas = owner.view.renderOwner.writers().find((writer: any) => writer.viewType === "canvas");
    if (!canvas) throw Error("Actual Canvas writer required");
    const describe = (el: Element | null): any => {
      if (!(el instanceof HTMLElement)) return null;
      const rect = el.getBoundingClientRect(), style = getComputedStyle(el), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2, hit = document.elementFromPoint(x, y);
      return { tag: el.tagName, className: el.className, rect: rect.toJSON(), scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflow: style.overflow, position: style.position, zIndex: style.zIndex, centerHit: hit && { tag: hit.tagName, className: hit.className, text: hit.textContent?.slice(0, 100) }, centerOwned: !!hit && el.contains(hit) };
    };
    const cell = [...root.querySelectorAll<HTMLElement>(".bases-data-row")].find(row => row.textContent?.includes("Source"))?.querySelectorAll("td")[1];
    const ancestors = []; for (let el: HTMLElement | null = cell ?? null; el; el = el.parentElement) { ancestors.push(describe(el)); if (el === root) break; }
    const probe = (window as any).__toolbarReachability ??= { phases: [], input: null, root, parent: root.parentElement, blur: 0, trusted: [] };
    probe.phases.push({ name, cell: describe(cell ?? null), input: describe(root.querySelector(".bases-cell-input")), toolbar: describe(root.querySelector(".canvas-toolbar")), surface: describe(root.querySelector(".canvas-surface")), note: describe(root.querySelector(".canvas-node-note")), ancestors, active: describe(document.activeElement), camera: { pan: { ...canvas.pan }, scale: canvas.scale, selectedIds: [...canvas.selectedIds] } });
  }, name);
  try {
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
    await page.locator('.nav-file-title[data-path="Outer.md"]').click();
    await page.getByRole("button", { name: "Toggle reading view (Cmd/Ctrl+E)" }).click();
    const root = page.locator(".canvas-embed-view:visible"), table = root.locator(".bases-table");
    await expect(table.locator(".bases-data-row")).toHaveCount(5);
    expect(await table.locator(".bases-data-row td:first-child").allTextContents()).toEqual(["Host.md", "Other.md", "Outer.md", "Source.md", "Unrelated.md"]);
    const source = table.locator(".bases-data-row").nth(3).locator("td").nth(1);
    await root.evaluate(el => el.addEventListener("click", event => { const p = (window as any).__toolbarReachability; if (p) p.trusted.push({ trusted: event.isTrusted, target: (event.target as HTMLElement).className }); }, true));
    await snapshot("before-action");
    const clickExposed = async (cell: typeof source) => {
      const point = await cell.evaluate(el => {
        const r = el.getBoundingClientRect(); let left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
        for (let parent = el.parentElement; parent; parent = parent.parentElement) { const style = getComputedStyle(parent), rect = parent.getBoundingClientRect(); if (style.overflowX !== "visible") { left = Math.max(left, rect.left); right = Math.min(right, rect.right); } if (style.overflowY !== "visible") { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); } }
        const samples = [];
        for (const yRatio of [0.1, 0.3, 0.5, 0.7, 0.9]) for (const xRatio of [0.1, 0.3, 0.5, 0.7, 0.9]) { const x = left + (right - left) * xRatio, y = top + (bottom - top) * yRatio, hit = document.elementFromPoint(x, y); samples.push({ x, y, owned: right > left && bottom > top && !!hit && el.contains(hit), hit: hit && { tag: hit.tagName, className: (hit as HTMLElement).className } }); }
        const candidate = samples.find(point => point.owned), chosen = candidate ? { x: candidate.x, y: candidate.y } : null;
        const probe = (window as any).__toolbarReachability; (probe.hitmaps ??= []).push({ row: (el as HTMLElement).dataset.rowIndex, column: (el as HTMLElement).dataset.colIndex, rect: r.toJSON(), clipped: { left, top, right, bottom }, samples, chosen });
        return chosen;
      });
      expect(point).not.toBeNull(); await page.mouse.click(point!.x, point!.y);
    };
    if (mode === "exposed pointer") await clickExposed(source);
    else {
      await clickExposed(table.locator(".bases-data-row").first().locator("td").nth(1));
      await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
      await expect(source).toHaveClass(/is-selected/);
    }
    await snapshot("after-selection"); await page.keyboard.press("Enter"); await snapshot("after-Enter");
    const input = source.locator("input"); await expect(input).toBeFocused(); await input.fill("9");
    await input.evaluate(el => { const p = (window as any).__toolbarReachability; p.input = el; el.addEventListener("blur", () => p.blur++); });
    await snapshot("draft-before-reachability-oracle");
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original);
    expect(await input.evaluate(el => { const p = (window as any).__toolbarReachability, r = el.getBoundingClientRect(); return { same: p.input === el, connected: el.isConnected, focused: document.activeElement === el, value: (el as HTMLInputElement).value, blur: p.blur, root: p.root.isConnected && p.root.parentElement === p.parent, hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el }; })).toEqual({ same: true, connected: true, focused: true, value: "9", blur: 0, root: true, hit: true });
    expect(await page.evaluate(() => (window as any).__toolbarReachability.trusted.some((event: any) => event.trusted))).toBe(true);
    await page.keyboard.press("Enter");
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(original.replace("priority: 2", "priority: 9"));
    await snapshot("after-deliberate-save");
    await root.getByRole("button", { name: "Add note from vault", exact: true }).click();
    await expect(page.getByPlaceholder("Search notes…")).toBeVisible(); await page.keyboard.press("Escape");
    expect(fs.readFileSync(path.join(vault, "Board.canvas"), "utf8")).toBe(board);
  } finally {
    const state = await page.evaluate(() => { const p = (window as any).__toolbarReachability; return p && { phases: p.phases, hitmaps: p.hitmaps, blur: p.blur, trusted: p.trusted, input: p.input && { connected: p.input.isConnected, value: p.input.value }, root: p.root.isConnected && p.root.parentElement === p.parent }; }).catch(() => null);
    fs.writeFileSync(info.outputPath("final-state.json"), JSON.stringify({ state, provider: fs.readFileSync(path.join(vault, "Source.md"), "utf8"), board: fs.readFileSync(path.join(vault, "Board.canvas"), "utf8") }, null, 2));
    await page.screenshot({ path: info.outputPath("toolbar-reachability.png") }).catch(() => {});
    await application.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
