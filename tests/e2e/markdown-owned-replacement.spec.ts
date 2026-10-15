import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page, type TestInfo } from "@playwright/test";

// Actual explicit-replacement regressions: normal input events, native views, synthetic files.
// Entry assertions precede lifetime actions so entry failures cannot masquerade
// as a detached-writer finding. No production guard or handler is replaced.
const repoRoot = path.resolve(__dirname, "../..");
const originalSource = "---\npriority: 2\n---\n\nOriginal source\n";
type Mode = "Reading" | "Live Preview";
type Gesture = "double-click" | "selected-cell Enter";

async function snapshot(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const probe = (window as any).__nestedWitness;
    const view = (window as any).app.workspace.getActiveLeaf().view;
    const writers = view.renderOwner?.writers() ?? [];
    const describe = (el: Element | null) => el ? { tag: el.tagName, class: el.className, connected: el.isConnected } : null;
    return {
      active: describe(document.activeElement), events: probe.events, actionError: probe.actionError,
      sameCell: probe.cell === document.querySelector('[data-nested-witness-cell]'),
      cellConnected: probe.cell?.isConnected, cellText: probe.cell?.textContent,
      input: probe.cell?.querySelector("input")?.value ?? null,
      capturedInputConnected: probe.input?.isConnected ?? null,
      capturedInputValue: probe.input?.value ?? null,
      writers: writers.map((writer: any) => ({
        type: writer.viewType, path: writer.file?.path, connected: writer.containerEl?.isConnected,
        readOnly: writer.tableView?.readOnly, editing: writer.tableView?.editing,
        sourceEdit: writer.sourceEdit && { file: writer.sourceEdit.file.path, rawText: writer.sourceEdit.rawText },
        scope: writer.renderOwner && { state: writer.renderOwner.state, generation: writer.renderOwner.generation, admission: writer.renderOwner.admissionAllowed },
        vaultSwitching: writer.vaultSwitching, conflict: writer.conflictReadOnly,
      })),
    };
  });
}

async function attachSnapshot(page: Page, info: TestInfo, name: string): Promise<void> {
  const destination = info.outputPath(name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(await snapshot(page), null, 2));
  await info.attach(name, { path: destination, contentType: "application/json" });
}

