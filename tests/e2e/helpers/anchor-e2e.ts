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
  await expect.poll(() => inView(window, (p: any) => p !== null && typeof p.setAnchors === "function"), { timeout: 30_000 }).toBe(true);
  return { app, window, env, root, cleanup: async () => { await app.close().catch(() => {}); fs.rmSync(env.temp, { recursive: true, force: true }); } };
}

export const frameOf = (w: Page): Locator => w.locator(".artifact-view-frame");
export const guestEval = <T = unknown>(w: Page, code: string): Promise<T> => frameOf(w).evaluate((g, c) => (g as any).executeJavaScript(c), code) as Promise<T>;

/** Runs `fn(probe, view, arg)` in the renderer, where `probe` is the view's anchorProbe. `fn` must be self-contained. */
export function inView<T, A = undefined>(w: Page, fn: (probe: any, view: any, arg: A) => T, arg?: A): Promise<Awaited<T>> {
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
