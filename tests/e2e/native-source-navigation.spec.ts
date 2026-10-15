import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

// Production renderer witness. No prototype layer, injected guard or forced click.
const repoRoot = path.resolve(__dirname, "../..");
const source = "---\npriority: 2\n---\n\nOriginal source\n";

test("production native child navigation refuses before incidental draft blur", async ({}, info) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "geode-source-navigation-"));
  const vault = path.join(directory, "vault"), profile = path.join(directory, "profile");
  fs.mkdirSync(vault); fs.mkdirSync(profile);
  const outer = "# Outer\n\n![[Board.canvas]]\n";
  const files: Record<string, string> = {
    "Source.md": source,
    "Other.md": "# Destination\n",
    "Outer.md": outer,
    "Host.md": "# Native child navigation\n\n![[Tasks.base]]\n\nAn authored paragraph separates this link from the table controls.\n\n[[Other]]\n",
    "Tasks.base": "views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - note.priority\n",
    "Board.canvas": JSON.stringify({ nodes: [{ id: "owned", type: "file", x: 0, y: 0, width: 760, height: 600, file: "Host.md" }], edges: [] }),
  };
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(vault, name), value);
  fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${profile}`], cwd: repoRoot });
  const page = await app.firstWindow();
  try {
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
    await page.locator('.nav-file-title[data-path="Outer.md"]').click();
    await page.getByRole("button", { name: "Toggle reading view (Cmd/Ctrl+E)" }).click();
    const root = page.locator(".canvas-embed-view:visible");
    const table = root.locator(".bases-table");
    await expect(table).toBeVisible();
    const column = (await table.locator("thead th").allTextContents()).indexOf("note.priority");
    expect(column).toBeGreaterThan(-1);
    const cell = table.locator(".bases-data-row", { hasText: "Source" }).locator("td.bases-cell").nth(column);
    await expect(cell).toHaveText("2");
    const phase = async (name: string) => page.evaluate(name => {
      const root = document.querySelector(".canvas-embed-view")!, note = root.querySelector(".canvas-node-note")!, table = root.querySelector(".bases-table")!, link = root.querySelector('a.internal-link[data-href="Other"]')!;
      const describe = (el: Element | null) => el && { tag: el.tagName, className: el.className, rect: el.getBoundingClientRect().toJSON(), scrollTop: el.scrollTop, scrollLeft: el.scrollLeft, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, style: { overflow: getComputedStyle(el).overflow, overflowX: getComputedStyle(el).overflowX, overflowY: getComputedStyle(el).overflowY, height: getComputedStyle(el).height }, tabindex: el.getAttribute("tabindex") };
      const ancestors = []; for (let parent: Element | null = link; parent && ancestors.length < 12; parent = parent.parentElement) ancestors.push(describe(parent));
      const owner = (window as any).app.workspace.getActiveLeaf().view;
      const canvas = owner.renderOwner.writers().find((writer: any) => writer.viewType === "canvas");
      if (!canvas) throw new Error("Actual Canvas writer required for geometry attribution");
      const stages = ((window as any).__sourceNavigationPhases ??= []);
      stages.push({ name, ancestors, input: describe(root.querySelector(".bases-cell-input")), root: describe(root), note: describe(note), table: describe(table), link: describe(link), surface: describe(root.querySelector(".canvas-surface")), active: describe(document.activeElement), camera: canvas && { pan: { ...canvas.pan }, scale: canvas.scale, selectedIds: [...canvas.selectedIds] } });
    }, name);
    await phase("before-cell-click");
    await cell.click(); await phase("after-cell-click");
    await page.keyboard.press("Enter"); await phase("after-Enter");
    const input = cell.locator(".bases-cell-input");
    await expect(input).toBeVisible(); await input.fill("9"); await phase("after-fill");
    await input.evaluate(el => {
      const app = (window as any).app, owner = app.workspace.getActiveLeaf();
      const root = el.closest(".canvas-embed-view")!;
      const probe = { input: el, root, parent: root.parentElement, owner, blur: 0, attempted: false, settled: false, sourceLeafId: null as string | null };
      el.addEventListener("blur", () => probe.blur++);
      (window as any).__sourceNavigation = probe;
      const open = app.openLink.bind(app);
      app.openLink = async (...args: any[]) => {
        if (args[0] !== "Other") return open(...args);
        probe.attempted = true; probe.sourceLeafId = args[3]?.id ?? null;
        try { return await open(...args); } finally { probe.settled = true; }
      };
    });
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source);
    const wheelPoint = await input.evaluate(el => {
      const rect = el.getBoundingClientRect(), point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const owned = document.elementFromPoint(point.x, point.y) === el;
      (window as any).__sourceNavigation.wheel = { point, owned }; return { point, owned };
    });
    expect(wheelPoint.owned, "The one ordinary wheel must target the actual visible native input").toBe(true);
    await phase("before-trusted-wheel");
    const panBefore = await page.evaluate(() => (window as any).__sourceNavigationPhases.at(-1).camera.pan.y);
    await page.mouse.move(wheelPoint.point.x, wheelPoint.point.y);
    await page.mouse.wheel(0, 120);
    await expect.poll(() => page.evaluate(() => {
      const owner = (window as any).__sourceNavigation.owner;
      return owner.view.renderOwner.writers().find((writer: any) => writer.viewType === "canvas").pan.y;
    })).not.toBe(panBefore);
    await phase("after-trusted-wheel");
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source);
    expect(await page.evaluate(() => {
      const p = (window as any).__sourceNavigation;
      return { connected: p.input.isConnected, value: p.input.value, blur: p.blur, focused: document.activeElement === p.input };
    })).toEqual({ connected: true, value: "9", blur: 0, focused: true });
    const link = root.locator('a.internal-link[data-href="Other"]');
    await expect(link).toHaveCount(1);
    const hit = await link.evaluate(el => {
      const r = el.getBoundingClientRect(), point = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      const actual = document.elementFromPoint(point.x, point.y);
      const result = { point, rect: r.toJSON(), owned: !!actual && el.contains(actual), hit: actual && { tag: actual.tagName, className: actual.className } };
      (window as any).__sourceNavigation.hit = result;
      el.addEventListener("click", event => { (window as any).__sourceNavigation.actualClick = { trusted: event.isTrusted, prevented: event.defaultPrevented }; }, { capture: true, once: true });
      return result;
    });
    expect(hit.owned, "The literal production child link must receive the real pointer before navigation claims").toBe(true);
    await page.mouse.click(hit.point.x, hit.point.y);
    expect(await page.evaluate(() => (window as any).__sourceNavigation.actualClick?.trusted)).toBe(true);
    // Drain the actual callback when entered; refusal need not call App.openLink.
    await expect.poll(() => page.evaluate(() => { const p = (window as any).__sourceNavigation; return !p.attempted || p.settled; })).toBe(true);
    // Bytes first: blur-save must not manufacture a successful replacement preflight.
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source);
    expect(await page.evaluate(() => {
      const p = (window as any).__sourceNavigation, app = (window as any).app;
      return { connected: p.input.isConnected, value: p.input.value, sameParent: p.root.parentElement === p.parent,
        rootConnected: p.root.isConnected, blur: p.blur, ownerFile: p.owner.view.getFile()?.path,
        activeOwner: app.workspace.getActiveLeaf() === p.owner };
    })).toEqual({ connected: true, value: "9", sameParent: true, rootConnected: true, blur: 0, ownerFile: "Outer.md", activeOwner: true });
    expect(fs.readFileSync(path.join(vault, "Outer.md"), "utf8")).toBe(outer);
  } finally {
    const state = await page.evaluate(() => {
      const p = (window as any).__sourceNavigation; if (!p) return null;
      return { phases: (window as any).__sourceNavigationPhases, wheel: p.wheel, hit: p.hit, actualClick: p.actualClick, attempted: p.attempted, settled: p.settled, sourceLeafId: p.sourceLeafId, blur: p.blur,
        inputConnected: p.input.isConnected, value: p.input.value, rootConnected: p.root.isConnected,
        sameParent: p.root.parentElement === p.parent, ownerFile: p.owner.view.getFile()?.path };
    }).catch(() => null);
    fs.writeFileSync(info.outputPath("final-state.json"), JSON.stringify({ state, originalProvider: source, provider: fs.readFileSync(path.join(vault, "Source.md"), "utf8") }, null, 2));
    await page.screenshot({ path: info.outputPath("navigation.png") }).catch(() => {});
    await app.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
