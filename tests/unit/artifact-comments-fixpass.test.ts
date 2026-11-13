/**
 * Fix pass for the G1 review (reviewer B1, A3-A6, A8, F8) and the full junk table through the client.
 * Written before the fixes; the F1-F7 findings live in artifact-comments-adversarial.test.ts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactFeedbackTarget } from "../../src/artifacts/feedback-contract";
import type { ArtifactCommentsChange, ArtifactCommentsProvider } from "../../src/artifacts/feedback-contract-v2";
import { rebuildComment, rebuildDetail, rebuildSnapshot } from "../../src/renderer/artifacts/comments-rebuild";
import { ArtifactFeedbackService } from "../../src/renderer/artifacts/feedback-registry";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "artifact-feedback");
const load = (name: string): any => JSON.parse(readFileSync(path.join(fixtureDir, name), "utf8"));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

const target: ArtifactFeedbackTarget = { root: "/a", artifactId: "art", title: "Art", runtime: "static", vaultRead: false };
const owner = { pluginId: "design", displayName: "Design" };
const ID = "cmt_0123456789abcdef0123456789abcdef";
const REQ = "req_00112233445566778899aabbccddeeff";
const STORE = "str_89abcdef0123456789abcdef01234567";
const ok = (value: unknown) => ({ status: "ok", value });
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

function fakeProvider(over: Record<string, unknown> = {}) {
  let listener: ((change: ArtifactCommentsChange) => void) | null = null;
  const list = vi.fn(async () => ok(load("snapshot.json")));
  const provider = {
    capabilities: { pins: true, batchSend: true, textEdit: false },
    list,
    get: vi.fn(async () => ok(load("detail.json"))),
    save: vi.fn(async () => ok({ comment: load("comment.json"), created: true })),
    update: vi.fn(), remove: vi.fn(), adopt: vi.fn(),
    subscribe: vi.fn((_t: unknown, l: (change: ArtifactCommentsChange) => void) => { listener = l; return { dispose() {} }; }),
    sendBatch: vi.fn(async () => ok(load("batch-report.json"))),
    ...over,
  } as unknown as ArtifactCommentsProvider;
  return { provider, list, emit: (change: unknown) => listener?.(change as ArtifactCommentsChange) };
}
const v2 = (comments: unknown): any => ({ contractVersion: 2, submit: vi.fn(async () => ({ status: "accepted" })), comments });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); vi.useRealTimers(); });

function setup(over: Record<string, unknown> = {}, options: ConstructorParameters<typeof ArtifactFeedbackService>[0] = {}, tgt: ArtifactFeedbackTarget = target) {
  const frames: (() => void)[] = [];
  const svc = new ArtifactFeedbackService({ scheduleFrame: (cb) => { frames.push(cb); return () => { const i = frames.indexOf(cb); if (i >= 0) frames.splice(i, 1); }; }, ...options });
  const fake = fakeProvider(over);
  svc.register(owner, v2(fake.provider));
  const client = svc.commentsFor(tgt)!;
  const runFrame = async () => { frames.splice(0).forEach((f) => f()); await flush(); };
  return { svc, fake, client, frames, runFrame };
}

describe("B1: the registry captures what it validated", () => {
  it("describeRoute and commentsFor use the version captured at register, even if the getter later lies", () => {
    let reads = 0;
    const handler: any = { submit: async () => ({ status: "accepted" }), comments: fakeProvider().provider };
    Object.defineProperty(handler, "contractVersion", { get() { reads += 1; return reads === 1 ? 2 : 1; } });
    const svc = new ArtifactFeedbackService();
    expect(svc.register(owner, handler).status).toBe("registered");
    expect(svc.describeRoute(target)).toEqual({ displayName: "Design", contractVersion: 2 });
    expect(svc.commentsFor(target)).not.toBeNull();
    expect(svc.describeRoute(target)).toEqual({ displayName: "Design", contractVersion: 2 });
  });

  it("commentsFor re-checks the provider and returns null instead of throwing when it has gone bad", () => {
    const fake = fakeProvider();
    const svc = new ArtifactFeedbackService();
    svc.register(owner, v2(fake.provider));
    (fake.provider as any).list = undefined;
    expect(() => svc.commentsFor(target)).not.toThrow();
    expect(svc.commentsFor(target)).toBeNull();
  });
});

describe("A3: minimum refresh interval", () => {
  it("a second refresh waits until 250 ms after the previous one started", async () => {
    vi.useFakeTimers();
    const { client, fake, frames } = setup();
    client.onDidChange(() => {});
    fake.emit({ storeId: STORE, revision: 8, reason: "local", ids: "all" });
    frames.splice(0).forEach((f) => f());
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.list).toHaveBeenCalledTimes(1);
    fake.emit({ storeId: STORE, revision: 9, reason: "local", ids: "all" });
    expect(frames).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(240);
    expect(frames).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(frames).toHaveLength(1);
  });
});

describe("A8: a malformed change event with a plausible revision still triggers a list", () => {
  it("schedules a refresh for a bad reason or bad ids, but not for junk", async () => {
    const { client, fake, frames, runFrame } = setup({}, { commentsMinRefreshMs: 0 });
    client.onDidChange(() => {});
    fake.emit({ storeId: STORE, revision: "9", reason: "local", ids: [] });
    fake.emit(null);
    fake.emit("boom");
    expect(frames).toHaveLength(0);
    fake.emit({ storeId: STORE, revision: 9, reason: "weather", ids: [] });
    expect(frames).toHaveLength(1);
    await runFrame();
    expect(fake.list).toHaveBeenCalledTimes(1);
  });
});

describe("A4: redaction and identity consistency in rebuilt comments", () => {
  it("a redacted comment must have an empty text anchor and no screenshot", () => {
    const a = clone(load("comment.json")); a.redacted = true; a.hasScreenshot = false;
    expect(rebuildComment(a)).toBeNull(); // textAnchor.text is "Save"
    a.anchor.textAnchor.text = "";
    expect(rebuildComment(a)).not.toBeNull();
    a.hasScreenshot = true;
    expect(rebuildComment(a)).toBeNull();
  });

  it("detail: selection.artifactId must equal the target, redaction must agree, and a redacted selection carries no text", () => {
    const detail = () => clone(load("detail.json"));
    expect(rebuildDetail(detail(), { artifactId: "art" })).not.toBeNull();
    expect(rebuildDetail(detail(), { artifactId: "other" })).toBeNull();
    const a = detail(); a.selection.redacted = true;
    expect(rebuildDetail(a, { artifactId: "art" })).toBeNull(); // comment.redacted is false
    const b = detail(); b.comment.redacted = true; b.comment.hasScreenshot = false; b.comment.anchor.textAnchor.text = "";
    b.selection.redacted = true; // textAnchor.text "Save" and a11y.name "Save" remain
    expect(rebuildDetail(b, { artifactId: "art" })).toBeNull();
    b.selection.textAnchor.text = ""; b.selection.a11y.name = null;
    expect(rebuildDetail(b, { artifactId: "art" })).not.toBeNull();
  });

  it("client.get passes its target through", async () => {
    const { client } = setup({}, {}, { ...target, artifactId: "someone-else" });
    expect(await client.get(ID)).toMatchObject({ status: "rejected", reason: "failed" });
  });
});

describe("A5: save is checked against the target", () => {
  const request = (over: Record<string, unknown> = {}, selection: Record<string, unknown> = {}): any => ({
    contractVersion: 1, artifact: target, comment: "c", selection: { ...load("selection.json"), ...selection },
    screenshot: null, screenshotOmitted: "capture-failed", stale: false, submittedAt: "2026-11-12T10:00:00.000Z", ...over,
  });
  it("accepts a matching request", async () => {
    const { client } = setup();
    expect(await client.save({ request: request() })).toMatchObject({ status: "ok" });
  });
  it("rejects a selection for another artifact", async () => {
    const { client, fake } = setup();
    expect(await client.save({ request: request({}, { artifactId: "other" }) })).toMatchObject({ status: "rejected", reason: "invalid" });
    expect((fake.provider.save as any).mock.calls).toHaveLength(0);
  });
  it("on a vault:read artifact rejects a screenshot or a non-redacted selection", async () => {
    const vault = { ...target, vaultRead: true };
    const { client, fake } = setup({}, {}, vault);
    const png = { mimeType: "image/png", bytes: new Uint8Array(8), width: 1, height: 1, cssRect: { x: 0, y: 0, width: 1, height: 1 }, devicePixelRatio: 1, downscaled: false };
    expect(await client.save({ request: request({ screenshot: png, screenshotOmitted: null }, { redacted: true }) })).toMatchObject({ reason: "invalid" });
    expect(await client.save({ request: request({}, { redacted: false }) })).toMatchObject({ reason: "invalid" });
    expect((fake.provider.save as any).mock.calls).toHaveLength(0);
  });
});

describe("A6: timeout copy for writes warns that the action may have been received", () => {
  it("save and sendBatch say so; list does not", async () => {
    vi.useFakeTimers();
    const hang = () => new Promise(() => {});
    const { client } = setup({ list: vi.fn(hang), save: vi.fn(hang), sendBatch: vi.fn(hang) }, { commentsCallTimeoutMs: 100, commentsSendTimeoutMs: 100 });
    const req: any = { contractVersion: 1, artifact: target, comment: "c", selection: load("selection.json"), screenshot: null, screenshotOmitted: "capture-failed", stale: false, submittedAt: "2026-11-12T10:00:00.000Z" };
    const results = [client.list(), client.save({ request: req }), client.sendBatch({ requestId: REQ, ids: [ID], resend: false, anchorStates: {} })];
    await vi.advanceTimersByTimeAsync(100);
    const [list, save, send] = (await Promise.all(results)) as any[];
    expect(list.message).not.toContain("may have been received");
    expect(save.message).toContain("It may have been received; check the thread before retrying.");
    expect(send.message).toContain("It may have been received; check the thread before retrying.");
  });
});

describe("full junk-snapshot table through the client", () => {
  const { cases } = load("junk-snapshots.json") as { cases: { name: string; patches: { path: string; value: any }[] }[] };
  const apply = (root: any, patch: { path: string; value: any }): any => {
    const resolve = (v: any): any => {
      if (v && typeof v === "object" && v.$delete === true) return undefined;
      if (typeof v === "string" && v.startsWith("REPEAT:")) { const [, ch, n] = v.split(":"); return (ch as string).repeat(Number(n)); }
      return v;
    };
    if (patch.path === "") return resolve(patch.value);
    const keys = patch.path.split(".");
    let holder = root;
    for (const key of keys.slice(0, -1)) holder = holder[key];
    const last = keys[keys.length - 1] as string;
    if (typeof patch.value === "string" && patch.value.startsWith("COPY:")) {
      let src = root;
      for (const key of patch.value.slice(5).split(".")) src = src[key];
      holder[last] = clone(src);
      return root;
    }
    const next = resolve(patch.value);
    if (next === undefined) delete holder[last]; else holder[last] = next;
    return root;
  };
  for (const junk of cases) {
    it(`client.list rejects: ${junk.name}`, async () => {
      let value: any = clone(load("snapshot.json"));
      for (const patch of junk.patches) value = apply(value, patch);
      const { client } = setup({ list: vi.fn(async () => ok(value)) });
      expect(await client.list()).toMatchObject({ status: "rejected", reason: "failed" });
      expect(client.cached).toBeNull();
    });
  }
});

describe("F8: display strings are truncated before they are cleaned", () => {
  it("never runs a replace over a huge string", () => {
    const original = String.prototype.replace;
    let longest = 0;
    const spy = vi.spyOn(String.prototype, "replace").mockImplementation(function (this: string, ...args: [any, any]) {
      longest = Math.max(longest, this.length);
      return original.apply(this, args);
    } as any);
    try {
      const raw = clone(load("snapshot.json"));
      raw.notice = "n".repeat(2_000_000);
      raw.comments[0].label = "l".repeat(2_000_000);
      raw.comments[0].send.lastMessage = "m".repeat(2_000_000);
      const out = rebuildSnapshot(raw)!;
      expect(out.notice!.length).toBe(300);
      expect(out.comments[0]!.label.length).toBe(120);
      expect(longest).toBeLessThan(100_000);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects over-long comment text without cleaning it first", () => {
    const original = String.prototype.replace;
    let longest = 0;
    const spy = vi.spyOn(String.prototype, "replace").mockImplementation(function (this: string, ...args: [any, any]) {
      longest = Math.max(longest, this.length);
      return original.apply(this, args);
    } as any);
    try {
      const raw = clone(load("comment.json"));
      raw.text = "t".repeat(2_000_000);
      expect(rebuildComment(raw)).toBeNull();
      expect(longest).toBeLessThan(100_000);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("A7: truncation to 200 comments is announced in the notice", () => {
  it("adds a Geode-authored notice and keeps a plugin notice", () => {
    const make = (n: number) => { const hex = n.toString(16).padStart(32, "0"); return { ...clone(load("comment.json")), id: `cmt_${hex}`, selectionId: `sel_${hex}`, ordinal: n }; };
    const comments = Array.from({ length: 250 }, (_, i) => make(i + 1));
    const base = { ...clone(load("snapshot.json")), foreignCount: 0, comments };
    expect(rebuildSnapshot(base)!.notice).toBe("Showing the first 200 of 250 comments.");
    expect(rebuildSnapshot({ ...base, health: "recovered", notice: "Recovered." })!.notice).toBe("Recovered. Showing the first 200 of 250 comments.");
    expect(rebuildSnapshot({ ...base, comments: comments.slice(0, 200) })!.notice).toBeNull();
  });
});
