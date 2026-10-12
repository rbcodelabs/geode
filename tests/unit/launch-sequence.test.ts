import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LaunchRegistry,
  LaunchRegistryError,
  LaunchRunner,
  createLaunchApi,
  summarizeLaunchFailures,
} from "../../src/renderer/launch/launch-sequence";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const statuses = (r: LaunchRunner) => Object.fromEntries(r.getSnapshot().steps.map((s) => [s.id, s.status]));

describe("LaunchRegistry", () => {
  it("orders by order then registration, per phase", () => {
    const reg = new LaunchRegistry();
    const run = () => {};
    reg.registerStep({ id: "a:late", title: "late", order: 50, run });
    reg.registerStep({ id: "a:first", title: "first", order: 1, run });
    reg.registerStep({ id: "a:tie1", title: "t1", run });
    reg.registerStep({ id: "a:tie2", title: "t2", run });
    reg.registerStep({ id: "core:pre", title: "pre", phase: "before-plugins", run });
    expect(reg.list("after-plugins").map((s) => s.id)).toEqual(["a:first", "a:late", "a:tie1", "a:tie2"]);
    expect(reg.list("before-plugins").map((s) => s.id)).toEqual(["core:pre"]);
  });

  it("validates ids, titles and duplicates", () => {
    const reg = new LaunchRegistry();
    const run = () => {};
    expect(() => reg.registerStep({ id: "nonamespace", title: "x", run })).toThrow(LaunchRegistryError);
    expect(() => reg.registerStep({ id: "a:", title: "x", run })).toThrow(LaunchRegistryError);
    expect(() => reg.registerStep({ id: "a:b", title: " ", run })).toThrow(LaunchRegistryError);
    expect(() => reg.registerStep({ id: "a:b", title: "x", timeoutMs: -1, run })).toThrow(LaunchRegistryError);
    reg.registerStep({ id: "a:b", title: "x", run });
    expect(() => reg.registerStep({ id: "a:b", title: "y", run })).toThrow(/already registered/);
  });

  it("disposer is idempotent and does not remove a later re-registration", () => {
    const reg = new LaunchRegistry();
    const run = () => {};
    const dispose = reg.registerStep({ id: "a:b", title: "x", run });
    dispose();
    reg.registerStep({ id: "a:b", title: "again", run });
    dispose();
    expect(reg.list().map((s) => s.title)).toEqual(["again"]);
  });

  it("unregisterOwner removes only that owner's steps", () => {
    const reg = new LaunchRegistry();
    const run = () => {};
    reg.registerStep({ id: "p1:a", title: "a", run });
    reg.registerStep({ id: "p1:b", title: "b", run });
    reg.registerStep({ id: "p2:a", title: "c", run });
    expect(reg.unregisterOwner("p1")).toBe(2);
    expect(reg.list().map((s) => s.id)).toEqual(["p2:a"]);
  });

  it("plugin API cannot pick a phase and applies the 60s default timeout", () => {
    const reg = new LaunchRegistry();
    const api = createLaunchApi(reg);
    expect(() => api.registerStep({ id: "p:x", title: "x", run() {}, phase: "before-plugins" } as any)).toThrow(/phase/);
    api.registerStep({ id: "p:y", title: "y", run() {} });
    expect(reg.list()[0].timeoutMs).toBe(60_000);
    expect(reg.list()[0].phase).toBe("after-plugins");
  });
});

