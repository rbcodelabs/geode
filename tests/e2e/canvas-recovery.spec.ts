import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

async function camera(view: import("@playwright/test").Locator): Promise<Record<string, string | null>> {
  return {
    scale: await view.getAttribute("data-scale"),
    panX: await view.getAttribute("data-pan-x"),
    panY: await view.getAttribute("data-pan-y"),
  };
}

test("recovers malformed Canvas files without exposing stale-document mutation paths", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-recovery-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-recovery-user-"));
  const canvasPath = path.join(vaultDir, "Recovery.canvas");
  const initial = {
    vendorCanvas: { phase: "initial" },
    nodes: [{ id: "stale", type: "text", x: 20, y: 20, width: 220, height: 120, text: "Must never return", vendorNode: true }],
    edges: [],
  };
  fs.writeFileSync(canvasPath, JSON.stringify(initial, null, 2) + "\n");
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));
    await window.locator('.nav-file-title[data-path="Recovery.canvas"]').click();
    let view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="stale"]')).toBeVisible();
    await view.locator('[data-canvas-action="zoom-in"]').click();
    const cameraBefore = await camera(view);

    await window.evaluate(() => {
      const current = window as any;
      current.__canvasRecoveryWrites = [];
      const modify = current.app.vault.modify.bind(current.app.vault);
      current.app.vault.modify = async (file: { path: string }, data: string) => {
        if (file.path === "Recovery.canvas") current.__canvasRecoveryWrites.push(data);
        return modify(file, data);
      };
    });

    const malformed = '{"nodes": [\n';
    await window.evaluate(async (text) => {
      const current = window as any;
      await current.app.vault.modify(current.app.vault.getFileByPath("Recovery.canvas"), text);
    }, malformed);
    await expect(view.locator(".canvas-error")).toBeVisible();
    await expect(view.getByRole("button", { name: "Retry", exact: true })).toHaveCount(1);
    await expect(view.locator(".canvas-node, .canvas-edge, .canvas-node-text-editor, .canvas-edge-label-editor")).toHaveCount(0);
    await expect(view.locator(".canvas-selection-controls, .canvas-color-palette")).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(malformed);
    await window.evaluate(() => { (window as any).__canvasRecoveryWrites = []; });

    // Representative toolbar, empty-surface, drop, selection/delete, and
    // history routes are all inert while the exact malformed bytes remain.
    await window.evaluate(() => {
      const toolbarButton = document.querySelector<HTMLButtonElement>('.canvas-view .canvas-toolbar button[aria-label="Add text card"]');
      toolbarButton?.click();
      const viewport = document.querySelector<HTMLElement>(".canvas-view .canvas-viewport")!;
      viewport.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 300, clientY: 240 }));
      viewport.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 240 }));
      const transfer = new DataTransfer();
      transfer.setData("text/plain", "https://example.com/recovery-guard");
      viewport.dispatchEvent(new DragEvent("drop", { bubbles: true, clientX: 300, clientY: 240, dataTransfer: transfer }));
    });
    await view.locator(".canvas-surface").focus();
    await window.keyboard.press("ControlOrMeta+A");
    await window.keyboard.press("Delete");
    await window.keyboard.press("ControlOrMeta+Z");
    await window.keyboard.press("ControlOrMeta+Shift+Z");
    await expect(view.locator(".prompt, .context-menu, textarea")).toHaveCount(0);
    await expect(view.locator(".canvas-error")).toBeVisible();
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(malformed);
    expect(await window.evaluate(() => (window as any).__canvasRecoveryWrites)).toEqual([]);
    expect(await camera(view)).toEqual(cameraBefore);

    // Retry against still-invalid bytes stays in recovery without a write or
    // duplicate error/action surface.
    await view.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(view.locator(".canvas-error")).toHaveCount(1);
    await expect(view.getByRole("button", { name: "Retry", exact: true })).toHaveCount(1);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(malformed);
    expect(await window.evaluate(() => (window as any).__canvasRecoveryWrites)).toEqual([]);

    const recovered = {
      vendorCanvas: { phase: "retry", keep: [1, 2, 3] },
      nodes: [
        { id: "left", type: "text", x: -40, y: 10, width: 200, height: 100, text: "Recovered", color: "2", vendorLeft: { keep: true } },
        { id: "right", type: "text", x: 320, y: 40, width: 180, height: 90, text: "Exact", vendorRight: true },
      ],
      edges: [{ id: "edge-keep", fromNode: "left", toNode: "right", fromSide: "right", toSide: "left", vendorEdge: "keep" }],
    };
    const recoveredText = JSON.stringify(recovered, null, 2) + "\n";
    fs.writeFileSync(canvasPath, recoveredText);
    await view.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(view.locator('.canvas-node[data-node-id="left"]')).toBeVisible();
    await expect(view.locator('.canvas-node[data-node-id="right"]')).toBeVisible();
    await expect(view.locator('.canvas-edge[data-edge-id="edge-keep"]')).toHaveCount(1);
    await expect(view.locator(".canvas-error")).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(recoveredText);
    expect(await window.evaluate(() => (window as any).__canvasRecoveryWrites)).toEqual([]);
    expect(await camera(view)).toEqual(cameraBefore);

    // Schema-invalid external changes remain safely errored; a later valid
    // vault modify recovers automatically with no extra Canvas writes.
    const schemaInvalid = JSON.stringify({ nodes: "not-an-array", edges: [] });
    const automatic = {
      vendorCanvas: { phase: "automatic" },
      nodes: [{ id: "automatic", type: "text", x: 5, y: 6, width: 140, height: 80, text: "Auto recovered", vendorAutomatic: true }],
      edges: [],
    };
    const automaticText = JSON.stringify(automatic, null, 2) + "\n";
    await window.evaluate(async ({ invalid, valid }) => {
      const current = window as any;
      const file = current.app.vault.getFileByPath("Recovery.canvas");
      await current.app.vault.modify(file, invalid);
      await new Promise<void>((resolve) => {
        const poll = () => document.querySelector(".canvas-view.has-error") ? resolve() : setTimeout(poll, 10);
        poll();
      });
      await current.app.vault.modify(file, valid);
    }, { invalid: schemaInvalid, valid: automaticText });
    await expect(view.locator('.canvas-node[data-node-id="automatic"]')).toBeVisible();
    await expect(view.locator(".canvas-error")).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(automaticText);
    expect(await window.evaluate(() => (window as any).__canvasRecoveryWrites)).toEqual([schemaInvalid, automaticText]);
    expect(await camera(view)).toEqual(cameraBefore);

    await window.reload();
    await window.locator('.nav-file-title[data-path="Recovery.canvas"]').click();
    view = window.locator(".canvas-view");
    await expect(view.locator('.canvas-node[data-node-id="automatic"]')).toBeVisible();
    await expect(view.locator(".canvas-error")).toHaveCount(0);
    expect(fs.readFileSync(canvasPath, "utf8")).toBe(automaticText);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
