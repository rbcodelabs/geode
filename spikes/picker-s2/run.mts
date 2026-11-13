#!/usr/bin/env node
/**
 * Spike S2 harness (THROWAWAY): how far off is an embedder overlay badge from an element inside the artifact <webview>?
 *
 *   npm run spike:s2 -- [--out <dir>] [--label <name>] [--fixtures a,b] [--quick] [--no-replica] [--strict]
 *
 * For every fixture and condition it
 *   1. asks the REAL guest anchor tracker (G2) for the target rects (guest css px, relative to the guest viewport),
 *   2. places an embedder-DOM marker on every target using the SAME formula the production selection box uses
 *      (ArtifactView.positionPopover: frame.left - stage.left + box.x, rounded) plus two corrected variants,
 *   3. reads the TRUE on-screen position back from pixels: the targets are painted in distinct saturated colours and
 *      located in a window screenshot (webContents.capturePage), the markers likewise, with sub-pixel edges,
 *   4. reports the per-case error in physical pixels and in embedder css px, p50/p95/max, a PASS/WARN/FAIL verdict
 *      per condition against a 1 css px tolerance, and writes everything to JSON.
 *
 * Throwaway: not part of any release, no tests beyond selftest.mts. Never opens a PR.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { detectBoxes } from "./lib/detect.mts";
import { FIXTURES } from "./lib/fixtures.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const TOLERANCE_CSS = 1;
const MAPPINGS = ["existing", "border", "scaled"] as const;
type Mapping = (typeof MAPPINGS)[number];

// Saturated colours that do not occur elsewhere on the white fixture pages; index = target number.
const PALETTE: number[][] = [[255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 200, 255], [255, 140, 0], [140, 0, 255], [0, 170, 0], [200, 200, 0]];

// ---------------------------------------------------------------------------------------------------------------- args
const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (flag("help") || flag("h")) {
  console.log("npm run spike:s2 -- [--out <dir>] [--label <name>] [--fixtures a,b] [--quick] [--no-replica] [--strict] [--list]");
  process.exit(0);
}
const outDir = value("out") ? path.resolve(value("out")!) : path.join(here, "results");
const label = (value("label") ?? `${os.hostname().split(".")[0]}`).replace(/[^A-Za-z0-9._-]/g, "-");
const onlyFixtures = value("fixtures")?.split(",").map((s) => s.trim()).filter(Boolean);
const quick = flag("quick");
const strict = flag("strict");
if (flag("list")) { for (const f of FIXTURES) console.log(`${f.id}\t${f.coverage}\t${f.title}`); process.exit(0); }

// ------------------------------------------------------------------------------------------------------------- states
interface State {
  id: string;
  group: "baseline" | "window-size" | "pane-resize" | "viewport-preset" | "app-zoom" | "scroll";
  size?: "small" | "med" | "large";
  sidebars?: 0 | 1 | 2;
  preset?: "fill" | "desktop" | "tablet" | "mobile";
  zoom?: number;
  stageScroll?: number;
  liveResize?: boolean;
  scene?: { name: string; page?: number; inner?: number };
}
const S = (s: State): State => s;
const FULL: State[] = [
  S({ id: "baseline", group: "baseline" }),
  S({ id: "size-small", group: "window-size", size: "small" }),
  S({ id: "size-large", group: "window-size", size: "large" }),
  S({ id: "pane-left-sidebar", group: "pane-resize", sidebars: 1 }),
  S({ id: "pane-both-sidebars", group: "pane-resize", sidebars: 2 }),
  S({ id: "pane-live-resize", group: "pane-resize", liveResize: true }),
  S({ id: "preset-desktop", group: "viewport-preset", preset: "desktop" }),
  S({ id: "preset-tablet", group: "viewport-preset", preset: "tablet" }),
  S({ id: "preset-mobile", group: "viewport-preset", preset: "mobile" }),
  S({ id: "preset-tablet-stage-scrolled", group: "viewport-preset", preset: "tablet", stageScroll: 120 }),
  S({ id: "zoom-80", group: "app-zoom", zoom: 0.8 }),
  S({ id: "zoom-125", group: "app-zoom", zoom: 1.25 }),
  S({ id: "zoom-150", group: "app-zoom", zoom: 1.5 }),
  S({ id: "zoom-125-tablet", group: "app-zoom", preset: "tablet", zoom: 1.25 }),
  S({ id: "zoom-150-tablet", group: "app-zoom", preset: "tablet", zoom: 1.5 }),
];
const CORE_IDS = ["baseline", "size-large", "preset-tablet", "preset-mobile", "zoom-80", "zoom-125", "zoom-150", "zoom-125-tablet"];
const QUICK_IDS = ["baseline", "preset-tablet", "zoom-125"];
const stateList = (fx: (typeof FIXTURES)[number]): State[] => {
  const ids = quick ? QUICK_IDS : fx.coverage === "full" ? null : CORE_IDS;
  const base = ids ? FULL.filter((s) => ids.includes(s.id)) : FULL.slice();
  const scenes: State[] = [];
  for (const scene of quick ? [] : fx.scenes ?? []) {
    scenes.push(S({ id: scene.name, group: "scroll", scene }));
    scenes.push(S({ id: `${scene.name}+zoom-125`, group: "scroll", zoom: 1.25, scene }));
  }
  return [...base, ...scenes];
};

// -------------------------------------------------------------------------------------------------------- page scripts
/** Installed once into the embedder renderer: the probe on the view's bridge, layout reads, marker placement. */
const EMBEDDER_SCRIPT = `(() => {
  const S = window.__s2 = window.__s2 || {};
  const view = () => window.app.workspace.getLeavesOfType("geode-artifact")[0]?.view;
  const rectOf = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, top: b.top, width: b.width, height: b.height, right: b.right, bottom: b.bottom }; };
  S.install = () => {
    const v = view(); const bridge = v && v.bridge;
    if (!bridge) return false;
    if (S.bridge === bridge) return true;
    S.bridge = bridge; S.latest = {}; S.messages = 0;
    const apply = (list, src) => { const t = performance.now(); for (const r of list) S.latest[r.key] = { rect: r.rect, visible: r.visible, t, src }; S.messages++; };
    bridge.options.callbacks.onAnchorResults = (m) => apply(m.results, "results");
    bridge.options.callbacks.onAnchorRects = (m) => apply(m.rects, "rects");
    return true;
  };
  S.setAnchors = (queries) => { S.latest = {}; return S.bridge.setAnchors(queries); };
  S.snapshot = () => JSON.parse(JSON.stringify({ latest: S.latest || {}, messages: S.messages || 0, now: performance.now() }));
  S.layout = () => {
    const frame = document.querySelector(".artifact-view-frame"), stage = document.querySelector(".artifact-view-stage"), overlay = document.querySelector(".artifact-view-overlay");
    const v = view();
    return {
      dpr: window.devicePixelRatio, innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      preset: v && v.viewport ? v.viewport.preset : null,
      frame: { ...rectOf(frame), clientLeft: frame.clientLeft, clientTop: frame.clientTop, clientWidth: frame.clientWidth, clientHeight: frame.clientHeight, offsetWidth: frame.offsetWidth, offsetHeight: frame.offsetHeight },
      stage: { ...rectOf(stage), scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop, clientWidth: stage.clientWidth, clientHeight: stage.clientHeight, scrollWidth: stage.scrollWidth, scrollHeight: stage.scrollHeight },
      overlay: rectOf(overlay),
    };
  };
  S.clearMarkers = () => { document.querySelector(".s2-layer")?.remove(); };
  /** The "existing" branch is a verbatim copy of ArtifactView.positionPopover's selection-box placement. */
  S.place = (mapping, items, guest, colors) => {
    S.clearMarkers();
    const L = S.layout(), f = L.frame, s = L.stage;
    const layer = document.createElement("div");
    layer.className = "s2-layer";
    layer.style.cssText = "position:absolute;inset:0;pointer-events:none";
    for (const it of items) {
      const b = it.rect; if (!b) continue;
      let left, top, width, height;
      if (mapping === "existing") {
        left = Math.round(f.left - s.left + b.x); top = Math.round(f.top - s.top + b.y);
        width = Math.max(2, Math.round(b.width)); height = Math.max(2, Math.round(b.height));
      } else {
        const ox = f.left + f.clientLeft - s.left, oy = f.top + f.clientTop - s.top;
        const kx = mapping === "scaled" ? f.clientWidth / guest.innerWidth : 1, ky = mapping === "scaled" ? f.clientHeight / guest.innerHeight : 1;
        left = ox + b.x * kx; top = oy + b.y * ky; width = b.width * kx; height = b.height * ky;
      }
      const m = document.createElement("div");
      const solid = Math.min(width, height) < 8; // too small for a visible ring: a solid block of exactly the mapped size
      m.style.cssText = "position:absolute;box-sizing:border-box;" + (solid ? "background:" + colors[it.i] : "border:3px solid " + colors[it.i] + ";background:transparent") + ";left:" + left + "px;top:" + top + "px;width:" + width + "px;height:" + height + "px";
      layer.appendChild(m);
    }
    document.querySelector(".artifact-view-overlay").appendChild(layer);
  };
  S.frames = (ms) => new Promise((resolve) => { let n = 0; const t0 = performance.now(); const tick = (t) => { n++; if (t - t0 >= ms) resolve({ frames: n, ms: t - t0, hz: Math.round((n - 1) / ((t - t0) / 1000) * 10) / 10 }); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  S.twoFrames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  /** Report lag: time from a guest scrollTo until the tracker's rect for key a0 equals the true one. */
  S.lag = async (trials) => {
    const frame = document.querySelector(".artifact-view-frame"); const out = [];
    const mc = new MessageChannel(); const tick = () => new Promise((r) => { mc.port1.onmessage = () => r(); mc.port2.postMessage(0); });
    for (let k = 0; k < trials; k++) {
      const y = 40 + ((k * 97) % 700) + (k % 2 ? 300 : 0);
      const before = S.messages;
      const t0 = performance.now();
      await frame.executeJavaScript("window.scrollTo(0," + y + "); 0");
      let ms = null;
      for (let guard = 0; guard < 4000; guard++) {
        const r = S.latest.a0 && S.latest.a0.rect;
        if (S.messages > before && r && Math.abs(r.y - (20 - y)) < 0.6) { ms = performance.now() - t0; break; }
        await tick();
      }
      out.push(ms);
      await new Promise((r) => setTimeout(r, 60));
    }
    return out;
  };
})()`;

