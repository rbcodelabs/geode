import { describe, expect, it, vi } from "vitest";
import type { ArtifactComment, ArtifactCommentsSnapshot } from "../../src/artifacts/feedback-contract-v2";
import { createPinsCoordinator, type PinsUi } from "../../src/renderer/artifacts/pins-coordinator";
import type { PinBadgeView } from "../../src/renderer/artifacts/pin-overlay";
import type { RailView } from "../../src/renderer/artifacts/rail-model";
import { comment, idOf, snapshot } from "./helpers/pin-fixtures";

/** Phase 2b-i G3: the wiring between the comments client, the guest anchor channels and the rail / pin layer (DOM-free). */

const REQ = (n: number) => `req_${n.toString(16).padStart(32, "0")}`;
const ok = <T,>(value: T) => ({ status: "ok" as const, value });
const rej = (reason: string, message = "nope") => ({ status: "rejected" as const, reason, message });
const stage = { left: 0, top: 0, width: 900, height: 600 };
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

function rig(initial: ArtifactCommentsSnapshot | null = snapshot([]), options: { client?: boolean } = {}) {
  let current = initial;
  const changeListeners = new Set<(r: unknown) => void>();
  const frames: Array<() => void> = [];
  let reqCounter = 0;
  const client = {
    get cached() { return current; },
    list: vi.fn(async () => (current ? ok(current) : rej("unavailable", "Design is not available."))),
    update: vi.fn(async (input: { id: string }) => ok(comment(1, { id: input.id }))),
    remove: vi.fn(async (input: { id: string }) => ok({ id: input.id })),
    adopt: vi.fn(async (input: { ids: string[] }) => ok({ adopted: input.ids })),
    sendBatch: vi.fn(async (input: { requestId: string; ids: string[] }) =>
      ok({ requestId: input.requestId, outcome: "sent", items: input.ids.map((id) => ({ id, result: "sent" })), message: "Sent." })),
    reportAnchors: vi.fn(),
    onDidChange: vi.fn((l: (r: unknown) => void) => { changeListeners.add(l); return () => { changeListeners.delete(l); }; }),
  };
  const bridge = {
    setAnchors: vi.fn((queries: readonly unknown[]) => ({ epoch: ++epoch, sent: queries.length, rejected: [] as string[] })),
    focusAnchor: vi.fn(() => true),
  };
  let epoch = 0;
  const log = { rail: [] as RailView[], pins: [] as Array<{ badges: readonly PinBadgeView[]; busy: boolean }>, announce: [] as string[], availability: [] as any[], focus: [] as any[] };
  const ui: PinsUi = {
    renderRail: (v) => { log.rail.push(v); },
    renderPins: (badges, busy) => { log.pins.push({ badges, busy }); },
    announce: (t) => { log.announce.push(t); },
    availability: (a) => { log.availability.push(a); },
    focusRail: (t) => { log.focus.push(t); },
    geometry: () => ({ frame: { left: 0, top: 0, clientLeft: 0, clientTop: 0 }, stage }),
  };
  const coordinator = createPinsCoordinator({
    getClient: () => (options.client === false ? null : (client as never)),
    bridge, ui,
    scheduleFrame: (cb) => { frames.push(cb); return () => { const i = frames.indexOf(cb); if (i >= 0) frames.splice(i, 1); }; },
    newRequestId: () => REQ(++reqCounter),
  });
  return {
    client, bridge, ui, coordinator, log, frames,
    set(snap: ArtifactCommentsSnapshot | null) { current = snap; },
    emit(snap: ArtifactCommentsSnapshot) { current = snap; for (const l of [...changeListeners]) l(ok(snap)); },
    runFrames() { const run = frames.splice(0); for (const f of run) f(); },
    lastRail: () => log.rail.at(-1)!,
    lastPins: () => log.pins.at(-1)!,
    results(epochNo: number, rows: Array<[string, string, boolean, { x: number; y: number; width: number; height: number } | null, boolean?]>) {
      coordinator.onAnchorResults({ epoch: epochNo, results: rows.map(([key, match, agrees, rect, visible]) => ({ key, match, agrees, rect, visible: visible ?? rect !== null })) } as never);
    },
  };
}
const BOX = { x: 100, y: 200, width: 160, height: 48 };

