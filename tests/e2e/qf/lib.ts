import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { BASIC_ARTIFACT, type ArtifactSpec } from "../helpers/artifact-picker-fixtures";

/**
 * QA final gate harness: the REAL Geode build (the repo this runs in) with the REAL Design plugin build installed into
 * a throwaway vault, next to a recording Agent Threads stand-in. Linux/Xvfb, DPR 1. Variants come from env:
 *   QF_PLUGIN  directory holding the built plugin (manifest.json + main.js)
 *   QF_VARIANT new-new | new-old | old-new (informational; specs branch on it)
 */
export const REPO = path.resolve(__dirname, "..", "..", "..");
export const PLUGIN_DIR = process.env.QF_PLUGIN ?? "/tmp/qf-plugin";
export const VARIANT = process.env.QF_VARIANT ?? "new-new";
export const OUT = process.env.QF_OUT ?? path.join(os.tmpdir(), "qf-out");
export const STANDIN = path.join(__dirname, "standin");
fs.mkdirSync(OUT, { recursive: true });

export const THREAD = "thread-qf";

export function ev(id: string, detail: unknown): void {
  try { fs.appendFileSync(path.join(OUT, "ev.jsonl"), JSON.stringify({ t: Date.now(), id, detail }) + "\n"); } catch { /* ignore */ }
}

export interface Session {
  app: ElectronApplication; window: Page; temp: string; vault: string; userData: string; logs: string[];
  cleanup(): Promise<void>;
}

export interface LaunchOptions {
  size?: [number, number];
  /** Called after the vault exists and before Geode starts. */
  prepare?: (vault: string) => void;
  /** Extra plugin dir to use instead of QF_PLUGIN. */
  pluginDir?: string;
  userData?: string; temp?: string; vault?: string;
}

export let CURRENT: Session | null = null;
let LAST_DIAG = "none";
export const diag = async (): Promise<string> => LAST_DIAG;
async function snapDiag(): Promise<string> {
  const s = CURRENT; if (!s) return "no-session";
  try {
    const d = await s.window.evaluate(() => {
      const a = (window as any).app;
      const q = (sel: string) => document.querySelectorAll(sel).length;
      const leaves: string[] = []; a.workspace.iterateAllLeaves?.((l: any) => leaves.push(String(l.view?.getViewType?.())));
      return { leaves: leaves.join("+"), frame: q(".artifact-view-frame"), pick: q(".artifact-view-pick-btn"), cm: q(".artifact-view-comments-btn"), pop: q(".pick-popover"), rail: q(".comments-rail"), badge: q(".pin-badge"), si: !!(window as any).__si };
    });
    const errs = s.logs.filter((l) => /error|pageerror|warn/i.test(l) && !/Electron Security Warning|GPU|dbus|vault-read ENOENT/i.test(l)).slice(-3).map((l) => l.slice(0, 110));
    return JSON.stringify(d) + " LOGS " + errs.join(" || ");
  } catch (e) { return "diag-failed " + String((e as Error).message).slice(0, 80); }
}
export async function launch(options: LaunchOptions = {}): Promise<Session> {
  const temp = options.temp ?? fs.mkdtempSync(path.join(os.tmpdir(), "qf-"));
  const userData = options.userData ?? path.join(temp, "user-data");
  const vault = options.vault ?? path.join(temp, "vault");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(path.join(vault, ".geode", "plugins", "claude-threads"), { recursive: true });
  fs.mkdirSync(path.join(vault, ".geode", "plugins", "threads-design"), { recursive: true });
  if (!fs.existsSync(path.join(vault, "Welcome.md"))) fs.writeFileSync(path.join(vault, "Welcome.md"), "# Welcome\n");
  for (const f of ["manifest.json", "main.js"]) fs.copyFileSync(path.join(STANDIN, f), path.join(vault, ".geode", "plugins", "claude-threads", f));
  for (const f of ["manifest.json", "main.js"]) fs.copyFileSync(path.join(options.pluginDir ?? PLUGIN_DIR, f), path.join(vault, ".geode", "plugins", "threads-design", f));
  fs.writeFileSync(path.join(vault, ".geode", "plugins.json"), JSON.stringify(["claude-threads", "threads-design"]));
  fs.writeFileSync(path.join(userData, "geode.json"), JSON.stringify({ recentVaults: [vault], lastVault: vault }));
  options.prepare?.(vault);
  const app = await electron.launch({ args: [REPO, `--user-data-dir=${userData}`], cwd: REPO });
  const window = await app.firstWindow();
  const logs: string[] = [];
  window.on("console", (m) => logs.push(`[renderer ${m.type()}] ${m.text()}`));
  window.on("pageerror", (e) => logs.push(`[renderer pageerror] ${e.message}`));
  app.process().stdout?.on("data", (d) => logs.push(`[main out] ${String(d).trim()}`));
  app.process().stderr?.on("data", (d) => logs.push(`[main err] ${String(d).trim()}`));
  await window.waitForFunction(() => (window as any).app?.workspace?.layoutReady);
  const bw = await app.browserWindow(window);
  const size = options.size ?? [1280, 800];
  await bw.evaluate((w: any, s: number[]) => w.setSize(s[0], s[1]), size);
  await window.evaluate(() => {
    const a = (window as any).app;
    for (const sidebar of [a.workspace.leftSidebar, a.workspace.rightSidebar]) if (sidebar && !sidebar.collapsed) sidebar.toggle();
  });
  await expect.poll(() => window.evaluate(() => !!(window as any).__si), { timeout: 30_000 }).toBe(true);
  const session: Session = {
    app, window, temp, vault, userData, logs,
    cleanup: async () => { LAST_DIAG = await snapDiag(); await app.close().catch(() => {}); fs.rmSync(temp, { recursive: true, force: true }); },
  };
  CURRENT = session;
  return session;
}

