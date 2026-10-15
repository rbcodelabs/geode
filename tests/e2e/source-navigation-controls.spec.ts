import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page, type TestInfo } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "../.."), provider = "---\npriority: 2\n---\n\nOriginal source\n";
async function isolated(info: TestInfo, kind: "link" | "base" | "recovery", linktext: string, reused: boolean, run: (page: Page, vault: string) => Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "geode-navigation-controls-"));
  const vault = path.join(directory, "vault"), profile = path.join(directory, "profile"); fs.mkdirSync(vault); fs.mkdirSync(profile);
  const board = JSON.stringify({ nodes: kind === "recovery" ? [] : [{ id: "owned", type: "file", x: 0, y: 0, width: kind === "base" ? 760 : 500, height: kind === "base" ? 600 : 200, file: "Host.md" }], edges: [] });
  const files = { "Source.md": provider, "Other.md": "# Heading\n\nDestination\n", "Unrelated.md": "# Unrelated\n", "Outer.md": "# Outer\n\n![[Board.canvas]]\n", "Host.md": kind === "base" ? "![[Tasks.base]]\n" : `An authored child link.\n\n[[${linktext}]]\n`, "Tasks.base": 'filters: file.name == "Source.md" || file.name == "Other.md"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - note.priority\n', "Board.canvas": board, "Recovery.canvas": board };
  for (const [name, value] of Object.entries(files)) fs.writeFileSync(path.join(vault, name), value);
  fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const application = await electron.launch({ args: [repoRoot, `--user-data-dir=${profile}`], cwd: repoRoot }); const page = await application.firstWindow();
  try {
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
    if (reused) await page.evaluate(async () => {
      const app = (window as any).app, leaf = app.workspace.getLeaf(true);
      await app.openFileInLeaf(leaf, app.vault.getFileByPath("Other.md")); (window as any).__reusedDestination = leaf;
    });
    if (reused) await page.evaluate(async () => {
      const app = (window as any).app, source = app.workspace.getLeaf(true);
      await app.openFileInLeaf(source, app.vault.getFileByPath("Outer.md")); source.group.setActiveLeaf(source);
      if (source === (window as any).__reusedDestination || (window as any).__reusedDestination.view.getFile().path !== "Other.md") throw new Error("Expected distinct source and existing destination leaves");
    });
    else await page.locator(`.nav-file-title[data-path="${kind === "recovery" ? "Board.canvas" : "Outer.md"}"]`).click();
    if (kind !== "recovery") await page.getByRole("button", { name: "Toggle reading view (Cmd/Ctrl+E)" }).click();
    await page.waitForFunction(() => {
      const app = (window as any).app, leaf = app.workspace.getActiveLeaf();
      return !!leaf?.view?.sourceNavigation;
    });
    await page.evaluate(() => {
      const app = (window as any).app, source = app.workspace.getActiveLeaf(), navigation = source.view.sourceNavigation;
      const probe = { source, originalView: source.view, intents: [] as { request: unknown; state: string; terminal: string | null }[] };
      (window as any).__navigationControls = probe;
      const prepare = navigation.prepareNavigation.bind(navigation);
      navigation.prepareNavigation = (...args: any[]) => {
        const intent = prepare(...args), record = { request: args[0].kind === "file" ? { kind: "file", path: args[0].file.path, newTab: args[0].newTab } : args[0], state: intent.state, terminal: null as string | null };
        probe.intents.push(record); void intent.completion.then((result: { status: string }) => { record.terminal = result.status; }); return intent;
      };
    });
    await run(page, vault);
  } finally {
    const state = await page.evaluate(() => { const p = (window as any).__navigationControls, app = (window as any).app; return p && { intents: p.intents, sourceFile: p.source.view?.getFile?.()?.path, activeFile: app.workspace.getActiveLeaf()?.view?.getFile?.()?.path, originalConnected: p.originalView.containerEl.isConnected }; }).catch(() => null);
    fs.writeFileSync(info.outputPath("final-state.json"), JSON.stringify({ state, provider: fs.readFileSync(path.join(vault, "Source.md"), "utf8"), board: fs.readFileSync(path.join(vault, "Board.canvas"), "utf8") }, null, 2));
    await page.screenshot({ path: info.outputPath("navigation-controls.png") }).catch(() => {});
    await application.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}