describe("start: availability (Pin only when the provider answers list)", () => {
  it("v2 client and an ok list: Pin and the rail are available", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    expect(r.log.availability.at(-1)).toMatchObject({ pin: true, rail: true, count: 1 });
    expect(r.coordinator.pinAvailable).toBe(true);
  });

  it("no client (v1 handler): nothing is available and no anchors are sent", async () => {
    const r = rig(snapshot([comment(1)]), { client: false });
    await r.coordinator.start();
    expect(r.log.availability.at(-1)).toMatchObject({ pin: false, rail: false });
    expect(r.bridge.setAnchors).not.toHaveBeenCalled();
  });

  it("health unavailable hides Pin but keeps the rail with the notice", async () => {
    const r = rig(snapshot([], { health: "unavailable", notice: "The comments file cannot be used." }));
    await r.coordinator.start();
    expect(r.log.availability.at(-1)).toMatchObject({ pin: false, rail: true });
    expect(r.lastRail().notice).toBe("The comments file cannot be used.");
  });

  it("a rejected list hides Pin, keeps the rail and shows the message", async () => {
    const r = rig(null);
    await r.coordinator.start();
    expect(r.log.availability.at(-1)).toMatchObject({ pin: false, rail: true });
    expect(r.lastRail().notice).toBe("Design is not available.");
  });

  it("read-only hides Pin (a pin could not be saved)", async () => {
    const r = rig(snapshot([comment(1)], { health: "read-only", notice: "Read only." }));
    await r.coordinator.start();
    expect(r.coordinator.pinAvailable).toBe(false);
    expect(r.lastRail().readOnly).toBe(true);
  });

  it("disables Pin at 200 live comments", async () => {
    const many = Array.from({ length: 200 }, (_, i) => comment(i + 1));
    const r = rig(snapshot(many));
    await r.coordinator.start();
    expect(r.coordinator.pinAvailable).toBe(false);
  });
});

describe("feeding anchors to the guest (T9: ids and selectors only)", () => {
  it("sends only allowlisted query fields with per-epoch keys", async () => {
    const r = rig(snapshot([comment(1, { text: "SECRET TEXT", label: "SECRET LABEL" }), comment(2)]));
    await r.coordinator.start();
    expect(r.bridge.setAnchors).toHaveBeenCalledTimes(1);
    const queries = r.bridge.setAnchors.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(queries.map((q) => q.key)).toEqual(["a0", "a1"]);
    for (const q of queries) expect(Object.keys(q).sort()).toEqual(["alternates", "key", "landmark", "route", "selector", "tag", "textAnchor"]);
    const wire = JSON.stringify(queries);
    expect(wire).not.toContain("SECRET");
    expect(wire).not.toContain(idOf(1));
    expect(wire).not.toContain("cmt_");
    expect(queries[0]).toMatchObject({ route: "/index.html", tag: "button", selector: "#b1", alternates: [], textAnchor: { tag: "button", text: "Button 1" } });
  });

  it("caps at 100 queries, non-terminal comments first", async () => {
    const terminal = Array.from({ length: 60 }, (_, i) => comment(i + 1, { status: "resolved" }));
    const live = Array.from({ length: 70 }, (_, i) => comment(i + 61));
    const r = rig(snapshot([...terminal, ...live]));
    await r.coordinator.start();
    const queries = r.bridge.setAnchors.mock.calls[0]![0] as Array<{ selector: string }>;
    expect(queries).toHaveLength(100);
    expect(queries.filter((q) => Number(q.selector.slice(2)) > 60)).toHaveLength(70);
  });

  it("does not re-send when only statuses changed, and re-sends when an anchor or the set changed", async () => {
    const r = rig(snapshot([comment(1), comment(2)]));
    await r.coordinator.start();
    r.emit(snapshot([comment(1, { status: "sent", version: 2 }), comment(2)], { revision: 2 }));
    await r.coordinator.refresh();
    expect(r.bridge.setAnchors).toHaveBeenCalledTimes(1);
    await r.coordinator.refresh();
    r.set(snapshot([comment(1), comment(2), comment(3)], { revision: 3 }));
    await r.coordinator.refresh();
    expect(r.bridge.setAnchors).toHaveBeenCalledTimes(2);
  });

  it("an empty set clears the guest", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    r.set(snapshot([], { revision: 2 }));
    await r.coordinator.refresh();
    expect(r.bridge.setAnchors).toHaveBeenLastCalledWith([]);
  });
});

