import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactCommentsSnapshot } from "../../src/artifacts/feedback-contract-v2";
import { CommentsRail } from "../../src/renderer/artifacts/comments-rail";
import { PinOverlay } from "../../src/renderer/artifacts/pin-overlay";
import { createPinsCoordinator } from "../../src/renderer/artifacts/pins-coordinator";
import { buildRailView } from "../../src/renderer/artifacts/rail-model";
import { comment, idOf, snapshot } from "./helpers/pin-fixtures";

vi.setConfig({ testTimeout: 30_000 });

/** QA G3 re-verify at 617938dd: coverage the mutation pass found missing (N02, N04, N09). Same harness as qa-g3-rail-coordinator-integration. */
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

describe("coordinator refuses an action for a stale rendered version (defence behind the rail's own confirm check)", () => {
  it("runAction with the version of an older row does nothing to the new content and says so; the current version acts", async () => {
    const r = rig(snapshot([comment(1, { version: 2 })]));
    await withOpenRail(r);
    await r.coordinator.runAction(idOf(1), "delete", 1);
    expect(r.client.remove).not.toHaveBeenCalled();
    expect(r.announced.at(-1)).toMatch(/changed elsewhere/);
    await r.coordinator.runAction(idOf(1), "delete", 2);
    expect(r.client.remove).toHaveBeenCalledWith({ id: idOf(1), expectedVersion: 2 });
  });
});

describe("a confirm does not outlive the action being offered even when the version did not change", () => {
  it("Delete confirm is dropped when the same-version row no longer lists delete", () => {
    const dom = new JSDOM("<!doctype html><body></body>");
    const doc = dom.window.document;
    const cb = { onFilter: vi.fn(), onClearCluster: vi.fn(), onToggleSelect: vi.fn(), onAction: vi.fn(), onSendSelected: vi.fn(), onResolveSent: vi.fn(), onAdoptAll: vi.fn(), onRetry: vi.fn(), onClose: vi.fn() };
    const rail = new CommentsRail(doc, cb);
    doc.body.append(rail.el);
    const input = (c: ReturnType<typeof comment>) => ({ comments: [c], anchorStates: {}, filter: "all" as const, clusterIds: null, selected: null, notice: null, health: "ok" as const, resultsLine: null });
    rail.render(buildRailView(input(comment(1, { version: 5 }))));
    (rail.el.querySelector('[data-action="delete"]') as HTMLElement).click();
    expect(rail.el.querySelector(".comments-rail-confirm")).not.toBeNull();
    rail.render(buildRailView(input(comment(1, { version: 5, status: "pending" })))); // same version, delete no longer offered
    expect(rail.el.querySelector(".comments-rail-confirm")).toBeNull();
  });
});

describe("a guest that never answers: after the busy timeout the placed pins are shown as unconfirmed, and an answer restores them", () => {
  it("is-approximate after 5 s without results, exact again when the answer arrives", async () => {
    vi.useFakeTimers();
    const r = rig(snapshot([comment(1)]));
    await withOpenRail(r);
    r.results(1, [["a0", "selector", true, BOX]]);
    r.runFrames();
    expect(r.q(".pin-badge").className).not.toContain("is-approximate");
    r.coordinator.onAnchorsSent(2); // a reload re-sends the set; the answer never comes
    r.runFrames();
    expect(r.layer.el.getAttribute("aria-busy")).toBe("true");
    vi.advanceTimersByTime(5100);
    r.runFrames();
    expect(r.layer.el.getAttribute("aria-busy")).toBe("false");
    expect(r.q(".pin-badge").className).toContain("is-approximate");
    r.results(2, [["a0", "selector", true, BOX]]);
    r.runFrames();
    expect(r.q(".pin-badge").className).not.toContain("is-approximate");
  });
});
