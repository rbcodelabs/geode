import { afterEach, describe, expect, it, vi } from "vitest";
import { createPinsCoordinator, type PinsUi } from "../../src/renderer/artifacts/pins-coordinator";
import { ArtifactFeedbackService } from "../../src/renderer/artifacts/feedback-registry";
import { PinsUiStateHolder } from "../../src/renderer/artifacts/pins-ui-state";
import { buildRailView, cutByCodePoints, pinAccessibleName } from "../../src/renderer/artifacts/rail-model";
import type { PinBadgeView } from "../../src/renderer/artifacts/pin-overlay";
import type { RailView } from "../../src/renderer/artifacts/rail-model";
import { comment, idOf, snapshot } from "./helpers/pin-fixtures";

/** Phase 2b-i G3 QA fix pass: reportAnchors, the subscription-cap notice, a reloaded handler keeps the Retry, edge marks, code points. */

const ok = <T,>(value: T) => ({ status: "ok" as const, value });
const rej = (reason: string, message = "no") => ({ status: "rejected" as const, reason, message });
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const BOX = { x: 100, y: 200, width: 160, height: 48 };
afterEach(() => { vi.useRealTimers(); });

function rig(initial = snapshot([comment(1), comment(2)]), over: { stage?: { left: number; top: number; width: number; height: number } } = {}) {
  let current = initial;
  let epoch = 0;
  let reqs = 0;
  const frames: Array<() => void> = [];
  const mkClient = () => ({
    liveUpdates: true,
    list: vi.fn(async () => ok(current)),
    update: vi.fn(), remove: vi.fn(), adopt: vi.fn(),
    sendBatch: vi.fn(async (i: { requestId: string; ids: string[] }) => ok({ requestId: i.requestId, outcome: "sent", items: i.ids.map((id) => ({ id, result: "sent" })), message: "Sent." })),
    reportAnchors: vi.fn(async (reports: unknown[]) => ok({ applied: reports.length })),
    onDidChange: vi.fn(() => () => {}),
  });
  let client: ReturnType<typeof mkClient> = mkClient();
  const log = { rail: [] as RailView[], pins: [] as PinBadgeView[][], announce: [] as string[] };
  const ui: PinsUi = {
    renderRail: (v) => { log.rail.push(v); }, renderPins: (b) => { log.pins.push([...b]); }, announce: (t) => { log.announce.push(t); },
    availability: () => {}, focusRail: () => {},
    geometry: () => ({ frame: { left: 0, top: 0, clientLeft: 0, clientTop: 0 }, stage: over.stage ?? { left: 0, top: 0, width: 900, height: 600 } }),
  };
  const bridge = { setAnchors: vi.fn((q: readonly unknown[]) => ({ epoch: ++epoch, sent: q.length, rejected: [] as string[] })), focusAnchor: vi.fn(() => true) };
  const coordinator = createPinsCoordinator({
    getClient: () => client as never, bridge, ui,
    scheduleFrame: (cb) => { frames.push(cb); return () => { const i = frames.indexOf(cb); if (i >= 0) frames.splice(i, 1); }; },
    newRequestId: () => `req_${(++reqs).toString(16).padStart(32, "0")}`,
  });
  return {
    coordinator, bridge, log, get client() { return client; }, swapClient() { client = mkClient(); return client; },
    runFrames() { for (const f of frames.splice(0)) f(); },
    results(rows: Array<[string, string, boolean, typeof BOX | null]>) {
      coordinator.onAnchorResults({ epoch, results: rows.map(([key, match, agrees, rect]) => ({ key, match, agrees, rect, visible: rect !== null })) } as never);
    },
    set(s: typeof initial) { current = s; },
    lastRail: () => log.rail.at(-1)!,
    lastPins: () => log.pins.at(-1)!,
  };
}

