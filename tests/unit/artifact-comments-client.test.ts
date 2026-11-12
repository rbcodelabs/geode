import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactFeedbackRequest, ArtifactFeedbackTarget } from "../../src/artifacts/feedback-contract";
import type {
  ArtifactCommentsChange,
  ArtifactCommentsProvider,
  ArtifactFeedbackHandlerV2,
} from "../../src/artifacts/feedback-contract-v2";
import { ArtifactFeedbackService } from "../../src/renderer/artifacts/feedback-registry";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "artifact-feedback");
const load = (name: string): any => JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8"));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const target: ArtifactFeedbackTarget = { root: "/a", artifactId: "art", title: "Art", runtime: "static", vaultRead: false };
const owner = { pluginId: "design", displayName: "Design" };
const ID = "cmt_0123456789abcdef0123456789abcdef";
const REQ = "req_00112233445566778899aabbccddeeff";
const ok = (value: unknown) => ({ status: "ok", value });

interface Fake {
  provider: ArtifactCommentsProvider;
  list: ReturnType<typeof vi.fn>;
  subscribeDispose: ReturnType<typeof vi.fn>;
  emit(change: unknown): void;
  subscribe: ReturnType<typeof vi.fn>;
}
function fakeProvider(over: Record<string, unknown> = {}): Fake {
  let listener: ((change: ArtifactCommentsChange) => void) | null = null;
  const subscribeDispose = vi.fn();
  const list = vi.fn(async () => ok(load("snapshot.json")));
  const subscribe = vi.fn((_t: unknown, l: (change: ArtifactCommentsChange) => void) => { listener = l; return { dispose: subscribeDispose }; });
  const provider = {
    capabilities: { pins: true, batchSend: true, textEdit: false },
    list,
    get: vi.fn(async () => ok(load("detail.json"))),
    save: vi.fn(async () => ok({ comment: load("comment.json"), created: true })),
    update: vi.fn(async () => ok(load("comment.json"))),
    remove: vi.fn(async () => ok({ id: ID })),
    adopt: vi.fn(async () => ok({ adopted: [ID] })),
    subscribe,
    sendBatch: vi.fn(async () => ok(load("batch-report.json"))),
    reportAnchors: vi.fn(async () => ok({ applied: 1 })),
    ...over,
  } as unknown as ArtifactCommentsProvider;
  return { provider, list, subscribe, subscribeDispose, emit: (change) => listener?.(change as ArtifactCommentsChange) };
}
const v2 = (comments: ArtifactCommentsProvider, over: Record<string, unknown> = {}): ArtifactFeedbackHandlerV2 =>
  ({ contractVersion: 2, submit: vi.fn(async () => ({ status: "accepted" })), comments, ...over }) as unknown as ArtifactFeedbackHandlerV2;

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); vi.useRealTimers(); });

function setup(over: Record<string, unknown> = {}, options: ConstructorParameters<typeof ArtifactFeedbackService>[0] = {}) {
  options = { commentsMinRefreshMs: 0, ...options };
  const frames: (() => void)[] = [];
  const svc = new ArtifactFeedbackService({ scheduleFrame: (cb) => { frames.push(cb); return () => { const i = frames.indexOf(cb); if (i >= 0) frames.splice(i, 1); }; }, ...options });
  const fake = fakeProvider(over);
  const reg = svc.register(owner, v2(fake.provider));
  expect(reg.status).toBe("registered");
  const client = svc.commentsFor(target)!;
  expect(client).not.toBeNull();
  const runFrame = async () => { frames.splice(0).forEach((frame) => frame()); await flush(); };
  return { svc, fake, reg, client, frames, runFrame };
}
const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

