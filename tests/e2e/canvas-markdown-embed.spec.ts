import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function board(text = "Embedded card", extra = false): Record<string, unknown> {
  return {
    vendorCanvas: { preserve: true },
    nodes: [
      { id: "cycle-note", type: "file", x: 320, y: 40, width: 260, height: 180, file: "Notes/Cycle.md", vendorCycle: true },
      { id: "image", type: "file", x: 40, y: 260, width: 220, height: 150, file: "pixel.png", vendorImage: [1] },
      { id: "text", type: "text", x: 40, y: 40, width: 220, height: 140, text, vendorText: { keep: true } },
      ...(extra ? [{ id: "external", type: "text", x: 620, y: 80, width: 180, height: 100, text: "Externally added" }] : []),
    ],
    edges: [{
      id: "edge-1",
      fromNode: "text",
      fromSide: "right",
      fromEnd: "none",
      toNode: "cycle-note",
      toSide: "left",
      toEnd: "arrow",
      vendorEdge: "keep",
    }],
  };
}

async function lifecycle(page: Page): Promise<{ listeners: number; created: string[]; revoked: string[] }> {
  return page.evaluate(() => ({
    listeners: (window as any).__canvasEmbedModifyHandlers.size,
    created: [...(window as any).__canvasEmbedCreatedUrls],
    revoked: [...(window as any).__canvasEmbedRevokedUrls],
  }));
}