describe("anchor results and rects drive pin and rail state", () => {
  async function placed(over: Partial<ArtifactComment> = {}) {
    const r = rig(snapshot([comment(1, over)]));
    await r.coordinator.start();
    r.results(1, [["a0", "selector", true, BOX]]);
    r.runFrames();
    return r;
  }

  it("places a badge at the element's top-right in stage px", async () => {
    const r = await placed();
    expect(r.lastPins().badges).toHaveLength(1);
    expect(r.lastPins().badges[0]).toMatchObject({ kind: "pin", text: "1", x: 256, y: 204, status: "open", approximate: false });
    expect(r.lastPins().badges[0]!.label).toBe("Comment 1, open, on button Button 1: Comment text 1");
  });

  it("uses the frame offset inside the stage", async () => {
    const r = rig(snapshot([comment(1)]));
    r.ui.geometry = () => ({ frame: { left: 40, top: 30, clientLeft: 1, clientTop: 1 }, stage: { ...stage, left: 10, top: 10 } });
    await r.coordinator.start();
    r.results(1, [["a0", "selector", true, BOX]]);
    r.runFrames();
    expect(r.lastPins().badges[0]).toMatchObject({ x: 287, y: 225 });
  });

  it("an element the tracker calls visible but that lies outside the visible stage (a preset webview larger than the pane) is not on screen", async () => {
    const r = rig(snapshot([comment(1), comment(2)]));
    r.ui.geometry = () => ({ frame: { left: 0, top: 0, clientLeft: 1, clientTop: 1 }, stage: { left: 0, top: 0, width: 400, height: 300 } });
    await r.coordinator.start();
    r.results(1, [["a0", "selector", true, { x: 600, y: 20, width: 50, height: 20 }, true], ["a1", "selector", true, { x: 300, y: 20, width: 50, height: 20 }, true]]);
    r.runFrames();
    expect(r.lastPins().badges.map((b) => b.text)).toEqual(["2"]);
    // a partly visible element still gets its badge, clamped inside the stage
    r.coordinator.onAnchorRects({ epoch: 1, rects: [{ key: "a0", rect: { x: 380, y: 20, width: 80, height: 20 }, visible: true }] });
    r.runFrames();
    expect(r.lastPins().badges.map((b) => b.text)).toContain("1");
    expect(Math.max(...r.lastPins().badges.map((b) => b.x))).toBeLessThanOrEqual(398);
  });

  it("agrees:false is unconfirmed: an approximate badge and an approximate chip", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    r.results(1, [["a0", "selector", false, BOX]]);
    r.runFrames();
    expect(r.lastPins().badges[0]!.approximate).toBe(true);
    expect(r.lastRail().rows[0]!.anchorChip).toBe("Approximate: may not be the same element");
  });

  it("detached and other-route pins are not on the canvas but show in the rail", async () => {
    const r = rig(snapshot([comment(1), comment(2)]));
    await r.coordinator.start();
    r.results(1, [["a0", "detached", true, null], ["a1", "other-route", true, null]]);
    r.runFrames();
    expect(r.lastPins().badges).toEqual([]);
    expect(r.lastRail().rows.map((row) => row.anchorChip)).toEqual(["Detached: the element was not found", "On another page"]);
  });

  it("off-screen (visible:false) pins are not rendered but a rect update brings them back", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    r.results(1, [["a0", "selector", true, { x: 100, y: 2500, width: 50, height: 20 }, false]]);
    r.runFrames();
    expect(r.lastPins().badges).toEqual([]);
    r.coordinator.onAnchorRects({ epoch: 1, rects: [{ key: "a0", rect: BOX, visible: true }] });
    r.runFrames();
    expect(r.lastPins().badges).toHaveLength(1);
  });

  it("rect messages are coalesced into one pin render per frame and do not re-send anchors", async () => {
    const r = await placed();
    const before = r.log.pins.length;
    for (let i = 0; i < 30; i++) r.coordinator.onAnchorRects({ epoch: 1, rects: [{ key: "a0", rect: { ...BOX, y: 200 + i }, visible: true }] });
    expect(r.log.pins.length).toBe(before);
    r.runFrames();
    expect(r.log.pins.length).toBe(before + 1);
    expect(r.lastPins().badges[0]!.y).toBe(204 + 29);
    expect(r.bridge.setAnchors).toHaveBeenCalledTimes(1);
  });

  it("an element that left the document (rect null) detaches the pin", async () => {
    const r = await placed();
    r.coordinator.onAnchorRects({ epoch: 1, rects: [{ key: "a0", rect: null, visible: false }] });
    r.runFrames();
    expect(r.lastPins().badges).toEqual([]);
    expect(r.lastRail().rows[0]!.anchorChip).toBe("Detached: the element was not found");
  });

  it("a stale epoch is ignored", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    r.results(99, [["a0", "selector", true, BOX]]);
    r.runFrames();
    expect(r.lastPins().badges).toEqual([]);
  });

  it("pins stay in place and busy while a new epoch's results are pending, then settle", async () => {
    const r = await placed();
    expect(r.lastPins().busy).toBe(false);
    r.coordinator.onAnchorsSent(2);
    r.runFrames();
    expect(r.lastPins().busy).toBe(true);
    expect(r.lastPins().badges).toHaveLength(1);
    r.results(2, [["a0", "text", true, { ...BOX, x: 300 }]]);
    r.runFrames();
    expect(r.lastPins().busy).toBe(false);
    expect(r.lastRail().rows[0]!.anchorChip).toBe("Moved");
  });

  it("terminal pins are hidden from the canvas unless the matching filter is on", async () => {
    const r = rig(snapshot([comment(1, { status: "resolved" }), comment(2)]));
    await r.coordinator.start();
    r.results(1, [["a0", "selector", true, BOX], ["a1", "selector", true, { ...BOX, x: 500 }]]);
    r.runFrames();
    expect(r.lastPins().badges.map((b) => b.text)).toEqual(["2"]);
    r.coordinator.setFilter("resolved");
    r.runFrames();
    // live pins always show; the matching terminal ones join them (anchor keys: live comments first, so a0 is comment 2)
    expect(r.lastPins().badges.map((b) => b.text)).toEqual(["2", "1"]);
    r.coordinator.setFilter("dismissed");
    r.runFrames();
    expect(r.lastPins().badges.map((b) => b.text)).toEqual(["2"]);
  });

  it("overlapping pins collapse into a count badge", async () => {
    const r = rig(snapshot([comment(1), comment(2), comment(3)]));
    await r.coordinator.start();
    r.results(1, [["a0", "selector", true, BOX], ["a1", "selector", true, { ...BOX, x: 104 }], ["a2", "selector", true, { ...BOX, x: 700 }]]);
    r.runFrames();
    expect(r.lastPins().badges.map((b) => b.kind)).toEqual(["cluster", "pin"]);
    expect(r.lastPins().badges[0]).toMatchObject({ text: "2", label: "2 comments here. Activate to list" });
  });

  it("a rejected anchor query shows as detached, not as locating forever", async () => {
    const r = rig(snapshot([comment(1)]));
    r.bridge.setAnchors.mockImplementation((q: readonly unknown[]) => ({ epoch: 1, sent: 0, rejected: q.map((x) => (x as { key: string }).key) }));
    await r.coordinator.start();
    expect(r.lastRail().rows[0]!.anchorChip).toBe("Detached: the element was not found");
  });
});

