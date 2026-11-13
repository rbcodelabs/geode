import * as fs from "node:fs";
import * as path from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactComment, ArtifactCommentsSnapshot } from "../../src/artifacts/feedback-contract-v2";
import { CommentsRail } from "../../src/renderer/artifacts/comments-rail";
import { PinOverlay } from "../../src/renderer/artifacts/pin-overlay";
import { createPinsCoordinator } from "../../src/renderer/artifacts/pins-coordinator";
import { comment, idOf, snapshot } from "./helpers/pin-fixtures";

vi.setConfig({ testTimeout: 30_000 });

/**
 * QA G3: the real CommentsRail + PinOverlay wired to the real coordinator the way artifact-view.ts wires them (JSDOM),
 * with a fake v2 client. Covers hostile strings, what the guest receives, focus, confirm lifetimes and teardown.
 * The former BUG tests (it.fails) are plain tests now that the defects are fixed.
 */

const SRC = path.resolve(__dirname, "..", "..", "src", "renderer");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const ok = <T,>(value: T) => ({ status: "ok" as const, value });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
const REQ = (n: number) => `req_${n.toString(16).padStart(32, "0")}`;

interface Rig {
  dom: JSDOM; doc: Document; rail: CommentsRail; layer: PinOverlay; coordinator: ReturnType<typeof createPinsCoordinator>;
  client: any; bridge: { setAnchors: ReturnType<typeof vi.fn>; focusAnchor: ReturnType<typeof vi.fn> };
  announced: string[]; frames: Array<() => void>; runFrames(): void; emit(s: ArtifactCommentsSnapshot): void;
  set(s: ArtifactCommentsSnapshot): void; q: (sel: string) => HTMLElement; qa: (sel: string) => HTMLElement[];
  results(epoch: number, rows: Array<[string, string, boolean, { x: number; y: number; width: number; height: number } | null]>): void;
  listeners: Set<(r: unknown) => void>; availability: any[];
}

function rig(initial: ArtifactCommentsSnapshot): Rig {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  const doc = dom.window.document;
  let current = initial;
  const listeners = new Set<(r: unknown) => void>();
  const frames: Array<() => void> = [];
  const announced: string[] = [];
  const availability: any[] = [];
  let reqCounter = 0;
  let epoch = 0;
  const client: any = {
    list: vi.fn(async () => ok(current)),
    update: vi.fn(async (input: { id: string }) => ok(comment(1, { id: input.id }))),
    remove: vi.fn(async (input: { id: string }) => ok({ id: input.id })),
    adopt: vi.fn(async (input: { ids: string[] }) => ok({ adopted: input.ids })),
    sendBatch: vi.fn(async (input: { requestId: string; ids: string[] }) => ok({ requestId: input.requestId, outcome: "sent", items: input.ids.map((id) => ({ id, result: "sent" })), message: "Sent." })),
    onDidChange: vi.fn((l: (r: unknown) => void) => { listeners.add(l); return () => { listeners.delete(l); }; }),
  };
  const bridge = {
    setAnchors: vi.fn((queries: readonly unknown[]) => ({ epoch: ++epoch, sent: queries.length, rejected: [] as string[] })),
    focusAnchor: vi.fn(() => true),
  };
  let coordinator!: ReturnType<typeof createPinsCoordinator>;
  const rail = new CommentsRail(doc, {
    onFilter: (f) => coordinator.setFilter(f),
    onClearCluster: () => coordinator.clearCluster(),
    onToggleSelect: (id, on) => coordinator.toggleSelect(id, on),
    onAction: (id, a) => { void coordinator.runAction(id, a); },
    onSendSelected: () => { void coordinator.sendSelected(); },
    onResolveSent: () => { void coordinator.resolveSent(); },
    onAdoptAll: () => { void coordinator.adoptAll(); },
    onRetry: () => { void coordinator.retryLastSend(); },
    onClose: () => coordinator.closeRail(),
  });
  const layer = new PinOverlay(doc, { onActivate: (b) => coordinator.activateBadge(b), onEscape: () => {} });
  const stage = doc.createElement("div");
  doc.body.append(stage, rail.el, layer.el);
  coordinator = createPinsCoordinator({
    getClient: () => client,
    bridge,
    scheduleFrame: (cb) => { frames.push(cb); return () => { const i = frames.indexOf(cb); if (i >= 0) frames.splice(i, 1); }; },
    newRequestId: () => REQ(++reqCounter),
    ui: {
      renderRail: (v) => rail.render(v),
      renderPins: (badges, busy) => layer.render(badges, { busy }),
      announce: (t) => { announced.push(t); },
      availability: (a) => { availability.push(a); },
      focusRail: (t) => { if (t.type === "heading") rail.focusHeading(); else rail.focusRow(t.id); },
      geometry: () => ({ frame: { left: 0, top: 0, clientLeft: 0, clientTop: 0 }, stage: { left: 0, top: 0, width: 900, height: 600 } }),
    },
  });
  return {
    dom, doc, rail, layer, coordinator, client, bridge, announced, frames, availability, listeners,
    runFrames() { const run = frames.splice(0); for (const f of run) f(); },
    emit(s) { current = s; for (const l of [...listeners]) l(ok(s)); },
    set(s) { current = s; },
    q: (sel) => doc.querySelector<HTMLElement>(sel)!,
    qa: (sel) => [...doc.querySelectorAll<HTMLElement>(sel)],
    results(e, rows) {
      coordinator.onAnchorResults({ epoch: e, results: rows.map(([key, match, agrees, rect]) => ({ key, match, agrees, rect, visible: rect !== null })) } as never);
    },
  };
}
const BOX = { x: 100, y: 200, width: 160, height: 48 };
const click = (el: Element) => el.dispatchEvent(new (el.ownerDocument.defaultView as any).MouseEvent("click", { bubbles: true, cancelable: true }));
const withOpenRail = async (r: Rig) => { await r.coordinator.start(); await r.coordinator.openRail(); };
afterEach(() => { vi.useRealTimers(); });

