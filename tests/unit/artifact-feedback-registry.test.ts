import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_FEEDBACK_CONTRACT_VERSIONS,
  ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS,
  type ArtifactFeedbackHandler,
  type ArtifactFeedbackRequest,
  type ArtifactFeedbackResult,
  type ArtifactFeedbackTarget,
} from "../../src/artifacts/feedback-contract";
import { ArtifactFeedbackService, createReadOnlyFeedbackView } from "../../src/renderer/artifacts/feedback-registry";

const target: ArtifactFeedbackTarget = { root: "/a", artifactId: "art", title: "Art", runtime: "static", vaultRead: false };
const request = (extra: Partial<ArtifactFeedbackRequest> = {}): ArtifactFeedbackRequest => ({
  contractVersion: 1,
  artifact: target,
  comment: "make it blue",
  selection: { schemaVersion: 1, selectionId: "sel_" + "a".repeat(32), tag: "div" } as never,
  screenshot: null,
  screenshotOmitted: "vault-read",
  stale: false,
  submittedAt: "2026-11-08T00:00:00.000Z",
  ...extra,
});
const ownerA = { pluginId: "plug-a", displayName: "Plugin A" };
const ownerB = { pluginId: "plug-b", displayName: "Plugin B" };
const accepted: ArtifactFeedbackResult = { status: "accepted", message: "Sent." };
const handler = (over: Partial<ArtifactFeedbackHandler> = {}): ArtifactFeedbackHandler => ({
  contractVersion: 1,
  submit: vi.fn(async () => accepted),
  ...over,
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); vi.useRealTimers(); });

describe("contract constants", () => {
  it("advertises version 1 and a 15 s timeout", () => {
    expect([...ARTIFACT_FEEDBACK_CONTRACT_VERSIONS]).toEqual([1]);
    expect(ARTIFACT_FEEDBACK_SUBMIT_TIMEOUT_MS).toBe(15_000);
    expect([...new ArtifactFeedbackService().contractVersions]).toEqual([1]);
  });
});