describe("list, subscribe, re-list and the rail", () => {
  it("start lists, subscribes for the life of the view, and lists again after subscribing", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    expect(r.client.onDidChange).toHaveBeenCalledTimes(1);
    expect(r.client.list).toHaveBeenCalledTimes(2);
    const [list1, list2] = r.client.list.mock.invocationCallOrder;
    const sub = r.client.onDidChange.mock.invocationCallOrder[0]!;
    expect(list1!).toBeLessThan(sub);
    expect(list2!).toBeGreaterThan(sub);
  });

  it("without a client nothing is subscribed", async () => {
    const r = rig(snapshot([comment(1)]), { client: false });
    await r.coordinator.start();
    expect(r.client.onDidChange).not.toHaveBeenCalled();
  });

  it("a change event updates the pins and the rail whether or not the rail is open", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    r.emit(snapshot([comment(1), comment(2)], { revision: 5 }));
    await flush();
    expect(r.lastRail().rows).toHaveLength(2);
    expect(r.bridge.setAnchors).toHaveBeenCalledTimes(2);
  });

  it("opening the rail lists again, does not subscribe twice, and asks the view to focus the heading", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    const lists = r.client.list.mock.calls.length;
    await r.coordinator.openRail();
    expect(r.client.onDidChange).toHaveBeenCalledTimes(1);
    expect(r.client.list.mock.calls.length).toBe(lists + 1);
    expect(r.log.focus.at(-1)).toEqual({ type: "heading" });
    expect(r.coordinator.railOpen).toBe(true);
  });

  it("closing the rail keeps the subscription (pins still follow changes)", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    await r.coordinator.openRail();
    r.coordinator.closeRail();
    r.coordinator.closeRail();
    expect(r.coordinator.railOpen).toBe(false);
    r.emit(snapshot([comment(1), comment(2)], { revision: 5 }));
    await flush();
    expect(r.lastRail().rows).toHaveLength(2);
  });

  it("a failed refresh from a change event shows the message and keeps the last rows", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    for (const l of [...(r.client.onDidChange.mock.calls.map((c) => c[0]))]) l(rej("unavailable", "Design went away."));
    expect(r.lastRail().notice).toBe("Design went away.");
    expect(r.lastRail().rows).toHaveLength(1);
  });

  it("focus and leaf activation re-list (refresh)", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    const n = r.client.list.mock.calls.length;
    await r.coordinator.refresh();
    expect(r.client.list.mock.calls.length).toBe(n + 1);
  });

  it("dispose drops the subscription and clears the guest anchors", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    await r.coordinator.openRail();
    r.coordinator.dispose();
    expect(r.bridge.setAnchors).toHaveBeenLastCalledWith([]);
    r.emit(snapshot([comment(1), comment(2)], { revision: 9 }));
    await flush();
    expect(r.lastRail().rows).toHaveLength(1);
  });
});