// ------------------------------------------------------------------------------------------------------- electron side
/** Runs in the Electron MAIN process. Self-contained: no outer references. */
const mainCapture = async ({ BrowserWindow }: any, arg: { detectSrc: string; palette: number[][]; regionCss: { left: number; top: number; right: number; bottom: number }; innerWidth: number; png: boolean }) => {
  const win = BrowserWindow.getAllWindows().find((w: any) => !w.isDestroyed());
  const image = await win.webContents.capturePage();
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const detect = new Function(`return (${arg.detectSrc})`)();
  const t0 = Date.now();
  const k = size.width / arg.innerWidth;
  const region = { x0: arg.regionCss.left * k, y0: arg.regionCss.top * k, x1: arg.regionCss.right * k, y1: arg.regionCss.bottom * k };
  const boxes = detect(bitmap, size.width, size.height, arg.palette, region);
  return { width: size.width, height: size.height, boxes, analysisMs: Date.now() - t0, content: win.getContentBounds(), png: arg.png ? image.toPNG().toString("base64") : null };
};
const mainWindow = async ({ BrowserWindow, screen, app: electronApp }: any, op: any) => {
  const win = BrowserWindow.getAllWindows().find((w: any) => !w.isDestroyed());
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  if (op.kind === "setup") {
    win.show(); win.moveTop();
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    win.setPosition(wa.x + 20, wa.y + 20);
    return { workArea: wa };
  }
  if (op.kind === "size") {
    const w = Math.min(op.width, wa.width - 40), h = Math.min(op.height, wa.height - 60);
    win.setContentSize(w, h);
    return { width: w, height: h };
  }
  if (op.kind === "zoom") { win.webContents.setZoomFactor(op.factor); return { zoomFactor: win.webContents.getZoomFactor() }; }
  if (op.kind === "info") {
    const d = screen.getDisplayMatching(win.getBounds());
    let gpu: any = null;
    try { gpu = electronApp.getGPUFeatureStatus(); } catch { gpu = null; }
    return {
      display: { id: d.id, label: d.label, scaleFactor: d.scaleFactor, size: d.size, workArea: d.workArea, bounds: d.bounds, displayFrequency: d.displayFrequency, colorDepth: d.colorDepth, colorSpace: d.colorSpace, internal: d.internal, rotation: d.rotation, displays: screen.getAllDisplays().length },
      versions: process.versions, platform: process.platform, arch: process.arch, gpu,
      windowBounds: win.getBounds(), contentBounds: win.getContentBounds(),
    };
  }
  return null;
};