// ------------------------------------------------------------------------------------------------------------------
describe("unsafe sinks: comment- and page-derived strings", () => {
  const files = ["artifacts/comments-rail.ts", "artifacts/pin-overlay.ts", "artifacts/pins-coordinator.ts", "artifacts/rail-model.ts", "artifacts/pin-collapse.ts"];
  const SINKS = /innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser|\.srcdoc|\beval\s*\(|new\s+Function|setTimeout\s*\(\s*["'`]|\.html\s*=|dangerouslySet|\.href\s*=|\.src\s*=|setAttribute\(\s*["']on|setAttribute\(\s*["'](href|src|srcdoc|style)["']/;
  it.each(files)("%s has no HTML-parsing or script sink", (rel) => {
    expect(read(rel)).not.toMatch(SINKS);
  });
  it("artifact-view.ts adds no innerHTML/outerHTML/insertAdjacentHTML (whole file checked; only icon helpers are allowed)", () => {
    const src = read("views/artifact-view.ts");
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
  it("the only attribute writes in the rail and overlay are aria-*, role, tabindex, hidden, data-key and class", () => {
    for (const rel of ["artifacts/comments-rail.ts", "artifacts/pin-overlay.ts"]) {
      const names = [...read(rel).matchAll(/setAttribute\(\s*["']([a-z-]+)["']/g)].map((m) => m[1]!);
      for (const n of names) expect(["aria-label", "aria-pressed", "aria-hidden", "aria-busy", "aria-live", "role"], `${rel} setAttribute ${n}`).toContain(n);
    }
  });
});

const HOSTILE = [
  `<img src=x onerror="window.__pwned=1">`,
  `"><svg onload=alert(1)>`,
  `</script><script>window.__pwned=1</script>`,
  `javascript:alert(1)`,
  `‮⁦gnp.exe⁩ ‭txt`,                       // bidi override / isolate controls
  `\u0000\u0001\u0007\u001b[31mred\u007f\u0085  `,   // control characters, NEL, LS, PS
  `​‍﻿⁠zero​width`,                  // zero-width
  `a`.repeat(4000),                                            // the contract text cap, no break opportunity
  `${"\u{1F600}".repeat(1999)}\uD83D`,                          // lone surrogate at the end
  `#top > div:has(> button), *`,                               // selector-ish
  `{{7*7}} \${7*7} %s %1$s`,                                   // template-ish
  `__proto__ constructor toString`,
];

describe("hostile comment text and labels (rail rows and pin badges)", () => {
  it("every hostile string renders as text only: no new element kinds, no on* or URL attributes, exact textContent", async () => {
    const cs = HOSTILE.map((h, i) => comment(i + 1, { text: h, label: h.slice(0, 120) }));
    const r = rig(snapshot(cs));
    await withOpenRail(r);
    r.results(1, cs.map((c, i) => [`a${i}`, "selector", true, { x: 20 + i * 70, y: 40 + (i % 3) * 90, width: 40, height: 20 }]));
    r.runFrames();
    const allowed = new Set(["ASIDE", "DIV", "H2", "BUTTON", "SPAN", "UL", "LI", "INPUT", "P"]);
    for (const el of [...r.rail.el.querySelectorAll("*"), ...r.layer.el.querySelectorAll("*")]) {
      expect(allowed.has(el.tagName), `<${el.tagName.toLowerCase()}> appeared`).toBe(true);
      for (const a of el.getAttributeNames()) {
        expect(a.startsWith("on"), `${el.tagName} ${a}`).toBe(false);
        expect(["href", "src", "srcdoc", "action", "formaction", "xlink:href"]).not.toContain(a);
      }
    }
    const rendered = r.qa(".comments-rail-text").map((e) => e.textContent);
    expect(rendered).toEqual(cs.map((c) => c.text)); // not truncated, not altered, not parsed
    expect((r.dom.window as any).__pwned).toBeUndefined();
    // the pin badges carry the ordinal only, and the hostile label only in aria-label (an attribute value)
    for (const b of r.qa(".pin-badge")) expect(b.textContent).toMatch(/^~?\d+$/);
  });

  it("title and aria-label attribute values hold the hostile string verbatim without breaking out", async () => {
    const h = `" onfocus="window.__pwned=1" x="`;
    const r = rig(snapshot([comment(1, { label: h, text: h })]));
    await withOpenRail(r);
    r.results(1, [["a0", "selector", true, BOX]]);
    r.runFrames();
    const badge = r.q(".pin-badge");
    expect(badge.getAttribute("aria-label")).toContain(h);
    expect(badge.getAttributeNames().filter((n) => n.startsWith("on"))).toEqual([]);
    expect(r.rail.el.getAttributeNames().filter((n) => n.startsWith("on"))).toEqual([]);
  });

  it("a 200-comment artifact with 4000-unit hostile text renders the first 50 rows only, quickly", async () => {
    const cs = Array.from({ length: 200 }, (_, i) => comment(i + 1, { text: HOSTILE[i % HOSTILE.length]!.repeat(2).slice(0, 4000) }));
    const r = rig(snapshot(cs));
    const t0 = performance.now();
    await withOpenRail(r);
    expect(r.qa(".comments-rail-row")).toHaveLength(50);
    expect(r.q(".comments-rail-more").textContent).toBe("Show 50 more");
    click(r.q(".comments-rail-more"));
    expect(r.qa(".comments-rail-row")).toHaveLength(100);
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it("a notice or results line containing markup is placed as text", async () => {
    const r = rig(snapshot([comment(1)], { notice: "<b>recovered</b><img src=x onerror=1>" }));
    await withOpenRail(r);
    expect(r.q(".comments-rail-notice").textContent).toBe("<b>recovered</b><img src=x onerror=1>");
    expect(r.rail.el.querySelector("b,img")).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("T9: what the guest receives", () => {
  it("setAnchors queries have exactly the allowlisted keys, and nothing the embedder knows about the comment appears anywhere in the arguments", async () => {
    const secret = "TOPSECRET-COMMENT-TEXT-9f3a";
    const cs = [
      comment(1, { text: secret, label: `LABEL-${secret}`, status: "sent", send: { attempts: 3, lastOutcome: "sent", maybeSent: true, lastMessage: `MSG-${secret}` } }),
      comment(2, { text: secret, provenance: "foreign" }),
    ];
    const r = rig(snapshot(cs));
    await r.coordinator.start();
    await r.coordinator.openRail();
    r.coordinator.activateBadge({ key: "x", kind: "pin", ids: [idOf(1)] });
    await r.coordinator.runAction(idOf(1), "jump");
    expect(r.bridge.setAnchors).toHaveBeenCalled();
    for (const [queries] of r.bridge.setAnchors.mock.calls) {
      for (const q of queries as any[]) {
        expect(Object.keys(q).sort()).toEqual(["alternates", "key", "landmark", "route", "selector", "tag", "textAnchor"]);
        expect(Object.keys(q.textAnchor).sort()).toEqual(["tag", "text"]);
        expect(q.key).toMatch(/^a[0-9]{1,3}$/);
      }
    }
    const wire = JSON.stringify([r.bridge.setAnchors.mock.calls, r.bridge.focusAnchor.mock.calls]);
    for (const leak of [secret, idOf(1), idOf(2), "sel_", "cmt_", "provenance", "ordinal", "maybeSent", "foreign", "sent\""]) {
      expect(wire.includes(leak), `leaked ${leak}`).toBe(false);
    }
    for (const [key, behavior] of r.bridge.focusAnchor.mock.calls) {
      expect(key).toMatch(/^a[0-9]{1,3}$/);
      expect(["scroll", "flash"]).toContain(behavior);
    }
  });

  it("a hostile selector string is passed through unmodified (the guest grammar, not the embedder, is the gate) and never reaches embedder DOM", async () => {
    const hostile = `div:has(> *) , *{}</script>`;
    const r = rig(snapshot([comment(1, { anchor: { ...comment(1).anchor, selector: hostile } })]));
    await withOpenRail(r);
    expect((r.bridge.setAnchors.mock.calls[0]![0] as any[])[0].selector).toBe(hostile);
    expect(r.doc.body.innerHTML.includes(hostile)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("unconfirmed and misplaced anchors", () => {
  it("agrees:false never produces an exact badge in any match kind; the rail says so", async () => {
    for (const match of ["selector", "text", "landmark"] as const) {
      const r = rig(snapshot([comment(1)]));
      await withOpenRail(r);
      r.results(1, [["a0", match, false, BOX]]);
      r.runFrames();
      expect(r.q(".pin-badge").className, match).toContain("is-approximate");
      expect(r.q(".comments-rail-chips").textContent, match).toContain("Approximate");
    }
  });

  it("other-route and detached pins are not drawn and have no Jump; moving back to the right route restores the badge", async () => {
    const r = rig(snapshot([comment(1), comment(2)]));
    await withOpenRail(r);
    r.results(1, [["a0", "other-route", true, null], ["a1", "detached", false, null]]);
    r.runFrames();
    expect(r.qa(".pin-badge")).toHaveLength(0);
    expect(r.qa('[data-action="jump"]')).toHaveLength(0);
    r.results(1, [["a0", "selector", true, BOX]]);
    r.runFrames();
    expect(r.qa(".pin-badge")).toHaveLength(1);
    expect(r.qa('[data-action="jump"]')).toHaveLength(1);
  });

  it("re-anchor lifecycle with a fake provider: resize and scroll move the badge without a resolve pass, a reload re-sends the set under a new epoch, an agent edit detaches and a debounced summary is announced once", async () => {
    vi.useFakeTimers();
    const r = rig(snapshot([comment(1), comment(2)]));
    await r.coordinator.start();
    r.results(1, [["a0", "selector", true, BOX], ["a1", "selector", true, { ...BOX, y: 300 }]]);
    r.runFrames();
    const x0 = (r.q(".pin-badge").style.transform);
    // scroll: rects only
    r.coordinator.onAnchorRects({ epoch: 1, rects: [{ key: "a0", rect: { ...BOX, y: 150 }, visible: true }] } as never);
    r.runFrames();
    expect(r.q(".pin-badge").style.transform).not.toBe(x0);
    expect(r.bridge.setAnchors).toHaveBeenCalledTimes(1);
    // reload: the view's bridge re-sends under epoch + 1 and tells the coordinator
    r.coordinator.onAnchorsSent(2);
    r.runFrames();
    expect(r.q(".pin-layer").getAttribute("aria-busy")).toBe("true");
    expect(r.qa(".pin-badge")).toHaveLength(2); // pins stay in place while results are pending
    r.results(2, [["a0", "text", true, { ...BOX, x: 400 }], ["a1", "detached", false, null]]);
    r.runFrames();
    expect(r.q(".pin-layer").getAttribute("aria-busy")).toBe("false");
    expect(r.qa(".pin-badge")).toHaveLength(1);
    expect(r.announced).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(r.announced).toEqual([]); // debounced: nothing is announced before the 1 s summary delay
    vi.advanceTimersByTime(600);
    expect(r.announced).toEqual(["1 comment moved, 1 detached"]);
    vi.advanceTimersByTime(5000);
    expect(r.announced).toHaveLength(1);
  });
});

describe("coordinator-level defence for forged or stale guest answers (the bridge validator is the first gate, this is the second)", () => {
  it("a result or rect for a key that was never sent moves nothing", async () => {
    const r = rig(snapshot([comment(1)]));
    await withOpenRail(r);
    r.results(1, [["a0", "selector", true, BOX]]);
    r.runFrames();
    const before = r.q(".pin-badge").style.transform;
    r.results(1, [["a99", "selector", true, { x: 700, y: 500, width: 10, height: 10 }], ["__proto__", "detached", false, null]]);
    r.coordinator.onAnchorRects({ epoch: 1, rects: [{ key: "a99", rect: { x: 700, y: 500, width: 10, height: 10 }, visible: true }] } as never);
    r.runFrames();
    expect(r.qa(".pin-badge")).toHaveLength(1);
    expect(r.q(".pin-badge").style.transform).toBe(before);
  });

  it("rects from an older or newer epoch than the current one move nothing", async () => {
    const r = rig(snapshot([comment(1)]));
    await withOpenRail(r);
    r.results(1, [["a0", "selector", true, BOX]]);
    r.runFrames();
    const before = r.q(".pin-badge").style.transform;
    for (const epoch of [0, 2, 99]) r.coordinator.onAnchorRects({ epoch, rects: [{ key: "a0", rect: { x: 700, y: 500, width: 10, height: 10 }, visible: true }] } as never);
    r.runFrames();
    expect(r.q(".pin-badge").style.transform).toBe(before);
  });

  it("Resolve sent never touches a foreign comment even when it is in status sent", async () => {
    const r = rig(snapshot([comment(1, { status: "sent" }), comment(2, { status: "sent", provenance: "foreign" })]));
    await withOpenRail(r);
    expect(r.q(".comments-rail-resolve-sent").textContent).toBe("Resolve sent (1)");
    click(r.q(".comments-rail-resolve-sent")); await flush();
    expect(r.client.update.mock.calls.map((c: any) => c[0].id)).toEqual([idOf(1)]);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("send wiring through the real rail", () => {
  it("each click on Send N, Send and Send again mints a NEW requestId; a failed transport click is retried only through Retry with the SAME id", async () => {
    const cs = [comment(1), comment(2), comment(3, { status: "sent" })];
    const r = rig(snapshot(cs));
    await withOpenRail(r);
    click(r.q(".comments-rail-send")); await flush();
    click(r.q(".comments-rail-send")); await flush(); // nothing left open? still the same default selection (open comments)
    const ids = r.client.sendBatch.mock.calls.map((c: any) => c[0].requestId);
    expect(new Set(ids).size).toBe(ids.length);
    r.client.sendBatch.mockClear();
    click(r.q('[data-id="' + idOf(3) + '"] [data-action="resend"]')); await flush();
    click(r.q('[data-id="' + idOf(3) + '"] [data-action="resend"]')); await flush();
    const resendIds = r.client.sendBatch.mock.calls.map((c: any) => c[0].requestId);
    expect(resendIds).toHaveLength(2);
    expect(resendIds[0]).not.toBe(resendIds[1]);
    expect(r.client.sendBatch.mock.calls.every((c: any) => c[0].resend === true)).toBe(true);

    // timeout: reason "failed" -> Retry reuses; a later fresh click mints new
    r.client.sendBatch.mockClear();
    r.client.sendBatch.mockResolvedValueOnce({ status: "rejected", reason: "failed", message: "No response from Design in 15 s." });
    click(r.q(".comments-rail-send")); await flush();
    const first = r.client.sendBatch.mock.calls[0][0].requestId;
    expect(r.q(".comments-rail-retry").hidden).toBe(false);
    expect(r.q(".comments-rail-results").textContent).toBe("No response from Design in 15 s.");
    click(r.q(".comments-rail-retry")); await flush();
    expect(r.client.sendBatch.mock.calls[1][0].requestId).toBe(first);
    expect(r.client.sendBatch.mock.calls[1][0].ids).toEqual(r.client.sendBatch.mock.calls[0][0].ids);
    click(r.q(".comments-rail-send")); await flush();
    expect(r.client.sendBatch.mock.calls[2][0].requestId).not.toBe(first);
  });

  it("abort (client disposed mid-flight => reason unavailable) is NOT retried with the old id", async () => {
    const r = rig(snapshot([comment(1)]));
    await withOpenRail(r);
    r.client.sendBatch.mockResolvedValueOnce({ status: "rejected", reason: "unavailable", message: "Design comments are no longer available." });
    click(r.q(".comments-rail-send")); await flush();
    expect(r.q(".comments-rail-retry").hidden).toBe(true);
  });

  it("maybeSent shows a chip, the checkbox stays, and Send stays enabled", async () => {
    const r = rig(snapshot([comment(1, { send: { attempts: 1, lastOutcome: null, maybeSent: true, lastMessage: null } })]));
    await withOpenRail(r);
    expect(r.q(".comments-rail-chips").textContent).toContain("May have been sent");
    expect(r.q<HTMLInputElement>(".comments-rail-select" as never).checked).toBe(true);
    expect((r.q(".comments-rail-send") as HTMLButtonElement).disabled).toBe(false);
  });

  it("results line for a partial batch: sent, queued, deferred and skipped", async () => {
    const r = rig(snapshot([comment(1), comment(2), comment(3), comment(4)]));
    await withOpenRail(r);
    r.client.sendBatch.mockResolvedValueOnce(ok({ requestId: REQ(1), outcome: "partial", message: "x", items: [
      { id: idOf(1), result: "sent" }, { id: idOf(2), result: "queued" }, { id: idOf(3), result: "deferred" }, { id: idOf(4), result: "skipped", reason: "conflict" }] }));
    click(r.q(".comments-rail-send")); await flush();
    expect(r.q(".comments-rail-results").textContent).toBe("1 sent, 1 waiting for the agent, 1 left for the next send, 1 skipped");
    expect(r.announced.at(-1)).toBe("1 sent, 1 waiting for the agent, 1 left for the next send, 1 skipped");
  });

  it("Cancel send (unqueue) needs a confirm, then calls update with action unqueue at the current version", async () => {
    const r = rig(snapshot([comment(1, { status: "pending", version: 4 })]));
    await withOpenRail(r);
    click(r.q('[data-action="unqueue"]'));
    expect(r.client.update).not.toHaveBeenCalled();
    expect(r.q(".comments-rail-confirm").textContent).toContain("Cancels the queued send of 1 comment.");
    click(r.q(".comments-rail-confirm-yes")); await flush();
    expect(r.client.update).toHaveBeenCalledWith({ id: idOf(1), expectedVersion: 4, change: { action: "unqueue" } });
  });

  it("a second Send click while the first is in flight sends nothing more (one request) and the plugin is not called twice", async () => {
    const r = rig(snapshot([comment(1)]));
    await withOpenRail(r);
    let release!: (v: unknown) => void;
    r.client.sendBatch.mockImplementationOnce(() => new Promise((res) => { release = res; }));
    click(r.q(".comments-rail-send"));
    click(r.q(".comments-rail-send"));
    click(r.q(".comments-rail-send"));
    await flush();
    expect(r.client.sendBatch).toHaveBeenCalledTimes(1);
    release(ok({ requestId: REQ(1), outcome: "sent", message: "Sent.", items: [{ id: idOf(1), result: "sent" }] }));
    await flush();
  });

  // QA-G3 advisory (static review #8): the extra clicks above are dropped with no visible or announced feedback.
  it("Send is disabled or the user is told while a send is in flight (a dropped click is silent)", async () => {
    const r = rig(snapshot([comment(1)]));
    await withOpenRail(r);
    r.client.sendBatch.mockImplementationOnce(() => new Promise(() => {}));
    click(r.q(".comments-rail-send"));
    await flush();
    click(r.q(".comments-rail-send"));
    await flush();
    const disabled = (r.q(".comments-rail-send") as HTMLButtonElement).disabled;
    const told = r.announced.length > 0 || (r.q(".comments-rail-results").textContent ?? "") !== "";
    expect(disabled || told).toBe(true);
  });

  // QA-G3 advisory: the results line is never cleared, so after "2 sent" the user reopens a comment and the old line remains.
  it("the results line from an earlier send does not linger after the comments it described changed state", async () => {
    const r = rig(snapshot([comment(1), comment(2)]));
    await withOpenRail(r);
    click(r.q(".comments-rail-send")); await flush();
    expect(r.q(".comments-rail-results").textContent).toBe("2 sent");
    r.emit(snapshot([comment(1, { status: "open" }), comment(2, { status: "open" })], { revision: 9 })); // reopened elsewhere
    await flush();
    expect(r.q(".comments-rail-results").textContent).toBe("");
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("focus and confirm lifetimes (static review #3, #8)", () => {
  // BUG (a11y): toggling a row checkbox with the keyboard re-renders the list and moves focus to the row <li>.
  it("a keyboard user's checkbox keeps focus after toggling it", async () => {
    const r = rig(snapshot([comment(1), comment(2)]));
    await withOpenRail(r);
    const box = r.qa(".comments-rail-select")[1] as HTMLInputElement;
    box.focus();
    expect(r.doc.activeElement).toBe(box);
    box.checked = false;
    box.dispatchEvent(new r.dom.window.Event("change", { bubbles: true }));
    await flush();
    const now = r.doc.activeElement as HTMLElement;
    expect(now.classList.contains("comments-rail-select")).toBe(true);
  });

  it("a row action button keeps focus across a re-render caused by a snapshot change", async () => {
    const r = rig(snapshot([comment(1), comment(2)]));
    await withOpenRail(r);
    const btn = r.q(`[data-id="${idOf(2)}"] [data-action="resolve"]`);
    btn.focus();
    r.emit(snapshot([comment(1), comment(2)], { revision: 5 }));
    await flush();
    expect((r.doc.activeElement as HTMLElement).dataset.action).toBe("resolve");
    expect((r.doc.activeElement as HTMLElement).closest("li")!.dataset.id).toBe(idOf(2));
  });

  // BUG (static review #3): the inline confirm is keyed by id+action only, so it outlives the state that justified it.
  it("a delete confirmation is dismissed when the comment turns pending (delete is no longer offered)", async () => {
    const r = rig(snapshot([comment(1, { version: 1 })]));
    await withOpenRail(r);
    click(r.q('[data-action="delete"]'));
    expect(r.q(".comments-rail-confirm")).toBeTruthy();
    r.emit(snapshot([comment(1, { version: 2, status: "pending" })], { revision: 3 }));
    await flush();
    // the row no longer offers delete, so the pending confirm "Delete comment 1?" must not stay armed
    expect(r.qa(".comments-rail-confirm-yes").map((b) => b.textContent)).not.toContain("Delete");
  });

  // BUG (static review #3): expectedVersion is read from the current snapshot at confirm time, not from the row the user saw.
  it("confirming Delete after the comment changed elsewhere does not delete the NEW content at its new version", async () => {
    const r = rig(snapshot([comment(1, { version: 1, text: "old text" })]));
    await withOpenRail(r);
    click(r.q('[data-action="delete"]'));
    r.emit(snapshot([comment(1, { version: 2, text: "someone rewrote this" })], { revision: 3 }));
    await flush();
    const yes = r.qa(".comments-rail-confirm-yes")[0];
    if (yes) click(yes);
    await flush();
    const deletedAtNewVersion = r.client.remove.mock.calls.some((c: any) => c[0].expectedVersion === 2);
    expect(deletedAtNewVersion, "the user confirmed version 1; version 2 was deleted").toBe(false);
  });

  it("Esc inside the open confirm closes only the confirm and returns focus to the row", async () => {
    const r = rig(snapshot([comment(1)]));
    await withOpenRail(r);
    click(r.q('[data-action="delete"]'));
    expect((r.doc.activeElement as HTMLElement).className).toContain("comments-rail-confirm-no");
    (r.doc.activeElement as HTMLElement).dispatchEvent(new r.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(r.q(".comments-rail-confirm")).toBeNull();
    expect((r.doc.activeElement as HTMLElement).classList.contains("comments-rail-row")).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("anchor bookkeeping (static review #8)", () => {
  // BUG: the signature has no comment ids, so replacing a comment by another with an identical anchor in one change keeps a0 -> old id.
  it("a comment that replaces another with an identical anchor in one change gets its own pin", async () => {
    const a = comment(1);
    const c = comment(2, { anchor: a.anchor });
    const r = rig(snapshot([a]));
    await withOpenRail(r);
    r.results(1, [["a0", "selector", true, BOX]]);
    r.runFrames();
    expect(r.qa(".pin-badge")).toHaveLength(1);
    r.emit(snapshot([c], { revision: 2 })); // A deleted, C pinned on the same element, coalesced into one change
    await flush();
    r.runFrames();
    // the guest result for the unchanged query set keeps arriving under the same key
    r.coordinator.onAnchorRects({ epoch: 1, rects: [{ key: "a0", rect: BOX, visible: true }] } as never);
    r.runFrames();
    expect(r.qa(".pin-badge").map((b) => b.textContent)).toEqual(["2"]);
  });

  // BUG: `busy` is set when the set is sent and only cleared by a result; a guest that never answers dims the layer for ever.
  it("pins do not stay dimmed (aria-busy) for ever when the guest never answers", async () => {
    vi.useFakeTimers();
    const r = rig(snapshot([comment(1)]));
    await withOpenRail(r);
    r.runFrames();
    expect(r.layer.el.getAttribute("aria-busy")).toBe("true");
    vi.advanceTimersByTime(60_000);
    r.runFrames();
    expect(r.layer.el.getAttribute("aria-busy")).toBe("false");
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("provenance and the 200 cap (static review #1, #8)", () => {
  // BUG (advisory): a foreign (copied-in) comment is drawn and named exactly like one of the user's own.
  it("a foreign comment's pin is distinguishable on the canvas and in its accessible name", async () => {
    const r = rig(snapshot([comment(1, { provenance: "foreign" })]));
    await withOpenRail(r);
    r.results(1, [["a0", "selector", true, BOX]]);
    r.runFrames();
    const badge = r.q(".pin-badge");
    const distinguished = /another install|foreign|unadopted/i.test(badge.getAttribute("aria-label") ?? "") || /foreign/.test(badge.className);
    expect(distinguished).toBe(true);
  });

  it("Adopt all asks first (adopted comments become sendable), then adopts every foreign comment in chunks of 20", async () => {
    const cs = Array.from({ length: 45 }, (_, i) => comment(i + 1, { provenance: "foreign" }));
    const r = rig(snapshot(cs));
    await withOpenRail(r);
    expect(r.qa(".comments-rail-select")).toHaveLength(0);
    click(r.q(".comments-rail-adopt-all")); await flush();
    expect(r.client.adopt).not.toHaveBeenCalled();
    expect(r.q(".comments-rail-foreign").textContent).toMatch(/Adopt 45 comments\?/);
    click(r.q(".comments-rail-adopt-yes")); await flush();
    expect(r.client.adopt.mock.calls.map((c: any) => c[0].ids.length)).toEqual([20, 20, 5]);
  });

  it("at 200 comments Pin is withdrawn", async () => {
    const cs = Array.from({ length: 200 }, (_, i) => comment(i + 1));
    const r = rig(snapshot(cs));
    await r.coordinator.start();
    expect(r.availability.at(-1)).toMatchObject({ pin: false, rail: true, count: 200 });
  });

  // BUG (advisory UX): nothing tells the user WHY Pin vanished at the cap.
  it("at the 200-comment cap the rail explains why Pin is unavailable", async () => {
    const cs = Array.from({ length: 200 }, (_, i) => comment(i + 1));
    const r = rig(snapshot(cs));
    await withOpenRail(r);
    expect((r.q(".comments-rail-notice").textContent ?? "") + (r.q(".comments-rail-empty").textContent ?? "")).toMatch(/200|maximum|limit/i);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("notices (G4)", () => {
  it("read-only: actions are withdrawn and the plugin's notice is shown", async () => {
    const r = rig(snapshot([comment(1)], { health: "read-only", notice: "The comments file is read-only." }));
    await withOpenRail(r);
    expect(r.q(".comments-rail-notice").textContent).toBe("The comments file is read-only.");
    expect(r.qa(".comments-rail-action").map((b) => b.dataset.action)).toEqual([]);
    expect((r.q(".comments-rail-send") as HTMLButtonElement).disabled).toBe(true);
  });

  // BUG (advisory, G4 notices): all actions silently vanish when the plugin reports read-only without a notice string.
  it("read-only without a plugin notice still tells the user why nothing can be changed", async () => {
    const r = rig(snapshot([comment(1)], { health: "read-only", notice: null }));
    await withOpenRail(r);
    expect((r.q(".comments-rail-notice").textContent ?? "").length).toBeGreaterThan(0);
  });

  it("recovered: the notice and Pin both stay available", async () => {
    const r = rig(snapshot([comment(1)], { health: "recovered", notice: "Comments were recovered from a backup." }));
    await withOpenRail(r);
    expect(r.q(".comments-rail-notice").textContent).toBe("Comments were recovered from a backup.");
    expect(r.availability.at(-1)).toMatchObject({ pin: true });
  });

  it("reportAnchors is not called before the answers were stable for 2 s (covered with timers in pins-g3-fixes)", async () => {
    const r = rig(snapshot([comment(1)]));
    r.client.reportAnchors = vi.fn(async () => ok({ applied: 1 }));
    await withOpenRail(r);
    r.results(1, [["a0", "text", true, BOX]]);
    r.runFrames();
    expect(r.client.reportAnchors).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("teardown: no timers, listeners or late callbacks survive dispose", () => {
  it("dispose unsubscribes, cancels the frame and the summary timer, clears the guest, and late results touch nothing", async () => {
    vi.useFakeTimers();
    const r = rig(snapshot([comment(1)]));
    const baseline = vi.getTimerCount(); // jsdom's own rAF interval, not ours
    await r.coordinator.start();
    expect(r.listeners.size).toBe(1);
    r.results(1, [["a0", "selector", true, BOX]]);
    r.runFrames();
    r.results(1, [["a0", "detached", false, null]]); // arms the 1 s summary timer + a frame
    expect(vi.getTimerCount()).toBeGreaterThan(baseline);
    r.coordinator.dispose();
    expect(r.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(baseline);
    expect(r.frames).toHaveLength(0);
    expect(r.bridge.setAnchors).toHaveBeenLastCalledWith([]);
    const rails = r.qa(".comments-rail-row").length;
    const announced = r.announced.length;
    r.emit(snapshot([comment(1), comment(2)], { revision: 7 }));
    r.results(1, [["a0", "selector", true, BOX]]);
    r.coordinator.onAnchorRects({ epoch: 1, rects: [] } as never);
    await r.coordinator.sendSelected();
    await r.coordinator.refresh();
    r.runFrames();
    vi.advanceTimersByTime(10_000);
    expect(r.qa(".comments-rail-row")).toHaveLength(rails);
    expect(r.announced).toHaveLength(announced);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(baseline);
  });

  it("a list or send that resolves after dispose does not render or announce", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    let release!: (v: unknown) => void;
    r.client.sendBatch.mockImplementationOnce(() => new Promise((res) => { release = res; }));
    void r.coordinator.sendSelected();
    await flush();
    const before = r.announced.length;
    r.coordinator.dispose();
    release(ok({ requestId: REQ(1), outcome: "sent", message: "Sent.", items: [{ id: idOf(1), result: "sent" }] }));
    await flush();
    expect(r.announced).toHaveLength(before);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("pin overlay focus on reorder (static review #2), jsdom level", () => {
  // BUG (static review #2): insertBefore of the focused node blurs it in Chromium too (confirmed in the e2e spec).
  it("a focused badge keeps document focus when a render changes the reading order", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const doc = dom.window.document;
    const layer = new PinOverlay(doc, { onActivate: () => {}, onEscape: () => {} });
    doc.body.append(layer.el);
    const mk = (key: string, x: number, y: number) => ({ key, kind: "pin" as const, ids: [key], x, y, text: key.slice(-1), label: key, status: "open" as const, approximate: false, z: 16 });
    layer.render([mk("c1", 10, 10), mk("c2", 50, 10), mk("c3", 90, 10)], { busy: false });
    const second = layer.el.querySelector<HTMLElement>('[data-key="c2"]')!;
    second.focus();
    expect(doc.activeElement).toBe(second);
    layer.render([mk("c3", 5, 5), mk("c2", 50, 10), mk("c1", 90, 10)], { busy: false }); // c3 and c1 swap: insertBefore moves nodes
    expect(doc.activeElement).toBe(layer.el.querySelector('[data-key="c2"]'));
  });
});

describe("pin layer Esc is the user's, not the page's or the app's", () => {
  it("Escape inside the pin layer is consumed (default prevented, propagation stopped) and calls onEscape once", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const doc = dom.window.document;
    const onEscape = vi.fn();
    const layer = new PinOverlay(doc, { onActivate: () => {}, onEscape });
    doc.body.append(layer.el);
    layer.render([{ key: "c1", kind: "pin", ids: ["c1"], x: 10, y: 10, text: "1", label: "c1", status: "open", approximate: false, z: 16 }], { busy: false });
    const bubbled = vi.fn();
    doc.body.addEventListener("keydown", bubbled);
    const ev = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    layer.el.querySelector("button")!.dispatchEvent(ev);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(bubbled).not.toHaveBeenCalled();
  });
});