describe("activating badges, jump and Esc", () => {
  it("activating a pin opens the rail on that row and asks the guest to scroll to it", async () => {
    const r = rig(snapshot([comment(1), comment(2)]));
    await r.coordinator.start();
    r.results(1, [["a0", "selector", true, BOX], ["a1", "selector", true, { ...BOX, x: 500 }]]);
    r.coordinator.activateBadge({ key: "p", kind: "pin", ids: [idOf(2)] });
    await flush();
    expect(r.coordinator.railOpen).toBe(true);
    expect(r.log.focus.at(-1)).toEqual({ type: "row", id: idOf(2) });
    expect(r.bridge.focusAnchor).toHaveBeenCalledWith("a1", "scroll");
  });

  it("activating a count badge opens the rail filtered to the cluster", async () => {
    const r = rig(snapshot([comment(1), comment(2), comment(3)]));
    await r.coordinator.start();
    r.coordinator.activateBadge({ key: "c", kind: "cluster", ids: [idOf(1), idOf(3)] });
    await flush();
    expect(r.lastRail().rows.map((row) => row.ordinal)).toEqual([1, 3]);
    expect(r.lastRail().clusterChip).toBe("2 comments at this spot");
  });

  it("Esc clears a cluster filter first, then closes the rail", async () => {
    const r = rig(snapshot([comment(1), comment(2)]));
    await r.coordinator.start();
    r.coordinator.activateBadge({ key: "c", kind: "cluster", ids: [idOf(1), idOf(2)] });
    await flush();
    expect(r.coordinator.escapeRail()).toBe("cluster");
    expect(r.coordinator.railOpen).toBe(true);
    expect(r.coordinator.escapeRail()).toBe("closed");
    expect(r.coordinator.railOpen).toBe(false);
    expect(r.coordinator.escapeRail()).toBe("none");
  });

  it("Jump scrolls then flashes and never claims focus", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    r.results(1, [["a0", "selector", true, BOX]]);
    await r.coordinator.runAction(idOf(1), "jump");
    expect(r.bridge.focusAnchor.mock.calls).toEqual([["a0", "scroll"], ["a0", "flash"]]);
    expect(r.log.focus.filter((f) => f.type === "page")).toEqual([]);
  });
});