// ------------------------------------------------------------------------------------------------------------ helpers
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (values: number[], q: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
const stats = (values: number[]) => ({ n: values.length, p50: round(pct(values, 0.5)), p95: round(pct(values, 0.95)), max: round(values.length ? Math.max(...values) : 0) });
const round = (n: number, d = 3): number => Math.round(n * 10 ** d) / 10 ** d;
const cssList = (s: string) => `rgb(${s})`;

const harnessErrors: string[] = [];
let app: any = null;
let appPid: number | undefined;
let tempRoot: string | null = null;
let closing = false;

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  if (app) {
    await Promise.race([app.close().catch(() => {}), sleep(15_000)]);
    // Only the child we spawned, never a name match.
    if (appPid) { try { process.kill(appPid, 0); process.kill(appPid, "SIGKILL"); } catch { /* already gone */ } }
  }
  if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
}
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { shutdown().finally(() => process.exit(130)); });

function makeEnv() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "geode-s2-"));
  const userDataDir = path.join(tempRoot, "user-data");
  const vaultPath = path.join(tempRoot, "vault");
  fs.mkdirSync(userDataDir);
  fs.mkdirSync(path.join(vaultPath, ".geode", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(vaultPath, "Welcome.md"), "# Welcome\n");
  const fixture = path.join(repoRoot, "tests", "fixtures", "plugins", "artifact-feedback-probe");
  const pluginDir = path.join(vaultPath, ".geode", "plugins", "artifact-feedback-probe");
  fs.mkdirSync(pluginDir, { recursive: true });
  for (const name of ["manifest.json", "main.js"]) fs.copyFileSync(path.join(fixture, name), path.join(pluginDir, name));
  fs.writeFileSync(path.join(vaultPath, ".geode", "plugins.json"), JSON.stringify(["artifact-feedback-probe"]));
  fs.writeFileSync(path.join(userDataDir, "geode.json"), JSON.stringify({ recentVaults: [vaultPath], lastVault: vaultPath }));
  return { userDataDir, vaultPath };
}

function writeArtifact(root: string, fx: (typeof FIXTURES)[number]): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "artifact.json"), JSON.stringify({
    schemaVersion: 1, id: `s2-${fx.id}`, title: fx.title, entry: "index.html", runtime: "static", createdByThreadId: "thread-s2",
    viewport: { preset: "fill", width: 1440, height: 900 }, permissions: { network: "none", clipboard: false },
  }));
  fs.writeFileSync(path.join(root, "index.html"), fx.html);
  fs.writeFileSync(path.join(root, "style.css"), fx.css);
}

// ------------------------------------------------------------------------------------------------------------- driver
interface Ctx { win: any; frame: any }
const guestEval = (ctx: Ctx, code: string): Promise<any> => ctx.win.locator(".artifact-view-frame").evaluate((g: any, c: string) => g.executeJavaScript(c), code);
const embedder = (ctx: Ctx, expr: string, arg?: unknown): Promise<any> =>
  ctx.win.evaluate(({ expr: e, arg: a }: any) => new Function("arg", `return (${e})`)(a), { expr, arg });
const GUEST_INFO = `(() => { const o = { innerWidth, innerHeight, dpr: devicePixelRatio, scrollX, scrollY, cw: document.documentElement.clientWidth, ch: document.documentElement.clientHeight,
  vv: window.visualViewport ? { scale: visualViewport.scale, width: visualViewport.width, height: visualViewport.height } : null };
  o.rects = [...document.querySelectorAll("[data-s2]")].map((e) => { const r = e.getBoundingClientRect(); return { id: e.id, x: r.x, y: r.y, width: r.width, height: r.height }; }).sort((a, b) => a.id.localeCompare(b.id));
  return o; })()`;

const SIZES = { small: [1024, 700], med: [1280, 800], large: [1680, 1050] } as const;

async function setupApp() {
  const env = makeEnv();
  if (!fs.existsSync(path.join(repoRoot, "dist", "main.js"))) throw new Error(`dist/main.js is missing: run "npm run build" first (see README)`);
  app = await electron.launch({
    args: [repoRoot, `--user-data-dir=${env.userDataDir}`], cwd: repoRoot,
    // GEODE_HEADLESS=1 only suppresses the first-run UI; the window is shown explicitly below so Rick sees it.
    env: { ...process.env, GEODE_HEADLESS: "1" } as Record<string, string>,
  });
  appPid = app.process().pid;
  const win = await app.firstWindow();
  await win.waitForFunction(() => (window as any).app?.workspace?.layoutReady, undefined, { timeout: 60_000 });
  await app.evaluate(mainWindow, { kind: "setup" });
  await win.evaluate(() => {
    const a = (window as any).app;
    for (const sidebar of [a.workspace.leftSidebar, a.workspace.rightSidebar]) if (!sidebar.collapsed) sidebar.toggle();
  });
  await win.waitForFunction(() => typeof (window as any).__feedbackProbe?.register === "function", undefined, { timeout: 60_000 });
  const reg = await win.evaluate(() => (window as any).__feedbackProbe.register());
  if (reg !== "registered") throw new Error(`feedback probe did not register: ${String(reg)}`);
  await win.evaluate(EMBEDDER_SCRIPT);
  return { win, env };
}

