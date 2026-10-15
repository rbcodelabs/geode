import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "../..");
const source = "---\npriority: 2\n---\n\nOriginal source\n";
const base = "views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - note.priority\n";

async function withDraft(kind: "text" | "file", nested: boolean, run: (page: Page, vault: string) => Promise<void>, reading = false, mobile = false): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-owned-"));
  const vault = path.join(directory, "vault"); const profile = path.join(directory, "profile");
  fs.mkdirSync(vault); fs.mkdirSync(profile);
  fs.writeFileSync(path.join(vault, "Source.md"), source);
  fs.writeFileSync(path.join(vault, "Tasks.base"), base);
  fs.writeFileSync(path.join(vault, "Host.md"), "![[Tasks.base]]\n");
  fs.writeFileSync(path.join(vault, "Replacement.md"), "# Replacement note\n");
  fs.writeFileSync(path.join(vault, "Outer.md"), "# Outer\n\n![[Board.canvas]]\n\nEnd\n");
  const node = { id: "owned", type: kind, x: 0, y: 0, width: 760, height: 600, ...(kind === "text" ? { text: "![[Tasks.base]]" } : { file: "Host.md" }) };
  fs.writeFileSync(path.join(vault, "Board.canvas"), JSON.stringify({ nodes: [node], edges: [] }));
  fs.writeFileSync(path.join(profile, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${profile}`], cwd: repoRoot });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady === true);
    if (mobile) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => document.body.classList.add("is-mobile"));
    }
    await page.evaluate(async ({ target, reading }) => {
      const app = (window as any).app; await app.openFile(app.vault.getFileByPath(target));
      if (reading) await app.workspace.getActiveLeaf().view.toggleMode();
    }, { target: nested ? "Outer.md" : "Board.canvas", reading });
    await page.waitForFunction(() => {
      const view = (window as any).app.workspace.getActiveLeaf().view;
      return view.viewType === "canvas" || view.renderOwner.writers().some((writer: any) => writer.viewType === "canvas" && writer.containerEl.getClientRects().length > 0);
    });
    await page.evaluate(() => {
      const app = (window as any).app;
      const view = app.workspace.getActiveLeaf().view;
      const canvas = view.viewType === "canvas" ? view : view.renderOwner.writers().find((writer: any) => writer.viewType === "canvas" && writer.containerEl.getClientRects().length > 0);
      (window as any).__canvasOwned = { canvas };
    });
    const row = page.locator(".canvas-view:visible .bases-data-row", { hasText: "Source" });
    await expect(row).toBeVisible();
    const headers = await page.locator(".canvas-view:visible .bases-table thead th").allTextContents();
    const column = headers.indexOf("note.priority"); expect(column).toBeGreaterThan(-1);
    const cell = row.locator("td.bases-cell").nth(column);
    await cell.dblclick();
    await expect(cell.locator(".bases-cell-input")).toBeVisible({ timeout: 1500 });
    await cell.locator(".bases-cell-input").fill("9");
    await page.evaluate(() => {
      const probe = (window as any).__canvasOwned;
      probe.input = document.activeElement; probe.wrapper = probe.input.closest(".canvas-node");
      probe.original = JSON.stringify(probe.canvas.document); probe.undo = JSON.stringify(probe.canvas.undoStack);
      probe.canvas.selectedIds.add("owned"); probe.selection = [...probe.canvas.selectedIds];
    });
    await run(page, vault);
  } finally {
    await app.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const kind of ["text", "file"] as const) {
  test(`Canvas ${kind} geometry redraw keeps the actual embedded Base draft connected without blur or writes`, async () => {
    await withDraft(kind, false, async (page, vault) => {
      await page.evaluate(() => {
        const probe = (window as any).__canvasOwned;
        probe.canvas.document.nodes[0].x += 15; probe.canvas.document.nodes[0].width += 20; probe.canvas.render();
      });
      expect(await page.evaluate(() => {
        const probe = (window as any).__canvasOwned;
        return { connected: probe.input.isConnected, sameFocus: document.activeElement === probe.input, sameWrapper: probe.input.closest(".canvas-node") === probe.wrapper, value: probe.input.value };
      })).toEqual({ connected: true, sameFocus: true, sameWrapper: true, value: "9" });
      expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source);
    });
  });

  for (const action of (kind === "text" ? ["delete", "source", "load", "undo"] : ["delete", "load", "undo"]) as readonly string[]) {
    test(`Canvas ${kind} ${action} refuses before mutating a presentation with an actual Base draft`, async () => {
      await withDraft(kind, false, async (page, vault) => {
        const savedBoard = fs.readFileSync(path.join(vault, "Board.canvas"), "utf8");
        await page.evaluate(async action => {
          const probe = (window as any).__canvasOwned; const canvas = probe.canvas;
          if (action === "delete") await canvas.deleteSelection();
          else if (action === "source") await canvas.editTextNode(probe.wrapper, canvas.document.nodes[0]);
          else if (action === "load") await canvas.load(JSON.stringify({ nodes: [], edges: [] }), true);
          else { canvas.undoStack.push(JSON.stringify({ nodes: [], edges: [] })); probe.undo = JSON.stringify(canvas.undoStack); await canvas.restoreHistory("undo"); }
        }, action);
        expect(await page.evaluate(() => {
          const probe = (window as any).__canvasOwned;
          return { connected: probe.input.isConnected, value: probe.input.value, sameDocument: JSON.stringify(probe.canvas.document) === probe.original, sameUndo: JSON.stringify(probe.canvas.undoStack) === probe.undo, sameSelection: JSON.stringify([...probe.canvas.selectedIds]) === JSON.stringify(probe.selection) };
        })).toEqual({ connected: true, value: "9", sameDocument: true, sameUndo: true, sameSelection: true });
        expect(fs.readFileSync(path.join(vault, "Board.canvas"), "utf8")).toBe(savedBoard);
        expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source);
        await expect(page.locator(".notice").filter({ hasText: /finish|cancel|draft/i })).toBeVisible();
        await page.locator(".canvas-node .bases-cell-input").press("Enter");
        await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toContain("priority: 9");
      });
    });
  }
}


test("Canvas file picker preserves normal blur commit before replacing the selected target", async () => {
  await withDraft("file", false, async (page, vault) => {
    await page.evaluate(() => (window as any).__canvasOwned.canvas.openSwapFilePicker("owned", "note"));
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source.replace("priority: 2", "priority: 9"));
    await page.locator(".modal").getByText("Replacement.md", { exact: true }).click();
    await expect.poll(() => {
      try { return JSON.parse(fs.readFileSync(path.join(vault, "Board.canvas"), "utf8")).nodes[0].file; }
      catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }).toBe("Replacement.md");
    await expect(page.locator(".canvas-node-note")).toContainText("Replacement note");
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source.replace("priority: 2", "priority: 9"));
  });
});

for (const activation of ["mouse", "keyboard"] as const) {
test(`Canvas conflict refusal keeps the actual failed child ${activation} Retry reachable and saves its latest draft`, async () => {
  await withDraft("file", false, async (page, vault) => {
    await page.evaluate(() => {
      const app = (window as any).app; const probe = (window as any).__canvasOwned;
      probe.originalModify = app.vault.modify.bind(app.vault); probe.successfulSourceWrites = 0;
      probe.editCalls = [];
      const base = probe.canvas.renderOwner.writers().find((writer: any) => writer.viewType === "base");
      const editCell = base.editCell.bind(base);
      base.editCell = (...args: any[]) => { probe.editCalls.push({ retry: args[3] === true, raw: args[2] }); return editCell(...args); };
      app.vault.modify = (file: any, text: string) => file.path === "Source.md" ? Promise.reject(new Error("row save rejected")) : probe.originalModify(file, text);
    });
    await page.locator(".canvas-node .bases-cell-input").press("Enter");
    await expect(page.getByRole("button", { name: "Retry Base save" })).toBeVisible();
    await page.evaluate(() => (window as any).__canvasOwned.canvas.presentConflict(null, null, true));
    await expect(page.locator(".notice").filter({ hasText: /finish|cancel|draft/i })).toBeVisible();
    expect(await page.evaluate(() => {
      const probe = (window as any).__canvasOwned;
      return probe.input.isConnected && !probe.canvas.surfaceEl.inert && probe.canvas.conflictReadOnly && JSON.stringify(probe.canvas.document) === probe.original;
    })).toBe(true);
    await page.evaluate(() => {
      const app = (window as any).app; const probe = (window as any).__canvasOwned;
      app.vault.modify = (file: any, text: string) => { if (file.path === "Source.md") probe.successfulSourceWrites++; return probe.originalModify(file, text); };
    });
    await page.locator(".canvas-node .bases-cell-input").fill("10");
    const retry = page.getByRole("button", { name: "Retry Base save" });
    if (activation === "keyboard") {
      await retry.focus();
      expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source);
      await retry.press("Enter");
    } else await retry.click();
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source.replace("priority: 2", "priority: 10"));
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as any).__canvasOwned;
      return { writes: probe.successfulSourceWrites, pending: probe.canvas.renderOwner.hasUnacknowledgedWrites };
    })).toEqual({ writes: 1, pending: false });
    expect(await page.evaluate(() => (window as any).__canvasOwned.editCalls)).toEqual([{ retry: false, raw: "9" }, { retry: true, raw: "10" }]);
  });
});
}

test("Canvas history refuses new user drafts until a delayed rejected board write restores usable controls", async () => {
  await withDraft("file", false, async (page, vault) => {
    await page.locator(".canvas-node .bases-cell-input").press("Escape");
    const savedBoard = fs.readFileSync(path.join(vault, "Board.canvas"), "utf8");
    await page.evaluate(() => {
      const app = (window as any).app; const probe = (window as any).__canvasOwned;
      const original = app.vault.modify.bind(app.vault);
      app.vault.modify = (file: any, text: string) => file.path === "Board.canvas" ? new Promise((_resolve, reject) => { probe.rejectHistory = reject; }) : original(file, text);
      probe.canvas.undoStack.push(JSON.stringify({ nodes: [], edges: [] }));
      probe.undo = JSON.stringify(probe.canvas.undoStack);
      probe.history = probe.canvas.restoreHistory("undo").then(() => "saved", (error: Error) => error.message);
    });
    await page.waitForFunction(() => !!(window as any).__canvasOwned.rejectHistory);
    expect(await page.evaluate(() => (window as any).__canvasOwned.canvas.containerEl.inert)).toBe(true);
    const row = page.locator(".canvas-view .bases-data-row", { hasText: "Source" });
    const headers = await page.locator(".canvas-view .bases-table thead th").allTextContents();
    await expect(row.locator("td.bases-cell").nth(headers.indexOf("note.priority")).dblclick({ timeout: 300 })).rejects.toThrow();
    await expect(page.locator(".canvas-view .bases-cell-input")).toHaveCount(0);
    await page.evaluate(() => (window as any).__canvasOwned.rejectHistory(new Error("history write rejected")));
    expect(await page.evaluate(() => (window as any).__canvasOwned.history)).toBe("history write rejected");
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as any).__canvasOwned;
      return !probe.canvas.containerEl.inert && JSON.stringify(probe.canvas.document) === probe.original && JSON.stringify(probe.canvas.undoStack) === probe.undo;
    })).toBe(true);
    expect(fs.readFileSync(path.join(vault, "Board.canvas"), "utf8")).toBe(savedBoard);
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source);
    await row.locator("td.bases-cell").nth(headers.indexOf("note.priority")).dblclick();
    await page.locator(".canvas-view .bases-cell-input").fill("9");
    await page.locator(".canvas-view .bases-cell-input").press("Enter");
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source.replace("priority: 2", "priority: 9"));
  });
});

test("Canvas rejected history preserves recovery through actual cell click and Enter", async () => {
  await withDraft("file", false, async (page, vault) => {
    await page.locator(".canvas-node .bases-cell-input").press("Escape");
    const savedBoard = fs.readFileSync(path.join(vault, "Board.canvas"), "utf8");
    await page.evaluate(() => {
      const app = (window as any).app; const probe = (window as any).__canvasOwned;
      const original = app.vault.modify.bind(app.vault);
      app.vault.modify = (file: any, text: string) => file.path === "Board.canvas" ? new Promise((_resolve, reject) => { probe.rejectHistory = reject; }) : original(file, text);
      probe.canvas.undoStack.push(JSON.stringify({ nodes: [], edges: [] }));
      probe.undo = JSON.stringify(probe.canvas.undoStack);
      probe.history = probe.canvas.restoreHistory("undo").then(() => "saved", (error: Error) => error.message);
    });
    await page.waitForFunction(() => !!(window as any).__canvasOwned.rejectHistory);
    expect(await page.evaluate(() => (window as any).__canvasOwned.canvas.containerEl.inert)).toBe(true);
    const row = page.locator(".canvas-view .bases-data-row", { hasText: "Source" });
    const headers = await page.locator(".canvas-view .bases-table thead th").allTextContents();
    await expect(row.locator("td.bases-cell").nth(headers.indexOf("note.priority")).dblclick({ timeout: 300 })).rejects.toThrow();
    await expect(page.locator(".canvas-view .bases-cell-input")).toHaveCount(0);
    await page.evaluate(() => (window as any).__canvasOwned.rejectHistory(new Error("history write rejected")));
    expect(await page.evaluate(() => (window as any).__canvasOwned.history)).toBe("history write rejected");
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as any).__canvasOwned;
      return !probe.canvas.containerEl.inert && JSON.stringify(probe.canvas.document) === probe.original && JSON.stringify(probe.canvas.undoStack) === probe.undo;
    })).toBe(true);
    expect(fs.readFileSync(path.join(vault, "Board.canvas"), "utf8")).toBe(savedBoard);
    expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source);
    await row.locator("td.bases-cell").nth(headers.indexOf("note.priority")).click();
    await page.locator(".canvas-view .bases-table-container").press("Enter");
    await page.locator(".canvas-view .bases-cell-input").fill("9");
    await page.locator(".canvas-view .bases-cell-input").press("Enter");
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source.replace("priority: 2", "priority: 9"));
  });
});

for (const submission of ["Enter", "blur", "Shift+Tab"] as const) {
  test(`Base failed row normal ${submission} resubmission saves the latest draft and acknowledges its exact failure`, async () => {
    await withDraft("file", false, async (page, vault) => {
      await page.evaluate(() => {
        const app = (window as any).app; const probe = (window as any).__canvasOwned;
        probe.modify = app.vault.modify.bind(app.vault); probe.writes = 0;
        app.vault.modify = (file: any, text: string) => file.path === "Source.md" ? Promise.reject(new Error("row rejected")) : probe.modify(file, text);
      });
      const input = page.locator(".canvas-node .bases-cell-input"); await input.press("Enter");
      await expect(page.getByRole("button", { name: "Retry Base save" })).toBeVisible();
      await page.evaluate(() => {
        const app = (window as any).app; const probe = (window as any).__canvasOwned;
        app.vault.modify = (file: any, text: string) => { if (file.path === "Source.md") probe.writes++; return probe.modify(file, text); };
      });
      await input.fill("10");
      if (submission === "Enter") await page.screenshot({ path: path.join(repoRoot, "docs/screenshots/base-row-recovery-desktop.png") });
      if (submission === "blur") {
        await expect(input).toBeFocused();
        const destination = page.locator(".canvas-view .bases-table-container");
        await destination.focus(); await expect(destination).toBeFocused();
      }
      else await input.press(submission);
      await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source.replace("priority: 2", "priority: 10"));
      await expect.poll(() => page.evaluate(() => {
        const probe = (window as any).__canvasOwned;
        return { writes: probe.writes, failed: probe.canvas.renderOwner.hasUnacknowledgedWrites };
      })).toEqual({ writes: 1, failed: false });
      await expect(input).toHaveCount(0);
    });
  });
}

test("Base query refresh keeps the same actual input connected until the current edit finishes", async () => {
  await withDraft("file", false, async (page, vault) => {
    expect(await page.evaluate(() => {
      const probe = (window as any).__canvasOwned;
      const base = probe.canvas.renderOwner.writers().find((writer: any) => writer.viewType === "base");
      base.runAndRender(); base.runAndRender();
      return { connected: probe.input.isConnected, focused: document.activeElement === probe.input, value: probe.input.value };
    })).toEqual({ connected: true, focused: true, value: "9" });
    await page.locator(".canvas-node .bases-cell-input").press("Enter");
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source.replace("priority: 2", "priority: 9"));
    await expect(page.locator(".canvas-node .bases-cell-input")).toHaveCount(0);
  });
});

for (const rejected of [false, true]) {
  test(`Base older row completion rejected=${rejected} preserves a newer actual row editor through double-click`, async () => {
    await withDraft("file", false, async (page, vault) => {
      await page.evaluate(() => {
        const app = (window as any).app; const probe = (window as any).__canvasOwned;
        probe.modify = app.vault.modify.bind(app.vault);
        app.vault.modify = (file: any, text: string) => file.path === "Source.md" ? new Promise<void>((resolve, reject) => {
          probe.finishOlder = async (fail: boolean) => { if (fail) reject(new Error("older row rejected")); else { await probe.modify(file, text); resolve(); } };
        }) : probe.modify(file, text);
      });
      await page.locator(".canvas-node .bases-cell-input").press("Enter");
      await page.waitForFunction(() => !!(window as any).__canvasOwned.finishOlder);
      const headers = await page.locator(".canvas-view .bases-table thead th").allTextContents();
      await expect(page.locator(".canvas-view .bases-table-container")).toBeFocused();
      await page.locator(".canvas-view .bases-data-row", { hasText: "Replacement" }).locator("td.bases-cell").nth(headers.indexOf("note.priority")).dblclick();
      const current = page.locator(".canvas-view .bases-cell-input:not([disabled])"); await current.fill("11");
      await page.evaluate(() => {
        const probe = (window as any).__canvasOwned; probe.newerInput = document.activeElement;
        probe.newerBase = probe.canvas.renderOwner.writers().find((writer: any) => writer.viewType === "base"); probe.newerEdit = probe.newerBase.sourceEdit;
      });
      await page.evaluate(fail => (window as any).__canvasOwned.finishOlder(fail), rejected);
      await expect.poll(() => page.evaluate(() => (window as any).__canvasOwned.newerBase.sourcePersistsInFlight.size)).toBe(0);
      expect(await page.evaluate(() => {
        const probe = (window as any).__canvasOwned;
        return { connected: probe.newerInput.isConnected, focused: document.activeElement === probe.newerInput, value: probe.newerInput.value, sameEdit: probe.newerBase.sourceEdit === probe.newerEdit };
      })).toEqual({ connected: true, focused: true, value: "11", sameEdit: true });
      expect(fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(rejected ? source : source.replace("priority: 2", "priority: 9"));
      await current.press("Enter");
      await expect.poll(() => fs.readFileSync(path.join(vault, "Replacement.md"), "utf8")).toBe("---\npriority: 11\n---\n# Replacement note\n");
      if (rejected) {
        await page.evaluate(() => { const probe = (window as any).__canvasOwned; (window as any).app.vault.modify = probe.modify; });
        await page.getByRole("button", { name: "Retry Base save" }).click();
        await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source.replace("priority: 2", "priority: 9"));
      }
      await expect.poll(() => page.evaluate(() => (window as any).__canvasOwned.canvas.renderOwner.hasUnacknowledgedWrites)).toBe(false);
    });
  });
}

test("Base mobile Save resubmits the latest failed row through its exact recovery key", async () => {
  await withDraft("file", false, async (page, vault) => {
    await page.evaluate(() => {
      const app = (window as any).app; const probe = (window as any).__canvasOwned;
      probe.modify = app.vault.modify.bind(app.vault); probe.writes = 0;
      app.vault.modify = (file: any, text: string) => file.path === "Source.md" ? Promise.reject(new Error("mobile row rejected")) : probe.modify(file, text);
    });
    await page.getByRole("button", { name: "Save cell edit", exact: true }).click();
    await expect(page.getByRole("button", { name: "Retry Base save" })).toBeVisible();
    await page.evaluate(() => {
      const app = (window as any).app; const probe = (window as any).__canvasOwned;
      app.vault.modify = (file: any, text: string) => { if (file.path === "Source.md") probe.writes++; return probe.modify(file, text); };
    });
    await page.locator(".canvas-node .bases-cell-input").fill("10");
    await page.screenshot({ path: path.join(repoRoot, "docs/screenshots/base-row-recovery-mobile-controls.png") });
    await page.getByRole("button", { name: "Save cell edit", exact: true }).click();
    await expect.poll(() => fs.readFileSync(path.join(vault, "Source.md"), "utf8")).toBe(source.replace("priority: 2", "priority: 10"));
    await expect.poll(() => page.evaluate(() => {
      const probe = (window as any).__canvasOwned;
      return { writes: probe.writes, failed: probe.canvas.renderOwner.hasUnacknowledgedWrites };
    })).toEqual({ writes: 1, failed: false });
    await expect(page.getByRole("button", { name: "Save cell edit", exact: true })).toHaveCount(0);
  }, false, true);
});
