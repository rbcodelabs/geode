/**
 * Second adversarial pass (after the G1 fix pass): probes of the new behavior. Tests named "FINDING Gn" use
 * `it.fails`: they assert the wanted behavior and are expected to fail against the current source.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactFeedbackTarget } from "../../src/artifacts/feedback-contract";
import type { ArtifactCommentsChange, ArtifactCommentsProvider } from "../../src/artifacts/feedback-contract-v2";
import { ArtifactFeedbackService } from "../../src/renderer/artifacts/feedback-registry";
import { rebuildDetail, rebuildSnapshot } from "../../src/renderer/artifacts/comments-rebuild";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "artifact-feedback");
const load = (name: string): any => JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8"));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const target: ArtifactFeedbackTarget = { root: "/a", artifactId: "art", title: "Art", runtime: "static", vaultRead: false };
const vaultTarget: ArtifactFeedbackTarget = { ...target, vaultRead: true };
const owner = { pluginId: "design", displayName: "Design" };
const ID = "cmt_0123456789abcdef0123456789abcdef";
const STORE = "str_89abcdef0123456789abcdef01234567";
const ok = (value: unknown) => ({ status: "ok", value });
const hex32 = (n: number) => n.toString(16).padStart(32, "0");
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

function makeComment(i: number, over: Record<string, unknown> = {}): any {
  const c = clone(load("comment.json"));
  c.selectionId = `sel_${hex32(i + 1)}`; c.id = `cmt_${hex32(i + 1)}`; c.ordinal = i + 1;
  return Object.assign(c, over);
}
const makeSnapshot = (revision: number, comments: any[] = [makeComment(0)], storeId = STORE): any =>
  ({ storeId, revision, health: "ok", notice: null, comments, foreignCount: 0 });
const redactedComment = (over: Record<string, unknown> = {}): any => {
  const c = makeComment(0, { redacted: true, hasScreenshot: false, ...over });
  c.anchor.textAnchor.text = "";
  return c;
};
const redactedSelection = (): any => {
  const s = clone(load("selection.json"));
  s.redacted = true; s.textAnchor.text = ""; s.a11y.name = null;
  return s;
};

function fakeProvider(over: Record<string, unknown> = {}) {
  let listener: ((change: ArtifactCommentsChange) => void) | null = null;
  const dispose = vi.fn();
  const list = vi.fn(async () => ok(load("snapshot.json")));
  const subscribe = vi.fn((_t: unknown, l: (change: ArtifactCommentsChange) => void) => { listener = l; return { dispose }; });
  const provider = {
    capabilities: { pins: true, batchSend: true, textEdit: false },
    list, subscribe,
    get: vi.fn(async () => ok(load("detail.json"))),
    save: vi.fn(async () => ok({ comment: load("comment.json"), created: true })),
    update: vi.fn(async () => ok(load("comment.json"))),
    remove: vi.fn(async () => ok({ id: ID })),
    adopt: vi.fn(async () => ok({ adopted: [ID] })),
    sendBatch: vi.fn(async () => ok(load("batch-report.json"))),
    ...over,
  } as unknown as ArtifactCommentsProvider;
  return { provider, list, subscribe, dispose, emit: (change: unknown) => listener?.(change as ArtifactCommentsChange) };
}
const v2 = (comments: unknown, over: Record<string, unknown> = {}): any => ({ contractVersion: 2, submit: async () => ({ status: "accepted" }), comments, ...over });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); vi.useRealTimers(); });

function setup(over: Record<string, unknown> = {}, options: ConstructorParameters<typeof ArtifactFeedbackService>[0] = {}, tgt: ArtifactFeedbackTarget = target) {
  const frames: (() => void)[] = [];
  const svc = new ArtifactFeedbackService({
    commentsMinRefreshMs: 0,
    scheduleFrame: (cb) => { frames.push(cb); return () => { const i = frames.indexOf(cb); if (i >= 0) frames.splice(i, 1); }; },
    ...options,
  });
  const fake = fakeProvider(over);
  const reg = svc.register(owner, v2(fake.provider));
  expect(reg.status).toBe("registered");
  const client = svc.commentsFor(tgt)!;
  expect(client).not.toBeNull();
  const runFrame = async () => { frames.splice(0).forEach((frame) => frame()); await flush(); };
  return { svc, fake, reg, client, frames, runFrame };
}
const change = (revision: number, extra: Record<string, unknown> = {}) => ({ storeId: STORE, revision, reason: "external", ids: "all", ...extra });

// ------------------------------------------------------------------------------------------------------------------
describe("A3 refresh interval", () => {
  it("two events in different frames inside 250 ms cost one list now and one more after the interval", async () => {
    vi.useFakeTimers();
    const { client, fake, runFrame } = setup({}, { commentsMinRefreshMs: 250 });
    client.onDidChange(() => {});
    fake.emit(change(100));
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(1);
    fake.emit(change(101));
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(2);
  });

  it("a flood across 100 frames inside one interval still produces a single pending refresh", async () => {
    vi.useFakeTimers();
    const { client, fake, runFrame } = setup({}, { commentsMinRefreshMs: 250 });
    client.onDidChange(() => {});
    fake.emit(change(100));
    await runFrame();
    for (let i = 0; i < 100; i += 1) { fake.emit(change(101 + i)); await runFrame(); await vi.advanceTimersByTimeAsync(1); }
    expect(fake.list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(2);
  });

  it("disposing, or dropping the last listener, while the interval timer is pending leaves no timer and no later list", async () => {
    vi.useFakeTimers();
    const a = setup({}, { commentsMinRefreshMs: 250 });
    a.client.onDidChange(() => {});
    a.fake.emit(change(100)); await a.runFrame();
    a.fake.emit(change(101)); await a.runFrame();
    a.client.dispose();
    await vi.advanceTimersByTimeAsync(1000); await a.runFrame();
    expect(a.fake.list).toHaveBeenCalledTimes(1);
    const b = setup({}, { commentsMinRefreshMs: 250 });
    const off = b.client.onDidChange(() => {});
    b.fake.emit(change(100)); await b.runFrame();
    b.fake.emit(change(101)); await b.runFrame();
    off();
    await vi.advanceTimersByTimeAsync(1000); await b.runFrame();
    expect(b.fake.list).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a failed refresh still obeys the interval (no retry storm against a failing provider)", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => { throw new Error("down"); });
    const { client, fake, runFrame } = setup({ list }, { commentsMinRefreshMs: 250 });
    client.onDidChange(() => {});
    for (let i = 0; i < 50; i += 1) { fake.emit(change(100 + i)); await runFrame(); await vi.advanceTimersByTimeAsync(10); }
    expect(list.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it.fails("FINDING G1: a system clock that jumps backwards does not delay change refreshes by the size of the jump", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
    const { client, fake, runFrame } = setup({}, { commentsMinRefreshMs: 250 });
    client.onDidChange(() => {});
    fake.emit(change(100));
    await runFrame();
    vi.setSystemTime(new Date("2026-11-12T11:00:00Z"));
    fake.emit(change(101));
    await runFrame();
    await vi.advanceTimersByTimeAsync(1000);
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(2);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("A8 malformed events as resync hints", () => {
  it("a malformed event with a plausible revision schedules exactly one coalesced list; 5,000 of them still one", async () => {
    const { client, fake, runFrame } = setup();
    client.onDidChange(() => {});
    for (let i = 0; i < 5000; i += 1) fake.emit({ storeId: "../bad", revision: 10 + i, reason: "x", ids: 5 });
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(1);
  });

  it("implausible revisions (float, negative, string, NaN, huge, getter, Proxy, array) schedule nothing and never invoke a getter", async () => {
    const { client, fake, frames } = setup();
    client.onDidChange(() => {});
    const getter = vi.fn(() => 5);
    const withGetter = Object.defineProperty({ storeId: "x" }, "revision", { enumerable: true, get: getter });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("trap"); }, ownKeys() { throw new Error("trap"); } });
    for (const raw of [{ revision: 1.5 }, { revision: -1 }, { revision: "7" }, { revision: Number.NaN }, { revision: 2 ** 53 }, { revision: null }, withGetter, proxy, [5], "5", 5, null, undefined]) {
      expect(() => fake.emit(raw)).not.toThrow();
    }
    expect(frames).toHaveLength(0);
    expect(getter).not.toHaveBeenCalled();
    expect(fake.list).not.toHaveBeenCalled();
  });

  it("a malformed event whose revision is not newer than the cache is ignored", async () => {
    const { client, fake, runFrame } = setup({ list: vi.fn(async () => ok(makeSnapshot(50))) });
    client.onDidChange(() => {});
    await client.list();
    fake.emit({ revision: 50, junk: true });
    fake.emit({ revision: 3, junk: true });
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(0);
    fake.emit({ revision: 51, junk: true });
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(0); // fake.list is the default spy; the override above is the one called
  });

  it("OBSERVATION: malformed events with a huge but safe revision keep one refresh per interval going for as long as they arrive", async () => {
    vi.useFakeTimers();
    const list = vi.fn(async () => ok(makeSnapshot(5)));
    const { client, fake, runFrame } = setup({ list }, { commentsMinRefreshMs: 250 });
    client.onDidChange(() => {});
    for (let t = 0; t < 40; t += 1) { fake.emit({ revision: Number.MAX_SAFE_INTEGER, junk: 1 }); await runFrame(); await vi.advanceTimersByTimeAsync(100); }
    expect(list.mock.calls.length).toBeGreaterThan(5);
    expect(list.mock.calls.length).toBeLessThanOrEqual(17); // 4 s of events, one per 250 ms
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("F7 events inside subscribe()", () => {
  it("a change emitted inside subscribe causes one refresh", async () => {
    const frames: (() => void)[] = [];
    const svc = new ArtifactFeedbackService({ commentsMinRefreshMs: 0, scheduleFrame: (cb) => { frames.push(cb); return () => {}; } });
    const fake = fakeProvider({ subscribe: vi.fn((_t: unknown, l: (c: unknown) => void) => { l(change(9)); l(change(10)); return { dispose() {} }; }) });
    svc.register(owner, v2(fake.provider));
    svc.commentsFor(target)!.onDidChange(() => {});
    frames.splice(0).forEach((f) => f());
    await flush();
    expect(fake.list).toHaveBeenCalledTimes(1);
  });

  it("a provider that emits inside subscribe and then throws, or returns junk, causes no refresh and frees the slot", async () => {
    for (const finish of [() => { throw new Error("late"); }, () => null, () => ({})]) {
      const frames: (() => void)[] = [];
      const svc = new ArtifactFeedbackService({ commentsMinRefreshMs: 0, scheduleFrame: (cb) => { frames.push(cb); return () => { const i = frames.indexOf(cb); if (i >= 0) frames.splice(i, 1); }; } });
      const fake = fakeProvider({ subscribe: vi.fn((_t: unknown, l: (c: unknown) => void) => { l(change(9)); return finish(); }) });
      svc.register(owner, v2(fake.provider));
      svc.commentsFor(target)!.onDidChange(() => {});
      frames.splice(0).forEach((f) => f());
      await flush();
      expect(fake.list).not.toHaveBeenCalled();
      expect(frames).toHaveLength(0);
      for (let i = 0; i < 8; i += 1) svc.commentsFor(target)!.onDidChange(() => {});
      expect((fake.provider.subscribe as any).mock.calls).toHaveLength(9);
    }
  });

  it("a provider whose subscribe re-enters the client (onDidChange inside subscribe) does not recurse or double-subscribe", () => {
    const frames: (() => void)[] = [];
    const svc = new ArtifactFeedbackService({ scheduleFrame: (cb) => { frames.push(cb); return () => {}; } });
    let client: any;
    const fake = fakeProvider({ subscribe: vi.fn(() => { client.onDidChange(() => {}); return { dispose() {} }; }) });
    svc.register(owner, v2(fake.provider));
    client = svc.commentsFor(target)!;
    expect(() => client.onDidChange(() => {})).not.toThrow();
    expect((fake.provider.subscribe as any).mock.calls).toHaveLength(1);
  });

  it.fails("FINDING G4: a provider whose subscribe disposes the client inside the call gets its returned subscription disposed (no leak)", () => {
    const svc = new ArtifactFeedbackService({ scheduleFrame: () => () => {} });
    let client: any;
    const dispose = vi.fn();
    const fake = fakeProvider({ subscribe: vi.fn(() => { client.dispose(); return { dispose }; }) });
    svc.register(owner, v2(fake.provider));
    client = svc.commentsFor(target)!;
    expect(() => client.onDidChange(() => {})).not.toThrow();
    // The client closed during subscribe: whatever subscribe returned must be disposed, and the slot freed.
    expect(dispose).toHaveBeenCalled();
    for (let i = 0; i < 8; i += 1) svc.commentsFor(target)!.onDidChange(() => {});
    expect((fake.provider.subscribe as any).mock.calls.length).toBe(9);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("F5/F6 never hand out or announce an older snapshot", () => {
  it("equal revision replaces, older does not, a new storeId always wins, and the older answer is the cached object itself", async () => {
    const answers = [makeSnapshot(9), makeSnapshot(4), makeSnapshot(9), makeSnapshot(1, [makeComment(0)], "str_other")];
    let i = 0;
    const { client } = setup({ list: vi.fn(async () => ok(answers[i++])) });
    const first: any = await client.list();
    const older: any = await client.list();
    expect(older.value).toBe(client.cached);
    expect(older.value.revision).toBe(9);
    expect(first.value.revision).toBe(9);
    await client.list();
    const other: any = await client.list();
    expect(other.value.storeId).toBe("str_other");
    expect(client.cached!.storeId).toBe("str_other");
  });

  it("listeners hear the cached snapshot, not the older refresh answer", async () => {
    let n = 0;
    const { client, fake, runFrame } = setup({ list: vi.fn(async () => ok(makeSnapshot(++n === 1 ? 20 : 12))) });
    const heard: number[] = [];
    client.onDidChange((r) => { if (r.status === "ok") heard.push(r.value.revision); });
    await client.list();
    fake.emit(change(21));
    await runFrame();
    expect(heard).toEqual([20]);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("A4/A5 save against the routed target", () => {
  const request = (over: Record<string, unknown> = {}, selOver: Record<string, unknown> = {}): any => ({
    contractVersion: 1, artifact: target, comment: "c", selection: { ...load("selection.json"), ...selOver },
    screenshot: null, screenshotOmitted: "vault-read", stale: false, submittedAt: "2026-11-12T10:00:00.000Z", ...over,
  });

  it("refuses a selection from another artifact, without calling the provider", async () => {
    const { client, fake } = setup();
    expect(await client.save({ request: request({}, { artifactId: "other" }) })).toMatchObject({ status: "rejected", reason: "invalid" });
    expect(fake.provider.save).not.toHaveBeenCalled();
  });

  it("on a vault:read artifact refuses any present screenshot (including falsy ones) and any non-redacted selection", async () => {
    const { client, fake } = setup({}, {}, vaultTarget);
    const sel = redactedSelection();
    for (const screenshot of [new Uint8Array(1), new Uint8Array(0), 0, "", false, {}]) {
      expect(await client.save({ request: request({ screenshot }, sel) }), String(screenshot)).toMatchObject({ status: "rejected", reason: "invalid" });
    }
    for (const redacted of [false, "true", 1, undefined, null]) {
      expect(await client.save({ request: request({}, { ...sel, redacted }) }), String(redacted)).toMatchObject({ status: "rejected", reason: "invalid" });
    }
    expect(fake.provider.save).not.toHaveBeenCalled();
    expect(await client.save({ request: request({ screenshot: null }, sel) })).toMatchObject({ status: "ok" });
    expect(await client.save({ request: request({ screenshot: undefined }, sel) })).toMatchObject({ status: "ok" });
  });

  it("a non-vault artifact may carry a screenshot and a non-redacted selection", async () => {
    const { client } = setup();
    expect(await client.save({ request: request({ screenshot: new Uint8Array(4) }) })).toMatchObject({ status: "ok" });
  });

  it("cyclic, 100,000-deep and throwing-getter requests are refused as invalid, never thrown, never unhandled", async () => {
    const { client, fake } = setup();
    const cyclic = request(); cyclic.self = cyclic;
    let deep: any = {}; const root = deep; for (let i = 0; i < 100_000; i += 1) { deep.n = {}; deep = deep.n; }
    const deepReq = request(); deepReq.extra = root;
    const getterReq = request(); Object.defineProperty(getterReq, "boom", { enumerable: true, get() { throw new Error("getter"); } });
    for (const r of [cyclic, deepReq, getterReq]) {
      await expect(Promise.resolve().then(() => client.save({ request: r }))).resolves.toMatchObject({ status: "rejected", reason: "invalid" });
    }
    expect(fake.provider.save).not.toHaveBeenCalled();
  });

  it.fails("FINDING G5: save sends the identity it checked: an accessor on the selection cannot swap it between the check and the call (request is passed by reference, not copied)", async () => {
    const { client, fake } = setup();
    let reads = 0;
    const selection = { ...load("selection.json") };
    Object.defineProperty(selection, "selectionId", { enumerable: true, get() { reads += 1; return reads === 1 ? `sel_${hex32(1)}` : `sel_${hex32(2)}`; } });
    const result = await client.save({ request: request({ selection }) });
    const sent = (fake.provider.save as any).mock.calls[0]?.[1];
    if (sent) expect(sent.request.selection.selectionId).toBe(`sel_${hex32(1)}`);
    else expect(result).toMatchObject({ status: "rejected" });
  });
});

describe("A4 redaction and identity on what comes back", () => {
  it("redacted comments must carry no text anchor and no screenshot; redacted selections no text and no accessible name", () => {
    expect(rebuildSnapshot(makeSnapshot(1, [redactedComment()]))).not.toBeNull();
    const cText = redactedComment(); cText.anchor.textAnchor.text = "secret";
    expect(rebuildSnapshot(makeSnapshot(1, [cText]))).toBeNull();
    expect(rebuildSnapshot(makeSnapshot(1, [redactedComment({ hasScreenshot: true })]))).toBeNull();
    const detail = (sel: any) => ({ comment: redactedComment(), selection: { ...sel, selectionId: `sel_${hex32(1)}` } });
    expect(rebuildDetail(detail(redactedSelection()), target)).not.toBeNull();
    expect(rebuildDetail(detail({ ...redactedSelection(), textAnchor: { tag: "button", text: "x" } }), target)).toBeNull();
    expect(rebuildDetail(detail({ ...redactedSelection(), a11y: { role: "button", name: "Save", tabIndex: 0 } }), target)).toBeNull();
    expect(rebuildDetail(detail({ ...redactedSelection(), redacted: false }), target)).toBeNull();
    expect(rebuildDetail(detail({ ...redactedSelection(), artifactId: "other" }), target)).toBeNull();
    expect(rebuildDetail(detail(redactedSelection()), { artifactId: "other" })).toBeNull();
  });

  it("get through the client refuses another artifact's selection and a redaction mismatch", async () => {
    const sel = { ...load("selection.json"), artifactId: "elsewhere" };
    const { client } = setup({ get: vi.fn(async () => ok({ comment: load("comment.json"), selection: sel })) });
    expect(await client.get(ID)).toMatchObject({ status: "rejected", reason: "failed" });
  });

  it.fails("FINDING G2: a redacted comment cannot carry page text in its label (design note T11: label omits text for redacted selections)", () => {
    const rebuilt = rebuildSnapshot(makeSnapshot(1, [redactedComment({ label: "button Quarterly payroll total" })]));
    expect(rebuilt === null || !rebuilt.comments[0]!.label.includes("payroll")).toBe(true);
  });

  it.fails("FINDING G3: a redacted selection cannot carry page text in outerHTML", () => {
    const sel = redactedSelection();
    sel.outerHTML = { html: "<button>Quarterly payroll total</button>", truncated: false };
    const rebuilt = rebuildDetail({ comment: redactedComment(), selection: { ...sel, selectionId: `sel_${hex32(1)}` } }, target);
    expect(rebuilt === null || !rebuilt.selection!.outerHTML.html.includes("payroll")).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("B1 capture at register", () => {
  it("capabilities, version and provider are fixed at register: later getter flips change nothing", async () => {
    let capReads = 0; let verReads = 0;
    const fake = fakeProvider();
    const caps: any = { pins: true, batchSend: true };
    Object.defineProperty(caps, "textEdit", { get() { capReads += 1; return capReads === 1; } });
    (fake.provider as any).capabilities = caps;
    (fake.provider as any).commitTextEdit = async () => ({});
    (fake.provider as any).undoTextEdit = async () => ({});
    const handler: any = { submit: async () => ({ status: "accepted" }), comments: fake.provider };
    Object.defineProperty(handler, "contractVersion", { get() { verReads += 1; return verReads === 1 ? 2 : 1; } });
    const svc = new ArtifactFeedbackService({ scheduleFrame: () => () => {} });
    expect(svc.register(owner, handler).status).toBe("registered");
    const client = svc.commentsFor(target);
    expect(client).not.toBeNull();
    expect(client!.capabilities.textEdit).toBe(true);
    expect(svc.describeRoute(target)).toMatchObject({ contractVersion: 2 });
  });

  it("getters that throw on submit, contractVersion or comments make register return a structured status", () => {
    for (const key of ["submit", "contractVersion", "comments"]) {
      const handler: any = { contractVersion: 2, submit: async () => ({}), comments: fakeProvider().provider };
      Object.defineProperty(handler, key, { get() { throw new Error(key); } });
      const svc = new ArtifactFeedbackService();
      let status = "";
      expect(() => { status = svc.register(owner, handler).status; }, key).not.toThrow();
      expect(["invalid", "unsupported-version"]).toContain(status);
      expect(svc.describeRoute(target)).toBeNull();
    }
  });

  it("a revoked-Proxy handler or provider is refused, not thrown", () => {
    const revoked = (): any => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; };
    const svc = new ArtifactFeedbackService();
    expect(() => svc.register(owner, revoked())).not.toThrow();
    expect(() => svc.register({ pluginId: "p2", displayName: "P2" }, v2(revoked()))).not.toThrow();
    expect(svc.register({ pluginId: "p3", displayName: "P3" }, v2(revoked())).status).toBe("invalid");
  });

  it("a provider method deleted after register: commentsFor yields no client (no throw); an existing client fails calls softly", async () => {
    const { svc, fake, client } = setup();
    (fake.provider as any).list = undefined;
    expect(await client.list()).toMatchObject({ status: "rejected", reason: "failed" });
    expect(() => svc.commentsFor(target)).not.toThrow();
    expect(svc.commentsFor(target)).toBeNull();
  });

  it("a v1 handler's submit still works after the register-time capture and a later submit-getter throw is an outcome, not a throw", async () => {
    const svc = new ArtifactFeedbackService();
    const handler: any = { contractVersion: 1, submit: async () => ({ status: "accepted" }) };
    svc.register(owner, handler);
    Object.defineProperty(handler, "submit", { get() { throw new Error("late"); } });
    await expect(svc.submit(target, { contractVersion: 1 } as never)).resolves.toMatchObject({ status: "rejected", source: "handler" });
  });
});

// ------------------------------------------------------------------------------------------------------------------
describe("A6/A7/F8 copy and truncation", () => {
  it("only write timeouts (save, sendBatch) carry the 'may have been received' hint", async () => {
    vi.useFakeTimers();
    const hang = () => new Promise(() => {});
    const { client } = setup({ save: vi.fn(hang), sendBatch: vi.fn(hang), update: vi.fn(hang), list: vi.fn(hang) });
    const req: any = { contractVersion: 1, artifact: target, comment: "c", selection: load("selection.json"), screenshot: null, screenshotOmitted: "vault-read", stale: false, submittedAt: "2026-11-12T10:00:00.000Z" };
    const save = client.save({ request: req });
    const send = client.sendBatch({ requestId: "req_00112233445566778899aabbccddeeff", ids: [ID], resend: false, anchorStates: {} });
    const update = client.update({ id: ID, expectedVersion: 1, change: { action: "resolve" } });
    const list = client.list();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(((await save) as any).message).toMatch(/may have been received/);
    expect(((await send) as any).message).toMatch(/request id/);
    expect(((await update) as any).message).not.toMatch(/received/);
    expect(((await list) as any).message).not.toMatch(/received/);
  });

  it("the truncation notice fits 300 units whatever the plugin notice is, and survives bidi and control junk", () => {
    const comments = Array.from({ length: 250 }, (_, i) => makeComment(i));
    for (const notice of [null, "", "x".repeat(300), "‮".repeat(500), "n".repeat(10_000_000)]) {
      const rebuilt = rebuildSnapshot({ ...makeSnapshot(1, comments), notice })!;
      expect(rebuilt.notice!.length, String(notice).slice(0, 5)).toBeLessThanOrEqual(300);
      expect(rebuilt.notice).toContain("first 200 of 250");
    }
  });

  it("an exactly-200 snapshot gets no truncation notice; 201 does", () => {
    expect(rebuildSnapshot(makeSnapshot(1, Array.from({ length: 200 }, (_, i) => makeComment(i))))!.notice).toBeNull();
    expect(rebuildSnapshot(makeSnapshot(1, Array.from({ length: 201 }, (_, i) => makeComment(i))))!.notice).toContain("first 200 of 201");
  });

  it("OBSERVATION: truncating before cleaning means a label that opens with more than 4x its cap of zero-width characters comes back empty", () => {
    const label = `${"​".repeat(500)}Save`;
    expect(rebuildSnapshot(makeSnapshot(1, [makeComment(0, { label })]))!.comments[0]!.label).toBe("");
  });

  it("40 MB of display strings now cleans in well under a second", () => {
    const big = "y\n".repeat(10_000_000);
    const snap = makeSnapshot(1, [makeComment(0, { label: big })]);
    snap.notice = big;
    const started = performance.now();
    rebuildSnapshot(snap);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
