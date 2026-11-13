import { expect, test } from "@playwright/test";
import {
  HAND, attachArtifact, badgeCentre, badges, centreOf, commentsToggle, diag, ev, obs, expectedCentre, launch, openArtifact, openRail, pinAt, waitComments, writeDesignArtifact, type Session,
} from "./lib";

test.skip(!process.env.QF_PLUGIN, "needs QF_PLUGIN: a built Design plugin directory");

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) info.annotations.push({ type: "diag", description: await diag() });
});

/** Window pixels: sample the composited window capture at each badge and compare with the badge's own computed colours. */
async function badgePixels(s: Session) {
  return s.app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!;
    const info = await win.webContents.executeJavaScript(`(() => [...document.querySelectorAll(".pin-badge")].map((b) => { const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); return { x: r.left, y: r.top, w: r.width, h: r.height, bg: cs.backgroundColor, text: b.textContent }; }))()`);
    const img = await win.webContents.capturePage();
    const size = img.getSize(); const bm = img.toBitmap();
    const px = (x: number, y: number) => { const X = Math.round(x), Y = Math.round(y); if (X < 0 || Y < 0 || X >= size.width || Y >= size.height) return null; const i = (Y * size.width + X) * 4; return [bm[i + 2]!, bm[i + 1]!, bm[i]!]; };
    return { size, dpr: await win.webContents.executeJavaScript("window.devicePixelRatio"), badges: info.map((b: any) => ({ ...b, atEdge: px(b.x + 3, b.y + b.h / 2), atTop: px(b.x + b.w / 2, b.y + 3) })) };
  });
}
const parseRgb = (s: string) => (s.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number);

test("QF-O01 overlay placement error at DPR 1: every badge centre is within 1.5 px of the true element rect (desktop and narrow)", async () => {
  test.setTimeout(240_000);
  const s = await launch();
  try {
    const w = s.window;
    const root = writeDesignArtifact(s.vault, "hand", HAND);
    await attachArtifact(w, root, HAND);
    await openArtifact(w, root);
    await expect(commentsToggle(w)).toBeVisible({ timeout: 20_000 });
    await pinAt(s, "#buy", "a"); await pinAt(s, ".price", "b"); await pinAt(s, "#go", "c"); await pinAt(s, "#plans-h", "d");
    await expect(badges(w)).toHaveCount(4, { timeout: 20_000 });
    const sel = ["#buy", ".price", "#go"]; // unclamped placements: the badge centre is the element's top-right corner offset (-4, +4)
    const errs: number[] = [];
    const skipped: string[] = [];
    const measure = async () => {
      for (let i = 0; i < sel.length; i++) {
        let e = 99; let wasClamped = false;
        for (let k = 0; k < 20 && e > 1.5; k++) {
          const b = await badgeCentre(w, String(i + 1)); const x = await expectedCentre(w, sel[i]!);
          const st = await w.evaluate(() => { const r = document.querySelector<HTMLElement>(".artifact-view-stage")!.getBoundingClientRect(); return { w: r.width, h: r.height }; });
          wasClamped = x.x >= st.w - 20 - 0.01 || x.x <= 20.01 || x.y >= st.h - 20 - 0.01 || x.y <= 20.01;
          e = b ? Math.max(Math.abs(b.x - x.x), Math.abs(b.y - x.y)) : 99;
          if (wasClamped) break; // an edge-clamped placement is checked by the inside-the-stage rule, not by the corner formula
          if (e > 1.5) await new Promise((r) => setTimeout(r, 300));
        }
        if (wasClamped) { skipped.push(sel[i]!); continue; }
        errs.push(e);
      }
    };
    await measure();
    ev("O01.desktopErr", errs.slice()); obs("desktop " + errs.map((e) => e.toFixed(2)).join(","));
    // the full-width heading's pin is clamped at the stage's right edge: the WHOLE badge must stay inside the stage
    const edge = await w.evaluate(() => {
      const st = document.querySelector<HTMLElement>(".artifact-view-stage")!.getBoundingClientRect();
      const b = [...document.querySelectorAll<HTMLElement>(".pin-badge")].find((x) => x.firstChild?.nodeValue?.replace("~", "") === "4")!.getBoundingClientRect();
      return { insideRight: st.right - b.right, insideLeft: b.left - st.left, insideTop: b.top - st.top, insideBottom: st.bottom - b.bottom };
    });
    obs("edge " + JSON.stringify(edge));
    expect(Math.min(edge.insideRight, edge.insideLeft, edge.insideTop, edge.insideBottom), "edge-clamped badge must be fully inside the stage " + JSON.stringify(edge)).toBeGreaterThanOrEqual(0);
    const dpr = await w.evaluate(() => window.devicePixelRatio);
    expect(dpr).toBe(1);
    expect(Math.max(...errs), "desktop errs " + errs.map((e) => e.toFixed(1)).join(",")).toBeLessThanOrEqual(1.5);
    await openRail(w);
    errs.length = 0; await measure();
    ev("O01.railErr", errs.slice()); obs("rail " + errs.map((e) => e.toFixed(2)).join(","));
    expect(Math.max(...errs), "rail errs " + errs.map((e) => e.toFixed(1)).join(",")).toBeLessThanOrEqual(1.5);
    const bw = await s.app.browserWindow(w);
    await bw.evaluate((win: any) => win.setSize(640, 800));
    await w.evaluate(() => { const side = (window as any).app.workspace.rightSidebar; if (side.collapsed) side.toggle(); });
    await new Promise((r) => setTimeout(r, 1500));
    errs.length = 0; skipped.length = 0; await measure();
    ev("O01.narrowErr", errs.slice()); obs("narrow " + errs.map((e) => e.toFixed(2)).join(",") + " clamped:" + skipped.join("+"));
    expect(errs.length, "narrow: at least one unclamped pin measured (skipped " + skipped.join("+") + ")").toBeGreaterThanOrEqual(1);
    expect(Math.max(...errs), "narrow errs " + errs.map((e) => e.toFixed(1)).join(",")).toBeLessThanOrEqual(1.5);
  } finally { await s.cleanup(); }
});

test("QF-O02 pixels: each badge is actually painted over the artifact (window capture sampled at the badge, colour equals its computed background)", async () => {
  test.setTimeout(240_000);
  const s = await launch();
  try {
    const w = s.window;
    const root = writeDesignArtifact(s.vault, "hand", HAND);
    await attachArtifact(w, root, HAND);
    await openArtifact(w, root);
    await expect(commentsToggle(w)).toBeVisible({ timeout: 20_000 });
    await pinAt(s, "#buy", "a"); await pinAt(s, ".price", "b");
    await expect(badges(w)).toHaveCount(2, { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 1500));
    const r = await badgePixels(s);
    ev("O02.pixels", JSON.stringify(r).slice(0, 600));
    expect(r.dpr).toBe(1);
    for (const b of r.badges) {
      const want = parseRgb(b.bg);
      const got = b.atEdge ?? [0, 0, 0];
      const d = Math.max(...want.map((v: number, i: number) => Math.abs(v - got[i]!)));
      expect(d, `badge ${b.text} bg ${b.bg} vs pixel ${got}`).toBeLessThanOrEqual(24);
    }
  } finally { await s.cleanup(); }
});