describe("LaunchRunner", () => {
  it("runs steps sequentially in order and ends done", async () => {
    const reg = new LaunchRegistry();
    const log: string[] = [];
    reg.registerStep({ id: "a:2", title: "2", order: 2, run: async () => { log.push("2"); } });
    reg.registerStep({ id: "a:1", title: "1", order: 1, run: async () => { log.push("1"); } });
    const runner = new LaunchRunner(reg);
    await runner.runPhase("after-plugins");
    expect(log).toEqual(["1", "2"]);
    expect(statuses(runner)).toEqual({ "a:1": "done", "a:2": "done" });
    expect(runner.getSnapshot().progress).toBe(1);
  });

  it("runs before-plugins phase without touching after-plugins steps", async () => {
    const reg = new LaunchRegistry();
    const log: string[] = [];
    reg.registerStep({ id: "core:u", title: "u", phase: "before-plugins", run: () => { log.push("pre"); } });
    reg.registerStep({ id: "p:x", title: "x", run: () => { log.push("post"); } });
    const runner = new LaunchRunner(reg);
    await runner.runPhase("before-plugins");
    expect(log).toEqual(["pre"]);
    expect(statuses(runner)).toEqual({ "core:u": "done", "p:x": "pending" });
    await runner.runPhase("after-plugins");
    expect(log).toEqual(["pre", "post"]);
  });

  it("isolates failures: a throwing step does not stop later ones", async () => {
    const reg = new LaunchRegistry();
    const ran = vi.fn();
    reg.registerStep({ id: "a:bad", title: "Bad", order: 1, run: () => { throw new Error("boom"); } });
    reg.registerStep({ id: "a:good", title: "Good", order: 2, run: ran });
    const runner = new LaunchRunner(reg);
    await runner.runPhase("after-plugins");
    expect(ran).toHaveBeenCalled();
    expect(statuses(runner)).toEqual({ "a:bad": "failed", "a:good": "done" });
    expect(runner.getSnapshot().steps[0].error).toBe("boom");
    expect(summarizeLaunchFailures(runner.getSnapshot())).toMatch(/1 launch step failed \(Bad\)/);
  });

  it("times out a hung step, aborts its signal, and continues", async () => {
    const reg = new LaunchRegistry();
    let signal!: AbortSignal;
    reg.registerStep({ id: "a:hang", title: "hang", order: 1, timeoutMs: 1000, run: (ctx) => { signal = ctx.signal; return new Promise(() => {}); } });
    reg.registerStep({ id: "a:next", title: "next", order: 2, run: () => {} });
    const runner = new LaunchRunner(reg);
    const done = runner.runPhase("after-plugins");
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(signal.aborted).toBe(true);
    expect(statuses(runner)).toEqual({ "a:hang": "failed", "a:next": "done" });
    expect(runner.getSnapshot().steps[0].error).toMatch(/timed out after 1s/);
  });

  it("swallows a late rejection from a step that ignored its abort", async () => {
    const reg = new LaunchRegistry();
    let reject!: (e: Error) => void;
    reg.registerStep({ id: "a:x", title: "x", timeoutMs: 10, run: () => new Promise<void>((_, rj) => { reject = rj; }) });
    const runner = new LaunchRunner(reg);
    const done = runner.runPhase("after-plugins");
    await vi.advanceTimersByTimeAsync(10);
    await done;
    reject(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses(runner)["a:x"]).toBe("failed");
  });

  it("skipActive skips an optional running step but not a required one", async () => {
    const reg = new LaunchRegistry();
    let sig!: AbortSignal;
    reg.registerStep({ id: "a:opt", title: "opt", order: 1, optional: true, run: (ctx) => { sig = ctx.signal; return new Promise(() => {}); } });
    reg.registerStep({ id: "a:req", title: "req", order: 2, run: () => new Promise((r) => setTimeout(r, 50)) });
    const runner = new LaunchRunner(reg);
    const done = runner.runPhase("after-plugins");
    await vi.advanceTimersByTimeAsync(0);
    expect(runner.getSnapshot().activeStepId).toBe("a:opt");
    expect(runner.skipActive()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(sig.aborted).toBe(true);
    expect(runner.getSnapshot().activeStepId).toBe("a:req");
    expect(runner.skipActive()).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    await done;
    expect(statuses(runner)).toEqual({ "a:opt": "skipped", "a:req": "done" });
  });

  it("a step may report itself skipped", async () => {
    const reg = new LaunchRegistry();
    reg.registerStep({ id: "a:s", title: "s", run: () => "skipped" });
    const runner = new LaunchRunner(reg);
    await runner.runPhase("after-plugins");
    expect(statuses(runner)["a:s"]).toBe("skipped");
  });

  it("exposes progress and title updates, ignoring them after settle", async () => {
    const reg = new LaunchRegistry();
    let ctxRef: any;
    reg.registerStep({ id: "a:p", title: "orig", run: async (ctx) => {
      ctxRef = ctx;
      ctx.setProgress("working");
      ctx.setProgress(2);
      ctx.setTitle("renamed");
      expect(runner.getSnapshot().steps[0]).toMatchObject({ detail: "working", fraction: 1, title: "renamed" });
    } });
    const runner = new LaunchRunner(reg);
    await runner.runPhase("after-plugins");
    ctxRef.setTitle("late");
    expect(runner.getSnapshot().steps[0].title).toBe("renamed");
  });

  it("picks up steps registered while the phase is running", async () => {
    const reg = new LaunchRegistry();
    const log: string[] = [];
    reg.registerStep({ id: "a:1", title: "1", run: () => { log.push("1"); reg.registerStep({ id: "a:late", title: "late", run: () => { log.push("late"); } }); } });
    const runner = new LaunchRunner(reg);
    await runner.runPhase("after-plugins");
    expect(log).toEqual(["1", "late"]);
  });

  it("owner unload drops pending steps and aborts the running one", async () => {
    const reg = new LaunchRegistry();
    let sig!: AbortSignal;
    reg.registerStep({ id: "p:run", title: "run", order: 1, run: (ctx) => { sig = ctx.signal; return new Promise(() => {}); } });
    reg.registerStep({ id: "p:pending", title: "pending", order: 2, run: () => { throw new Error("must not run"); } });
    reg.registerStep({ id: "q:other", title: "other", order: 3, run: () => {} });
    const runner = new LaunchRunner(reg);
    const done = runner.runPhase("after-plugins");
    await vi.advanceTimersByTimeAsync(0);
    runner.unregisterOwner("p");
    await done;
    expect(sig.aborted).toBe(true);
    expect(statuses(runner)).toEqual({ "p:run": "skipped", "q:other": "done" });
  });
});