describe("reportAnchors (G4): only changed states, after 2 s of stable answers, state only", () => {
  it("does not report first-seen exact anchors; reports a moved one once after 2 s with no healed anchor", async () => {
    vi.useFakeTimers();
    const r = rig();
    await r.coordinator.start();
    r.results([["a0", "selector", true, BOX], ["a1", "text", true, { ...BOX, x: 400 }]]);
    await vi.advanceTimersByTimeAsync(1999);
    expect(r.client.reportAnchors).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(r.client.reportAnchors).toHaveBeenCalledTimes(1);
    expect(r.client.reportAnchors).toHaveBeenCalledWith([{ id: idOf(2), state: "moved" }]);
  });

  it("repeated identical answers (the guest re-sends them) neither restart the wait nor re-report", async () => {
    vi.useFakeTimers();
    const r = rig();
    await r.coordinator.start();
    r.results([["a0", "selector", true, BOX], ["a1", "text", true, BOX]]);
    for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(600); r.results([["a0", "selector", true, BOX], ["a1", "text", true, BOX]]); }
    expect(r.client.reportAnchors).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    r.results([["a0", "selector", true, BOX], ["a1", "text", true, BOX]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.client.reportAnchors).toHaveBeenCalledTimes(1);
  });

  it("a later change of state is reported again; a provider that does not accept reports is not asked twice", async () => {
    vi.useFakeTimers();
    const r = rig();
    await r.coordinator.start();
    r.results([["a0", "selector", true, BOX], ["a1", "detached", true, null]]);
    await vi.advanceTimersByTimeAsync(2100);
    expect(r.client.reportAnchors).toHaveBeenLastCalledWith([{ id: idOf(2), state: "detached" }]);
    r.results([["a0", "text", true, BOX], ["a1", "detached", true, null]]);
    await vi.advanceTimersByTimeAsync(2100);
    expect(r.client.reportAnchors).toHaveBeenLastCalledWith([{ id: idOf(1), state: "moved" }]);
    const r2 = rig();
    r2.client.reportAnchors.mockResolvedValue(rej("unavailable", "This plugin does not accept anchor reports.") as never);
    await r2.coordinator.start();
    r2.results([["a0", "detached", true, null], ["a1", "detached", true, null]]);
    await vi.advanceTimersByTimeAsync(2100);
    r2.results([["a0", "text", true, BOX], ["a1", "detached", true, null]]);
    await vi.advanceTimersByTimeAsync(2100);
    expect(r2.client.reportAnchors).toHaveBeenCalledTimes(1);
  });

  it("dispose cancels a queued report", async () => {
    vi.useFakeTimers();
    const r = rig();
    await r.coordinator.start();
    r.results([["a0", "detached", true, null], ["a1", "selector", true, BOX]]);
    r.coordinator.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.client.reportAnchors).not.toHaveBeenCalled();
  });
});

describe("notices Geode words itself", () => {
  it("a client without live updates (subscription cap) says so", async () => {
    const r = rig();
    r.client.liveUpdates = false;
    await r.coordinator.start();
    expect(r.lastRail().notice).toMatch(/Live updates are paused/);
  });
  it("a store that is read-only gets Geode's sentence when the plugin gave none, the plugin's own otherwise", async () => {
    const a = rig(snapshot([comment(1)], { health: "read-only", notice: null }));
    await a.coordinator.start();
    expect(a.lastRail().notice).toMatch(/read-only/i);
    const b = rig(snapshot([comment(1)], { health: "read-only", notice: "File is locked." }));
    await b.coordinator.start();
    expect(b.lastRail().notice).toBe("File is locked.");
  });
});

describe("a plugin reload keeps the UI state (exportUi / restoreUi) and the Retry requestId", () => {
  it("a new coordinator restored from the old one's state retries the timed-out click with its own id", async () => {
    const r = rig(snapshot([comment(1), comment(2)]));
    r.client.sendBatch.mockResolvedValueOnce(rej("failed", "No response from Design in 15 s.") as never);
    await r.coordinator.start();
    r.coordinator.setFilter("open");
    r.coordinator.toggleSelect(idOf(2), false);
    await r.coordinator.sendSelected();
    const state = r.coordinator.exportUi();
    expect(state).toMatchObject({ filter: "open", lastSend: { ids: [idOf(1)] } });
    const first = (r.client.sendBatch.mock.calls[0]![0] as { requestId: string }).requestId;
    const r2 = rig(snapshot([comment(1), comment(2)]));
    r2.coordinator.restoreUi(state);
    await r2.coordinator.start();
    expect(r2.lastRail().filter).toBe("open");
    expect(r2.lastRail().retry).toBe(true);
    await r2.coordinator.retryLastSend();
    expect((r2.client.sendBatch.mock.calls[0]![0] as { requestId: string }).requestId).toBe(first);
  });
  it("exports no comment data", async () => {
    const r = rig(snapshot([comment(1, { text: "SECRET" })]));
    await r.coordinator.start();
    expect(JSON.stringify(r.coordinator.exportUi())).not.toContain("SECRET");
  });
});