/** The design manifest the plugin's canHandle/intake accept (schemaVersion 2, static, fill viewport). */
export function writeDesignArtifact(vault: string, folder: string, spec: ArtifactSpec, extra: { threadId?: string; permissions?: Record<string, unknown> } = {}): string {
  const root = path.join(vault, "Artifacts", "threads-design", folder);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "artifact.json"), JSON.stringify({
    schemaVersion: 2, id: spec.id, title: spec.title ?? spec.id, entry: "index.html", runtime: "static",
    createdByThreadId: extra.threadId ?? THREAD, viewport: { preset: "fill", width: 900, height: 600 },
    permissions: { network: "none", clipboard: false, ...(spec.permissions ?? {}), ...(extra.permissions ?? {}) },
  }));
  fs.writeFileSync(path.join(root, "index.html"), spec.html);
  for (const [name, content] of Object.entries(spec.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

/** Registers the thread and the artifact ref with the stand-in (what Agent Threads would hold for a real /design run). */
export async function attachArtifact(w: Page, root: string, spec: ArtifactSpec, threadId = THREAD): Promise<void> {
  await w.evaluate(({ root, id, title, threadId }) => {
    const si = (window as any).__si;
    if (!si.threads.has(threadId)) si.newThread(threadId, "/tmp");
    si.attachRef(threadId, { providerId: "agent-threads.design", kind: "design-static", schemaVersion: 2, id, title, data: {}, storageRoot: root });
  }, { root, id: spec.id, title: spec.title ?? spec.id, threadId });
}

export async function openArtifact(w: Page, root: string): Promise<void> {
  await w.evaluate((r) => (window as any).app.openArtifact(r), root);
  await expect(w.locator(".artifact-view-frame")).toBeVisible({ timeout: 30_000 });
  await expect(w.locator(".artifact-view-pick-btn")).toBeVisible({ timeout: 30_000 });
}

export const frameOf = (w: Page): Locator => w.locator(".artifact-view-frame");
export const guestEval = <T = unknown>(w: Page, code: string): Promise<T> => frameOf(w).evaluate((g, c) => (g as any).executeJavaScript(c), code) as Promise<T>;
export const pickToggle = (w: Page): Locator => w.locator(".artifact-view-pick-btn");
export const commentsToggle = (w: Page): Locator => w.locator(".artifact-view-comments-btn");
export const popover = (w: Page): Locator => w.locator(".pick-popover");
export const popStatus = (w: Page): Locator => w.locator(".pick-popover-status");
export const badges = (w: Page): Locator => w.locator(".pin-badge");
export const rail = (w: Page): Locator => w.locator(".comments-rail");
export const rows = (w: Page): Locator => rail(w).locator(".comments-rail-row");
export const si = <T>(w: Page, fn: (si: any) => T): Promise<T> => w.evaluate(`(${fn.toString()})(window.__si)`) as Promise<T>;
export const sends = (w: Page) => si(w, (s) => s.calls.filter((c: any) => c.method === "threads.send").map((c: any) => ({ id: c.args.id, prompt: c.args.input.prompt as string, key: c.args.input.idempotencyKey as string })));

export const guestInput = (app: ElectronApplication, event: Record<string, unknown>) =>
  app.evaluate(({ webContents }, e) => {
    const g = webContents.getAllWebContents().find((x) => x.getType() === "webview" && !x.isDestroyed() && !x.getURL().startsWith("devtools"));
    if (!g) return false;
    g.sendInputEvent(e as any);
    return true;
  }, event);
export async function clickAt(app: ElectronApplication, x: number, y: number): Promise<void> {
  await guestInput(app, { type: "mouseMove", x, y });
  await guestInput(app, { type: "mouseDown", x, y, button: "left", clickCount: 1 });
  await guestInput(app, { type: "mouseUp", x, y, button: "left", clickCount: 1 });
}
export async function guestKey(app: ElectronApplication, keyCode: string): Promise<void> {
  await guestInput(app, { type: "keyDown", keyCode });
  await guestInput(app, { type: "keyUp", keyCode });
}
export const BUY = { x: 180, y: 224 };
export const PRICE = { x: 150, y: 120 };

export type Mode = "pin" | "send";
/** Pick the element under (x, y), type text, press Pin or Send in the popover. Returns the popover status text. */
export async function pickAndSubmit(s: Session, at: { x: number; y: number }, text: string, mode: Mode, done = true): Promise<string> {
  const w = s.window;
  if ((await pickToggle(w).getAttribute("aria-pressed")) !== "true") await pickToggle(w).click();
  await clickAt(s.app, at.x, at.y);
  await expect(popover(w)).toBeVisible({ timeout: 15_000 });
  await popover(w).locator("textarea").fill(text);
  await popover(w).getByRole("button", { name: mode === "pin" ? "Pin" : "Send", exact: true }).click();
  await expect(popStatus(w)).toHaveText(mode === "pin" ? /Pinned/ : /Sent|Queued/, { timeout: 20_000 });
  const status = (await popStatus(w).textContent()) ?? "";
  if (done) {
    const d = popover(w).getByRole("button", { name: "Done" });
    if (await d.isVisible().catch(() => false)) await d.click();
    await expect(popover(w)).toBeHidden({ timeout: 10_000 });
  }
  return status;
}

export const commentsPath = (root: string) => path.join(root, ".threads-design", "comments.json");
export function readComments(root: string): any | null {
  try { return JSON.parse(fs.readFileSync(commentsPath(root), "utf8")); } catch { return null; }
}
export const sidecarFiles = (root: string): string[] => {
  const d = path.join(root, ".threads-design");
  try { return fs.readdirSync(d, { recursive: true } as any).map(String).sort(); } catch { return []; }
};

/** Badge centre relative to the stage vs the true element rect (guest) mapped through the real webview offset. */
export async function badgeCentre(w: Page, label: string): Promise<{ x: number; y: number } | null> {
  return w.evaluate((t) => {
    const stage = document.querySelector<HTMLElement>(".artifact-view-stage")!.getBoundingClientRect();
    const el = [...document.querySelectorAll<HTMLElement>(".pin-badge")].find((b) => b.firstChild?.nodeValue?.replace("~", "") === t);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2 - stage.left, y: r.top + r.height / 2 - stage.top };
  }, label);
}
export async function expectedCentre(w: Page, selector: string): Promise<{ x: number; y: number }> {
  const r = await guestEval<{ right: number; top: number }>(w, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { right: r.right, top: r.top }; })()`);
  const frame = await w.evaluate(() => {
    const f = document.querySelector<HTMLElement>(".artifact-view-frame")!;
    const st = document.querySelector<HTMLElement>(".artifact-view-stage")!.getBoundingClientRect();
    const b = f.getBoundingClientRect();
    return { left: b.left + f.clientLeft - st.left, top: b.top + f.clientTop - st.top, width: st.width, height: st.height };
  });
  const INSET = 20; // PIN_BADGE.edgeMargin (10) + diameter / 2 (10): the whole badge stays inside the stage
  const clamp = (v: number, max: number) => Math.min(Math.max(INSET, v), Math.max(INSET, max - INSET));
  return { x: clamp(frame.left + r.right - 4, frame.width), y: clamp(frame.top + r.top + 4, frame.height) };
}
export const near = (a: { x: number; y: number } | null, b: { x: number; y: number }, tol = 1.5) => a !== null && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plugin disable then enable through the app's own plugin manager (a real reload of the Design plugin). */
export async function reloadPlugin(w: Page, id = "threads-design"): Promise<void> {
  await w.evaluate(async (pid) => {
    const a = (window as any).app;
    await a.plugins.disablePlugin(pid);
    await new Promise((r) => setTimeout(r, 300));
    await a.plugins.enablePlugin(pid);
  }, id);
}

export const centreOf = (w: Page, selector: string) =>
  guestEval<{ x: number; y: number }>(w, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
export async function pinAt(s: Session, selector: string, text: string): Promise<string> {
  return pickAndSubmit(s, await centreOf(s.window, selector), text, "pin");
}
export async function waitComments(root: string, pred: (file: any) => boolean, timeoutMs = 15_000): Promise<any> {
  const end = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < end) { last = readComments(root); if (last && pred(last)) return last; await sleep(150); }
  throw new Error(`comments.json did not reach the expected state: ${JSON.stringify((last?.comments ?? []).map((c: any) => [c.ordinal, c.status, c.provenance]))}`);
}
export const statuses = (file: any): string[] => (file?.comments ?? []).slice().sort((a: any, b: any) => a.ordinal - b.ordinal).map((c: any) => c.status);
export async function openRail(w: Page): Promise<void> {
  if (!(await rail(w).isVisible().catch(() => false))) await commentsToggle(w).click();
  await expect(rail(w)).toBeVisible({ timeout: 10_000 });
}
export const setRunning = (w: Page, running: boolean, threadId = THREAD) => w.evaluate(([t, r]) => (window as any).__si.setRunning(t, r), [threadId, running] as const);
export const occurrences = (hay: string, needle: string): number => (needle ? hay.split(needle).length - 1 : 0);

/** A hand-made artifact with a second page (other-route tests). */
export const HAND: ArtifactSpec = {
  ...BASIC_ARTIFACT,
  id: "hand-pins",
  title: "Hand-made pricing page",
  html: BASIC_ARTIFACT.html.replace("</main>", '<a id="go" href="about.html" style="position:absolute;left:420px;top:120px">About us</a></main>'),
  files: {
    ...(BASIC_ARTIFACT.files ?? {}),
    "about.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About</title></head><body style="margin:0"><h1 id="about-h" style="margin:16px">About us</h1><button id="ab" type="button" style="position:absolute;left:100px;top:200px;width:160px;height:48px;margin:0;padding:0;border:0;background:#46c;color:#fff">Contact sales</button><a id="back" href="index.html" style="position:absolute;left:420px;top:120px">Back home</a></body></html>`,
  },
};

/** Records an observation on the running test (shown in the digest and the JSON report even when the test passes). */
export const obs = (value: unknown): void => { test.info().annotations.push({ type: "obs", description: typeof value === "string" ? value : JSON.stringify(value) }); };