async function withEntry(mode: Mode, gesture: Gesture, info: TestInfo, run?: (page: Page, vault: string) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "geode-nested-witness-"));
  const vault = path.join(directory, "vault");
  const profile = path.join(directory, "profile");
  fs.mkdirSync(vault); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(vault, "Source.md"), originalSource);
  fs.writeFileSync(path.join(vault, "Tasks.base"), "views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - note.priority\n");
  fs.writeFileSync(path.join(vault, "Host.md"), "![[Tasks.base]]\n");
  fs.writeFileSync(path.join(vault, "Outer.md"), "# Outer\n\n![[Board.canvas]]\n\nEnd\n" + "\nParagraph for viewport movement.\n".repeat(250));
  fs.writeFileSync(path.join(vault, "Board.canvas"), JSON.stringify({ nodes: [{ id: "owned", type: "file", x: 0, y: 0, width: 760, height: 600, file: "Host.md" }], edges: [] }));
  fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${profile}`], cwd: repoRoot });
  const page = await app.firstWindow();
  try {
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
    await page.locator('.nav-file-title[data-path="Outer.md"]').click();
    if (mode === "Reading") await page.getByRole("button", { name: "Toggle reading view (Cmd/Ctrl+E)" }).click();
    const table = page.locator(".canvas-embed-view:visible .bases-table");
    await expect(table).toBeVisible();
    const column = (await table.locator("thead th").allTextContents()).indexOf("note.priority");
    expect(column).toBeGreaterThan(-1);
    const cell = table.locator(".bases-data-row", { hasText: "Source" }).locator("td.bases-cell").nth(column);
    await expect(cell).toHaveText("2");
    await cell.evaluate(el => {
      el.setAttribute("data-nested-witness-cell", "");
      const probe = { cell: el, input: null, events: [] as unknown[] };
      (window as any).__nestedWitness = probe;
      for (const capture of [true, false]) for (const name of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "keydown", "focusin", "focusout"]) {
        document.addEventListener(name, event => {
          if (probe.events.length >= 200) return;
          const target = event.target as HTMLElement;
          probe.events.push({ event: name, capture, time: performance.now(), trusted: event.isTrusted, prevented: event.defaultPrevented, target: target.tagName + "." + target.className, key: (event as KeyboardEvent).key, cellConnected: el.isConnected, input: el.querySelector("input")?.value ?? null, active: (document.activeElement as HTMLElement)?.className });
        }, capture);
      }
    });
    await attachSnapshot(page, info, "before-entry.json");
    if (gesture === "double-click") await cell.dblclick();
    else { await cell.click(); await page.keyboard.press("Enter"); }
    const input = cell.locator(".bases-cell-input");
    await expect(input, "Real user gesture must enter the Base editor before any lifetime claim").toBeVisible();
    await input.fill("9");
    await input.evaluate(el => { (window as any).__nestedWitness.input = el; });
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(originalSource);
    await attachSnapshot(page, info, "valid-entry.json");
    if (run) await run(page, vault);
    else {
      await input.press("Enter");
      await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toContain("priority: 9");
    }
  } finally {
    await attachSnapshot(page, info, "final-state.json").catch(() => {});
    await page.screenshot({ path: info.outputPath("nested-entry.png") }).catch(() => {});
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("nested lifetime: Reading refresh preserves a valid connected Base draft", async ({}, info) => {
  await withEntry("Reading", "selected-cell Enter", info, async (page, vault) => {
    await page.evaluate(async () => {
      try { await (window as any).app.workspace.getActiveLeaf().view.renderReading(); }
      catch (error) { (window as any).__nestedWitness.actionError = String(error); }
    });
    const after = {
      source: fs.readFileSync(path.join(vault, "Source.md"), "utf8"),
      controls: await page.evaluate(() => {
        const input = (window as any).__nestedWitness.input;
        return { connected: input.isConnected, value: input.value };
      }),
    };
    fs.writeFileSync(info.outputPath("post-action.json"), JSON.stringify(after, null, 2));
    expect(after.source).toBe(originalSource);
    expect(after.controls).toEqual({ connected: true, value: "9" });
    await page.screenshot({ path: info.outputPath("retained-draft-before-submit.png") });
    await page.locator('[data-nested-witness-cell] .bases-cell-input').press("Enter");
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(originalSource.replace("priority: 2", "priority: 9"));
    await expect(page.locator(".canvas-embed-view:visible .bases-table .bases-data-row", { hasText: "Source" }).locator("td.bases-cell").nth(1)).toHaveText("9");
  });
});

test("nested lifetime: Live Preview reconfiguration preserves a valid connected Base draft", async ({}, info) => {
  await withEntry("Live Preview", "selected-cell Enter", info, async (page, vault) => {
    await page.evaluate(async () => {
      try { await (window as any).app.workspace.getActiveLeaf().view.toggleSource(); }
      catch (error) { (window as any).__nestedWitness.actionError = String(error); }
    });
    const after = {
      source: fs.readFileSync(path.join(vault, "Source.md"), "utf8"),
      controls: await page.evaluate(() => {
        const input = (window as any).__nestedWitness.input;
        return { connected: input.isConnected, value: input.value };
      }),
    };
    fs.writeFileSync(info.outputPath("post-action.json"), JSON.stringify(after, null, 2));
    expect(after.source).toBe(originalSource);
    expect(after.controls).toEqual({ connected: true, value: "9" });
    await page.screenshot({ path: info.outputPath("retained-draft-before-submit.png") });
    await page.locator('[data-nested-witness-cell] .bases-cell-input').press("Enter");
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(originalSource.replace("priority: 2", "priority: 9"));
    await expect(page.locator(".canvas-embed-view:visible .bases-table .bases-data-row", { hasText: "Source" }).locator("td.bases-cell").nth(1)).toHaveText("9");
  });
});


test("nested lifetime: source header pointer preserves the focused Base draft before mode replacement", async ({}, info) => {
  await withEntry("Live Preview", "selected-cell Enter", info, async (page, vault) => {
    await page.getByRole("button", { name: "Toggle Live Preview / Source mode" }).click();
    const input = page.locator('[data-nested-witness-cell] .bases-cell-input');
    await expect(input).toBeFocused(); await expect(input).toHaveValue("9");
    expect(await page.evaluate(() => (window as any).app.workspace.getActiveLeaf().view.mode)).toBe("live");
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(originalSource);
    await input.press("Enter");
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(originalSource.replace("priority: 2", "priority: 9"));
    await expect(page.locator(".canvas-embed-view:visible .bases-table .bases-data-row", { hasText: "Source" }).locator("td.bases-cell").nth(1)).toHaveText("9");
  });
});