describe("commentsFor routing", () => {
  it("is null with no handler, for a v1 handler, and when the first matching handler is v1 (no fall-through)", () => {
    const svc = new ArtifactFeedbackService();
    expect(svc.commentsFor(target)).toBeNull();
    svc.register(owner, { contractVersion: 1, submit: async () => ({ status: "accepted" }) });
    expect(svc.commentsFor(target)).toBeNull();
    svc.register({ pluginId: "other", displayName: "Other" }, v2(fakeProvider().provider));
    expect(svc.commentsFor(target)).toBeNull();
    expect(svc.describeRoute(target)).toEqual({ displayName: "Design", contractVersion: 1 });
    expect(svc.describeHandler(target)).toBe("Design");
  });

  it("returns a client for a v2 handler and honors canHandle", () => {
    const svc = new ArtifactFeedbackService();
    svc.register(owner, v2(fakeProvider().provider, { canHandle: (t: ArtifactFeedbackTarget) => t.artifactId === "mine" }));
    expect(svc.commentsFor(target)).toBeNull();
    expect(svc.commentsFor({ ...target, artifactId: "mine" })).not.toBeNull();
    expect(svc.describeRoute({ ...target, artifactId: "mine" })).toEqual({ displayName: "Design", contractVersion: 2 });
  });

  it("exposes capabilities by value", () => {
    const { client } = setup();
    expect(client.capabilities).toEqual({ pins: true, batchSend: true, textEdit: false });
    expect(Object.isFrozen(client.capabilities)).toBe(true);
  });
});

describe("calls: round trip, data-only, frozen", () => {
  it("list passes a fresh frozen target and an abort signal, and returns a rebuilt frozen snapshot", async () => {
    const { client, fake } = setup();
    const result = await client.list();
    expect(result).toEqual({ status: "ok", value: load("snapshot.json") });
    const [passedTarget, ctx] = fake.list.mock.calls[0]!;
    expect(passedTarget).toEqual(target);
    expect(passedTarget).not.toBe(target);
    expect(Object.isFrozen(passedTarget)).toBe(true);
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.signal.aborted).toBe(false);
    expect(Object.isFrozen((result as any).value.comments[0])).toBe(true);
    expect(client.cached).toEqual(load("snapshot.json"));
  });

  it("every method reaches the provider with the right arguments and rebuilds its result", async () => {
    const { client, fake } = setup();
    expect(await client.get(ID)).toMatchObject({ status: "ok", value: { comment: { id: ID }, selection: { selectionId: "sel_0123456789abcdef0123456789abcdef" } } });
    expect((fake.provider.get as any).mock.calls[0][1]).toBe(ID);
    const request = { contractVersion: 1, artifact: target, comment: "c", selection: load("selection.json"), screenshot: null, screenshotOmitted: "vault-read", stale: false, submittedAt: "2026-11-12T10:00:00.000Z" } as unknown as ArtifactFeedbackRequest;
    expect(await client.save({ request })).toMatchObject({ status: "ok", value: { created: true, comment: { id: ID } } });
    expect(Object.isFrozen((fake.provider.save as any).mock.calls[0][1].request)).toBe(true);
    expect(await client.update({ id: ID, expectedVersion: 3, change: { action: "resolve" } })).toMatchObject({ status: "ok", value: { id: ID } });
    expect(await client.update({ id: ID, expectedVersion: 3, change: { text: "new text" } })).toMatchObject({ status: "ok" });
    expect(await client.remove({ id: ID, expectedVersion: 3 })).toEqual({ status: "ok", value: { id: ID } });
    expect(await client.adopt({ ids: [ID] })).toEqual({ status: "ok", value: { adopted: [ID] } });
    const batchIds = [ID, "cmt_fedcba9876543210fedcba9876543210", "cmt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
    expect(await client.sendBatch({ requestId: REQ, ids: batchIds, resend: false, anchorStates: { [ID]: "exact" } })).toMatchObject({ status: "ok", value: { outcome: "partial" } });
    expect(await client.reportAnchors([{ id: ID, state: "moved", healed: { selector: "a > b", selectorAlternates: [], textAnchor: { tag: "b", text: "x" }, landmark: null, lastRect: null } }])).toEqual({ status: "ok", value: { applied: 1 } });
  });

  it("reportAnchors is unavailable when the provider does not implement it", async () => {
    const { client } = setup({ reportAnchors: undefined });
    expect(await client.reportAnchors([{ id: ID, state: "detached" }])).toMatchObject({ status: "rejected", reason: "unavailable" });
  });

  it("passes provider rejections through with cleaned messages", async () => {
    const { client } = setup({ update: vi.fn(async () => ({ status: "rejected", reason: "conflict", message: `stale\u0000 version${"!".repeat(600)}` })) });
    const result = await client.update({ id: ID, expectedVersion: 1, change: { action: "dismiss" } });
    expect(result).toMatchObject({ status: "rejected", reason: "conflict" });
    expect((result as any).message.length).toBe(500);
    expect((result as any).message).not.toContain("\u0000");
  });
});