async function loadFixture(ctx: Ctx, env: { vaultPath: string }, fx: (typeof FIXTURES)[number]) {
  const root = path.join(tempRoot!, `artifact-${fx.id}`);
  writeArtifact(root, fx);
  await ctx.win.evaluate(async (r: string) => {
    const a = (window as any).app;
    await a.workspace.detachLeavesOfType("geode-artifact");
    await a.openArtifact(r);
  }, root);
  await ctx.win.locator(".artifact-view-frame").waitFor({ state: "visible", timeout: 30_000 });
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const ok = await embedder(ctx, `window.__s2.install()`).catch(() => false);
    const ready = ok && await guestEval(ctx, `document.readyState === "complete" && document.querySelectorAll("[data-s2]").length`).catch(() => 0);
    if (ready) break;
    await sleep(200);
  }
  const info = await guestEval(ctx, GUEST_INFO);
  const targets: Array<{ id: string; tag: string; i: number }> = await guestEval(ctx,
    `[...document.querySelectorAll("[data-s2]")].map((e) => ({ id: e.id, tag: e.tagName.toLowerCase() })).sort((a, b) => a.id.localeCompare(b.id))`);
  if (!targets.length) throw new Error(`fixture ${fx.id}: no [data-s2] targets found in the guest`);
  for (const t of targets) t.i = Number(t.id.slice(1));
  // Colour the targets through the CSSOM (allowed under the artifact CSP; inline style attributes are not).
  await guestEval(ctx, `(() => { const pal = ${JSON.stringify(PALETTE)}; for (const e of document.querySelectorAll("[data-s2]")) { const c = "rgb(" + pal[Number(e.id.slice(1))].join(",") + ")"; if (e instanceof SVGElement) e.style.setProperty("fill", c, "important"); else e.style.setProperty("background-color", c, "important"); } return true; })()`);
  const route = await guestEval(ctx, `location.pathname + location.hash`);
  const queries = targets.map((t) => ({ key: `a${t.i}`, route, tag: t.tag, selector: `#${t.id}`, alternates: [], textAnchor: { tag: t.tag, text: "" }, landmark: null }));
  const set = await embedder(ctx, `window.__s2.setAnchors(arg)`, queries);
  if (!set || set.rejected?.length) throw new Error(`fixture ${fx.id}: anchors rejected: ${JSON.stringify(set)}`);
  return { targets, info };
}

async function applyState(ctx: Ctx, state: State, targets: Array<{ id: string; i: number }>) {
  const [w, h] = SIZES[state.size ?? "med"];
  if (state.liveResize) {
    // A drag-like resize: many small steps, ending where the next measurement is taken.
    await app.evaluate(mainWindow, { kind: "size", width: SIZES.med[0], height: SIZES.med[1] });
    await sleep(150);
    for (let k = 1; k <= 14; k++) { await app.evaluate(mainWindow, { kind: "size", width: SIZES.med[0] - k * 20, height: SIZES.med[1] - k * 10 }); await sleep(16); }
  } else {
    await app.evaluate(mainWindow, { kind: "size", width: w, height: h });
  }
  await app.evaluate(mainWindow, { kind: "zoom", factor: state.zoom ?? 1 });
  await ctx.win.evaluate((n: number) => {
    const a = (window as any).app;
    const want = [n >= 1, n >= 2];
    [a.workspace.leftSidebar, a.workspace.rightSidebar].forEach((sb: any, k: number) => { if (sb.collapsed === want[k]) sb.toggle(); });
  }, state.sidebars ?? 0);
  const preset = state.preset ?? "fill";
  const current = await embedder(ctx, `window.__s2.layout().preset`);
  if (current !== preset) await ctx.win.locator(`[data-viewport="${preset}"]`).click();
  await sleep(120);
  await ctx.win.evaluate((px: number) => { const s = document.querySelector(".artifact-view-stage") as HTMLElement; s.scrollTop = px; s.scrollLeft = 0; }, state.stageScroll ?? 0);
  await guestEval(ctx, `(() => { window.scrollTo(0, ${state.scene?.page ?? 0}); const b = document.getElementById("box"); if (b) b.scrollTop = ${state.scene?.inner ?? 0}; return true; })()`);
  void targets;
}

/** Wait until the tracker's rects equal the guest's own and the embedder layout stopped moving. */
async function settle(ctx: Ctx, targets: Array<{ id: string; i: number }>) {
  const t0 = Date.now();
  let stable = 0, lastKey = "", firstErr: number | null = null, timedOut = false;
  while (true) {
    const [layout, guest, snap] = await Promise.all([embedder(ctx, `window.__s2.layout()`), guestEval(ctx, GUEST_INFO), embedder(ctx, `window.__s2.snapshot()`)]);
    let worst = 0;
    for (const t of targets) {
      const g = guest.rects.find((r: any) => r.id === t.id), rep = snap.latest[`a${t.i}`];
      if (!g) continue;
      if (!rep || !rep.rect) { worst = Math.max(worst, 99); continue; }
      worst = Math.max(worst, Math.abs(rep.rect.x - g.x), Math.abs(rep.rect.y - g.y), Math.abs(rep.rect.width - g.width), Math.abs(rep.rect.height - g.height));
    }
    if (firstErr === null) firstErr = worst;
    const key = JSON.stringify([layout.frame.left, layout.frame.top, layout.frame.width, layout.frame.height, layout.stage.scrollTop, layout.stage.width, guest.innerWidth, guest.innerHeight, guest.scrollY]);
    stable = worst <= 0.6 && key === lastKey ? stable + 1 : 0;
    lastKey = key;
    if (stable >= 3) break;
    if (Date.now() - t0 > 6000) { timedOut = true; break; }
    await sleep(70);
  }
  return { settleMs: Date.now() - t0, timedOut, initialTrackerErrorCssPx: round(firstErr ?? 0) };
}

