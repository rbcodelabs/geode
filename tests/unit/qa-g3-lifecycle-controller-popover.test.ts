import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactFeedbackTarget } from "../../src/artifacts/feedback-contract";
import type { ArtifactCommentsProvider, ArtifactFeedbackHandlerV2 } from "../../src/artifacts/feedback-contract-v2";
import { ArtifactFeedbackService, type ArtifactFeedbackOutcome } from "../../src/renderer/artifacts/feedback-registry";
import { createPinsCoordinator } from "../../src/renderer/artifacts/pins-coordinator";
import { PickController, type FocusTarget, type PickControllerHost, type PickState } from "../../src/renderer/artifacts/pick-controller";
import { PickPopover } from "../../src/renderer/artifacts/pick-popover";
import type { SelectionSnapshot } from "../../src/renderer/views/artifact-inspector-bridge";

vi.setConfig({ testTimeout: 30_000 });

/**
 * QA G3: (6) comments client lifecycle through the REAL registry + client + coordinator, (4) PickController pin state
 * machine edge cases, and the Mod+Shift+Enter popover/global-command interaction (static review #6).
 */

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "artifact-feedback");
const load = (name: string): any => JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8"));
const ok = (value: unknown) => ({ status: "ok", value });
const target: ArtifactFeedbackTarget = { root: "/a", artifactId: "art", title: "Art", runtime: "static", vaultRead: false };
const owner = { pluginId: "design", displayName: "Design" };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); vi.useRealTimers(); });

function provider() {
  let revision = 1;
  const listeners = new Set<(c: unknown) => void>();
  const subscribeDispose = vi.fn();
  const list = vi.fn(async () => { const s = load("snapshot.json"); s.revision = revision; return ok(s); });
  const subscribe = vi.fn((_t: unknown, l: (c: unknown) => void) => { listeners.add(l); return { dispose: () => { listeners.delete(l); subscribeDispose(); } }; });
  const p = {
    capabilities: { pins: true, batchSend: true, textEdit: false },
    list, subscribe,
    get: vi.fn(async () => ok(load("detail.json"))), save: vi.fn(), update: vi.fn(), remove: vi.fn(), adopt: vi.fn(),
    sendBatch: vi.fn(async () => ok(load("batch-report.json"))),
  } as unknown as ArtifactCommentsProvider;
  return { p, list, subscribe, subscribeDispose, listeners, bump: () => { revision++; const storeId = load("snapshot.json").storeId; for (const l of [...listeners]) l({ storeId, revision, reason: "external", ids: "all" }); } };
}
const v2 = (comments: ArtifactCommentsProvider): ArtifactFeedbackHandlerV2 => ({ contractVersion: 2, submit: vi.fn(async () => ({ status: "accepted" })), comments }) as unknown as ArtifactFeedbackHandlerV2;

function viewLike(options: { slots?: number } = {}) {
  const frames: Array<() => void> = [];
  const svc = new ArtifactFeedbackService({ scheduleFrame: (cb) => { frames.push(cb); return () => { const i = frames.indexOf(cb); if (i >= 0) frames.splice(i, 1); }; }, commentsMinRefreshMs: 0 });
  const fake = provider();
  svc.register(owner, v2(fake.p));
  const clients: any[] = [];
  const mount = () => {
    const client: any = svc.commentsFor(target);
    clients.push(client);
    const bridge = { setAnchors: vi.fn((q: readonly unknown[]) => ({ epoch: 1, sent: q.length, rejected: [] as string[] })), focusAnchor: vi.fn(() => true) };
    const coordinator = createPinsCoordinator({
      getClient: () => client, bridge,
      scheduleFrame: (cb) => { const t = setTimeout(cb, 0); return () => clearTimeout(t); },
      newRequestId: () => "req_" + "0".repeat(32),
      ui: {
        renderRail: () => {}, renderPins: () => {}, announce: () => {}, availability: () => {}, focusRail: () => {},
        geometry: () => ({ frame: { left: 0, top: 0, clientLeft: 0, clientTop: 0 }, stage: { left: 0, top: 0, width: 900, height: 600 } }),
      },
    });
    return { client, coordinator, bridge };
  };
  void options;
  return { svc, fake, frames, mount, runFrames: async () => { frames.splice(0).forEach((f) => f()); await flush(); } };
}