describe("row actions", () => {
  const intent: Array<[string, "resolve" | "dismiss" | "reopen" | "unqueue", string]> = [
    ["open", "resolve", "resolve"], ["open", "dismiss", "dismiss"], ["sent", "reopen", "reopen"], ["pending", "unqueue", "unqueue"],
  ];
  it.each(intent)("%s + %s calls update with the current version", async (status, action, change) => {
    const r = rig(snapshot([comment(1, { status: status as never, version: 7 })]));
    await r.coordinator.start();
    await r.coordinator.runAction(idOf(1), action);
    expect(r.client.update).toHaveBeenCalledWith({ id: idOf(1), expectedVersion: 7, change: { action: change } });
    expect(r.client.list.mock.calls.length).toBeGreaterThan(1);
  });

  it("delete calls remove with the current version", async () => {
    const r = rig(snapshot([comment(1, { version: 4 })]));
    await r.coordinator.start();
    await r.coordinator.runAction(idOf(1), "delete");
    expect(r.client.remove).toHaveBeenCalledWith({ id: idOf(1), expectedVersion: 4 });
  });

  it("adopt calls adopt with the id", async () => {
    const r = rig(snapshot([comment(1, { provenance: "foreign" })]));
    await r.coordinator.start();
    await r.coordinator.runAction(idOf(1), "adopt");
    expect(r.client.adopt).toHaveBeenCalledWith({ ids: [idOf(1)] });
  });

  it("Adopt all adopts every foreign comment in chunks of at most 20", async () => {
    const r = rig(snapshot(Array.from({ length: 45 }, (_, i) => comment(i + 1, { provenance: "foreign" }))));
    await r.coordinator.start();
    await r.coordinator.adoptAll();
    expect(r.client.adopt.mock.calls.map((c) => (c[0] as { ids: string[] }).ids.length)).toEqual([20, 20, 5]);
  });

  it("a conflict re-lists and tells the user, never retrying blindly", async () => {
    const r = rig(snapshot([comment(1)]));
    r.client.update.mockResolvedValueOnce(rej("conflict", "Changed elsewhere.") as never);
    await r.coordinator.start();
    const lists = r.client.list.mock.calls.length;
    await r.coordinator.runAction(idOf(1), "resolve");
    expect(r.client.update).toHaveBeenCalledTimes(1);
    expect(r.client.list.mock.calls.length).toBeGreaterThan(lists);
    expect(r.log.announce.at(-1)).toMatch(/changed/i);
  });

  it("an invalid-transition whose refetched state equals the intent counts as success (1.5)", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    r.client.update.mockImplementationOnce(async () => { r.set(snapshot([comment(1, { status: "resolved", version: 2 })], { revision: 2 })); return rej("invalid-transition", "Already resolved.") as never; });
    await r.coordinator.runAction(idOf(1), "resolve");
    expect(r.log.announce.at(-1)).toBe("Comment 1 resolved.");
  });

  it("Resolve sent resolves every local sent comment", async () => {
    const r = rig(snapshot([comment(1, { status: "sent" }), comment(2, { status: "sent" }), comment(3)]));
    await r.coordinator.start();
    await r.coordinator.resolveSent();
    expect(r.client.update.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual([idOf(1), idOf(2)]);
  });

  it("an action unknown to the current snapshot is ignored", async () => {
    const r = rig(snapshot([comment(1)]));
    await r.coordinator.start();
    await r.coordinator.runAction(idOf(9), "resolve");
    expect(r.client.update).not.toHaveBeenCalled();
  });
});

