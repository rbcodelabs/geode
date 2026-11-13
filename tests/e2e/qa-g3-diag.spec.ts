import { test } from "@playwright/test";
import { BASIC_ARTIFACT } from "./helpers/artifact-picker-fixtures";
import { session } from "./helpers/anchor-e2e";

test("diag: why are seeded pins not placed", async () => {
  test.setTimeout(120_000);
  const s = await session(BASIC_ARTIFACT, { register: "v2" });
  const w = s.window;
  try {
    await w.evaluate(() => {
      const view = (window as any).app.workspace.getLeavesOfType("geode-artifact")[0].view;
      const bridge = view.bridge;
      const log: any = ((window as any).__diag = { sent: [], res: [], rects: [] });
      const wv = bridge.webview;
      const orig = wv.send.bind(wv);
      wv.send = (c: string, ...a: unknown[]) => { log.sent.push([c, JSON.stringify(a[0]).slice(0, 400)]); return orig(c, ...a); };
      const cb = bridge.options.callbacks;
      const r0 = cb.onAnchorResults; cb.onAnchorResults = (m: any) => { log.res.push(JSON.stringify(m).slice(0, 500)); r0(m); };
      const r1 = cb.onAnchorRects; cb.onAnchorRects = (m: any) => { log.rects.push(JSON.stringify(m).slice(0, 300)); r1(m); };
    });
    await w.evaluate(() => (window as any).__feedbackProbe.store.seed([
      { tag: "button", label: "button Buy now", anchor: { tag: "button", selector: "#buy", textAnchor: { tag: "button", text: "Buy now" } } },
    ]));
    await w.waitForTimeout(6000);
    const dump = await w.evaluate(() => {
      const view = (window as any).app.workspace.getLeavesOfType("geode-artifact")[0].view;
      const st = (window as any).__feedbackProbe.store;
      return {
        diag: (window as any).__diag,
        listCalls: st.listCalls, listeners: st.listeners.size, comments: st.comments.length,
        hasPins: !!view.pins, hasClient: !!view.commentsClient, commentsRoute: view.commentsRoute,
        railOpen: view.pins?.railOpen, pinAvailable: view.pins?.pinAvailable,
        geometry: view.pinGeometry(),
        layer: document.querySelector(".pin-layer")?.outerHTML.slice(0, 600),
        route: view.webview ? null : null,
      };
    });
    console.log("G3DIAG " + JSON.stringify(dump, null, 1));
  } finally { await s.cleanup(); }
});