const dumpDir = process.env.S2_DUMP;
const capture = async (regionCss: { left: number; top: number; right: number; bottom: number }, innerWidth: number, name: string): Promise<any> => {
  const r = await app.evaluate(mainCapture, { detectSrc: detectBoxes.toString(), palette: PALETTE, regionCss, innerWidth, png: !!dumpDir });
  if (dumpDir && r.png) { fs.mkdirSync(dumpDir, { recursive: true }); fs.writeFileSync(path.join(dumpDir, `${name.replace(/[^A-Za-z0-9._-]/g, "_")}.png`), Buffer.from(r.png, "base64")); }
  r.png = null;
  return r;
};

/** css rect of the on-screen area where the guest can show anything (stage clip ∩ webview content box). */
function clipRectCss(L: any) {
  const f = L.frame, s = L.stage;
  return {
    left: Math.max(s.left, f.left + f.clientLeft), top: Math.max(s.top, f.top + f.clientTop),
    right: Math.min(s.right, f.left + f.clientLeft + f.clientWidth), bottom: Math.min(s.bottom, f.top + f.clientTop + f.clientHeight),
  };
}

async function measureState(ctx: Ctx, fx: (typeof FIXTURES)[number], state: State, targets: Array<{ id: string; tag: string; i: number }>) {
  const settled = await settle(ctx, targets);
  const layout = await embedder(ctx, `window.__s2.layout()`);
  const guest = await guestEval(ctx, GUEST_INFO);
  const snap = await embedder(ctx, `window.__s2.snapshot()`);
  const items = targets.map((t) => ({ i: t.i, rect: snap.latest[`a${t.i}`]?.rect ?? null, visible: snap.latest[`a${t.i}`]?.visible ?? false }));

  await embedder(ctx, `window.__s2.clearMarkers()`);
  await embedder(ctx, `window.__s2.twoFrames()`);
  const clip = clipRectCss(layout);
  const stageRegion = { left: layout.stage.left, top: layout.stage.top, right: layout.stage.right, bottom: layout.stage.bottom };
  const capT = await capture(clip, layout.innerWidth, `${fx.id}-${state.id}-targets`);
  const pxPerCss = capT.width / layout.innerWidth;
  await guestEval(ctx, `(() => { for (const e of document.querySelectorAll("[data-s2]")) e.style.setProperty("visibility", "hidden", "important"); return true; })()`);
  const markerBoxes: Record<string, any[]> = {};
  try {
    for (const mapping of MAPPINGS) {
      await embedder(ctx, `window.__s2.place(arg.mapping, arg.items, arg.guest, arg.colors)`, {
        mapping, items, guest: { innerWidth: guest.innerWidth, innerHeight: guest.innerHeight }, colors: PALETTE.map((c) => cssList(c.join(","))),
      });
      await embedder(ctx, `window.__s2.twoFrames()`);
      await sleep(30);
      markerBoxes[mapping] = (await capture(stageRegion, layout.innerWidth, `${fx.id}-${state.id}-${mapping}`)).boxes;
    }
  } finally {
    await embedder(ctx, `window.__s2.clearMarkers()`).catch(() => {});
    await guestEval(ctx, `(() => { for (const e of document.querySelectorAll("[data-s2]")) e.style.removeProperty("visibility"); return true; })()`).catch(() => {});
  }

  const cases = targets.map((t) => {
    const it = items.find((x) => x.i === t.i)!;
    const truth = guest.rects.find((r: any) => r.id === t.id);
    const tb = capT.boxes[t.i];
    const c: any = {
      target: t.id, tag: t.tag, reportedVisible: it.visible, reportedRect: it.rect,
      guestRect: truth ? { x: truth.x, y: truth.y, width: truth.width, height: truth.height } : null,
      trackerVsGuestCssPx: it.rect && truth ? round(Math.max(Math.abs(it.rect.x - truth.x), Math.abs(it.rect.y - truth.y), Math.abs(it.rect.width - truth.width), Math.abs(it.rect.height - truth.height))) : null,
      targetFound: !!tb?.found, targetBoxPhys: tb?.found ? boxOut(tb) : null, mappings: {} as Record<string, any>,
    };
    if (!it.rect) { c.note = "no reported rect"; return c; }
    // Which edges are cut by the guest viewport / the stage clip (excluded: both sides see a clip, not a position).
    const k = (m: Mapping) => (m === "scaled" ? { x: layout.frame.clientWidth / guest.innerWidth, y: layout.frame.clientHeight / guest.innerHeight } : { x: 1, y: 1 });
    const kk = k("scaled");
    const ox = layout.frame.left + layout.frame.clientLeft, oy = layout.frame.top + layout.frame.clientTop;
    const intended = { left: ox + it.rect.x * kk.x, top: oy + it.rect.y * kk.y, right: ox + (it.rect.x + it.rect.width) * kk.x, bottom: oy + (it.rect.y + it.rect.height) * kk.y };
    const cut = { l: intended.left < clip.left + 0.25, t: intended.top < clip.top + 0.25, r: intended.right > clip.right - 0.25, b: intended.bottom > clip.bottom - 0.25 };
    c.cutEdges = cut;
    for (const mapping of MAPPINGS) {
      const mb = markerBoxes[mapping]![t.i];
      if (!tb?.found || !mb?.found) {
        const inClip = intended.right > clip.left && intended.left < clip.right && intended.bottom > clip.top && intended.top < clip.bottom;
        const error = !tb?.found && !mb?.found
          ? (!it.visible ? "offscreen" : !inClip ? "outside-pane-clip" : "phantom: reported visible, nothing on screen (an ancestor clips it)")
          : !tb?.found ? "target not found, marker drawn" : "marker not found, target drawn";
        c.mappings[mapping] = { error };
        continue;
      }
      const eL = mb.left - tb.left, eT = mb.top - tb.top, eR = mb.right - tb.right, eB = mb.bottom - tb.bottom;
      const phys: any = {};
      if (!cut.l) phys.dx = eL;
      if (!cut.t) phys.dy = eT;
      if (!cut.l && !cut.r) phys.dw = eR - eL;
      if (!cut.t && !cut.b) phys.dh = eB - eT;
      const cssv: any = {};
      for (const [key, v] of Object.entries(phys)) cssv[key] = round((v as number) / pxPerCss);
      c.mappings[mapping] = { markerBoxPhys: boxOut(mb), errPhys: roundAll(phys), errCss: cssv, worstCss: Object.values(cssv).length ? round(Math.max(...(Object.values(cssv) as number[]).map(Math.abs))) : null };
    }
    return c;
  });

  return {
    fixture: fx.id, condition: state.id, group: state.group, spec: state, settle: settled,
    pxPerCss: round(pxPerCss, 4), bitmap: { width: capT.width, height: capT.height, contentDip: capT.content, analysisMs: capT.analysisMs },
    layout, guest: { ...guest, rects: undefined }, clipCss: clip, cases,
  };
}
const boxOut = (b: any) => ({ left: round(b.left), top: round(b.top), right: round(b.right), bottom: round(b.bottom), width: round(b.right - b.left), height: round(b.bottom - b.top) });
const roundAll = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));