async function assertEmbeddedCanvas(embed: Locator): Promise<void> {
  await expect(embed).toBeVisible();
  await expect(embed.locator(".view-header")).toBeHidden();
  await expect(embed.locator('.canvas-node[data-node-id="text"]')).toBeVisible();
  await expect(embed.locator('.canvas-node[data-node-id="cycle-note"]')).toBeVisible();
  await expect(embed.locator('.canvas-node[data-node-id="image"] img')).toHaveAttribute("src", /^blob:/);
  await expect(embed.locator('.canvas-edge[data-edge-id="edge-1"]')).toHaveCount(1);
  const box = (await embed.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(240);
  expect(box.height).toBeLessThanOrEqual(500);
}

test("embeds a live Canvas in Markdown Reading view and Live Preview with safe lifecycle", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-markdown-embed-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-canvas-markdown-embed-user-"));
  fs.mkdirSync(path.join(vaultDir, "Notes"));
  const hostPath = path.join(vaultDir, "Notes", "Host.md");
  const boardPath = path.join(vaultDir, "Notes", "Board.canvas");
  const hostText = ["# Canvas host", "", "![[Board.canvas]]", "", "![[Missing.canvas]]", ""].join("\n");
  fs.writeFileSync(hostPath, hostText);
  fs.writeFileSync(boardPath, JSON.stringify(board(), null, 2) + "\n");
  fs.writeFileSync(path.join(vaultDir, "Notes", "Cycle.md"), "# Cycle\n\n![[Board.canvas]]\n");
  fs.writeFileSync(
    path.join(vaultDir, "pixel.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  );
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    const errors: string[] = [];
    window.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    window.on("pageerror", (error) => errors.push(String(error)));

    const notesFolder = window.locator('.nav-folder-title[data-path="Notes"]');
    await expect(notesFolder).toBeVisible();
    await notesFolder.click();
    await expect(window.locator('.nav-file-title[data-path="Notes/Host.md"]')).toBeVisible();
    await window.evaluate(() => {
      const vault = (window as any).app.vault;
      const on = vault.on.bind(vault);
      const off = vault.off.bind(vault);
      const handlers = new Set<unknown>();
      (window as any).__canvasEmbedModifyHandlers = handlers;
      vault.on = (event: string, handler: unknown) => {
        if (event === "modify") handlers.add(handler);
        return on(event, handler);
      };
      vault.off = (event: string, handler: unknown) => {
        if (event === "modify") handlers.delete(handler);
        return off(event, handler);
      };
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      const created: string[] = [];
      const revoked: string[] = [];
      (window as any).__canvasEmbedCreatedUrls = created;
      (window as any).__canvasEmbedRevokedUrls = revoked;
      URL.createObjectURL = (blob) => {
        const url = create(blob);
        created.push(url);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        revoked.push(url);
        revoke(url);
      };
    });

    await window.locator('.nav-file-title[data-path="Notes/Host.md"]').click();

    // Live Preview resolves the same-folder relative link into one bounded,
    // headerless real CanvasView while preserving unresolved embeds.
    let live = window.locator(".cm-embed-widget.cm-embed-block.canvas-embed-widget .canvas-embed-view");
    await assertEmbeddedCanvas(live);
    await expect(window.locator('.cm-embed-widget.internal-embed.is-unresolved')).toContainText("Missing.canvas");
    await expect(live.locator(".canvas-embed-cycle")).toHaveCount(1);
    await expect(window.locator(".canvas-embed-view")).toHaveCount(1);
    const liveListenerCount = (await lifecycle(window)).listeners;
    expect(liveListenerCount).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => (await lifecycle(window)).created.length).toBeGreaterThan(0);

    // Camera and selection remain interactive inside the widget without
    // changing the host note. The text node is already last, avoiding any
    // Canvas z-order write as part of this selection-only assertion.
    const liveCamera = await live.getAttribute("data-scale");
    await live.getByRole("button", { name: "Zoom in" }).click();
    expect(await live.getAttribute("data-scale")).not.toBe(liveCamera);
    await live.locator('.canvas-node[data-node-id="text"]').click();
    await expect(live.locator('.canvas-node.is-selected[data-node-id="text"]')).toHaveCount(1);
    expect(fs.readFileSync(hostPath, "utf8")).toBe(hostText);

    // A real vault modification of Board.canvas refreshes the mounted view.
    await window.evaluate(async (next) => {
      const file = (window as any).app.vault.getFileByPath("Notes/Board.canvas");
      await (window as any).app.vault.modify(file, next);
    }, JSON.stringify(board("Embedded card", true), null, 2) + "\n");
    await expect(live.locator('.canvas-node[data-node-id="external"]')).toBeVisible();
    expect(fs.readFileSync(hostPath, "utf8")).toBe(hostText);

    // Destroying the Live Preview widget unregisters its vault listener and
    // revokes every Canvas-owned object URL.
    await window.getByRole("button", { name: "Toggle Live Preview / Source mode" }).click();
    await expect(window.locator(".canvas-embed-view")).toHaveCount(0);
    await expect.poll(async () => (await lifecycle(window)).listeners).toBe(liveListenerCount - 1);
    let state = await lifecycle(window);
    expect(state.created.length).toBeGreaterThan(0);
    expect(new Set(state.revoked)).toEqual(new Set(state.created));

    // Reading view mounts through the same CanvasView lifecycle and updates
    // on external Board.canvas changes without touching Host.md.
    await window.getByRole("button", { name: "Toggle reading view (Cmd/Ctrl+E)" }).click();
    let reading = window.locator(".markdown-reading-view .canvas-embed-view");
    await assertEmbeddedCanvas(reading);
    await expect(window.locator(".markdown-reading-view .internal-embed.is-unresolved")).toContainText("Missing.canvas");
    await expect(reading.locator(".canvas-embed-cycle")).toHaveCount(1);
    await expect.poll(async () => (await lifecycle(window)).listeners).toBe(liveListenerCount);
    await window.evaluate(async (next) => {
      const file = (window as any).app.vault.getFileByPath("Notes/Board.canvas");
      await (window as any).app.vault.modify(file, next);
    }, JSON.stringify(board("Reading refresh", true), null, 2) + "\n");
    await expect(reading.locator('.canvas-node[data-node-id="text"] .canvas-node-text')).toContainText("Reading refresh");
    expect(fs.readFileSync(hostPath, "utf8")).toBe(hostText);

    // A Reading-view rerender tears down the old Canvas before replacing it,
    // so listeners stay singleton and the old render's URLs are revoked.
    const beforeRerender = await lifecycle(window);
    await window.getByRole("button", { name: "Toggle reading view (Cmd/Ctrl+E)" }).click();
    await window.getByRole("button", { name: "Toggle reading view (Cmd/Ctrl+E)" }).click();
    reading = window.locator(".markdown-reading-view .canvas-embed-view");
    await assertEmbeddedCanvas(reading);
    await expect.poll(async () => (await lifecycle(window)).listeners).toBe(liveListenerCount);
    state = await lifecycle(window);
    expect(state.created.length).toBeGreaterThan(beforeRerender.created.length);
    for (const url of beforeRerender.created) expect(state.revoked).toContain(url);
    expect(fs.readFileSync(hostPath, "utf8")).toBe(hostText);
    expect(errors, `Console errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await app.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
