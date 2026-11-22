import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repoRoot = path.resolve(__dirname, "..", "..");

function writeStaticArtifact(
  dir: string,
  id: string,
  title: string,
  pages: Record<string, string>,
  extraFiles: Record<string, string> = {},
): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "artifact.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      title,
      entry: "index.html",
      runtime: "static",
      createdByThreadId: `thread-${id}`,
      viewport: { preset: "desktop", width: 1440, height: 900 },
      permissions: { network: "none", clipboard: false },
    }, null, 2),
  );
  for (const [rel, content] of Object.entries({ ...pages, ...extraFiles })) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

test("renders 8 full-size design artboards (shared tokens + independent) with Tier 1 PNGs, 0.05 zoom, zero idle webviews, and drill-in to ArtifactView", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-design-canvas-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-design-canvas-user-"));

  const boardFolderRel = "Artifacts/threads-artifacts/pricing-redesign";
  const sharedDir = path.join(vaultDir, boardFolderRel);
  const sharedManifestRel = `${boardFolderRel}/artifact.json`;
  const navV1Rel = "Artifacts/threads-artifacts/nav-v1/artifact.json";
  const navV2Rel = "Artifacts/threads-artifacts/nav-v2/artifact.json";

  writeStaticArtifact(
    sharedDir,
    "pricing-redesign",
    "Pricing Redesign",
    {
      "index.html": `<!doctype html><link rel="stylesheet" href="tokens.css"><body style="margin:0;background:var(--bg-home)"><h1>Home</h1></body>`,
      "screens/home.html": `<!doctype html><link rel="stylesheet" href="../tokens.css"><body style="margin:0;background:var(--bg-home)"><h1>Home Desktop</h1></body>`,
      "screens/mobile.html": `<!doctype html><link rel="stylesheet" href="../tokens.css"><body style="margin:0;background:var(--bg-mobile)"><h1>Mobile Screen</h1></body>`,
      "screens/pricing.html": `<!doctype html><link rel="stylesheet" href="../tokens.css"><body style="margin:0;background:var(--bg-pricing)"><h1>Pricing</h1></body>`,
      "screens/faq.html": `<!doctype html><link rel="stylesheet" href="../tokens.css"><body style="margin:0;background:var(--bg-faq)"><h1>FAQ</h1></body>`,
      "screens/checkout.html": `<!doctype html><link rel="stylesheet" href="../tokens.css"><body style="margin:0;background:var(--bg-checkout)"><h1>Checkout</h1></body>`,
    },
    {
      "tokens.css": `:root { --bg-home: #1e3a8a; --bg-mobile: #065f46; --bg-pricing: #7c2d12; --bg-faq: #581c87; --bg-checkout: #881337; }`,
    },
  );

  writeStaticArtifact(path.join(vaultDir, "Artifacts/threads-artifacts/nav-v1"), "nav-v1", "Nav V1", {
    "index.html": `<!doctype html><body style="margin:0;background:#0f766e"><h1>Nav V1</h1></body>`,
  });
  writeStaticArtifact(path.join(vaultDir, "Artifacts/threads-artifacts/nav-v2"), "nav-v2", "Nav V2", {
    "index.html": `<!doctype html><body style="margin:0;background:#b45309"><h1>Nav V2</h1></body>`,
  });

  fs.writeFileSync(path.join(vaultDir, "Spec.md"), "# Pricing Redesign Spec\n\nMix notes with live artboards.\n");

  const boardPath = path.join(sharedDir, "board.canvas");
  fs.writeFileSync(
    boardPath,
    JSON.stringify({
      nodes: [
        { id: "spec", type: "file", file: "Spec.md", x: -460, y: 0, width: 380, height: 320 },
        { id: "ab-1", type: "file", file: sharedManifestRel, x: 0, y: 0, width: 1440, height: 900 },
        { id: "ab-2", type: "file", file: sharedManifestRel, subpath: "#screens/home.html", x: 1540, y: 0, width: 1440, height: 900 },
        { id: "ab-3", type: "file", file: sharedManifestRel, subpath: "#screens/mobile.html", x: 3080, y: 0, width: 390, height: 844 },
        { id: "ab-4", type: "file", file: sharedManifestRel, subpath: "#screens/pricing.html", x: 3570, y: 0, width: 1440, height: 900 },
        { id: "ab-5", type: "file", file: sharedManifestRel, subpath: "#screens/faq.html", x: 0, y: 1020, width: 1440, height: 900 },
        { id: "ab-6", type: "file", file: sharedManifestRel, subpath: "#screens/checkout.html", x: 1540, y: 1020, width: 1440, height: 900 },
        { id: "ab-7", type: "file", file: navV1Rel, x: 3080, y: 1020, width: 1440, height: 900 },
        { id: "ab-8", type: "file", file: navV2Rel, x: 4620, y: 1020, width: 1440, height: 900 },
      ],
      edges: [
        { id: "e1", fromNode: "ab-1", fromSide: "right", toNode: "ab-2", toSide: "left", toEnd: "arrow", label: "CTA" },
      ],
    }, null, 2),
  );

  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
    const initialWindows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

    await window.evaluate(async (canvasRelPath) => {
      const a = (window as any).app;
      const file = a.vault.getFileByPath(canvasRelPath);
      await a.workspace.getLeaf(false).openFile(file);
    }, `${boardFolderRel}/board.canvas`);

    const artboards = window.locator(".canvas-node-artifact");
    await expect(artboards).toHaveCount(8);

    // Wait for all 8 Tier 1 PNG thumbnails to finish rendering.
    const images = window.locator(".canvas-node-artifact img.canvas-artboard-image");
    await expect(images).toHaveCount(8, { timeout: 30_000 });
    await expect.poll(async () => {
      return images.evaluateAll((els) =>
        els.every((el) => (el as HTMLImageElement).src.startsWith("blob:") && (el as HTMLImageElement).naturalWidth > 0),
      );
    }, { timeout: 30_000 }).toBe(true);

    // Headers show title, #subpath entry, and WxH dimensions.
    await expect(window.locator('.canvas-node[data-node-id="ab-3"] .canvas-artboard-title')).toHaveText("Pricing Redesign");
    await expect(window.locator('.canvas-node[data-node-id="ab-3"] .canvas-artboard-entry')).toHaveText("screens/mobile.html");
    await expect(window.locator('.canvas-node[data-node-id="ab-3"] .canvas-artboard-dims')).toHaveText("390×844");
    await expect(window.locator('.canvas-node[data-node-id="ab-7"] .canvas-artboard-title')).toHaveText("Nav V1");
    await expect(window.locator('.canvas-node[data-node-id="ab-8"] .canvas-artboard-title')).toHaveText("Nav V2");

    // Zero stray webviews on the canvas when idle, zero leaked BrowserWindows, and no captures/ files written.
    await expect(window.locator(".canvas-view webview")).toHaveCount(0);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(initialWindows);
    expect(fs.existsSync(path.join(sharedDir, "captures"))).toBe(false);

    // Fit all 8 full-size artboards (requires scale < 0.2) and zoom down to MIN_SCALE = 0.05.
    await window.getByRole("button", { name: "Zoom to fit" }).click();
    const fitScale = await window.evaluate(() => {
      const leaf = (window as any).app.workspace.getLeavesOfType("canvas")[0];
      return leaf.view.scale as number;
    });
    expect(fitScale).toBeLessThan(0.2);
    expect(fitScale).toBeGreaterThanOrEqual(0.05);

    const { scaleAfterZoom, zoomMs } = await window.evaluate(() => {
      const leaf = (window as any).app.workspace.getLeavesOfType("canvas")[0];
      const view = leaf.view;
      const t0 = performance.now();
      view.zoomAroundCenter(0.01);
      const zoomMs = performance.now() - t0;
      return { scaleAfterZoom: view.scale as number, zoomMs };
    });
    expect(scaleAfterZoom).toBeCloseTo(0.05, 4);
    expect(zoomMs).toBeLessThan(200);

    // Double-click the mobile subpath artboard -> opens ArtifactView at that root + entry.
    await window.getByRole("button", { name: "Zoom to fit" }).click();
    const mobileNode = window.locator('.canvas-node[data-node-id="ab-3"]');
    await mobileNode.dispatchEvent("dblclick");

    await expect.poll(async () => {
      return window.evaluate(() => {
        const leaves = (window as any).app.workspace.getLeavesOfType("geode-artifact");
        if (!leaves.length) return null;
        return leaves[0].view.getState();
      });
    }, { timeout: 10_000 }).toMatchObject({
      root: fs.realpathSync(sharedDir).replace(/^\/private/, "") === sharedDir ? sharedDir : expect.stringContaining("pricing-redesign"),
      entry: "screens/mobile.html",
      viewport: { preset: "custom", width: 390, height: 844 },
    });

    // Verify the live ArtifactView actually loaded screens/mobile.html.
    const artifactWebview = window.locator(".artifact-view webview.artifact-view-frame");
    await expect(artifactWebview).toHaveAttribute("src", /geode-artifact:\/\/pricing-redesign\/screens\/mobile\.html$/);

    // Closing the canvas revokes all artboard blob URLs.
    const blobCountAndRevoked = await window.evaluate(async () => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>(".canvas-node-artifact img.canvas-artboard-image")];
      const srcs = imgs.map((img) => img.src);
      const revoked: string[] = [];
      const origRevoke = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (url: string) => { revoked.push(url); origRevoke(url); };
      try {
        await (window as any).app.workspace.getLeavesOfType("canvas")[0].detach();
      } finally {
        URL.revokeObjectURL = origRevoke;
      }
      return { total: srcs.length, allRevoked: srcs.every((s) => revoked.includes(s)) };
    });
    expect(blobCountAndRevoked).toEqual({ total: 8, allRevoked: true });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test("Phase 1: LRU cap of 4 live webviews, Interact toggle pointer-events gating, shared session hot reload, and vault-switch teardown", async () => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-design-canvas-p1-vault-"));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "geode-design-canvas-p1-user-"));

  const boardFolderRel = "Artifacts/threads-artifacts/pricing-redesign";
  const sharedDir = path.join(vaultDir, boardFolderRel);
  const sharedManifestRel = `${boardFolderRel}/artifact.json`;

  writeStaticArtifact(
    sharedDir,
    "pricing-redesign",
    "Pricing Redesign",
    {
      "index.html": `<!doctype html><link rel="stylesheet" href="tokens.css"><body style="margin:0;background:var(--bg)"><h1>Screen 1</h1></body>`,
      "screens/s2.html": `<!doctype html><link rel="stylesheet" href="../tokens.css"><body style="margin:0;background:var(--bg)"><h1>Screen 2</h1></body>`,
      "screens/s3.html": `<!doctype html><link rel="stylesheet" href="../tokens.css"><body style="margin:0;background:var(--bg)"><h1>Screen 3</h1></body>`,
      "screens/s4.html": `<!doctype html><link rel="stylesheet" href="../tokens.css"><body style="margin:0;background:var(--bg)"><h1>Screen 4</h1></body>`,
      "screens/s5.html": `<!doctype html><link rel="stylesheet" href="../tokens.css"><body style="margin:0;background:var(--bg)"><h1>Screen 5</h1></body>`,
    },
    {
      "tokens.css": `:root { --bg: #1e3a8a; }`,
    },
  );

  fs.writeFileSync(
    path.join(sharedDir, "board.canvas"),
    JSON.stringify({
      nodes: [
        { id: "ab-1", type: "file", file: sharedManifestRel, x: 0, y: 0, width: 640, height: 420 },
        { id: "ab-2", type: "file", file: sharedManifestRel, subpath: "#screens/s2.html", x: 700, y: 0, width: 640, height: 420 },
        { id: "ab-3", type: "file", file: sharedManifestRel, subpath: "#screens/s3.html", x: 1400, y: 0, width: 640, height: 420 },
        { id: "ab-4", type: "file", file: sharedManifestRel, subpath: "#screens/s4.html", x: 0, y: 480, width: 640, height: 420 },
        { id: "ab-5", type: "file", file: sharedManifestRel, subpath: "#screens/s5.html", x: 700, y: 480, width: 640, height: 420 },
      ],
      edges: [],
    }, null, 2),
  );

  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultDir], lastVault: vaultDir }));

  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${userDataDir}`], cwd: repoRoot });
  try {
    const window = await app.firstWindow();
    await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);

    await window.evaluate(async (canvasRelPath) => {
      const a = (window as any).app;
      const file = a.vault.getFileByPath(canvasRelPath);
      await a.workspace.getLeaf(false).openFile(file);
    }, `${boardFolderRel}/board.canvas`);

    await expect(window.locator(".canvas-node-artifact img.canvas-artboard-image")).toHaveCount(5, { timeout: 25_000 });
    await expect(window.locator(".canvas-view webview")).toHaveCount(0);

    // Click Interact on ab-1..ab-5 sequentially -> LRU cap of 4 evicts ab-1 back to Tier 1 PNG.
    for (const id of ["ab-1", "ab-2", "ab-3", "ab-4", "ab-5"]) {
      await window.locator(`.canvas-node[data-node-id="${id}"] .canvas-artboard-interact-btn`).click();
      await expect(window.locator(`.canvas-node[data-node-id="${id}"] .canvas-node-artifact`)).toHaveAttribute("data-lod-tier", "2");
    }

    await expect(window.locator(".canvas-view webview.canvas-artboard-webview")).toHaveCount(4);
    await expect(window.locator('.canvas-node[data-node-id="ab-1"] .canvas-node-artifact')).toHaveAttribute("data-lod-tier", "1");
    await expect(window.locator('.canvas-node[data-node-id="ab-1"] img.canvas-artboard-image')).toHaveCount(1);

    // All 4 live webviews share the exact same ArtifactRuntime partition (one shared session + watcher).
    const partitions = await window.locator(".canvas-view webview.canvas-artboard-webview").evaluateAll((els) =>
      els.map((el) => el.getAttribute("partition")),
    );
    expect(partitions.every((p) => p && p.startsWith("geode-artifact-"))).toBe(true);
    expect(new Set(partitions).size).toBe(1);

    // Pointer-events gating: ab-5 is interacting (pointer-events: auto), ab-2 is warm but non-interacting (pointer-events: none).
    const pointerEvents = await window.evaluate(() => {
      const active = document.querySelector('.canvas-node[data-node-id="ab-5"] webview.canvas-artboard-webview');
      const warm = document.querySelector('.canvas-node[data-node-id="ab-2"] webview.canvas-artboard-webview');
      return {
        active: active ? getComputedStyle(active).pointerEvents : null,
        warm: warm ? getComputedStyle(warm).pointerEvents : null,
      };
    });
    expect(pointerEvents).toEqual({ active: "auto", warm: "none" });

    // Toggling Interact off on ab-5 gates pointer-events back to none while keeping webview warm.
    await window.locator('.canvas-node[data-node-id="ab-5"] .canvas-artboard-interact-btn').click();
    const afterExit = await window.evaluate(() => {
      const wv = document.querySelector('.canvas-node[data-node-id="ab-5"] webview.canvas-artboard-webview');
      return wv ? getComputedStyle(wv).pointerEvents : null;
    });
    expect(afterExit).toBe("none");

    // Revision-driven hot reload: editing tokens.css refreshes ab-1's Tier 1 snapshot (new blob URL).
    const beforeSnapUrl = await window.locator('.canvas-node[data-node-id="ab-1"] img.canvas-artboard-image').getAttribute("src");
    fs.writeFileSync(path.join(sharedDir, "tokens.css"), `:root { --bg: #059669; }\n`);
    await expect.poll(async () => {
      return window.locator('.canvas-node[data-node-id="ab-1"] img.canvas-artboard-image').getAttribute("src");
    }, { timeout: 10_000 }).not.toBe(beforeSnapUrl);

    // Clean teardown on vault switch: prepareVaultSwitch removes all webviews and clears sessions.
    await window.evaluate(async () => {
      const leaf = (window as any).app.workspace.getLeavesOfType("canvas")[0];
      await leaf.view.prepareVaultSwitch();
    });
    await expect(window.locator(".canvas-view webview")).toHaveCount(0);
    const remainingRoots = await window.evaluate(() => {
      const leaf = (window as any).app.workspace.getLeavesOfType("canvas")[0];
      return leaf.view.artifactLodPool.registeredSessionRoots;
    });
    expect(remainingRoots).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