describe("(6) comments client lifecycle with the real registry, client and coordinator", () => {
  it("list, subscribe for the life of the view, list again after subscribing (in that order); closing the rail changes nothing", async () => {
    const v = viewLike();
    const m = v.mount();
    const order: string[] = [];
    v.fake.list.mockImplementation(async () => { order.push("list"); return ok(load("snapshot.json")); });
    v.fake.subscribe.mockImplementation((_t: unknown, l: (c: unknown) => void) => { order.push("subscribe"); v.fake.listeners.add(l); return { dispose: v.fake.subscribeDispose }; });
    await m.coordinator.start();
    expect(order).toEqual(["list", "subscribe", "list"]);
    await m.coordinator.openRail();
    m.coordinator.closeRail();
    await m.coordinator.openRail();
    expect(v.fake.subscribe).toHaveBeenCalledTimes(1);
    expect(v.fake.subscribeDispose).not.toHaveBeenCalled();
  });

  it("change events: a burst of 1000 causes at most one list per frame; the coordinator ends on the newest revision", async () => {
    const v = viewLike();
    const m = v.mount();
    await m.coordinator.start();
    v.fake.list.mockClear();
    for (let i = 0; i < 1000; i++) v.fake.bump();
    expect(v.fake.list).not.toHaveBeenCalled();
    await v.runFrames();
    expect(v.fake.list).toHaveBeenCalledTimes(1);
    expect(m.client.cached.revision).toBe(1001);
    m.coordinator.dispose();
    m.client.dispose();
  });

  it("view close/dispose leaves no provider subscription, no pending frame or timer, and frees the subscriber slot", async () => {
    vi.useFakeTimers();
    const v = viewLike();
    const base = vi.getTimerCount();
    const m = v.mount();
    await m.coordinator.start();
    v.fake.bump(); // a pending change refresh
    m.coordinator.dispose();
    m.client.dispose();
    expect(v.fake.subscribeDispose).toHaveBeenCalledTimes(1);
    expect(v.fake.listeners.size).toBe(0);
    expect(v.frames).toHaveLength(0);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(base);
    // all 8 slots are free again
    const ms = Array.from({ length: 8 }, () => v.mount());
    await Promise.all(ms.map((x) => x.coordinator.start()));
    expect(v.fake.listeners.size).toBe(8);
    for (const x of ms) { x.coordinator.dispose(); x.client.dispose(); }
    expect(v.fake.listeners.size).toBe(0);
  });

  it("dispose with a hanging list in flight clears the call timeout timer and settles it as unavailable", async () => {
    vi.useFakeTimers();
    const v = viewLike();
    const m = v.mount();
    const base = vi.getTimerCount();
    v.fake.list.mockImplementation(() => new Promise(() => {}));
    const pending = m.client.list();
    expect(vi.getTimerCount()).toBe(base + 1);
    m.client.dispose();
    expect((await pending).reason).toBe("unavailable");
    expect(vi.getTimerCount()).toBe(base);
  });

  it("subscription cap: the 9th view for one artifact still lists (and works) but gets no change events; nothing throws, one warning", async () => {
    const v = viewLike();
    const ms = Array.from({ length: 9 }, () => v.mount());
    for (const x of ms) await x.coordinator.start();
    expect(v.fake.listeners.size).toBe(8);
    expect(ms[8]!.client.cached).not.toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("subscriptions for one artifact"))).toBe(true);
    // the 9th is stale until a re-list (focus, leaf activation, opening the rail): refresh() recovers it
    v.fake.bump();
    await v.runFrames();
    expect(ms[8]!.client.cached.revision).toBeLessThan(ms[0]!.client.cached.revision);
    await ms[8]!.coordinator.refresh();
    expect(ms[8]!.client.cached.revision).toBe(ms[0]!.client.cached.revision);
    for (const x of ms) { x.coordinator.dispose(); x.client.dispose(); }
  });

  it("the handler being unregistered while a view is open: pins and rail keep their last rows, Pin and the rail become unavailable on the next list", async () => {
    const v = viewLike();
    const m = v.mount();
    await m.coordinator.start();
    expect(m.coordinator.railAvailable).toBe(true);
    // the registry closes the client (handlerGone) when the owner is disposed
    (v.svc as any).entries.length = 0;
    m.client.handlerGone();
    await m.coordinator.refresh();
    expect(m.coordinator.pinAvailable).toBe(false);
    expect(v.fake.listeners.size).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------
const snap = (id = "sel_aaaa"): SelectionSnapshot => ({ selection: { selectionId: id }, screenshot: null, screenshotOmitted: "vault-read" }) as unknown as SelectionSnapshot;
const accepted = (message?: string): ArtifactFeedbackOutcome => ({ status: "accepted", ...(message ? { message } : {}), source: "handler" });
const rejected = (message: string, source: ArtifactFeedbackOutcome["source"] = "handler"): ArtifactFeedbackOutcome => ({ status: "rejected", reason: "failed", message, source });

function controllerRig() {
  const modes: string[] = [];
  const focuses: FocusTarget[] = [];
  const pins: Array<{ comment: string; resolve: (o: ArtifactFeedbackOutcome) => void }> = [];
  const sends: Array<{ comment: string; resolve: (o: ArtifactFeedbackOutcome) => void }> = [];
  const states: PickState[] = [];
  const host: PickControllerHost = {
    setGuestMode: (m) => { modes.push(m); },
    focus: (t) => { focuses.push(t); },
    changed: (s) => { states.push(s); },
    submit: (_s, comment) => new Promise((resolve) => { sends.push({ comment, resolve }); }),
    pin: (_s, comment) => new Promise((resolve) => { pins.push({ comment, resolve }); }),
  };
  const c = new PickController(host);
  c.setPinAvailable(true);
  c.enter("pointer");
  c.selected(snap(), "toggle");
  c.setComment("Make this larger");
  return { c, modes, focuses, pins, sends, states };
}
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("(4) PickController pin state machine, adversarial", () => {
  it("double Pin: the second call while pending is ignored (one host.pin call, one pending state)", () => {
    const { c, pins, states } = controllerRig();
    const before = states.length;
    c.pin(); c.pin(); c.pin();
    expect(pins).toHaveLength(1);
    expect(states.length - before).toBe(1);
    expect(c.state.submit).toBe("pending");
    expect(c.state.action).toBe("pin");
  });

  it("Pin then Send while pending and Send then Pin while pending are both ignored", () => {
    const a = controllerRig();
    a.c.pin(); a.c.send();
    expect(a.sends).toHaveLength(0);
    const b = controllerRig();
    b.c.send(); b.c.pin();
    expect(b.pins).toHaveLength(0);
    expect(b.sends).toHaveLength(1);
  });

  it("Pin then Esc while pending: Esc is consumed, nothing is cancelled, and the late acceptance still lands as accepted", async () => {
    const { c, pins, modes } = controllerRig();
    c.pin();
    expect(c.escape()).toBe(true);
    expect(c.canCancel()).toBe(false);
    expect(c.state.phase).toBe("popover");
    expect(modes.at(-1)).not.toBe("off");
    pins[0]!.resolve(accepted("Pinned as comment 1."));
    await tick();
    expect(c.state).toMatchObject({ phase: "popover", submit: "accepted", action: "pin" });
  });

  it("Pin accepted then Esc: ends pick mode and hands focus to the pin layer exactly once", async () => {
    const { c, pins, focuses, modes } = controllerRig();
    c.pin();
    pins[0]!.resolve(accepted());
    await tick();
    focuses.length = 0;
    expect(c.escape()).toBe(true);
    expect(c.state.phase).toBe("off");
    expect(modes.at(-1)).toBe("off");
    expect(focuses).toEqual(["pins"]);
  });

  it("Pin rejected keeps the typed text and the Send path still works afterwards with the same text", async () => {
    const { c, pins, sends } = controllerRig();
    c.pin();
    pins[0]!.resolve(rejected("The comments file is read-only."));
    await tick();
    expect(c.state).toMatchObject({ submit: "rejected", action: "pin", comment: "Make this larger" });
    c.send();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.comment).toBe("Make this larger");
    expect(c.state.action).toBe("send");
  });

  it("the handler vanishing mid-flight: the in-flight pin still settles, then both Pin and Send are disabled and retry is impossible", async () => {
    const { c, pins } = controllerRig();
    c.pin();
    c.setAvailable(false);
    expect(c.state.handlerGone).toBe(true);
    pins[0]!.resolve(rejected("Design was unloaded before it answered.", "disposed"));
    await tick();
    expect(c.state.submit).toBe("rejected");
    expect(c.canPin()).toBe(false);
    expect(c.canSend()).toBe(false);
    c.pin(); c.send();
    expect(pins).toHaveLength(1);
  });

  it("Esc/guest-cancel and Capture while a pin is pending are refused (the pin cannot be abandoned), so the late acceptance lands", async () => {
    for (const refuse of ["captureRequested", "cancelFromGuest"] as const) {
      const { c, pins } = controllerRig();
      c.pin();
      c[refuse]();
      expect(c.state, refuse).toMatchObject({ phase: "popover", submit: "pending" });
      pins[0]!.resolve(accepted());
      await tick();
      expect(c.state, refuse).toMatchObject({ phase: "popover", submit: "accepted", action: "pin" });
    }
  });

  it("dispose while a pin is pending: the late result changes no state and nothing throws", async () => {
    const { c, pins, states } = controllerRig();
    c.pin();
    c.dispose();
    const n = states.length;
    pins[0]!.resolve(accepted());
    await tick();
    expect(states.length).toBe(n);
  });

  it("pageReloaded while a pin is pending marks the popover stale; the late acceptance is still shown, and a retry after rejection re-sends nothing new", async () => {
    const { c, pins } = controllerRig();
    c.pin();
    c.pageReloaded();
    expect(c.state.stale).toBe(true);
    pins[0]!.resolve(accepted("Pinned as comment 2."));
    await tick();
    expect(c.state).toMatchObject({ submit: "accepted", stale: true });
  });

  it("pin availability flipping off while the popover is open keeps the typed text and Send", () => {
    const { c } = controllerRig();
    c.setPinAvailable(false);
    expect(c.canPin()).toBe(false);
    expect(c.canSend()).toBe(true);
    expect(c.state.comment).toBe("Make this larger");
  });

  // BUG (advisory, defence in depth): the controller has no catch on the host promise. bridge.pin() never rejects today,
  // but a host.pin that does leaves the popover "pending" for ever (Cancel disabled, Esc consumed) and an unhandled rejection.
  it.fails("BUG: a rejecting host.pin settles the popover as rejected instead of leaving it pending", async () => {
    const host: PickControllerHost = {
      setGuestMode: () => {}, focus: () => {}, changed: () => {},
      submit: async () => accepted(),
      pin: () => Promise.reject(new Error("boom")),
    };
    const c = new PickController(host);
    c.setPinAvailable(true);
    c.enter("pointer"); c.selected(snap(), "toggle"); c.setComment("x");
    const swallow = () => {};
    process.on("unhandledRejection", swallow);
    c.pin();
    await tick(); await tick();
    process.off("unhandledRejection", swallow);
    expect(c.state.submit).toBe("rejected");
  });
});

// ------------------------------------------------------------------------------------------------------------------
const popoverSnapshot = {
  selection: {
    schemaVersion: 1, selectionId: "sel_" + "a".repeat(32), artifactId: "demo", artifactRevision: 1, viewSessionId: "reg", viewportPreset: "fill",
    capturedAt: "2026-11-08T00:00:00.000Z", redacted: false, route: "/index.html", tag: "button", selector: "#buy", selectorAlternates: [],
    textAnchor: { tag: "button", text: "Buy" }, landmark: null, outerHTML: { html: "<button>Buy</button>", truncated: false }, ancestors: [],
    computedStyles: {}, boundingBox: { viewport: { x: 1, y: 2, width: 3, height: 4 }, document: { x: 1, y: 2, width: 3, height: 4 } },
    viewport: { width: 1, height: 1, devicePixelRatio: 1, scrollX: 0, scrollY: 0 }, a11y: { role: "button", name: "Buy", tabIndex: 0 },
  },
  screenshot: null, screenshotOmitted: "vault-read",
} as never;
const baseState: PickState = {
  phase: "popover", submit: "idle", action: "send", pinAvailable: true, snapshot: popoverSnapshot, comment: "hello", outcome: null, stale: false, handlerGone: false, elementGone: false,
};
function popoverRig() {
  const dom = new JSDOM("<!doctype html><body></body>");
  const doc = dom.window.document;
  const cb = { onComment: vi.fn(), onSend: vi.fn(), onPin: vi.fn(), onCancel: vi.fn(), onDone: vi.fn(), onEscape: vi.fn(), onRepick: vi.fn() };
  const popover = new PickPopover(doc, cb);
  doc.body.append(popover.el);
  const outside = doc.createElement("input");
  doc.body.append(outside);
  const global = vi.fn(); // what CommandRegistry.attach installs as a document capture keydown listener (Toggle focus on active pane)
  doc.addEventListener("keydown", global, true);
  const press = (el: Element, init: KeyboardEventInit = {}) => {
    const ev = new dom.window.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(ev);
    return ev;
  };
  const area = popover.el.querySelector<HTMLTextAreaElement>(".pick-popover-comment")!;
  return { dom, doc, popover, cb, global, press, area, outside };
}

describe("Mod+Shift+Enter: Pin in the popover vs the global 'Toggle focus on active pane' (static review #6)", () => {
  it("outside the popover the combo reaches the global command and never pins; page-like targets (not in the popover) are ignored", () => {
    const r = popoverRig();
    r.popover.render(baseState, "Design");
    r.press(r.outside);
    r.press(r.doc.body);
    expect(r.global).toHaveBeenCalledTimes(2);
    expect(r.cb.onPin).not.toHaveBeenCalled();
  });

  it("a hidden-Pin popover (v1 handler) still leaves the combo to the global command: the popover pins nothing", () => {
    const r = popoverRig();
    r.popover.render({ ...baseState, pinAvailable: false }, "Design");
    r.press(r.area);
    expect(r.cb.onPin).not.toHaveBeenCalled();
  });

  // BUG (static review #6): the window capture listener swallows the combo whenever focus is in the popover, even when
  // Pin is hidden (v1 handler), disabled (empty comment, pending) or accepted. The engineer's note says "everywhere else unchanged".
  it.fails("BUG: in a v1 popover (no Pin button) Mod+Shift+Enter still reaches the global command", () => {
    const r = popoverRig();
    r.popover.render({ ...baseState, pinAvailable: false }, "Design");
    r.press(r.area);
    expect(r.global).toHaveBeenCalledTimes(1);
  });

  it.fails("BUG: with an empty comment (Pin disabled) Mod+Shift+Enter still reaches the global command", () => {
    const r = popoverRig();
    r.popover.render({ ...baseState, comment: "" }, "Design");
    r.press(r.area);
    expect(r.global).toHaveBeenCalledTimes(1);
  });

  it.fails("BUG: while a send is pending Mod+Shift+Enter still reaches the global command", () => {
    const r = popoverRig();
    r.popover.render({ ...baseState, submit: "pending", action: "send" }, "Design");
    r.press(r.area);
    expect(r.global).toHaveBeenCalledTimes(1);
  });

  it("with Pin available and a comment typed: Pin fires once, the global command does not, default is prevented", () => {
    const r = popoverRig();
    r.popover.render(baseState, "Design");
    const ev = r.press(r.area);
    expect(r.cb.onPin).toHaveBeenCalledTimes(1);
    expect(r.global).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(true);
  });

  it("other combos are untouched: Shift+Enter, Mod+Enter (sends), Alt+Mod+Shift+Enter, composing", () => {
    const r = popoverRig();
    r.popover.render(baseState, "Design");
    r.press(r.area, { ctrlKey: false });                 // Shift+Enter: newline, not Pin
    r.press(r.area, { shiftKey: false });                // Mod+Enter: Send
    r.press(r.area, { altKey: true });                   // Alt+Mod+Shift+Enter
    r.press(r.area, { isComposing: true });              // IME
    expect(r.cb.onPin).not.toHaveBeenCalled();
    expect(r.cb.onSend).toHaveBeenCalledTimes(1);
    expect(r.global).toHaveBeenCalledTimes(4); // none of these four is the Pin combo, so the global listener sees all of them
  });

  it("cmd on macOS (metaKey) pins as well", () => {
    const r = popoverRig();
    r.popover.render(baseState, "Design");
    r.press(r.area, { ctrlKey: false, metaKey: true });
    expect(r.cb.onPin).toHaveBeenCalledTimes(1);
  });

  it("a synthetic (untrusted) event inside the popover also pins: only embedder code can dispatch it, because the guest page is a separate process whose key events never reach this document", () => {
    const r = popoverRig();
    r.popover.render(baseState, "Design");
    const ev = r.press(r.area);
    expect(ev.isTrusted).toBe(false);
    expect(r.cb.onPin).toHaveBeenCalledTimes(1); // not a defect by itself: see the e2e spec for the real guest-keystroke check
  });
});