describe("input validation happens before the provider is called", () => {
  const cases: [string, (c: any) => Promise<unknown>][] = [
    ["get with a traversal id", (c) => c.get("cmt_../../x")],
    ["get with a non-string id", (c) => c.get(7)],
    ["update with a bad id", (c) => c.update({ id: "x", expectedVersion: 1, change: { action: "resolve" } })],
    ["update with expectedVersion 0", (c) => c.update({ id: ID, expectedVersion: 0, change: { action: "resolve" } })],
    ["update with an unknown action", (c) => c.update({ id: ID, expectedVersion: 1, change: { action: "delete" } })],
    ["update with empty text", (c) => c.update({ id: ID, expectedVersion: 1, change: { text: "" } })],
    ["update with 4001 units of text", (c) => c.update({ id: ID, expectedVersion: 1, change: { text: "t".repeat(4001) } })],
    ["remove with a bad version", (c) => c.remove({ id: ID, expectedVersion: 1.5 })],
    ["adopt with 21 ids", (c) => c.adopt({ ids: Array.from({ length: 21 }, (_, i) => `cmt_${i.toString(16).padStart(32, "0")}`) })],
    ["adopt with no ids", (c) => c.adopt({ ids: [] })],
    ["adopt with a duplicate id", (c) => c.adopt({ ids: [ID, ID] })],
    ["sendBatch with a bad requestId", (c) => c.sendBatch({ requestId: "req_x", ids: [ID], resend: false, anchorStates: {} })],
    ["sendBatch with 21 ids", (c) => c.sendBatch({ requestId: REQ, ids: Array.from({ length: 21 }, (_, i) => `cmt_${i.toString(16).padStart(32, "0")}`), resend: false, anchorStates: {} })],
    ["sendBatch with resend not boolean", (c) => c.sendBatch({ requestId: REQ, ids: [ID], resend: "yes", anchorStates: {} })],
    ["sendBatch with an unknown anchor state", (c) => c.sendBatch({ requestId: REQ, ids: [ID], resend: false, anchorStates: { [ID]: "teleported" } })],
    ["sendBatch with an anchor state keyed by a bad id", (c) => c.sendBatch({ requestId: REQ, ids: [ID], resend: false, anchorStates: { "../x": "exact" } })],
    ["reportAnchors with 101 reports", (c) => c.reportAnchors(Array.from({ length: 101 }, (_, i) => ({ id: `cmt_${i.toString(16).padStart(32, "0")}`, state: "exact" })))],
    ["reportAnchors with a bad state", (c) => c.reportAnchors([{ id: ID, state: "gone" }])],
    ["save without a request", (c) => c.save({})],
  ];
  for (const [name, call] of cases) {
    it(`rejects ${name} as invalid`, async () => {
      const { client, fake } = setup();
      const result = await call(client);
      expect(result).toMatchObject({ status: "rejected", reason: "invalid" });
      for (const method of ["get", "save", "update", "remove", "adopt", "sendBatch", "reportAnchors"] as const) {
        expect((fake.provider[method] as any).mock.calls).toHaveLength(0);
      }
    });
  }
});