describe("selection and batch send", () => {
  it("defaults to every open local comment and Send N uses it, in ordinal order, with anchor states", async () => {
    const r = rig(snapshot([comment(2), comment(1), comment(3, { status: "sent" })]));
    await r.coordinator.start();
    r.results(1, [["a0", "selector", true, BOX], ["a1", "detached", true, null]]);
    await r.coordinator.sendSelected();
    const input = r.client.sendBatch.mock.calls[0]![0] as any;
    expect(input.ids).toEqual([idOf(1), idOf(2)]);
    expect(input.resend).toBe(false);
    expect(input.requestId).toMatch(/^req_[0-9a-f]{32}$/);
    expect(Object.keys(input.anchorStates).sort()).toEqual([idOf(1), idOf(2)].sort());
    expect(new Set(Object.values(input.anchorStates))).toEqual(new Set(["exact", "detached"]));
  });

  it("toggling changes the batch; an empty selection sends nothing", async () => {
    const r = rig(snapshot([comment(1), comment(2)]));
    await r.coordinator.start();
    r.coordinator.toggleSelect(idOf(1), false);
    await r.coordinator.sendSelected();
    expect((r.client.sendBatch.mock.calls[0]![0] as any).ids).toEqual([idOf(2)]);
    r.coordinator.toggleSelect(idOf(2), false);
    await r.coordinator.sendSelected();
    expect(r.client.sendBatch).toHaveBeenCalledTimes(1);
  });

  it("more than 20 selected is refused before the call", async () => {
    const r = rig(snapshot(Array.from({ length: 25 }, (_, i) => comment(i + 1))));
    await r.coordinator.start();
    await r.coordinator.sendSelected();
    expect(r.client.sendBatch).not.toHaveBeenCalled();
    expect(r.log.announce.at(-1)).toMatch(/at most 20/i);
  });

  it("shows the results line and announces it", async () => {
    const r = rig(snapshot([comment(1), comment(2), comment(3)]));
    r.client.sendBatch.mockImplementationOnce(async (input: any) => ok({
      requestId: input.requestId, outcome: "partial",
      items: [{ id: idOf(1), result: "sent" }, { id: idOf(2), result: "sent" }, { id: idOf(3), result: "queued" }], message: "x",
    }) as never);
    await r.coordinator.start();
    await r.coordinator.sendSelected();
    expect(r.lastRail().resultsLine).toBe("2 sent, 1 waiting for the agent");
    expect(r.log.announce.at(-1)).toBe("2 sent, 1 waiting for the agent");
  });

  it("row Send and Send again send one comment; resend sets resend:true", async () => {
    const r = rig(snapshot([comment(1), comment(2, { status: "sent" })]));
    await r.coordinator.start();
    await r.coordinator.runAction(idOf(1), "send");
    await r.coordinator.runAction(idOf(2), "resend");
    const [first, second] = r.client.sendBatch.mock.calls.map((c) => c[0] as any);
    expect(first).toMatchObject({ ids: [idOf(1)], resend: false });
    expect(second).toMatchObject({ ids: [idOf(2)], resend: true });
  });

  it("a rejection shows the plugin message and keeps the selection", async () => {
    const r = rig(snapshot([comment(1)]));
    r.client.sendBatch.mockResolvedValueOnce(rej("busy", "The agent is still working on an earlier batch.") as never);
    await r.coordinator.start();
    await r.coordinator.sendSelected();
    expect(r.lastRail().resultsLine).toBe("The agent is still working on an earlier batch.");
    expect(r.lastRail().send.count).toBe(1);
  });

  describe("requestId rule (plugin P2b QA): one id per user click, reused only for transport retries of that click", () => {
    it("every click mints a new requestId, including a click on a maybeSent comment", async () => {
      const maybe = comment(1, { send: { attempts: 1, lastOutcome: "unknown", maybeSent: true, lastMessage: null } });
      const r = rig(snapshot([maybe]));
      await r.coordinator.start();
      await r.coordinator.sendSelected();
      await r.coordinator.sendSelected();
      await r.coordinator.runAction(idOf(1), "send");
      const ids = r.client.sendBatch.mock.calls.map((c) => (c[0] as any).requestId);
      expect(new Set(ids).size).toBe(3);
    });

    it("a transport failure offers a retry that reuses the same requestId and ids", async () => {
      const r = rig(snapshot([comment(1), comment(2)]));
      r.client.sendBatch.mockResolvedValueOnce(rej("failed", "No response from Design in 15 s.") as never);
      await r.coordinator.start();
      await r.coordinator.sendSelected();
      expect(r.lastRail().retry).toBe(true);
      await r.coordinator.retryLastSend();
      const [a, b] = r.client.sendBatch.mock.calls.map((c) => c[0] as any);
      expect(b.requestId).toBe(a.requestId);
      expect(b.ids).toEqual(a.ids);
      expect(b.resend).toBe(a.resend);
      expect(r.lastRail().retry).toBe(false);
    });

    it("a fresh click after a failed one mints a new requestId and drops the retry", async () => {
      const r = rig(snapshot([comment(1)]));
      r.client.sendBatch.mockResolvedValueOnce(rej("failed", "No response.") as never);
      await r.coordinator.start();
      await r.coordinator.sendSelected();
      await r.coordinator.sendSelected();
      const [a, b] = r.client.sendBatch.mock.calls.map((c) => c[0] as any);
      expect(b.requestId).not.toBe(a.requestId);
      expect(r.lastRail().retry).toBe(false);
    });

    it("non-transport rejections (busy, conflict, invalid) offer no retry", async () => {
      for (const reason of ["busy", "conflict", "invalid", "foreign", "limit"]) {
        const r = rig(snapshot([comment(1)]));
        r.client.sendBatch.mockResolvedValueOnce(rej(reason, "no") as never);
        await r.coordinator.start();
        await r.coordinator.sendSelected();
        expect(r.lastRail().retry, reason).toBe(false);
      }
    });

    it("retryLastSend without a failed send does nothing", async () => {
      const r = rig(snapshot([comment(1)]));
      await r.coordinator.start();
      await r.coordinator.retryLastSend();
      expect(r.client.sendBatch).not.toHaveBeenCalled();
    });
  });
});

describe("after a pin is saved from the popover", () => {
  it("re-lists and focuses the new badge when it is placed, else the toggle", async () => {
    const r = rig(snapshot([]));
    await r.coordinator.start();
    const sel = "sel_" + idOf(1).slice(4);
    r.set(snapshot([comment(1)], { revision: 2 }));
    await r.coordinator.pinned(sel);
    expect(r.client.list.mock.calls.length).toBeGreaterThan(1);
    expect(r.coordinator.focusTargetAfterPin()).toEqual({ type: "toggle" });
    r.results(r.bridge.setAnchors.mock.results.at(-1)!.value.epoch, [["a0", "selector", true, BOX]]);
    r.runFrames();
    expect(r.coordinator.focusTargetAfterPin()).toEqual({ type: "badge", id: idOf(1) });
  });
});