/** Drive the real pick flow once and check that the production selection box sits where the copied formula says. */
async function replicaCheck(ctx: Ctx, targets: Array<{ id: string; i: number }>, stateId: string) {
  try {
    const snap = await embedder(ctx, `window.__s2.snapshot()`);
    const t = targets[0]!;
    const r = snap.latest[`a${t.i}`]?.rect;
    if (!r) return { state: stateId, skipped: "no rect" };
    await ctx.win.locator(".artifact-view-pick-btn").click();
    const cx = Math.round(r.x + r.width / 2), cy = Math.round(r.y + r.height / 2);
    const send = (e: any) => app.evaluate(({ webContents }: any, ev: any) => {
      const g = webContents.getAllWebContents().find((w: any) => w.getType() === "webview" && !w.isDestroyed() && !w.getURL().startsWith("devtools"));
      if (g) g.sendInputEvent(ev);
    }, e);
    await send({ type: "mouseMove", x: cx, y: cy });
    await send({ type: "mouseDown", x: cx, y: cy, button: "left", clickCount: 1 });
    await send({ type: "mouseUp", x: cx, y: cy, button: "left", clickCount: 1 });
    await ctx.win.locator(".pick-popover").waitFor({ state: "visible", timeout: 8000 });
    await sleep(400);
    const out = await ctx.win.evaluate(() => {
      const v = (window as any).app.workspace.getLeavesOfType("geode-artifact")[0].view;
      const box = document.querySelector(".artifact-view-selection-box") as HTMLElement;
      const frame = document.querySelector(".artifact-view-frame")!.getBoundingClientRect();
      const stage = document.querySelector(".artifact-view-stage")!.getBoundingClientRect();
      const b = v.liveRect ?? v.pick?.state?.snapshot?.selection?.boundingBox?.viewport;
      return {
        domLeft: parseFloat(box.style.left), domTop: parseFloat(box.style.top), domWidth: parseFloat(box.style.width), domHeight: parseFloat(box.style.height),
        formulaLeft: Math.round(frame.left - stage.left + b.x), formulaTop: Math.round(frame.top - stage.top + b.y),
        formulaWidth: Math.max(2, Math.round(b.width)), formulaHeight: Math.max(2, Math.round(b.height)),
      };
    });
    await ctx.win.evaluate(() => { const v = (window as any).app.workspace.getLeavesOfType("geode-artifact")[0].view; v.pick?.escape(); v.pick?.escape(); });
    await sleep(150);
    return { state: stateId, ...out, match: out.domLeft === out.formulaLeft && out.domTop === out.formulaTop && out.domWidth === out.formulaWidth && out.domHeight === out.formulaHeight };
  } catch (error) {
    return { state: stateId, skipped: String((error as Error).message ?? error).split("\n")[0] };
  }
}

// ------------------------------------------------------------------------------------------------------------ summary
type CaseRow = { fixture: string; condition: string; group: string; mapping: Mapping; comps: Record<string, number>; worst: number };
function buildSummary(states: any[]) {
  const rows: CaseRow[] = [];
  for (const s of states) for (const c of s.cases) for (const m of MAPPINGS) {
    const mm = c.mappings[m];
    if (!mm || !mm.errCss || mm.worstCss === null) continue;
    rows.push({ fixture: s.fixture, condition: s.condition, group: s.group, mapping: m, comps: mm.errCss, worst: mm.worstCss });
  }
  const verdict = (worsts: number[]): "PASS" | "WARN" | "FAIL" | "NO-DATA" => {
    if (!worsts.length) return "NO-DATA";
    if (Math.max(...worsts) <= TOLERANCE_CSS) return "PASS";
    return pct(worsts, 0.95) <= TOLERANCE_CSS ? "WARN" : "FAIL";
  };
  const aggregate = (pick: (r: CaseRow) => boolean) => {
    const out: any = {};
    for (const m of MAPPINGS) {
      const rs = rows.filter((r) => r.mapping === m && pick(r));
      const comps: any = {};
      for (const k of ["dx", "dy", "dw", "dh"]) comps[k] = stats(rs.filter((r) => k in r.comps).map((r) => Math.abs(r.comps[k]!)));
      const signed: any = {};
      for (const k of ["dx", "dy", "dw", "dh"]) { const v = rs.filter((r) => k in r.comps).map((r) => r.comps[k]!); signed[k] = { median: round(pct(v, 0.5)) }; }
      out[m] = { cases: rs.length, worstCss: stats(rs.map((r) => r.worst)), components: comps, signedMedian: signed, verdict: verdict(rs.map((r) => r.worst)) };
    }
    return out;
  };
  const conditions = [...new Set(states.map((s) => s.condition))];
  const groups = [...new Set(states.map((s) => s.group))];
  return {
    toleranceCssPx: TOLERANCE_CSS,
    verdictRule: "PASS: every case within 1 css px; WARN: p95 within 1 css px but some case beyond; FAIL: p95 beyond 1 css px. css px = embedder css px at the current app zoom.",
    perCondition: conditions.map((id) => ({ condition: id, group: states.find((s) => s.condition === id).group, ...aggregate((r) => r.condition === id) })),
    perGroup: groups.map((g) => ({ group: g, ...aggregate((r) => r.group === g) })),
    perFixture: [...new Set(states.map((s) => s.fixture))].map((f) => ({ fixture: f, ...aggregate((r) => r.fixture === f) })),
    overall: aggregate(() => true),
  };
}