describe("fault isolation, timeouts, abort", () => {
  it("a throwing, rejecting or junk-returning provider becomes a rejected failure and a warning, never a throw", async () => {
    const thrower = setup({ list: vi.fn(() => { throw new Error("sync boom"); }) });
    expect(await thrower.client.list()).toMatchObject({ status: "rejected", reason: "failed" });
    const rejecter = setup({ list: vi.fn(async () => { throw new Error("async boom"); }) });
    expect(await rejecter.client.list()).toMatchObject({ status: "rejected", reason: "failed" });
    const junk = setup({ list: vi.fn(async () => ({ status: "ok", value: { nonsense: true } })) });
    expect(await junk.client.list()).toMatchObject({ status: "rejected", reason: "failed" });
    const notAResult = setup({ list: vi.fn(async () => 42) });
    expect(await notAResult.client.list()).toMatchObject({ status: "rejected", reason: "failed" });
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(thrower.client.cached).toBeNull();
  });

  it("a hanging provider times out at 10 s (list) and 15 s (sendBatch) and its signal aborts", async () => {
    vi.useFakeTimers();
    const hang = () => new Promise(() => {});
    const { client, fake } = setup({ list: vi.fn(hang), sendBatch: vi.fn(hang) });
    const listed = client.list();
    const sent = client.sendBatch({ requestId: REQ, ids: [ID], resend: false, anchorStates: {} });
    let listDone = false;
    let sendDone = false;
    void listed.then(() => { listDone = true; });
    void sent.then(() => { sendDone = true; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(listDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await listed).toMatchObject({ status: "rejected", reason: "failed" });
    expect((fake.provider.list as any).mock.calls[0][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(sendDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await sent).toMatchObject({ status: "rejected", reason: "failed" });
    expect(((fake.provider.sendBatch as any).mock.calls[0][2].signal as AbortSignal).aborted).toBe(true);
  });

  it("timeouts are configurable and a late answer after a timeout is ignored", async () => {
    vi.useFakeTimers();
    let resolveLate!: (value: unknown) => void;
    const { client } = setup({ list: vi.fn(() => new Promise((resolve) => { resolveLate = resolve; })) }, { commentsCallTimeoutMs: 50 });
    const pending = client.list();
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({ status: "rejected", reason: "failed" });
    resolveLate(ok(load("snapshot.json")));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.cached).toBeNull();
  });

  it("unregistering the handler settles in-flight calls as unavailable, aborts them, and later calls never reach the provider", async () => {
    const { client, fake, reg } = setup({ list: vi.fn(() => new Promise(() => {})) });
    const pending = client.list();
    reg.dispose();
    expect(await pending).toMatchObject({ status: "rejected", reason: "unavailable" });
    expect((fake.provider.list as any).mock.calls[0][1].signal.aborted).toBe(true);
    expect(await client.get(ID)).toMatchObject({ status: "rejected", reason: "unavailable" });
    expect((fake.provider.get as any).mock.calls).toHaveLength(0);
  });

  it("disposing the client settles in-flight calls as unavailable and aborts them", async () => {
    const { client, fake } = setup({ list: vi.fn(() => new Promise(() => {})) });
    const pending = client.list();
    client.dispose();
    expect(await pending).toMatchObject({ status: "rejected", reason: "unavailable" });
    expect((fake.provider.list as any).mock.calls[0][1].signal.aborted).toBe(true);
    expect(await client.list()).toMatchObject({ status: "rejected", reason: "unavailable" });
    client.dispose(); // idempotent
  });

  it("a canHandle that changes after the client exists does not matter; the client belongs to the handler that was routed", async () => {
    const svc = new ArtifactFeedbackService();
    let handles = true;
    const fake = fakeProvider();
    svc.register(owner, v2(fake.provider, { canHandle: () => handles }));
    const client = svc.commentsFor(target)!;
    handles = false;
    expect(svc.commentsFor(target)).toBeNull();
    expect(await client.list()).toMatchObject({ status: "ok" });
  });
});

describe("change events: validated, coalesced, deduplicated by revision", () => {
  it("subscribes to the provider lazily and disposes it with the last listener", () => {
    const { client, fake } = setup();
    expect(fake.subscribe).not.toHaveBeenCalled();
    const offA = client.onDidChange(() => {});
    const offB = client.onDidChange(() => {});
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(fake.subscribe.mock.calls[0]![0])).toBe(true);
    offA();
    expect(fake.subscribeDispose).not.toHaveBeenCalled();
    offB();
    expect(fake.subscribeDispose).toHaveBeenCalledTimes(1);
    offB(); // idempotent
    expect(fake.subscribeDispose).toHaveBeenCalledTimes(1);
  });

  it("1,000 change events in one burst cause exactly one list per frame", async () => {
    const { client, fake, frames, runFrame } = setup();
    const seen = vi.fn();
    client.onDidChange(seen);
    for (let i = 0; i < 1000; i += 1) fake.emit({ storeId: "str_89abcdef0123456789abcdef01234567", revision: 8 + i, reason: "local", ids: [ID] });
    expect(fake.list).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0]).toMatchObject({ status: "ok" });
  });

  it("ignores events whose revision is not newer within the same storeId, but a different storeId always refetches", async () => {
    const { client, fake, frames, runFrame } = setup();
    await client.list(); // cache: storeId str_89ab..., revision 7
    const seen = vi.fn();
    client.onDidChange(seen);
    const store = "str_89abcdef0123456789abcdef01234567";
    fake.emit({ storeId: store, revision: 7, reason: "local", ids: [ID] });
    fake.emit({ storeId: store, revision: 3, reason: "local", ids: "all" });
    expect(frames).toHaveLength(0);
    fake.emit({ storeId: "str_ffffffffffffffffffffffffffffffff", revision: 1, reason: "recovered", ids: "all" });
    expect(frames).toHaveLength(1);
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("drops events that carry no usable revision; ones with a plausible revision still cause a list (fixpass A8)", () => {
    const { client, fake, frames } = setup();
    client.onDidChange(() => {});
    fake.emit({ storeId: "str_89abcdef0123456789abcdef01234567", revision: "9", reason: "local", ids: [] });
    fake.emit(null);
    fake.emit("boom");
    expect(frames).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("an event during an in-flight refresh schedules one follow-up refresh after it completes", async () => {
    let finish!: (value: unknown) => void;
    const first = new Promise((resolve) => { finish = resolve; });
    const list = vi.fn().mockReturnValueOnce(first).mockResolvedValue(ok({ ...load("snapshot.json"), revision: 20 }));
    const { client, fake, frames, runFrame } = setup({ list });
    client.onDidChange(() => {});
    const store = "str_89abcdef0123456789abcdef01234567";
    fake.emit({ storeId: store, revision: 8, reason: "local", ids: "all" });
    await runFrame();
    expect(list).toHaveBeenCalledTimes(1);
    fake.emit({ storeId: store, revision: 20, reason: "local", ids: "all" });
    expect(frames).toHaveLength(0);
    finish(ok({ ...load("snapshot.json"), revision: 8 }));
    await flush();
    expect(frames).toHaveLength(1);
    await runFrame();
    expect(list).toHaveBeenCalledTimes(2);
    expect(client.cached!.revision).toBe(20);
  });

  it("never lets an older response overwrite a newer cache", async () => {
    const { client, fake } = setup();
    fake.list.mockResolvedValueOnce(ok({ ...load("snapshot.json"), revision: 9 })).mockResolvedValueOnce(ok({ ...load("snapshot.json"), revision: 8 }));
    await client.list();
    expect(await client.list()).toMatchObject({ status: "ok", value: { revision: 9 } }); // never an older snapshot than the cache holds
    expect(client.cached!.revision).toBe(9);
  });

  it("a failed refresh notifies listeners with the failure and keeps the cache", async () => {
    const { client, fake, runFrame } = setup();
    await client.list();
    fake.list.mockRejectedValueOnce(new Error("down"));
    const seen = vi.fn();
    client.onDidChange(seen);
    fake.emit({ storeId: "str_89abcdef0123456789abcdef01234567", revision: 9, reason: "external", ids: "all" });
    await runFrame();
    expect(seen.mock.calls[0]![0]).toMatchObject({ status: "rejected", reason: "failed" });
    expect(client.cached!.revision).toBe(7);
  });

  it("a throwing listener does not stop the others", async () => {
    const { client, fake, runFrame } = setup();
    const good = vi.fn();
    client.onDidChange(() => { throw new Error("listener boom"); });
    client.onDidChange(good);
    fake.emit({ storeId: "str_89abcdef0123456789abcdef01234567", revision: 9, reason: "local", ids: "all" });
    await runFrame();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("a provider whose subscribe throws or returns junk degrades to no events", () => {
    const thrower = setup({ subscribe: vi.fn(() => { throw new Error("no"); }) });
    expect(() => thrower.client.onDidChange(() => {})()).not.toThrow();
    const junk = setup({ subscribe: vi.fn(() => ({ nope: 1 })) });
    expect(() => junk.client.onDidChange(() => {})()).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it("disposing the client or the handler stops events, cancels the pending frame and disposes the subscription", async () => {
    const a = setup();
    const seenA = vi.fn();
    a.client.onDidChange(seenA);
    a.fake.emit({ storeId: "str_89abcdef0123456789abcdef01234567", revision: 9, reason: "local", ids: "all" });
    a.client.dispose();
    expect(a.frames).toHaveLength(0);
    expect(a.fake.subscribeDispose).toHaveBeenCalledTimes(1);
    a.fake.emit({ storeId: "str_89abcdef0123456789abcdef01234567", revision: 10, reason: "local", ids: "all" });
    await a.runFrame();
    expect(seenA).not.toHaveBeenCalled();

    const b = setup();
    b.client.onDidChange(() => {});
    b.reg.dispose();
    expect(b.fake.subscribeDispose).toHaveBeenCalledTimes(1);
  });

  it("allows at most 8 live subscriptions per artifact root", () => {
    const svc = new ArtifactFeedbackService();
    const fake = fakeProvider();
    svc.register(owner, v2(fake.provider));
    const offs = Array.from({ length: 9 }, () => svc.commentsFor(target)!.onDidChange(() => {}));
    expect(fake.subscribe).toHaveBeenCalledTimes(8);
    expect(warn).toHaveBeenCalled();
    offs.forEach((off) => off());
    expect(fake.subscribeDispose).toHaveBeenCalledTimes(8);
    // the slots are free again
    svc.commentsFor(target)!.onDidChange(() => {});
    expect(fake.subscribe).toHaveBeenCalledTimes(9);
  });
});

describe("hostile fixtures end to end through the client", () => {
  it("every junk snapshot fixture comes back as a rejected failure, never as data", async () => {
    const { cases } = load("junk-snapshots.json") as { cases: { name: string; patches: { path: string; value: any }[] }[] };
    for (const junk of cases.filter((c) => c.patches[0]!.path === "" || c.patches[0]!.path.split(".").length === 1)) {
      const snapshot = clone(load("snapshot.json"));
      let value: any = snapshot;
      const patch = junk.patches[0]!;
      if (patch.path === "") value = patch.value;
      else snapshot[patch.path] = patch.value;
      const { client } = setup({ list: vi.fn(async () => ok(value)) });
      expect(await client.list(), junk.name).toMatchObject({ status: "rejected", reason: "failed" });
      expect(client.cached).toBeNull();
    }
  });
});