describe("S2 guest-to-embedder scale and the on-screen set", () => {
  const frame = (over: Record<string, number> = {}) => ({ left: 0, top: 0, clientLeft: 1, clientTop: 1, clientWidth: 800, clientHeight: 600, ...over });
  const VIEWPORT = { width: 1000, height: 750 };
  const resultsWith = (r: ReturnType<typeof rig>, viewport: { width: number; height: number } | undefined, rows: Array<[string, { x: number; y: number; width: number; height: number }]>) =>
    r.coordinator.onAnchorResults({ epoch: 1, ...(viewport ? { viewport } : {}), results: rows.map(([key, rect]) => ({ key, match: "selector", agrees: true, rect, visible: true })) } as never);

  it("scales the badge position with frame.clientWidth / guest.innerWidth", async () => {
    const r = rig(snapshot([comment(1)]));
    r.ui.geometry = () => ({ frame: frame(), stage });
    await r.coordinator.start();
    resultsWith(r, VIEWPORT, [["a0", { x: 100, y: 200, width: 160, height: 48 }]]);
    r.runFrames();
    // box = 1 + 100 * 0.8 = 81 wide 128; top-right x = 81 + 128 - 4; y = 1 + 160 + 4
    expect(r.lastPins().badges[0]).toMatchObject({ x: 81 + 128 - 4, y: 1 + 160 + 4 });
  });

  it("a rects message carrying a new guest viewport re-maps the badges (a preset or zoom change)", async () => {
    const r = rig(snapshot([comment(1)]));
    r.ui.geometry = () => ({ frame: frame(), stage });
    await r.coordinator.start();
    resultsWith(r, VIEWPORT, [["a0", { x: 100, y: 200, width: 160, height: 48 }]]);
    r.runFrames();
    const before = r.lastPins().badges[0]!.x;
    r.coordinator.onAnchorRects({ epoch: 1, viewport: { width: 800, height: 600 }, rects: [{ key: "a0", rect: { x: 100, y: 200, width: 160, height: 48 }, visible: true }] } as never);
    r.runFrames();
    expect(r.lastPins().badges[0]!.x).toBe(1 + 100 + 160 - 4);
    expect(r.lastPins().badges[0]!.x).not.toBe(before);
  });

  it("no guest viewport means scale 1 (the border-corrected mapping)", async () => {
    const r = rig(snapshot([comment(1)]));
    r.ui.geometry = () => ({ frame: frame(), stage });
    await r.coordinator.start();
    resultsWith(r, undefined, [["a0", { x: 100, y: 200, width: 160, height: 48 }]]);
    r.runFrames();
    expect(r.lastPins().badges[0]).toMatchObject({ x: 1 + 100 + 160 - 4, y: 1 + 200 + 4 });
  });

  it("on screen is judged on the SCALED box: unscaled it would be inside the pane, scaled it is outside", async () => {
    const r = rig(snapshot([comment(1), comment(2)]));
    // pane 400 x 300; the guest is twice the embedder size, so x = 700 maps to 350 (inside) and x = 900 to 450 (outside).
    r.ui.geometry = () => ({ frame: frame({ clientWidth: 500, clientHeight: 375 }), stage: { left: 0, top: 0, width: 400, height: 300 } });
    await r.coordinator.start();
    resultsWith(r, { width: 1000, height: 750 }, [["a0", { x: 700, y: 20, width: 40, height: 20 }], ["a1", { x: 900, y: 20, width: 40, height: 20 }]]);
    r.runFrames();
    expect(r.lastPins().badges.map((b) => b.text)).toEqual(["1"]);
  });

  it("cluster counts only count pins that are on screen", async () => {
    const r = rig(snapshot([comment(1), comment(2), comment(3)]));
    r.ui.geometry = () => ({ frame: frame(), stage: { left: 0, top: 0, width: 400, height: 300 } });
    await r.coordinator.start();
    // a0 and a1 sit at the same on-pane spot (a cluster of 2); a2 is beside them but beyond the pane edge
    resultsWith(r, undefined, [["a0", { x: 100, y: 100, width: 50, height: 20 }], ["a1", { x: 102, y: 100, width: 50, height: 20 }], ["a2", { x: 700, y: 100, width: 50, height: 20 }]]);
    r.runFrames();
    expect(r.lastPins().badges.map((b) => [b.kind, b.text])).toEqual([["cluster", "2"]]);
  });
});
