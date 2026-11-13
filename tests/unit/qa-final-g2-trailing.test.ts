import { describe, expect, it, vi } from "vitest";
import { INSPECT_CHANNEL, INSPECTOR_CAPS, type InspectAnchorQuery } from "../../src/artifacts/inspector-protocol";
import { boot, type GuestHarness } from "../helpers/inspector-guest-harness";

vi.setConfig({ testTimeout: 60_000 });

/**
 * QA final gate (G2 post-gate fix 4d677a85, QA-G2-8): after a burst of rect changes faster than the 9 ms spacing, the guest's
 * LAST anchor-rects message must carry the final rect (the trailing send). Without the trailing timer the pin stays stale
 * until the next 1 s re-assertion. Independent of the dev's own tests: a mutant that removes the trailing timer survived
 * tests/unit/qa-g2-fixpass-probes.test.ts.
 */
const PAGE = `<body><main><h2>Pricing</h2><section class="plans"><div class="card" id="pro"><button class="cta" data-testid="buy">Buy now</button></div></section></main></body>`;
const R = { x: 100, y: 200, width: 160, height: 48 };
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const q = (): InspectAnchorQuery => ({ key: "a0", route: "/page.html#frag", tag: "button", selector: "[data-testid=\"buy\"]", alternates: [], textAnchor: { tag: "button", text: "Buy now" }, landmark: null });

async function step(h: GuestHarness, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 1) { h.advance(1); h.flush(1); await settle(); }
}

describe("QA final: guest anchor-rects trailing send (QA-G2-8)", () => {
  it("after a burst faster than the spacing the last rects message carries the final rect", async () => {
    const h = boot(PAGE);
    const b = h.doc.querySelector("button")!;
    h.setRect(b, R);
    h.deliver(INSPECT_CHANNEL.anchors, { epoch: 1, redactText: false, anchors: [q()] });
    await step(h, 600);
    for (let i = 1; i <= 12; i++) { h.setRect(b, { ...R, y: 200 + i * 5 }); h.fire("scroll", {}, h.win as never); await step(h, 2); }
    await step(h, 300); // quiet: the trailing send must have happened by now, with no further page activity
    const last = h.last(INSPECT_CHANNEL.anchorRects)!.payload as { rects: Array<{ rect: { y: number } }> };
    expect(last.rects[0]!.rect.y).toBe(260);
  });

  it("spacing constant is the 9 ms the embedder's 120 per second window needs", () => {
    expect(INSPECTOR_CAPS.anchorRectsSpacingMillis).toBeGreaterThanOrEqual(1000 / INSPECTOR_CAPS.anchorRectsPerSecond);
  });
});