function printSummary(result: any) {
  const L: string[] = [];
  const d = result.display, v = result.versions;
  L.push("", "=== Spike S2 summary ===" + (result.mechanicsCheckOnly ? "   (MECHANICS CHECK ONLY: not the spike result)" : ""));
  L.push(`machine     ${result.host.hostname}  ${result.host.platform} ${result.host.osRelease} ${result.host.arch}`);
  L.push(`electron    ${v.electron}  chrome ${v.chrome}  node ${v.node}`);
  L.push(`display     scaleFactor ${d.scaleFactor}  ${d.size.width}x${d.size.height} dip  refresh ${d.displayFrequency || "n/a"} Hz  internal ${d.internal}  colorSpace ${JSON.stringify(d.colorSpace)}`);
  L.push(`rAF rate    start ${result.rafHz.start} Hz  end ${result.rafHz.end} Hz   (embedder requestAnimationFrame; a visible ProMotion display shows ~120)`);
  L.push(`states      ${result.states.length} measured, ${result.harnessErrors.length} harness errors, ${result.durationSec}s`);
  if (result.replicaCheck?.length) L.push(`replica     production selection box vs copied formula: ${result.replicaCheck.map((r: any) => r.skipped ? `${r.state}: skipped (${r.skipped})` : `${r.state}: ${r.match ? "identical" : "DIFFERENT"}`).join("; ")}`);
  if (result.reportLag) L.push(`report lag  tracker rect vs a guest scrollTo (includes automation round trip): p50 ${result.reportLag.p50} ms  p95 ${result.reportLag.p95} ms  max ${result.reportLag.max} ms  (n ${result.reportLag.n})`);
  L.push("", "Verdict per condition, error in embedder css px (worst of dx dy dw dh per case: p50 / p95 / max). Production mapping = 'existing'.");
  const cell = (a: any) => a && a.cases ? `${a.verdict.padEnd(7)} ${String(a.worstCss.p50).padStart(5)} /${String(a.worstCss.p95).padStart(5)} /${String(a.worstCss.max).padStart(5)} (n ${a.cases})` : "no data";
  L.push(`${"condition".padEnd(34)}${"existing".padEnd(36)}${"border".padEnd(36)}scaled`);
  for (const c of result.summary.perCondition) L.push(`${c.condition.padEnd(34)}${cell(c.existing).padEnd(36)}${cell(c.border).padEnd(36)}${cell(c.scaled)}`);
  L.push("", "Per group (existing mapping):");
  for (const g of result.summary.perGroup) L.push(`  ${g.group.padEnd(16)} ${cell(g.existing)}   signed median dx ${g.existing.signedMedian.dx.median} dy ${g.existing.signedMedian.dy.median} dw ${g.existing.signedMedian.dw.median} dh ${g.existing.signedMedian.dh.median}`);
  L.push("", "Overall:");
  for (const m of MAPPINGS) L.push(`  ${m.padEnd(9)} ${cell(result.summary.overall[m])}`);
  if (result.findings.length) { L.push("", "Notes:"); for (const f of result.findings) L.push(`  - ${f}`); }
  if (result.harnessErrors.length) { L.push("", "Harness errors:"); for (const e of result.harnessErrors) L.push(`  ! ${e}`); }
  L.push("", `Results: ${result.files.json}`);
  return L.join("\n");
}

function findings(result: any): string[] {
  const out: string[] = [];
  const e = result.summary.overall.existing, s = result.summary.overall.scaled;
  if (e.cases && s.cases && e.worstCss.p95 > 1.0 && s.worstCss.p95 <= 1.0) out.push("The production mapping misses the tolerance but the scaled mapping (frame content box origin plus guest-to-embedder scale) meets it: the formula needs a correction.");
  for (const g of result.summary.perGroup) {
    const ex = g.existing, sc = g.scaled;
    if (ex.cases && ex.verdict !== "PASS") out.push(`group ${g.group}: existing mapping ${ex.verdict} (p95 ${ex.worstCss.p95} css px, signed median dx ${ex.signedMedian.dx.median}, dy ${ex.signedMedian.dy.median}); scaled ${sc.verdict} (p95 ${sc.worstCss.p95}).`);
  }
  const slow = result.states.filter((s: any) => s.settle.timedOut).map((s: any) => `${s.fixture}/${s.condition}`);
  if (slow.length) out.push(`tracker rects never converged to the guest's own within 6 s in: ${slow.slice(0, 8).join(", ")}${slow.length > 8 ? " ..." : ""}`);
  const phantom = result.states.flatMap((s: any) => s.cases.filter((c: any) => String(c.mappings.existing?.error ?? "").startsWith("phantom") || String(c.mappings.existing?.error ?? "").startsWith("target not found")).map((c: any) => `${s.fixture}/${s.condition}/${c.target}`));
  if (phantom.length) out.push(`the tracker reports visible=true for elements that are not on screen (clipped by an ancestor scroller / overflow): a badge would float over unrelated content. ${phantom.length} cases, e.g. ${phantom.slice(0, 4).join(", ")}`);
  const paneClipped = result.states.flatMap((s: any) => s.cases.filter((c: any) => c.mappings.existing?.error === "outside-pane-clip").map((c: any) => `${s.fixture}/${s.condition}/${c.target}`));
  if (paneClipped.length) out.push(`reported visible (inside the guest viewport) but outside the visible pane (webview larger than the stage): the overlay clips it correctly but a badge list must not count it as on screen. ${paneClipped.length} cases.`);
  const noRect = result.states.flatMap((s: any) => s.cases.filter((c: any) => c.targetFound && c.reportedVisible === false).map((c: any) => `${s.fixture}/${s.condition}/${c.target}`));
  if (noRect.length) out.push(`target visible on screen while the tracker said not visible: ${noRect.slice(0, 6).join(", ")}`);
  return out;
}

