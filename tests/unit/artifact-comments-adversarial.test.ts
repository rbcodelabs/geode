/**
 * Adversarial QA for the G1 comments client, rebuild and registry (ADR 0006 Addendum 1, design note T1/T6/T10/T12).
 *
 * Tests named "FINDING Fn" use `it.fails`: they assert the behavior we want and are EXPECTED to fail against the
 * current source. They go green-in-CI today and flip to "unexpectedly passed" (a red run) when the source is fixed,
 * which is the signal to turn them into plain `it`. Everything else asserts behavior that holds today.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactFeedbackRequest, ArtifactFeedbackTarget } from "../../src/artifacts/feedback-contract";
import type { ArtifactCommentsChange, ArtifactCommentsProvider } from "../../src/artifacts/feedback-contract-v2";
import { ArtifactFeedbackService, createReadOnlyFeedbackView } from "../../src/renderer/artifacts/feedback-registry";
import { rebuildChange, rebuildResult, rebuildSnapshot } from "../../src/renderer/artifacts/comments-rebuild";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "artifact-feedback");
const load = (name: string): any => JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8"));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const target: ArtifactFeedbackTarget = { root: "/a", artifactId: "art", title: "Art", runtime: "static", vaultRead: false };
const owner = { pluginId: "design", displayName: "Design" };
const ID = "cmt_0123456789abcdef0123456789abcdef";
const ID2 = "cmt_fedcba9876543210fedcba9876543210";
const REQ = "req_00112233445566778899aabbccddeeff";
const STORE = "str_89abcdef0123456789abcdef01234567";
const ok = (value: unknown) => ({ status: "ok", value });
const hex32 = (n: number) => n.toString(16).padStart(32, "0");
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

function makeComment(i: number, over: Record<string, unknown> = {}): any {
  const c = clone(load("comment.json"));
  c.selectionId = `sel_${hex32(i + 1)}`;
  c.id = `cmt_${hex32(i + 1)}`;
  c.ordinal = i + 1;
  return Object.assign(c, over);
}
function makeSnapshot(revision: number, comments: any[] = [makeComment(0)], storeId = STORE): any {
  return { storeId, revision, health: "ok", notice: null, comments, foreignCount: 0 };
}

interface Fake {
  provider: ArtifactCommentsProvider;
  list: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  subscribeDispose: ReturnType<typeof vi.fn>;
  emit(change: unknown): void;
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
const v2 = (comments: unknown, over: Record<string, unknown> = {}): any =>
  ({ contractVersion: 2, submit: vi.fn(async () => ({ status: "accepted" })), comments, ...over });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); vi.useRealTimers(); });

function setup(over: Record<string, unknown> = {}, options: ConstructorParameters<typeof ArtifactFeedbackService>[0] = {}, tgt: ArtifactFeedbackTarget = target) {
  const frames: (() => void)[] = [];
  const svc = new ArtifactFeedbackService({
    scheduleFrame: (cb) => { frames.push(cb); return () => { const i = frames.indexOf(cb); if (i >= 0) frames.splice(i, 1); }; },
    ...options,
  });
  const fake = fakeProvider(over);
  const reg = svc.register(owner, v2(fake.provider));
  expect(reg.status).toBe("registered");
  const client = svc.commentsFor(tgt)!;
  const runFrame = async () => { frames.splice(0).forEach((frame) => frame()); await flush(); };
  return { svc, fake, reg, client, frames, runFrame };
}

const METHODS: [string, (c: any) => Promise<any>][] = [
  ["list", (c) => c.list()],
  ["get", (c) => c.get(ID)],
  ["save", (c) => c.save({ request: { contractVersion: 1, artifact: target, comment: "c", selection: load("selection.json"), screenshot: null, screenshotOmitted: "vault-read", stale: false, submittedAt: "2026-11-12T10:00:00.000Z" } as unknown as ArtifactFeedbackRequest })],
  ["update", (c) => c.update({ id: ID, expectedVersion: 3, change: { action: "resolve" } })],
  ["remove", (c) => c.remove({ id: ID, expectedVersion: 3 })],
  ["adopt", (c) => c.adopt({ ids: [ID] })],
  ["sendBatch", (c) => c.sendBatch({ requestId: REQ, ids: [ID, ID2], resend: false, anchorStates: {} })],
  ["reportAnchors", (c) => c.reportAnchors([{ id: ID, state: "exact" }])],
];

// ------------------------------------------------------------------------------------------------------------------
describe("junk provider output: shapes JSON cannot express", () => {
  it("a Proxy whose traps throw is a rejected failure, not a throw", async () => {
    const hostile = (trap: string) => new Proxy({}, { [trap]() { throw new Error(`trap ${trap}`); } } as ProxyHandler<object>);
    for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor", "get", "has"]) {
      const { client } = setup({ list: vi.fn(async () => hostile(trap)) });
      expect(await client.list(), trap).toMatchObject({ status: "rejected", reason: "failed" });
    }
  });

  it("a revoked Proxy as the result, as the snapshot value and as a comment is rejected", async () => {
    const revoked = () => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };
    for (const value of [revoked(), ok(revoked()), ok(makeSnapshot(1, [revoked()]))]) {
      const { client } = setup({ list: vi.fn(async () => value) });
      expect(await client.list()).toMatchObject({ status: "rejected", reason: "failed" });
    }
  });

  it("an accessor property is refused and never invoked", async () => {
    const getter = vi.fn(() => "open");
    const snap = makeSnapshot(1);
    Object.defineProperty(snap.comments[0], "status", { enumerable: true, get: getter });
    const { client } = setup({ list: vi.fn(async () => ok(snap)) });
    expect(await client.list()).toMatchObject({ status: "rejected", reason: "failed" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("an inherited status/value cannot satisfy the result envelope even if Object.prototype is polluted", () => {
    const proto = Object.prototype as any;
    try {
      proto.status = "ok";
      proto.value = makeSnapshot(1);
      expect(rebuildResult({}, rebuildSnapshot)).toBeNull();
      expect(rebuildResult({ status: "ok" }, rebuildSnapshot)).toBeNull();
    } finally {
      delete proto.status;
      delete proto.value;
    }
    expect(({} as any).status).toBeUndefined();
  });

  it("an inherited comment field (prototype pollution) does not fill a missing own field", () => {
    const proto = Object.prototype as any;
    const snap = makeSnapshot(1);
    delete snap.comments[0].text;
    try {
      proto.text = "polluted";
      expect(rebuildSnapshot(snap)).toBeNull();
    } finally {
      delete proto.text;
    }
  });

  it("null-prototype objects are accepted as plain data", () => {
    const withNullProto = (o: any): any => {
      const out = Object.assign(Object.create(null), o);
      out.comments = o.comments.map((c: any) => Object.assign(Object.create(null), c));
      return out;
    };
    expect(rebuildSnapshot(withNullProto(makeSnapshot(3)))).toEqual(makeSnapshot(3));
  });

  it("class instances, Maps, Dates and arrays-as-objects are refused where a plain object is required", () => {
    class Snap { storeId = STORE; revision = 1; health = "ok"; notice = null; comments = []; foreignCount = 0; }
    expect(rebuildSnapshot(new Snap())).toBeNull();
    expect(rebuildSnapshot(new Map())).toBeNull();
    const withDate = makeSnapshot(1);
    withDate.comments[0].createdAt = new Date();
    expect(rebuildSnapshot(withDate)).toBeNull();
    const asArray = Object.assign([], makeSnapshot(1));
    expect(rebuildSnapshot(asArray)).toBeNull();
  });

  it("sparse arrays, array holes and a huge sparse length are rejected without scanning", () => {
    const holes = makeSnapshot(1);
    holes.comments = new Array(3);
    expect(rebuildSnapshot(holes)).toBeNull();
    const huge = makeSnapshot(1);
    huge.comments = new Array(1_000_000_000);
    const started = performance.now();
    expect(rebuildSnapshot(huge)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
    const anchors = makeSnapshot(1);
    anchors.comments[0].anchor.selectorAlternates = new Array(3);
    expect(rebuildSnapshot(anchors)).toBeNull();
  });

  it("an array with an extra non-index property still rebuilds from the indexed elements only", () => {
    const snap = makeSnapshot(1);
    (snap.comments as any).extra = "ignored";
    expect(rebuildSnapshot(snap)).toEqual(makeSnapshot(1));
  });

  it("unknown keys are dropped, and hostile keys are refused at every depth that is read", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      for (const pathToHolder of [[], ["comments", "0"], ["comments", "0", "anchor"], ["comments", "0", "anchor", "textAnchor"], ["comments", "0", "send"]]) {
        const snap = JSON.parse(JSON.stringify(makeSnapshot(1)).replace(/^\{/, "{"));
        let holder = snap;
        for (const p of pathToHolder) holder = holder[p];
        Object.defineProperty(holder, key, { value: 1, enumerable: true, configurable: true, writable: true });
        expect(rebuildSnapshot(snap), `${key} at ${pathToHolder.join(".") || "root"}`).toBeNull();
      }
    }
    expect(({} as any).polluted).toBeUndefined();
  });

  it("a JSON-parsed __proto__ own key neither pollutes Object.prototype nor survives", () => {
    const raw = JSON.parse(`{"storeId":"${STORE}","revision":1,"health":"ok","notice":null,"foreignCount":0,"comments":[],"__proto__":{"polluted":true}}`);
    expect(rebuildSnapshot(raw)).toBeNull();
    expect(({} as any).polluted).toBeUndefined();
  });

  it("number edge cases: -0, 2^53, 1e308 magnitudes and string numerals are handled", () => {
    const rect = (v: unknown) => { const s = makeSnapshot(1); s.comments[0].anchor.lastRect = { x: v, y: 0, width: 1, height: 1 }; return rebuildSnapshot(s); };
    expect(rect(-0)).not.toBeNull();
    expect(rect(1e308)).toBeNull();
    expect(rect("1")).toBeNull();
    expect(rect(Number.NaN)).toBeNull();
    const ordinal = (v: unknown) => rebuildSnapshot(makeSnapshot(1, [makeComment(0, { ordinal: v })]));
    expect(ordinal(0)).toBeNull();
    expect(ordinal(2 ** 53)).toBeNull();
    expect(ordinal(Number.MAX_SAFE_INTEGER)).not.toBeNull();
    expect(ordinal(1.0000001)).toBeNull();
  });

  it("dates: lookalike and out-of-range ISO strings are rejected", () => {
    for (const bad of ["2026-13-01T00:00:00.000Z", "2026-11-12", "2026-11-12T10:00:00+00:00", "2026-11-12T25:00:00.000Z", "2026-11-12T10:00:00.0000Z", " 2026-11-12T10:00:00.000Z", "2026-11-12T10:00:00.000Z\n"]) {
      expect(rebuildSnapshot(makeSnapshot(1, [makeComment(0, { createdAt: bad })])), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("junk provider output: huge payloads", () => {
  it("20 MB of text, selector or storeId is rejected quickly without being copied into the result", () => {
    const big = "x".repeat(20_000_000);
    const started = performance.now();
    expect(rebuildSnapshot(makeSnapshot(1, [makeComment(0, { text: big })]))).toBeNull();
    const withSelector = makeSnapshot(1);
    withSelector.comments[0].anchor.selector = big;
    expect(rebuildSnapshot(withSelector)).toBeNull();
    expect(rebuildSnapshot({ ...makeSnapshot(1), storeId: big })).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("20 MB display strings (label, notice, message) are truncated to their caps, not rejected and not kept", () => {
    const big = `${"y\n".repeat(10_000_000)}`;
    const snap = makeSnapshot(1, [makeComment(0, { label: big })]);
    snap.notice = big;
    const started = performance.now();
    const rebuilt = rebuildSnapshot(snap)!;
    expect(performance.now() - started).toBeLessThan(3000);
    expect(rebuilt.comments[0]!.label).toHaveLength(120);
    expect(rebuilt.notice).toHaveLength(300);
    const rejected = rebuildResult({ status: "rejected", reason: "failed", message: big }, () => null) as any;
    expect(rejected.message).toHaveLength(500);
  });

  it("an object with 200,000 own keys is read by allowlist and does not blow up", () => {
    const snap = makeSnapshot(1);
    for (let i = 0; i < 200_000; i += 1) snap.comments[0][`k${i}`] = i;
    const started = performance.now();
    expect(rebuildSnapshot(snap)).toEqual(makeSnapshot(1));
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("deep nesting inside unread fields is never traversed", () => {
    let deep: any = {};
    const root = deep;
    for (let i = 0; i < 100_000; i += 1) { deep.n = {}; deep = deep.n; }
    const snap = makeSnapshot(1);
    snap.comments[0].unknown = root;
    snap.unknownTop = root;
    expect(rebuildSnapshot(snap)).toEqual(makeSnapshot(1));
  });

  it("201 comments are truncated to 200 and 20,001 are still handled without scanning them all", () => {
    const comments = Array.from({ length: 201 }, (_, i) => makeComment(i));
    expect(rebuildSnapshot(makeSnapshot(1, comments))!.comments).toHaveLength(200);
    const many = Array.from({ length: 20_001 }, () => makeComment(0));
    const started = performance.now();
    expect(rebuildSnapshot(makeSnapshot(1, many))).toBeNull();
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("OBSERVATION: truncation keeps the first 200 in provider order, so a descending provider loses its LOWEST ordinals", () => {
    const comments = Array.from({ length: 250 }, (_, i) => makeComment(249 - i));
    const kept = rebuildSnapshot(makeSnapshot(1, comments))!.comments.map((c) => c.ordinal);
    expect(kept).toHaveLength(200);
    expect(kept[0]).toBe(50);
    expect(kept[199]).toBe(249);
  });

  it("a change event with 201 ids or 10,000 ids is rejected; 'all' and 200 ids are fine", () => {
    const ev = (ids: unknown) => rebuildChange({ storeId: STORE, revision: 1, reason: "local", ids });
    expect(ev(Array.from({ length: 201 }, (_, i) => `cmt_${hex32(i)}`))).toBeNull();
    expect(ev(Array.from({ length: 10_000 }, (_, i) => `cmt_${hex32(i)}`))).toBeNull();
    expect(ev(Array.from({ length: 200 }, (_, i) => `cmt_${hex32(i)}`))).not.toBeNull();
    expect(ev("all")).not.toBeNull();
    expect(ev("ALL")).toBeNull();
    expect(ev(undefined)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("hanging, throwing and misbehaving providers, every method", () => {
  const behaviours: [string, () => unknown][] = [
    ["throws synchronously", () => { throw new Error("sync"); }],
    ["throws a non-Error", () => { throw undefined; }],
    ["rejects with undefined", () => Promise.reject(undefined)],
    ["rejects with a Symbol", () => Promise.reject(Symbol("x"))],
    ["returns undefined", () => undefined],
    ["returns a plain non-result", () => "ok"],
    ["returns a thenable whose then throws", () => ({ then() { throw new Error("then boom"); } })],
    ["returns a thenable that never calls back", () => ({ then() {} })],
    ["returns an ok result with a null value", () => Promise.resolve(ok(null))],
  ];
  for (const [method, call] of METHODS) {
    for (const [name, behave] of behaviours) {
      if (name.includes("never calls back")) continue; // covered by the timeout test below
      it(`${method}: provider ${name} -> rejected failed, no throw`, async () => {
        const { client } = setup({ [method]: vi.fn(behave) });
        await expect(call(client)).resolves.toMatchObject({ status: "rejected", reason: "failed" });
      });
    }
  }

  it("every method times out on a provider that never settles, and aborts its signal", async () => {
    vi.useFakeTimers();
    for (const [method, call] of METHODS) {
      const signals: AbortSignal[] = [];
      const { client } = setup({ [method]: vi.fn((..._args: any[]) => { signals.push(_args[_args.length - 1].signal); return new Promise(() => {}); }) });
      const pending = call(client);
      await vi.advanceTimersByTimeAsync(method === "sendBatch" ? 15_000 : 10_000);
      await expect(pending, method).resolves.toMatchObject({ status: "rejected", reason: "failed" });
      expect(signals[0]!.aborted, method).toBe(true);
    }
  });

  it("a thenable that resolves twice with different values settles with the first only", async () => {
    const { client } = setup({
      list: vi.fn(() => ({ then(resolve: (v: unknown) => void) { resolve(ok(makeSnapshot(1))); resolve(ok(makeSnapshot(99))); } })),
    });
    expect(await client.list()).toMatchObject({ status: "ok", value: { revision: 1 } });
  });

  it("a provider that tries to mutate the frozen target fails inside its own call and cannot change later calls", async () => {
    const seen: any[] = [];
    const { client, fake } = setup({
      list: vi.fn(async (t: any) => { seen.push(t); t.root = "/evil"; return ok(load("snapshot.json")); }),
    });
    expect(await client.list()).toMatchObject({ status: "rejected", reason: "failed" });
    expect(seen[0].root).toBe("/a");
    await client.list();
    expect(seen[1]).toBe(seen[0]);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(fake.list).toHaveBeenCalledTimes(2);
  });

  it("the target is an allowlisted copy: extra caller fields never reach the provider", () => {
    const frames: (() => void)[] = [];
    const svc = new ArtifactFeedbackService({ scheduleFrame: (cb) => { frames.push(cb); return () => {}; } });
    const fake = fakeProvider();
    svc.register(owner, v2(fake.provider));
    const client = svc.commentsFor({ ...target, secret: "token", runtime: "react" } as any)!;
    void client.list();
    const passed = fake.list.mock.calls[0]![0];
    expect(Object.keys(passed).sort()).toEqual(["artifactId", "root", "runtime", "title", "vaultRead"]);
    expect(passed.runtime).toBe("static");
  });

  it("a provider method removed or replaced after the client exists degrades to a rejected failure", async () => {
    const { client, fake } = setup();
    (fake.provider as any).list = undefined;
    (fake.provider as any).get = 42;
    expect(await client.list()).toMatchObject({ status: "rejected", reason: "failed" });
    expect(await client.get(ID)).toMatchObject({ status: "rejected", reason: "failed" });
  });

  it("a provider that answers a 200-comment list with 4000-unit texts still round trips under the budget", async () => {
    const comments = Array.from({ length: 200 }, (_, i) => makeComment(i, { text: "t".repeat(4000) }));
    const { client } = setup({ list: vi.fn(async () => ok(makeSnapshot(1, comments))) });
    const started = performance.now();
    const result = await client.list();
    expect(result).toMatchObject({ status: "ok" });
    expect((result as any).value.comments).toHaveLength(200);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it.fails("FINDING F1: a v2 handler whose `comments` getter throws is refused as invalid instead of making register throw", () => {
    const handler: any = { contractVersion: 2, submit: async () => ({ status: "accepted" }) };
    Object.defineProperty(handler, "comments", { get() { throw new Error("getter"); } });
    const svc = new ArtifactFeedbackService();
    let result: any;
    expect(() => { result = svc.register(owner, handler); }).not.toThrow();
    expect(result.status).toBe("invalid");
  });

  it.fails("FINDING F2: a `comments` getter that returns a valid provider at register and junk afterwards does not make commentsFor throw", () => {
    let reads = 0;
    const good = fakeProvider().provider;
    const handler: any = { contractVersion: 2, submit: async () => ({ status: "accepted" }) };
    Object.defineProperty(handler, "comments", { get() { reads += 1; return reads === 1 ? good : {}; } });
    const svc = new ArtifactFeedbackService();
    expect(svc.register(owner, handler).status).toBe("registered");
    expect(() => svc.commentsFor(target)).not.toThrow();
  });

  it.fails("FINDING F3: a provider whose capabilities.textEdit getter throws on the second read does not make commentsFor throw", () => {
    let reads = 0;
    const fake = fakeProvider();
    const capabilities: any = { pins: true, batchSend: true };
    Object.defineProperty(capabilities, "textEdit", { get() { reads += 1; if (reads > 1) throw new Error("flip"); return false; } });
    (fake.provider as any).capabilities = capabilities;
    const svc = new ArtifactFeedbackService();
    expect(svc.register(owner, v2(fake.provider)).status).toBe("registered");
    expect(() => svc.commentsFor(target)).not.toThrow();
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("identity: derived ids, mismatches and duplicates", () => {
  const detailFor = (id: string, selectionId: string) => ({ comment: { ...makeComment(0), id, selectionId }, selection: null });

  it("get: a detail for a different comment than the one asked is rejected", async () => {
    const { client } = setup({ get: vi.fn(async () => ok({ comment: makeComment(7), selection: null })) });
    expect(await client.get(ID)).toMatchObject({ status: "rejected", reason: "failed" });
  });

  it("get: a stored selection that belongs to another pin is rejected", async () => {
    const detail = { comment: load("comment.json"), selection: { ...load("selection.json"), selectionId: `sel_${hex32(9)}` } };
    const { client } = setup({ get: vi.fn(async () => ok(detail)) });
    expect(await client.get(ID)).toMatchObject({ status: "rejected", reason: "failed" });
  });

  it("an invented comment id (not cmt_ + the selection id digits) poisons the whole snapshot, detail and save", async () => {
    const invented = makeComment(0, { id: ID2 });
    expect(rebuildSnapshot(makeSnapshot(1, [makeComment(1), invented]))).toBeNull();
    const { client } = setup({
      get: vi.fn(async () => ok(detailFor(ID2, "sel_0123456789abcdef0123456789abcdef"))),
      save: vi.fn(async () => ok({ comment: invented, created: true })),
    });
    expect(await client.get(ID2)).toMatchObject({ status: "rejected", reason: "failed" });
    expect(await METHODS[2]![1](client)).toMatchObject({ status: "rejected", reason: "failed" });
  });

  it("id derivation is exact: uppercase hex, a longer id and a mixed-case prefix do not pass", () => {
    for (const bad of [{ id: ID.toUpperCase() }, { id: `${ID}0` }, { id: `CMT_${ID.slice(4)}` }, { selectionId: `SEL_${hex32(1)}` }, { selectionId: `sel_${hex32(1)}\n` }]) {
      expect(rebuildSnapshot(makeSnapshot(1, [makeComment(0, bad)])), JSON.stringify(bad)).toBeNull();
    }
  });

  it("save: a result for a different selection than the one saved is rejected", async () => {
    const { client } = setup({ save: vi.fn(async () => ok({ comment: makeComment(3), created: true })) });
    expect(await METHODS[2]![1](client)).toMatchObject({ status: "rejected", reason: "failed" });
  });

  it("update: a result for a different comment is rejected; remove: a different id is rejected", async () => {
    const a = setup({ update: vi.fn(async () => ok(makeComment(4))) });
    expect(await a.client.update({ id: ID, expectedVersion: 3, change: { action: "resolve" } })).toMatchObject({ status: "rejected", reason: "failed" });
    const b = setup({ remove: vi.fn(async () => ok({ id: ID2 })) });
    expect(await b.client.remove({ id: ID, expectedVersion: 3 })).toMatchObject({ status: "rejected", reason: "failed" });
  });

  it("adopt: ids that were not asked for are rejected, a subset is accepted", async () => {
    const extra = setup({ adopt: vi.fn(async () => ok({ adopted: [ID, ID2] })) });
    expect(await extra.client.adopt({ ids: [ID] })).toMatchObject({ status: "rejected", reason: "failed" });
    const subset = setup({ adopt: vi.fn(async () => ok({ adopted: [] })) });
    expect(await subset.client.adopt({ ids: [ID] })).toEqual({ status: "ok", value: { adopted: [] } });
  });

  it("sendBatch: a wrong requestId, an unasked id, a duplicated item, reason on a non-skipped item are all rejected", async () => {
    const bad = (mutate: (r: any) => void) => {
      const report = clone(load("batch-report.json"));
      mutate(report);
      return setup({ sendBatch: vi.fn(async () => ok(report)) }).client.sendBatch({ requestId: REQ, ids: [ID, ID2, "cmt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], resend: false, anchorStates: {} });
    };
    expect(await bad((r) => { r.requestId = "req_ffffffffffffffffffffffffffffffff"; })).toMatchObject({ status: "rejected" });
    expect(await bad((r) => { r.items[0].id = `cmt_${hex32(77)}`; })).toMatchObject({ status: "rejected" });
    expect(await bad((r) => { r.items[1].id = r.items[0].id; })).toMatchObject({ status: "rejected" });
    expect(await bad((r) => { r.items[0].reason = "foreign"; })).toMatchObject({ status: "rejected" });
    expect(await bad((r) => { delete r.items[1].reason; })).toMatchObject({ status: "rejected" });
    expect(await bad(() => {})).toMatchObject({ status: "ok" });
  });

  it("duplicate ordinals or duplicate ids reject the whole snapshot; gaps and unordered input are fine", () => {
    expect(rebuildSnapshot(makeSnapshot(1, [makeComment(0), makeComment(1, { ordinal: 1 })]))).toBeNull();
    expect(rebuildSnapshot(makeSnapshot(1, [makeComment(0), makeComment(0)]))).toBeNull();
    const sorted = rebuildSnapshot(makeSnapshot(1, [makeComment(9), makeComment(2), makeComment(40)]))!;
    expect(sorted.comments.map((c) => c.ordinal)).toEqual([3, 10, 41]);
  });

  it("a rejected result cannot smuggle a value, and an ok result cannot smuggle a reason", () => {
    expect(rebuildResult({ status: "rejected", reason: "failed", message: "m", value: makeSnapshot(1) }, rebuildSnapshot)).toEqual({ status: "rejected", reason: "failed", message: "m" });
    expect(rebuildResult({ status: "ok", value: makeSnapshot(1), reason: "failed" }, rebuildSnapshot)).toEqual({ status: "ok", value: makeSnapshot(1) });
    expect(rebuildResult({ status: "OK", value: makeSnapshot(1) }, rebuildSnapshot)).toBeNull();
    expect(rebuildResult({ status: "rejected", reason: "__proto__", message: "m" }, rebuildSnapshot)).toBeNull();
    expect(rebuildResult({ status: "rejected", reason: "toString", message: "m" }, rebuildSnapshot)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("input validation: what the embedder sends cannot be altered or abused afterwards", () => {
  it("update input is copied: mutating it after the call does not change what the provider received", async () => {
    const { client, fake } = setup();
    const input: any = { id: ID, expectedVersion: 3, change: { text: "first" } };
    const pending = client.update(input);
    input.change.text = "second";
    input.id = "cmt_00000000000000000000000000000000";
    await pending;
    expect((fake.provider.update as any).mock.calls[0][1]).toEqual({ id: ID, expectedVersion: 3, change: { text: "first" } });
    expect(Object.isFrozen((fake.provider.update as any).mock.calls[0][1])).toBe(true);
  });

  it("sendBatch ids and anchorStates are copied and frozen; a JSON __proto__ key is refused", async () => {
    const { client, fake } = setup();
    const ids = [ID, ID2];
    const states: any = { [ID]: "exact" };
    const pending = client.sendBatch({ requestId: REQ, ids, resend: false, anchorStates: states });
    ids.length = 0;
    states[ID] = "detached";
    await pending;
    expect((fake.provider.sendBatch as any).mock.calls[0][1]).toEqual({ requestId: REQ, ids: [ID, ID2], resend: false, anchorStates: { [ID]: "exact" } });
    const proto = JSON.parse(`{"__proto__":"exact"}`);
    expect(await client.sendBatch({ requestId: REQ, ids: [ID], resend: false, anchorStates: proto })).toMatchObject({ status: "rejected", reason: "invalid" });
    const classy = Object.assign(Object.create({ inherited: "exact" }), {});
    expect(await client.sendBatch({ requestId: REQ, ids: [ID], resend: false, anchorStates: classy })).toMatchObject({ status: "rejected", reason: "invalid" });
  });

  it("numbers that look like versions but are not: NaN, Infinity, 2^53, strings, booleans", async () => {
    const { client, fake } = setup();
    for (const v of [Number.NaN, Infinity, -1, 2 ** 53, "3", true, null, undefined]) {
      expect(await client.remove({ id: ID, expectedVersion: v as any }), String(v)).toMatchObject({ status: "rejected", reason: "invalid" });
    }
    expect((fake.provider.remove as any).mock.calls).toHaveLength(0);
  });

  it("text boundaries: 4000 passes, 4001 and the empty string do not, an astral pair counts as two units", async () => {
    const { client } = setup();
    const send = (text: string) => client.update({ id: ID, expectedVersion: 1, change: { text } });
    expect(await send("a".repeat(4000))).toMatchObject({ status: "ok" });
    expect(await send("a".repeat(4001))).toMatchObject({ status: "rejected", reason: "invalid" });
    expect(await send("")).toMatchObject({ status: "rejected", reason: "invalid" });
    expect(await send("\u{1F600}".repeat(2000))).toMatchObject({ status: "ok" });
    expect(await send("\u{1F600}".repeat(2001))).toMatchObject({ status: "rejected", reason: "invalid" });
  });

  it("an update carrying both an action and text sends only the action (text is never smuggled alongside it)", async () => {
    const { client, fake } = setup();
    await client.update({ id: ID, expectedVersion: 1, change: { action: "resolve", text: "extra" } as any });
    expect((fake.provider.update as any).mock.calls[0][1].change).toEqual({ action: "resolve" });
  });

  it("reportAnchors: healed anchors are rebuilt (extra keys dropped, infinite rects and 513-unit selectors refused)", async () => {
    const { client, fake } = setup();
    const healed = (over: Record<string, unknown>) => ({ selector: "a", selectorAlternates: [], textAnchor: { tag: "b", text: "x" }, landmark: null, lastRect: null, ...over });
    await client.reportAnchors([{ id: ID, state: "moved", healed: { ...healed({}), evil: 1 } as any }]);
    expect((fake.provider.reportAnchors as any).mock.calls[0][1][0].healed).toEqual(healed({}));
    for (const bad of [healed({ lastRect: { x: Infinity, y: 0, width: 1, height: 1 } }), healed({ selector: "s".repeat(513) }), healed({ selectorAlternates: ["a", "b", "c", "d"] }), healed({ textAnchor: { tag: "B!", text: "" } })]) {
      expect(await client.reportAnchors([{ id: ID, state: "moved", healed: bad as any }])).toMatchObject({ status: "rejected", reason: "invalid" });
    }
    expect(await client.reportAnchors([{ id: ID, state: "moved", healed: null as any }])).toMatchObject({ status: "rejected", reason: "invalid" });
  });

  it("reportAnchors result: applied above the 100 cap or negative is rejected", async () => {
    for (const applied of [101, -1, 1.5, "1"]) {
      const { client } = setup({ reportAnchors: vi.fn(async () => ok({ applied })) });
      expect(await client.reportAnchors([{ id: ID, state: "exact" }]), String(applied)).toMatchObject({ status: "rejected", reason: "failed" });
    }
  });

  it("save freezes the caller's request in place (same as v1 submit): documented, not copied", async () => {
    const { client } = setup();
    const request: any = { contractVersion: 1, artifact: target, comment: "c", selection: load("selection.json"), screenshot: new Uint8Array(8), screenshotOmitted: null, stale: false, submittedAt: "2026-11-12T10:00:00.000Z" };
    await client.save({ request });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.selection)).toBe(true);
  });

  it.fails("FINDING F4: save with a self-referencing or very deeply nested request resolves as rejected instead of throwing out of the client", async () => {
    const { client } = setup();
    const request: any = { selection: { selectionId: `sel_${hex32(1)}` } };
    request.self = request;
    await expect(Promise.resolve().then(() => client.save({ request }))).resolves.toMatchObject({ status: "rejected" });
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("abort and dispose races", () => {
  it("disposing mid-call settles unavailable, aborts the signal, and ignores the provider's late answer", async () => {
    let release!: (v: unknown) => void;
    let signal!: AbortSignal;
    const { client } = setup({ list: vi.fn((_t: unknown, ctx: any) => { signal = ctx.signal; return new Promise((r) => { release = r; }); }) });
    const pending = client.list();
    client.dispose();
    await expect(pending).resolves.toMatchObject({ status: "rejected", reason: "unavailable" });
    expect(signal.aborted).toBe(true);
    release(ok(load("snapshot.json")));
    await flush();
    expect(client.cached).toBeNull();
  });

  it("dispose is idempotent and every later call is unavailable without reaching the provider", async () => {
    const { client, fake } = setup();
    client.dispose();
    client.dispose();
    for (const [name, call] of METHODS) expect(await call(client), name).toMatchObject({ status: "rejected", reason: "unavailable" });
    for (const m of ["list", "get", "save", "update", "remove", "adopt", "sendBatch", "reportAnchors"] as const) expect((fake.provider[m] as any).mock.calls, m).toHaveLength(0);
    const off = client.onDidChange(() => {});
    expect(typeof off).toBe("function");
    expect(fake.subscribe).not.toHaveBeenCalled();
  });

  it("unregistering the handler kills an old client for good even after the same plugin registers a new handler", async () => {
    const { svc, reg, client } = setup();
    reg.dispose();
    const second = fakeProvider();
    expect(svc.register(owner, v2(second.provider)).status).toBe("registered");
    expect(await client.list()).toMatchObject({ status: "rejected", reason: "unavailable" });
    expect(second.list).not.toHaveBeenCalled();
    const fresh = svc.commentsFor(target)!;
    expect(await fresh.list()).toMatchObject({ status: "ok" });
  });

  it("the handler's own unregister message says the comment may have arrived", async () => {
    const { reg, client } = setup({ sendBatch: vi.fn(() => new Promise(() => {})) });
    const pending = client.sendBatch({ requestId: REQ, ids: [ID], resend: false, anchorStates: {} });
    reg.dispose();
    const result: any = await pending;
    expect(result.reason).toBe("unavailable");
    expect(result.message).toMatch(/Check the thread/);
  });

  it("timeout then dispose, and dispose then timeout, settle exactly once", async () => {
    vi.useFakeTimers();
    const hang = () => new Promise(() => {});
    const a = setup({ list: vi.fn(hang) });
    const pa = a.client.list();
    await vi.advanceTimersByTimeAsync(10_000);
    a.client.dispose();
    await expect(pa).resolves.toMatchObject({ status: "rejected", reason: "failed" });
    const b = setup({ list: vi.fn(hang) });
    const pb = b.client.list();
    b.client.dispose();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pb).resolves.toMatchObject({ status: "rejected", reason: "unavailable" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposing from inside a change listener mid-refresh does not throw, schedules nothing and disposes the subscription once", async () => {
    const { client, fake, runFrame, frames } = setup();
    const seen: string[] = [];
    client.onDidChange(() => { seen.push("a"); client.dispose(); });
    client.onDidChange(() => { seen.push("b"); });
    fake.emit(load("change.json"));
    await runFrame();
    expect(seen[0]).toBe("a");
    expect(fake.subscribeDispose).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
    fake.emit({ ...load("change.json"), revision: 99 });
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(1);
  });

  it("disposing while the refresh's list is in flight never notifies listeners afterwards", async () => {
    let release!: (v: unknown) => void;
    const { client, fake, runFrame } = setup({ list: vi.fn(() => new Promise((r) => { release = r; })) });
    const listener = vi.fn();
    client.onDidChange(listener);
    fake.emit(load("change.json"));
    await runFrame();
    client.dispose();
    release(ok(load("snapshot.json")));
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribe then re-subscribe in one tick disposes the old subscription once and opens exactly one new one", async () => {
    const { client, fake, frames } = setup();
    const off = client.onDidChange(() => {});
    fake.emit(load("change.json"));
    expect(frames).toHaveLength(1);
    off();
    expect(frames).toHaveLength(0);
    expect(fake.subscribeDispose).toHaveBeenCalledTimes(1);
    client.onDidChange(() => {});
    expect(fake.subscribe).toHaveBeenCalledTimes(2);
  });

  it("calling an unsubscribe function twice does not close another listener's subscription", () => {
    const { client, fake } = setup();
    const offA = client.onDidChange(() => {});
    client.onDidChange(() => {});
    offA();
    offA();
    expect(fake.subscribeDispose).not.toHaveBeenCalled();
  });

  it("a provider listener held by a plugin after dispose is inert, even with a valid newer revision", async () => {
    const { client, fake, runFrame } = setup();
    client.onDidChange(() => {});
    client.dispose();
    fake.emit({ ...load("change.json"), revision: 500 });
    await runFrame();
    expect(fake.list).not.toHaveBeenCalled();
  });

  it("an abort listener registered by the provider sees the abort when the client times out, not before", async () => {
    vi.useFakeTimers();
    const onAbort = vi.fn();
    const { client } = setup({ list: vi.fn((_t: unknown, ctx: any) => { ctx.signal.addEventListener("abort", onAbort); return new Promise(() => {}); }) });
    const pending = client.list();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(onAbort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it("a successful call never aborts its signal (a provider doing follow-up work keeps running)", async () => {
    let signal!: AbortSignal;
    const { client } = setup({ list: vi.fn(async (_t: unknown, ctx: any) => { signal = ctx.signal; return ok(load("snapshot.json")); }) });
    await client.list();
    expect(signal.aborted).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("change-event floods and refresh ordering", () => {
  it("5,000 events carrying 200 ids each in one burst cost one list and finish quickly", async () => {
    const { client, fake, runFrame } = setup();
    client.onDidChange(() => {});
    const ids = Array.from({ length: 200 }, (_, i) => `cmt_${hex32(i)}`);
    const started = performance.now();
    for (let r = 8; r < 5008; r += 1) fake.emit({ storeId: STORE, revision: r, reason: "external", ids });
    expect(performance.now() - started).toBeLessThan(5000);
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(1);
  });

  it("a burst of malformed events schedules no work and does not throw", async () => {
    const { client, fake, frames } = setup();
    client.onDidChange(() => {});
    const junk = [null, undefined, 1, "x", [], {}, { storeId: STORE }, { storeId: STORE, revision: -1, reason: "local", ids: "all" }, { storeId: STORE, revision: 1, reason: "bogus", ids: "all" }, new Proxy({}, { ownKeys() { throw new Error("x"); } })];
    const started = performance.now();
    for (let i = 0; i < 2000; i += 1) expect(() => fake.emit(junk[i % junk.length])).not.toThrow();
    expect(performance.now() - started).toBeLessThan(5000);
    expect(frames).toHaveLength(0);
  });

  it("events that keep arriving while lists fail cause at most one list per frame, never a tight loop", async () => {
    const { client, fake, runFrame, frames } = setup({ list: vi.fn(async () => { throw new Error("down"); }) });
    const results: string[] = [];
    client.onDidChange((r) => results.push(r.status));
    for (let frame = 0; frame < 25; frame += 1) {
      for (let i = 0; i < 40; i += 1) fake.emit({ storeId: STORE, revision: 100 + frame * 40 + i, reason: "local", ids: "all" });
      await runFrame();
    }
    expect(fake.list).toHaveBeenCalledTimes(25);
    expect(results).toEqual(Array(25).fill("rejected"));
    expect(frames).toHaveLength(0);
  });

  it("events alternating between store ids still coalesce to one list per frame", async () => {
    const { client, fake, runFrame } = setup();
    client.onDidChange(() => {});
    for (let i = 0; i < 500; i += 1) fake.emit({ storeId: i % 2 ? "str_a" : "str_b", revision: i % 7, reason: "recovered", ids: "all" });
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(1);
  });

  it("revision going backwards inside one store is ignored once a newer snapshot is cached", async () => {
    const { client, fake, runFrame } = setup({ list: vi.fn(async () => ok(makeSnapshot(50))) });
    client.onDidChange(() => {});
    await client.list();
    fake.emit({ storeId: STORE, revision: 49, reason: "external", ids: "all" });
    fake.emit({ storeId: STORE, revision: 50, reason: "external", ids: "all" });
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(1);
    fake.emit({ storeId: STORE, revision: 51, reason: "external", ids: "all" });
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(2);
  });

  it("OBSERVATION: a failed refresh with newer events behind it is not retried until the next event", async () => {
    let call = 0;
    const { client, fake, runFrame } = setup({ list: vi.fn(async () => { call += 1; if (call === 1) throw new Error("once"); return ok(makeSnapshot(60)); }) });
    client.onDidChange(() => {});
    fake.emit({ storeId: STORE, revision: 10, reason: "external", ids: "all" });
    await runFrame();
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(1);
    expect(client.cached).toBeNull();
  });

  it.fails("FINDING F5: concurrent lists that finish out of order never hand a caller an older snapshot than the cache holds", async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    const { client } = setup({ list: vi.fn(() => new Promise((r) => { resolvers.push(r); })) });
    const first = client.list();
    const second = client.list();
    resolvers[1]!(ok(makeSnapshot(9)));
    await second;
    resolvers[0]!(ok(makeSnapshot(4)));
    const late: any = await first;
    expect(client.cached!.revision).toBe(9);
    expect(late.status === "ok" ? late.value.revision : 9).toBe(9);
  });

  it.fails("FINDING F6: a refresh that returns an older revision of the same store does not notify listeners with that older snapshot", async () => {
    let call = 0;
    const { client, fake, runFrame } = setup({ list: vi.fn(async () => ok(makeSnapshot(++call === 1 ? 20 : 12))) });
    const received: number[] = [];
    client.onDidChange((r) => { if (r.status === "ok") received.push(r.value.revision); });
    await client.list();
    fake.emit({ storeId: STORE, revision: 21, reason: "external", ids: "all" });
    await runFrame();
    expect(client.cached!.revision).toBe(20);
    expect(received.every((rev) => rev >= 20)).toBe(true);
  });

  it("a different storeId resets the cache even when its revision is lower", async () => {
    let call = 0;
    const { client } = setup({ list: vi.fn(async () => ok(call++ === 0 ? makeSnapshot(90) : makeSnapshot(2, [makeComment(0)], "str_new"))) });
    await client.list();
    await client.list();
    expect(client.cached).toMatchObject({ storeId: "str_new", revision: 2 });
  });

  it.fails("FINDING F7: a provider that emits a change synchronously inside subscribe() still gets a refresh", async () => {
    const frames: (() => void)[] = [];
    const svc = new ArtifactFeedbackService({ scheduleFrame: (cb) => { frames.push(cb); return () => {}; } });
    const fake = fakeProvider({
      subscribe: vi.fn((_t: unknown, l: (c: unknown) => void) => { l(load("change.json")); return { dispose() {} }; }),
    });
    svc.register(owner, v2(fake.provider));
    const client = svc.commentsFor(target)!;
    client.onDidChange(() => {});
    frames.splice(0).forEach((f) => f());
    await flush();
    expect(fake.list).toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("subscription cap and slot accounting", () => {
  function many(n: number, over: Record<string, unknown> = {}, tgt: ArtifactFeedbackTarget = target) {
    const frames: (() => void)[] = [];
    const svc = new ArtifactFeedbackService({ scheduleFrame: (cb) => { frames.push(cb); return () => {}; } });
    const fake = fakeProvider(over);
    const reg = svc.register(owner, v2(fake.provider));
    const clients = Array.from({ length: n }, () => svc.commentsFor(tgt)!);
    return { svc, fake, reg, clients, frames };
  }

  it("the 9th subscriber gets a warning and no provider subscription; the first 8 are unaffected", () => {
    const { fake, clients } = many(9);
    clients.forEach((c) => c.onDidChange(() => {}));
    expect(fake.subscribe).toHaveBeenCalledTimes(8);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("more than 8 subscriptions"))).toBe(true);
  });

  it("two listeners on one client use one slot", () => {
    const { fake, clients } = many(8);
    const extra = clients[0]!;
    extra.onDidChange(() => {});
    extra.onDidChange(() => {});
    clients.slice(1).forEach((c) => c.onDidChange(() => {}));
    expect(fake.subscribe).toHaveBeenCalledTimes(8);
  });

  it("slots are per artifact root", () => {
    const frames: (() => void)[] = [];
    const svc = new ArtifactFeedbackService({ scheduleFrame: (cb) => { frames.push(cb); return () => {}; } });
    const fake = fakeProvider();
    svc.register(owner, v2(fake.provider));
    for (let i = 0; i < 8; i += 1) svc.commentsFor(target)!.onDidChange(() => {});
    for (let i = 0; i < 8; i += 1) svc.commentsFor({ ...target, root: "/b" })!.onDidChange(() => {});
    expect(fake.subscribe).toHaveBeenCalledTimes(16);
  });

  it("subscribe throwing, returning junk, or dispose throwing never leaks a slot over 100 cycles", () => {
    const behaviours: (() => unknown)[] = [() => { throw new Error("no"); }, () => null, () => ({}), () => ({ dispose: 5 }), () => ({ dispose() { throw new Error("dispose"); } })];
    for (const behave of behaviours) {
      const { svc, fake } = many(0, { subscribe: vi.fn(behave) });
      for (let i = 0; i < 100; i += 1) {
        const c = svc.commentsFor(target)!;
        const off = c.onDidChange(() => {});
        off();
        c.dispose();
      }
      // A well-behaved provider afterwards must still get all 8 slots under the same root.
      const good = fakeProvider();
      (fake.provider as any).subscribe = good.subscribe;
      for (let i = 0; i < 8; i += 1) svc.commentsFor(target)!.onDidChange(() => {});
      expect(good.subscribe, behave.toString()).toHaveBeenCalledTimes(8);
    }
  });

  it("disposing clients and unregistering the handler return every slot", () => {
    const { svc, fake, reg, clients } = many(8);
    clients.forEach((c) => c.onDidChange(() => {}));
    clients[0]!.dispose();
    clients[1]!.onDidChange(() => {})();
    reg.dispose();
    expect(fake.subscribeDispose).toHaveBeenCalledTimes(8);
    const again = fakeProvider();
    svc.register(owner, v2(again.provider));
    for (let i = 0; i < 8; i += 1) svc.commentsFor(target)!.onDidChange(() => {});
    expect(again.subscribe).toHaveBeenCalledTimes(8);
  });

  it("OBSERVATION: a client refused a slot stays silent after a slot frees, until it gains a new first listener", () => {
    const { fake, clients } = many(9);
    clients.forEach((c) => c.onDidChange(() => {}));
    clients[0]!.dispose();
    expect(fake.subscribe).toHaveBeenCalledTimes(8);
    const late = clients[8]!;
    late.onDidChange(() => {});
    expect(fake.subscribe).toHaveBeenCalledTimes(8 + 1);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("negotiation: v1 handler, v2 handler, version 3 and look-alikes", () => {
  const v1 = (over: Record<string, unknown> = {}): any => ({ contractVersion: 1, submit: async () => ({ status: "accepted" }), ...over });

  it("only the numbers 1 and 2 are accepted as versions", () => {
    const outcomes: Record<string, string> = {};
    for (const version of [0, -1, 3, 4, 1.5, 2.000001, Number.NaN, Infinity, "1", "2", "v2", [2], { valueOf: () => 2 }, null, undefined, true]) {
      const svc = new ArtifactFeedbackService();
      outcomes[String(version)] = svc.register(owner, v2(fakeProvider().provider, { contractVersion: version })).status;
    }
    for (const [version, status] of Object.entries(outcomes)) expect(status, version).toBe("unsupported-version");
  });

  it("a v1 handler that also carries a comments provider is still v1: Pin is never offered", () => {
    const svc = new ArtifactFeedbackService();
    expect(svc.register(owner, v1({ comments: fakeProvider().provider })).status).toBe("registered");
    expect(svc.commentsFor(target)).toBeNull();
    expect(svc.describeRoute(target)).toEqual({ displayName: "Design", contractVersion: 1 });
  });

  it("v2 without a usable provider is invalid for each missing or broken piece, and nothing is registered", () => {
    const base = fakeProvider().provider as any;
    const without = (key: string) => ({ ...base, [key]: undefined });
    const cases: unknown[] = [undefined, null, 5, "p", {}, [], without("list"), without("get"), without("save"), without("update"), without("remove"), without("adopt"), without("subscribe"), without("sendBatch"),
      { ...base, capabilities: undefined }, { ...base, capabilities: null }, { ...base, capabilities: { pins: false, batchSend: true, textEdit: false } },
      { ...base, capabilities: { pins: true, batchSend: false, textEdit: false } }, { ...base, capabilities: { pins: true, batchSend: true } }, { ...base, capabilities: { pins: true, batchSend: true, textEdit: "no" } },
      { ...base, list: "nope" }];
    for (const comments of cases) {
      const svc = new ArtifactFeedbackService();
      expect(svc.register(owner, v2(comments)).status, JSON.stringify(comments)).toBe("invalid");
      expect(svc.describeRoute(target)).toBeNull();
    }
  });

  it("reportAnchors is optional and its absence does not make a v2 provider invalid", () => {
    const svc = new ArtifactFeedbackService();
    expect(svc.register(owner, v2({ ...(fakeProvider().provider as any), reportAnchors: undefined })).status).toBe("registered");
  });

  it("textEdit capability is true only when both text-edit methods exist", () => {
    const frames: (() => void)[] = [];
    const mk = (extra: Record<string, unknown>) => {
      const svc = new ArtifactFeedbackService({ scheduleFrame: (cb) => { frames.push(cb); return () => {}; } });
      svc.register(owner, v2({ ...(fakeProvider().provider as any), capabilities: { pins: true, batchSend: true, textEdit: true }, ...extra }));
      return svc.commentsFor(target)!.capabilities.textEdit;
    };
    expect(mk({})).toBe(false);
    expect(mk({ commitTextEdit: async () => ({}) })).toBe(false);
    expect(mk({ undoTextEdit: async () => ({}) })).toBe(false);
    expect(mk({ commitTextEdit: async () => ({}), undoTextEdit: async () => ({}) })).toBe(true);
  });

  it("the same plugin cannot hold a v1 and a v2 handler at once, and freeing the slot lets either version register", () => {
    const svc = new ArtifactFeedbackService();
    const first = svc.register(owner, v1());
    expect(svc.register(owner, v2(fakeProvider().provider)).status).toBe("conflict");
    first.dispose();
    const second = svc.register(owner, v2(fakeProvider().provider));
    expect(second.status).toBe("registered");
    second.dispose();
    expect(svc.register(owner, v1()).status).toBe("registered");
  });

  it("a throwing or non-true canHandle on a v2 handler yields no client and no throw; a v1 behind it still routes", () => {
    const svc = new ArtifactFeedbackService();
    svc.register(owner, v2(fakeProvider().provider, { canHandle: () => { throw new Error("x"); } }));
    expect(() => svc.commentsFor(target)).not.toThrow();
    expect(svc.commentsFor(target)).toBeNull();
    svc.register({ pluginId: "o", displayName: "O" }, v1({ canHandle: () => "yes" }));
    expect(svc.describeRoute(target)).toBeNull();
    svc.register({ pluginId: "p", displayName: "P" }, v1());
    expect(svc.describeRoute(target)).toEqual({ displayName: "P", contractVersion: 1 });
  });

  it("v1 submit on a v2 handler is untouched by the comments client: Send still works while comments hang", async () => {
    vi.useFakeTimers();
    const svc = new ArtifactFeedbackService();
    const submit = vi.fn(async () => ({ status: "accepted", message: "sent" }));
    svc.register(owner, v2(fakeProvider({ list: () => new Promise(() => {}) }).provider, { submit }));
    const client = svc.commentsFor(target)!;
    void client.list();
    const outcome = await svc.submit(target, { contractVersion: 1, artifact: target, comment: "c", selection: load("selection.json"), screenshot: null, screenshotOmitted: "vault-read", stale: false, submittedAt: "2026-11-12T10:00:00.000Z" } as never);
    expect(outcome).toMatchObject({ status: "accepted", source: "handler" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("the plugin-facing view advertises [1, 2], is frozen, and exposes neither register nor commentsFor", () => {
    const view: any = createReadOnlyFeedbackView(new ArtifactFeedbackService());
    expect([...view.contractVersions]).toEqual([1, 2]);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.contractVersions)).toBe(true);
    for (const key of ["register", "submit", "commentsFor", "describeRoute", "describeHandler"]) expect(view[key], key).toBeUndefined();
    expect(() => { view.contractVersions.push(3); }).toThrow();
  });

  it("the service's own list of versions cannot be widened by a plugin through the view", () => {
    const svc = new ArtifactFeedbackService();
    const view: any = createReadOnlyFeedbackView(svc);
    try { view.contractVersions[0] = 9; } catch { /* frozen */ }
    expect([...svc.contractVersions]).toEqual([1, 2]);
  });
});
