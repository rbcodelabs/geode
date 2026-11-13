import * as fs from "node:fs";
import * as path from "node:path";
import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { makeEnv, writeStaticArtifact, type ArtifactSpec, type E2eEnv } from "./artifact-picker-fixtures";

/** Shared driver for the Phase 2b-i anchor e2e specs: real Electron, real preload, the view's `anchorProbe` test hook. */
export const repoRoot = path.resolve(__dirname, "..", "..", "..");

export interface Session { app: ElectronApplication; window: Page; env: E2eEnv; root: string; cleanup(): Promise<void> }

export async function session(spec: ArtifactSpec, options: { size?: [number, number]; prepare?: (root: string) => void } = {}): Promise<Session> {
  const env = makeEnv("geode-anchors-");
  const root = path.join(env.temp, "artifact");
  writeStaticArtifact(root, spec);
  options.prepare?.(root);
  const app = await electron.launch({ args: [repoRoot, `--user-data-dir=${env.userDataDir}`], cwd: repoRoot });
  const window = await app.firstWindow();
  await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
  const size = options.size ?? [1280, 800];
  const browserWindow = await app.browserWindow(window);
  await browserWindow.evaluate((win: any, s) => win.setSize(s[0], s[1]), size);
  await window.evaluate(() => {
    const a = (window as any).app;
    for (const sidebar of [a.workspace.leftSidebar, a.workspace.rightSidebar]) if (!sidebar.collapsed) sidebar.toggle();
  });
  await expect.poll(() => window.evaluate(() => typeof (window as any).__feedbackProbe?.register), { timeout: 30_000 }).toBe("function");
  expect(await window.evaluate(() => (window as any).__feedbackProbe.register())).toBe("registered");
  await window.evaluate((r) => (window as any).app.openArtifact(r), root);
  await expect(window.locator(".artifact-view-frame")).toBeVisible();
  await expect(window.locator(".artifact-view-pick-btn")).toBeVisible();
  await expect.poll(() => installProbe(window), { timeout: 30_000 }).toBe(true);
  return { app, window, env, root, cleanup: async () => { await app.close().catch(() => {}); fs.rmSync(env.temp, { recursive: true, force: true }); } };
}

export const frameOf = (w: Page): Locator => w.locator(".artifact-view-frame");
export const guestEval = <T = unknown>(w: Page, code: string): Promise<T> => frameOf(w).evaluate((g, c) => (g as any).executeJavaScript(c), code) as Promise<T>;

/**
 * The anchors have no UI yet, so the test drives the view's bridge directly (there is no production hook): this installs
 * `view.anchorProbe` on the live view instance, wrapping `bridge.setAnchors` / `focusAnchor` and recording the validated
 * guest messages through the bridge's own callbacks. Re-installed when the view re-attaches its inspector (a new bridge).
 */
export function installProbe(w: Page): Promise<boolean> {
  return w.evaluate(() => {
    const view = (window as any).app.workspace.getLeavesOfType("geode-artifact")[0]?.view;
    const bridge = view?.bridge;
    if (!bridge) return false;
    if (view.anchorProbe?.bridge === bridge) return true;
    let results: any[] = [];
    let rects: any[] = [];
    let resultCount = 0;
    let rectCount = 0;
    bridge.options.callbacks.onAnchorResults = (m: any) => { resultCount++; results = [...results, m].slice(-50); };
    bridge.options.callbacks.onAnchorRects = (m: any) => { rectCount++; rects = [...rects, m].slice(-50); };
    view.anchorProbe = {
      bridge,
      setAnchors: (q: unknown[]) => bridge.setAnchors(q),
      focus: (key: string, behavior: string) => bridge.focusAnchor(key, behavior),
      snapshot: () => ({ epoch: bridge.anchorEpoch, results: results.slice(), rects: rects.slice(), resultCount, rectCount }),
      clear() { results = []; rects = []; resultCount = 0; rectCount = 0; },
    };
    return true;
  });
}

/** Runs `fn(probe, view, arg)` in the renderer, where `probe` is the view's anchorProbe. `fn` must be self-contained. */
export async function inView<T, A = undefined>(w: Page, fn: (probe: any, view: any, arg: A) => T, arg?: A): Promise<Awaited<T>> {
  await installProbe(w);
  return w.evaluate(({ src, arg: a }) => {
    const view = (window as any).app.workspace.getLeavesOfType("geode-artifact")[0].view;
    return new Function("probe", "view", "arg", `return (${src})(probe, view, arg)`)(view.anchorProbe, view, a);
  }, { src: fn.toString(), arg }) as Promise<Awaited<T>>;
}

export const route = (w: Page) => guestEval<string>(w, `location.pathname + location.hash`);
export const query = (key: string, r: string, over: Record<string, unknown> = {}) => ({
  key, route: r, tag: "div", selector: "", alternates: [], textAnchor: { tag: "div", text: "" }, landmark: null, ...over,
});
export const lastResults = (w: Page) => inView(w, (p: any) => p.snapshot().results.at(-1) ?? null);
export const lastRects = (w: Page) => inView(w, (p: any) => p.snapshot().rects.at(-1) ?? null);
export const counts = (w: Page) => inView(w, (p: any) => { const s = p.snapshot(); return { epoch: s.epoch, results: s.resultCount, rects: s.rectCount }; });
export const near = (a: number, b: number, tolerance = 1) => Math.abs(a - b) <= tolerance;
export const percentile = (values: number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};