describe("registration", () => {
  it("registers, becomes visible, and notifies on change", () => {
    const svc = new ArtifactFeedbackService();
    const changes = vi.fn();
    svc.onDidChange(changes);
    expect(svc.has(target)).toBe(false);
    const reg = svc.register(ownerA, handler());
    expect(reg.status).toBe("registered");
    expect(svc.has(target)).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    reg.dispose();
    expect(svc.has(target)).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
    reg.dispose(); // idempotent
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("returns structured results instead of throwing", () => {
    const svc = new ArtifactFeedbackService();
    expect(svc.register(ownerA, { contractVersion: 2, submit: async () => accepted } as never).status).toBe("unsupported-version");
    expect(svc.register(ownerA, {} as never).status).toBe("invalid");
    expect(svc.register(ownerA, null as never).status).toBe("invalid");
    expect(new ArtifactFeedbackService({ enabled: false }).register(ownerA, handler()).status).toBe("unavailable");
    const first = svc.register(ownerA, handler());
    expect(first.status).toBe("registered");
    const dup = svc.register(ownerA, handler());
    expect(dup.status).toBe("conflict");
    dup.dispose(); // a failed registration's dispose must not drop the live one
    expect(svc.has(target)).toBe(true);
    first.dispose();
    expect(svc.register(ownerA, handler()).status).toBe("registered"); // free again after dispose
  });

  it("onDidChange unsubscribes and a throwing listener does not break the others", () => {
    const svc = new ArtifactFeedbackService();
    const good = vi.fn();
    svc.onDidChange(() => { throw new Error("boom"); });
    const off = svc.onDidChange(good);
    svc.register(ownerA, handler());
    expect(good).toHaveBeenCalledTimes(1);
    off();
    svc.register(ownerB, handler());
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe("canHandle and routing", () => {
  it("omitted canHandle handles everything; a throwing or non-boolean canHandle is false", () => {
    const svc = new ArtifactFeedbackService();
    svc.register(ownerA, handler({ canHandle: () => { throw new Error("x"); } }));
    expect(svc.has(target)).toBe(false);
    svc.register(ownerB, handler({ canHandle: (() => "yes") as never }));
    expect(svc.has(target)).toBe(false);
    expect(warn).not.toHaveBeenCalled(); // visibility checks must not spam
  });

  it("only the first registered handler whose canHandle passes receives the submission (exactly one)", async () => {
    const svc = new ArtifactFeedbackService();
    const a = handler({ canHandle: () => false });
    const b = handler();
    const c = handler();
    svc.register(ownerA, a);
    svc.register(ownerB, b);
    svc.register({ pluginId: "plug-c", displayName: "C" }, c);
    const outcome = await svc.submit(target, request());
    expect(outcome).toMatchObject({ status: "accepted", source: "handler" });
    expect(a.submit).not.toHaveBeenCalled();
    expect(b.submit).toHaveBeenCalledTimes(1);
    expect(c.submit).not.toHaveBeenCalled();
  });

  it("rejects as unavailable when nothing handles the target", async () => {
    const svc = new ArtifactFeedbackService();
    expect(await svc.submit(target, request())).toMatchObject({ status: "rejected", reason: "unavailable", source: "no-handler" });
    svc.register(ownerA, handler({ canHandle: () => false }));
    expect(await svc.submit(target, request())).toMatchObject({ status: "rejected", reason: "unavailable", source: "no-handler" });
  });

  it("hands the handler a frozen request with the screenshot bytes intact", async () => {
    const svc = new ArtifactFeedbackService();
    const seen: ArtifactFeedbackRequest[] = [];
    svc.register(ownerA, handler({ submit: async (req) => { seen.push(req); return accepted; } }));
    const bytes = new Uint8Array([137, 80, 78, 71]);
    await svc.submit(target, request({ screenshot: { mimeType: "image/png", bytes, width: 1, height: 1, cssRect: { x: 0, y: 0, width: 1, height: 1 }, devicePixelRatio: 1, downscaled: false }, screenshotOmitted: null }));
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0]!.selection)).toBe(true);
    expect(seen[0]!.screenshot!.bytes).toBe(bytes);
  });
});

describe("fault isolation", () => {
  it("converts a throw, a rejection and junk results to rejected outcomes with console.warn", async () => {
    for (const submit of [
      () => { throw new Error("sync boom"); },
      async () => { throw new Error("async boom"); },
      async () => undefined,
      async () => ({ status: "weird" }),
      async () => ({ status: "rejected", reason: "nope", message: "x" }),
      async () => ({ status: "rejected", reason: "busy" }),
    ]) {
      const svc = new ArtifactFeedbackService();
      svc.register(ownerA, { contractVersion: 1, submit: submit as never });
      const outcome = await svc.submit(target, request());
      expect(outcome.status).toBe("rejected");
      expect(outcome).toMatchObject({ reason: "failed" });
      expect(outcome.source).toMatch(/handler|invalid-result/);
    }
    expect(warn).toHaveBeenCalled();
  });

  it("truncates and cleans handler messages and ignores a non-string accepted message", async () => {
    const svc = new ArtifactFeedbackService();
    const long = `ok\u0000\u001b[31m${"x".repeat(900)}\nline`;
    svc.register(ownerA, { contractVersion: 1, submit: async () => ({ status: "rejected", reason: "busy", message: long }) });
    const outcome = await svc.submit(target, request());
    if (outcome.status !== "rejected") throw new Error("expected rejected");
    expect(outcome.message.length).toBeLessThanOrEqual(500);
    // eslint-disable-next-line no-control-regex
    expect(outcome.message).not.toMatch(/[\u0000-\u001f\u007f]/);
    const svc2 = new ArtifactFeedbackService();
    svc2.register(ownerA, { contractVersion: 1, submit: async () => ({ status: "accepted", message: 42 as never }) });
    expect(await svc2.submit(target, request())).toEqual({ status: "accepted", source: "handler" });
  });

  it("does not quarantine: a failing submit never reaches anything but console.warn", async () => {
    const svc = new ArtifactFeedbackService();
    svc.register(ownerA, { contractVersion: 1, submit: async () => { throw new Error("boom"); } });
    await svc.submit(target, request());
    expect(svc.has(target)).toBe(true); // handler stays registered
  });
});

describe("timeout and abort", () => {
  it("times out after 15 s, aborts the signal, drops a late result", async () => {
    vi.useFakeTimers();
    const svc = new ArtifactFeedbackService();
    let signal!: AbortSignal;
    let release!: (r: ArtifactFeedbackResult) => void;
    svc.register(ownerA, { contractVersion: 1, submit: (_req, ctx) => { signal = ctx.signal; return new Promise((r) => { release = r; }); } });
    const pending = svc.submit(target, request());
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const outcome = await pending;
    expect(outcome).toMatchObject({ status: "rejected", reason: "failed", source: "timeout" });
    expect(outcome.status === "rejected" && outcome.message).toMatch(/15 s/);
    expect(signal.aborted).toBe(true);
    release(accepted); // late: dropped, no throw
    expect(warn).toHaveBeenCalled();
  });

  it("honours a configured timeout", async () => {
    vi.useFakeTimers();
    const svc = new ArtifactFeedbackService({ timeoutMs: 50 });
    svc.register(ownerA, { contractVersion: 1, submit: () => new Promise(() => {}) });
    const pending = svc.submit(target, request());
    await vi.advanceTimersByTimeAsync(51);
    expect((await pending).source).toBe("timeout");
  });

  it("clears the timer when the handler settles in time", async () => {
    vi.useFakeTimers();
    const svc = new ArtifactFeedbackService();
    svc.register(ownerA, handler());
    await svc.submit(target, request());
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("disposal", () => {
  it("settles an in-flight submit as unavailable, aborts its signal and drops the late result", async () => {
    const svc = new ArtifactFeedbackService();
    let signal!: AbortSignal;
    let release!: (r: ArtifactFeedbackResult) => void;
    const reg = svc.register(ownerA, { contractVersion: 1, submit: (_r, ctx) => { signal = ctx.signal; return new Promise((r) => { release = r; }); } });
    const pending = svc.submit(target, request());
    reg.dispose();
    const outcome = await pending;
    expect(outcome).toEqual({ status: "rejected", reason: "unavailable", message: "Plugin A was unloaded before it answered. Check the thread to see whether your comment arrived.", source: "disposed" });
    expect(signal.aborted).toBe(true);
    release(accepted);
    await Promise.resolve();
    expect(await Promise.race([pending, "still-the-same"])).toBe(outcome);
  });

  it("a handler that is disposed while evaluating never receives a later submit", async () => {
    const svc = new ArtifactFeedbackService();
    const h = handler();
    svc.register(ownerA, h).dispose();
    expect(await svc.submit(target, request())).toMatchObject({ source: "no-handler" });
    expect(h.submit).not.toHaveBeenCalled();
  });
});

describe("describeHandler (popover copy)", () => {
  it("names the handler that would receive a submission, or null when none would", () => {
    const svc = new ArtifactFeedbackService();
    expect(svc.describeHandler(target)).toBeNull();
    svc.register(ownerA, handler({ canHandle: () => false }));
    expect(svc.describeHandler(target)).toBeNull();
    svc.register(ownerB, handler());
    expect(svc.describeHandler(target)).toBe("Plugin B");
  });
});

describe("a handler whose canHandle is a throwing getter (review A6)", () => {
  it("counts as not handling: has, describeHandler and submit never throw", async () => {
    const svc = new ArtifactFeedbackService();
    const evil = handler();
    Object.defineProperty(evil, "canHandle", { get() { throw new Error("getter"); } });
    svc.register(ownerA, evil);
    expect(() => svc.has(target)).not.toThrow();
    expect(svc.has(target)).toBe(false);
    expect(svc.describeHandler(target)).toBeNull();
    await expect(svc.submit(target, request())).resolves.toMatchObject({ status: "rejected", source: "no-handler" });
    // and a later well-behaved handler still receives the submission
    svc.register(ownerB, handler());
    expect(svc.has(target)).toBe(true);
  });
});

describe("the plugin-facing view (review A7)", () => {
  it("exposes has, onDidChange and contractVersions only, frozen, and tracks the service", () => {
    const svc = new ArtifactFeedbackService();
    const view = createReadOnlyFeedbackView(svc) as unknown as Record<string, unknown>;
    expect(Object.keys(view).sort()).toEqual(["contractVersions", "has", "onDidChange"]);
    expect(Object.isFrozen(view)).toBe(true);
    expect(view.register).toBeUndefined();
    expect(view.submit).toBeUndefined();
    expect(view.describeHandler).toBeUndefined();
    expect([...(view.contractVersions as number[])]).toEqual([1]);
    const changes = vi.fn();
    (view.onDidChange as (l: () => void) => void)(changes);
    expect((view.has as (t: unknown) => boolean)(target)).toBe(false);
    svc.register(ownerA, handler());
    expect((view.has as (t: unknown) => boolean)(target)).toBe(true);
    expect(changes).toHaveBeenCalledTimes(1);
    // mutating the version list cannot widen what the service accepts
    expect(() => { (view.contractVersions as number[]).push(2); }).toThrow();
  });
});