// ------------------------------------------------------------------------------------------------------------- main
async function main(): Promise<number> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const selected = FIXTURES.filter((f) => !onlyFixtures || onlyFixtures.includes(f.id));
  if (!selected.length) { console.error(`no fixture matches --fixtures ${value("fixtures")}`); return 2; }
  const { win, env } = await setupApp();
  const ctx: Ctx = { win, frame: null };
  const info = await app.evaluate(mainWindow, { kind: "info" });
  const rafStart = await win.evaluate(() => (window as any).__s2.frames(1000));
  console.log(`S2 harness: ${selected.length} fixtures, ${quick ? "quick" : "full"} conditions, scaleFactor ${info.display.scaleFactor}`);

  const states: any[] = [];
  const replica: any[] = [];
  let reportLag: any = null;
  for (const fx of selected) {
    let loaded;
    try { loaded = await loadFixture(ctx, env, fx); } catch (error) { harnessErrors.push(`fixture ${fx.id}: ${(error as Error).message}`); console.error(`! ${harnessErrors.at(-1)}`); continue; }
    const list = stateList(fx);
    console.log(`\n[${fx.id}] ${loaded.targets.length} targets, ${list.length} conditions`);
    let first = true;
    for (const st of list) {
      const t0 = Date.now();
      try {
        await applyState(ctx, st, loaded.targets);
        const result = await measureState(ctx, fx, st, loaded.targets);
        if (first && !result.cases.some((c: any) => c.targetFound)) throw new Error("no target colour found in the window capture: capturePage does not include the <webview> content on this machine");
        first = false;
        states.push(result);
        const worst = result.cases.flatMap((c: any) => c.mappings.existing?.worstCss ?? []);
        console.log(`  ${st.id.padEnd(32)} ${String(Date.now() - t0).padStart(5)} ms  existing worst ${worst.length ? Math.max(...worst) : "-"} css px  settle ${result.settle.settleMs} ms${result.settle.timedOut ? " TIMEOUT" : ""}`);
        if (!flag("no-replica") && fx.id === "plain" && ["baseline", "preset-tablet", "zoom-125-tablet"].includes(st.id)) replica.push(await replicaCheck(ctx, loaded.targets, st.id));
      } catch (error) {
        harnessErrors.push(`${fx.id}/${st.id}: ${(error as Error).message}`);
        console.error(`  ! ${harnessErrors.at(-1)}`);
        if (/capturePage does not include/.test((error as Error).message)) break;
      }
    }
    if (fx.id === "scroller" && !quick) {
      try {
        await applyState(ctx, FULL[0]!, loaded.targets);
        await settle(ctx, loaded.targets);
        const lags: Array<number | null> = await embedder(ctx, `window.__s2.lag(24)`);
        const ok = lags.filter((x): x is number => typeof x === "number");
        reportLag = { ...stats(ok), n: ok.length, timeouts: lags.length - ok.length };
      } catch (error) { harnessErrors.push(`report lag: ${(error as Error).message}`); }
    }
  }
  await app.evaluate(mainWindow, { kind: "zoom", factor: 1 }).catch(() => {});
  const rafEnd = await win.evaluate(() => (window as any).__s2.frames(1000)).catch(() => ({ hz: null }));

  const finishedAt = new Date().toISOString();
  const result: any = {
    schema: "geode-s2-results-v1",
    mechanicsCheckOnly: info.platform !== "darwin" || flag("mechanics"),
    startedAt, finishedAt, durationSec: Math.round((Date.now() - started) / 1000), label, args: argv,
    host: { hostname: os.hostname(), platform: info.platform, osRelease: os.release(), arch: info.arch, cpus: os.cpus().length, totalMemGb: Math.round(os.totalmem() / 2 ** 30) },
    versions: info.versions, display: info.display, gpu: info.gpu, windowBounds: info.windowBounds,
    rafHz: { start: rafStart.hz, end: rafEnd.hz }, reportLag, replicaCheck: replica,
    palette: PALETTE, mappings: { existing: "verbatim ArtifactView.positionPopover: round(frame.left - stage.left + box.x)", border: "unrounded, origin includes the webview border (frame.clientLeft/Top)", scaled: "border + guest-to-embedder scale (frame.clientWidth / guest.innerWidth)" },
    states, harnessErrors,
  };
  result.summary = buildSummary(states);
  result.findings = findings(result);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(outDir, `s2-${label}-${stamp}.json`);
  const txtPath = path.join(outDir, `s2-${label}-${stamp}.summary.txt`);
  result.files = { json: jsonPath, summary: txtPath };
  fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
  const text = printSummary(result);
  fs.writeFileSync(txtPath, text + "\n");
  console.log(text);
  if (harnessErrors.length) return 2;
  if (strict && Object.values(result.summary.overall).some((m: any) => m.verdict === "FAIL")) return 1;
  return 0;
}

let code = 2;
try { code = await main(); } catch (error) { console.error(`HARNESS ERROR: ${(error as Error).stack ?? error}`); code = 2; } finally { await shutdown(); }
process.exit(code);