describe("PinsUiStateHolder", () => {
  const state = { railOpen: true, filter: "open" as const, clusterIds: null, selected: null, resultsLine: null, lastSend: { requestId: "req_" + "a".repeat(32), ids: ["x"], resend: false } };
  it("hands the state back once to the same owner within the grace window", () => {
    const h = new PinsUiStateHolder(10_000);
    h.save("design", state, 1000);
    expect(h.take("design", 9000)).toBe(state);
    expect(h.take("design", 9001)).toBeNull(); // consumed
  });
  it("expires after the grace window", () => {
    const h = new PinsUiStateHolder(10_000);
    h.save("design", state, 1000);
    expect(h.take("design", 11_001)).toBeNull();
  });
  it("discards the state when a different owner registers (and does not keep it for later)", () => {
    const h = new PinsUiStateHolder(10_000);
    h.save("design", state, 1000);
    expect(h.take("other", 1500)).toBeNull();
    expect(h.take("design", 1600)).toBeNull();
  });
  it("clear (the view is disposed) drops it", () => {
    const h = new PinsUiStateHolder(10_000);
    h.save("design", state, 1000);
    h.clear();
    expect(h.take("design", 1001)).toBeNull();
  });
});

describe("registry routeInstance", () => {
  const target = { root: "/a", artifactId: "x", title: "X", runtime: "static" as const, vaultRead: false };
  const provider = () => ({
    capabilities: { pins: true, batchSend: true, textEdit: false },
    list: async () => rej("failed"), get: async () => rej("failed"), save: async () => rej("failed"), update: async () => rej("failed"),
    remove: async () => rej("failed"), adopt: async () => rej("failed"), subscribe: () => ({ dispose() {} }), sendBatch: async () => rej("failed"),
  });
  it("routeOwnerId names the plugin that would receive a submission", () => {
    const service = new ArtifactFeedbackService();
    service.register({ pluginId: "design", displayName: "Design" }, { contractVersion: 2 as const, submit: async () => ({ status: "accepted" as const }), comments: provider() as never });
    expect(service.routeOwnerId(target)).toBe("design");
  });
  it("is stable while the handler lives, changes when it is re-registered, and is null with no handler", () => {
    const service = new ArtifactFeedbackService();
    expect(service.routeInstance(target)).toBeNull();
    const handler = () => ({ contractVersion: 2 as const, submit: async () => ({ status: "accepted" as const }), comments: provider() as never });
    const a = service.register({ pluginId: "p", displayName: "P" }, handler());
    const first = service.routeInstance(target);
    expect(first).not.toBeNull();
    expect(service.routeInstance(target)).toBe(first);
    a.dispose();
    service.register({ pluginId: "p", displayName: "P" }, handler());
    expect(service.routeInstance(target)).not.toBe(first);
  });
});

describe("pins on the canvas: foreign, edge and unconfirmed marks", () => {
  it("a foreign pin is drawn foreign/hollow and named so; an edge-clamped badge is marked and named", async () => {
    const r = rig(snapshot([comment(1, { provenance: "foreign" }), comment(2)]), { stage: { left: 0, top: 0, width: 400, height: 300 } });
    await r.coordinator.start();
    r.results([["a0", "selector", true, { x: 380, y: 20, width: 80, height: 20 }], ["a1", "selector", true, { x: 100, y: 100, width: 50, height: 20 }]]);
    r.runFrames();
    const [foreignEdge, plain] = r.lastPins().sort((a, b) => a.text.localeCompare(b.text));
    expect(foreignEdge).toMatchObject({ foreign: true, approximate: true, edge: true });
    expect(foreignEdge!.label).toMatch(/not adopted, from another install.*partly out of view/);
    expect(plain).toMatchObject({ foreign: false, edge: false, approximate: false });
  });

  it("the cluster chip counts the rows that are actually visible", () => {
    const view = buildRailView({ comments: [comment(1), comment(2, { status: "resolved" }), comment(3)], anchorStates: {}, filter: "open", clusterIds: [idOf(1), idOf(2), idOf(3)], selected: null, notice: null, health: "ok", resultsLine: null });
    expect(view.clusterChip).toBe("2 comments at this spot");
  });
});

describe("code points", () => {
  it("cutByCodePoints never splits a pair, and the accessible name uses it", () => {
    expect(cutByCodePoints("a\u{1F600}b", 2)).toBe("a\u{1F600}");
    expect(cutByCodePoints("abc", 10)).toBe("abc");
    const name = pinAccessibleName(comment(1, { text: "x".repeat(59) + "\u{1F600}y" }), "exact");
    expect(name.endsWith("\u{1F600}")).toBe(true);
  });
});
