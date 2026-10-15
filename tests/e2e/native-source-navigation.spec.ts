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
    "Host.md": "# Native child navigation\n\nAn authored paragraph separates this link from the Canvas controls.\n\n[[Other]]\n\n![[Tasks.base]]\n",
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
    await cell.click(); await page.keyboard.press("Enter");
    const input = cell.locator(".bases-cell-input");
    await expect(input).toBeVisible(); await input.fill("9");
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
      return { hit: p.hit, actualClick: p.actualClick, attempted: p.attempted, settled: p.settled, sourceLeafId: p.sourceLeafId, blur: p.blur,
        inputConnected: p.input.isConnected, value: p.input.value, rootConnected: p.root.isConnected,
        sameParent: p.root.parentElement === p.parent, ownerFile: p.owner.view.getFile()?.path };
    }).catch(() => null);
    fs.writeFileSync(info.outputPath("final-state.json"), JSON.stringify({ state, originalProvider: source, provider: fs.readFileSync(path.join(vault, "Source.md"), "utf8") }, null, 2));
    await page.screenshot({ path: info.outputPath("navigation.png") }).catch(() => {});
    await app.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