async function actualLink(page: Page, linktext: string, newTab: boolean) {
  const link = page.locator(".canvas-embed-view:visible").locator('a.internal-link').filter({ hasText: linktext.split("#")[0] });
  await expect(link).toHaveCount(1);
  const point = await link.evaluate(el => { const r = el.getBoundingClientRect(), point = { x: r.x + r.width / 2, y: r.y + r.height / 2 }; return { ...point, owned: el.contains(document.elementFromPoint(point.x, point.y)) }; });
  expect(point.owned).toBe(true);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  if (newTab) await page.keyboard.down(modifier);
  try { await page.mouse.click(point.x, point.y); } finally { if (newTab) await page.keyboard.up(modifier); }
  await expect.poll(() => page.evaluate(() => (window as any).__navigationControls.intents.map((intent: any) => intent.terminal))).toEqual(["completed"]);
}
for (const scenario of [
  { name: "fresh target in its source pane", link: "Other", reused: false, newTab: false, target: "Other.md", foreignActive: false },
  { name: "source pane while another split is active", link: "Other", reused: false, newTab: false, target: "Other.md", foreignActive: true },
  { name: "existing destination without replacing the source", link: "Other", reused: true, newTab: false, target: "Other.md" },
  { name: "modifier new-tab target", link: "Other", reused: false, newTab: true, target: "Other.md" },
  { name: "missing target creation", link: "Missing", reused: false, newTab: false, target: "Missing.md" },
  { name: "awaited heading reveal", link: "Other#Heading", reused: false, newTab: false, target: "Other.md" },
]) test(`clean native child navigation completes ${scenario.name}`, async ({}, info) => {
  await isolated(info, "link", scenario.link, scenario.reused, async (page, vault) => {
    if (scenario.foreignActive) {
      await page.evaluate(async () => {
        const app = (window as any).app, other = app.workspace.getLeaf("split", "vertical");
        await app.openFileInLeaf(other, app.vault.getFileByPath("Unrelated.md")); other.group.setActiveLeaf(other);
      });
      expect(await page.evaluate(() => (window as any).app.workspace.getActiveLeaf().view.getFile().path)).toBe("Unrelated.md");
    }
    await actualLink(page, scenario.link, scenario.newTab);
    expect(await page.evaluate(() => (window as any).app.workspace.getActiveLeaf()?.view?.getFile?.()?.path)).toBe(scenario.target);
    if (scenario.newTab || scenario.reused) expect(await page.evaluate(() => (window as any).__navigationControls.source.view.getFile().path)).toBe("Outer.md");
    if (scenario.reused) expect(await page.evaluate(() => (window as any).app.workspace.getActiveLeaf() === (window as any).__reusedDestination)).toBe(true);
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(provider);
    if (scenario.link === "Missing") expect(fs.readFileSync(path.join(vault, "Missing.md"), "utf8")).toBe("");
  });
});

test("Base filename selection deliberately saves before a separate clean double-click navigation", async ({}, info) => {
  await isolated(info, "base", "", false, async (page, vault) => {
    const table = page.locator(".canvas-embed-view:visible .bases-table"); await expect(table).toBeVisible();
    await expect(table.locator(".bases-data-row")).toHaveCount(2);
    const column = (await table.locator("thead th").allTextContents()).indexOf("note.priority"); expect(column).toBeGreaterThan(-1);
    const source = table.locator(".bases-data-row", { hasText: "Source" }).locator("td.bases-cell").nth(column);
    expect(await source.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })).toBe(true);
    await source.click(); await page.keyboard.press("Enter"); await source.locator("input").fill("9");
    const other = table.locator(".bases-data-row", { hasText: "Other" }).locator("td.bases-cell").first();
    await other.click();
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(provider.replace("priority: 2", "priority: 9"));
    expect(await page.evaluate(() => (window as any).__navigationControls.intents)).toEqual([]);
    await expect(table.locator(".bases-data-row", { hasText: "Source" }).locator("td.bases-cell").nth(column)).toHaveText("9");
    await other.dblclick();
    await expect.poll(() => page.evaluate(() => (window as any).__navigationControls.intents.map((intent: any) => intent.terminal))).toEqual(["completed"]);
    expect(await page.evaluate(() => (window as any).__navigationControls.source.view.getFile().path)).toBe("Other.md");
  });
});

test("explicit Canvas recovery-copy access remains usable without changing provider bytes", async ({}, info) => {
  await isolated(info, "recovery", "", false, async (page, vault) => {
    const original = fs.readFileSync(path.join(vault, "Board.canvas"), "utf8"), recovery = fs.readFileSync(path.join(vault, "Recovery.canvas"), "utf8");
    await page.evaluate(() => { const view = (window as any).__navigationControls.originalView; view.presentConflict(null, "Recovery.canvas", true); });
    await page.getByRole("button", { name: "Open local conflict copy", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).app.workspace.getActiveLeaf()?.view?.getFile?.()?.path)).toBe("Recovery.canvas");
    expect(fs.readFileSync(path.join(vault, "Board.canvas"), "utf8")).toBe(original);
    expect(fs.readFileSync(path.join(vault, "Recovery.canvas"), "utf8")).toBe(recovery);
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(provider);
    expect(await page.evaluate(() => (window as any).__navigationControls.originalView.containerEl.isConnected)).toBe(true);
  });
});
