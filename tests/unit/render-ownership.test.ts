import { expect, it, vi } from "vitest";
import { RenderOwnership, ScopeCancelled } from "../../src/renderer/workspaces/render-ownership";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(finish => { resolve = finish; }); return { promise, resolve }; };
it("tracks an initialization before its first await and cancels late publication", async () => {
  const registry = new RenderOwnership(); const scope = registry.create({}); const gate = deferred(); let published = false;
  const task = scope.run(async token => { await gate.promise; token.check(); published = true; });
  await Promise.resolve();
  const frozen = scope.freezeAndDrain(); gate.resolve(); await frozen; await expect(task).rejects.toBeInstanceOf(ScopeCancelled);
  expect(published).toBe(false); expect(() => scope.child()).toThrow(/admission/i); scope.resume(); expect(scope.child()).toBeDefined();
});
it("closes a child allocated during initialization once after cancellation", async () => {
  const registry = new RenderOwnership(); const root = registry.create({}); const close = vi.fn(async () => {}); const child = root.child({ close }); const gate = deferred();
  const task = child.run(async token => { await gate.promise; token.check(); });
  await Promise.resolve();
  const closing = child.close(); gate.resolve(); await closing; await child.close(); await root.close();
  await expect(task).rejects.toBeInstanceOf(ScopeCancelled); expect(close).toHaveBeenCalledOnce();
});
it("drains a recursive Markdown/Canvas/Markdown/Base ownership chain", async () => {
  const registry = new RenderOwnership(); const root = registry.create({}); const closes: string[] = [];
  const canvas = root.child({ writer: "canvas", close: async () => { closes.push("canvas"); } });
  const markdown = canvas.child({ close: async () => { closes.push("markdown"); } });
  markdown.child({ writer: "base", close: async () => { closes.push("base"); } });
  expect(root.writers()).toEqual(["canvas", "base"]); await root.close(); expect(closes).toEqual(["base", "markdown", "canvas"]);
});
it("propagates rejected pending work and memoizes failed close without retrying", async () => {
  const registry = new RenderOwnership(); const close = vi.fn(async () => { throw new Error("row write failed"); }); const scope = registry.create({}, { close });
  await expect(scope.close()).rejects.toThrow("row write failed"); await expect(scope.close()).rejects.toThrow("row write failed"); expect(close).toHaveBeenCalledOnce();
});
it("resumes retained scopes on abort and never admits or resumes a retired scope", async () => {
  const registry = new RenderOwnership(); const resume = vi.fn(); const root = registry.create({}, { resume }); const childResume = vi.fn(); const child = root.child({ resume: childResume });
  await root.freezeAndDrain(); root.resume(); expect(resume).toHaveBeenCalledOnce(); expect(childResume).toHaveBeenCalledOnce();
  await child.close(); await root.freezeAndDrain(); root.resume(); expect(childResume).toHaveBeenCalledOnce(); expect(() => child.run(async () => {})).toThrow(/admission/i);
});
it("rejects unknown root owners before freezing and keeps detached owners visible until closed", () => {
  const registry = new RenderOwnership(); const owner = {}; registry.create(owner, { writer: owner }); registry.create({}, { writer: {} });
  expect(() => registry.select(new Set([owner]))).toThrow(/unregistered|outside/i);
});

it("awaits a close already initiated by a synchronous widget destroy", async () => {
  const registry = new RenderOwnership(); const root = registry.create({}); const gate = deferred();
  const child = root.child({ close: async () => gate.promise }); void child.close();
  let drained = false; const draining = root.freezeAndDrain().then(() => { drained = true; });
  await Promise.resolve(); await Promise.resolve(); expect(drained).toBe(false); gate.resolve(); await draining; expect(drained).toBe(true);
});
it("freezes every owner before awaiting the first pending render", async () => {
  const registry = new RenderOwnership(); const one = {}; const two = {}; const first = registry.create(one); const second = registry.create(two); const gate = deferred();
  const pending = first.run(async token => { await gate.promise; token.check(); }); await Promise.resolve();
  const held = registry.hold(new Set([one, two])); expect(() => second.child()).toThrow(/admission/i); gate.resolve(); await held; await expect(pending).rejects.toBeInstanceOf(ScopeCancelled);
});
it("propagates a rejected keyed row write through the barrier", async () => {
  const registry = new RenderOwnership(); const root = registry.create({});
  await expect(root.run(async () => { throw new Error("source row write failed"); }, "row")).rejects.toThrow("source row write failed");
  await expect(root.freezeAndDrain()).rejects.toThrow("source row write failed"); root.resume();
});
it("reports failure from an earlier fire-and-forget child close during the owner barrier", async () => {
  const registry = new RenderOwnership(); const root = registry.create({}); const child = root.child({ close: async () => { throw new Error("nested flush failed"); } });
  await expect(child.close()).rejects.toThrow("nested flush failed");
  await expect(root.freezeAndDrain()).rejects.toThrow("nested flush failed");
});
it("retains a failed root teardown so a later barrier cannot overlook its writer", async () => {
  const registry = new RenderOwnership(); const owner = {}; const scope = registry.create(owner, { writer: owner, close: async () => { throw new Error("root row write failed"); } });
  await expect(scope.close()).rejects.toThrow("root row write failed");
  await expect(registry.hold(new Set([owner]))).rejects.toThrow("root row write failed");
  expect(() => registry.select(new Set())).toThrow(/outside/i);
});
it("rejects overlapping barriers and a release from a different hold", async () => {
  const registry = new RenderOwnership(); const owner = {}; registry.create(owner); const held = await registry.hold(new Set([owner]));
  await expect(registry.hold(new Set([owner]))).rejects.toThrow(/busy|progress/i);
  expect(() => registry.release([])).toThrow(/hold/i); expect(registry.admissionOpen).toBe(false);
  registry.release(held); expect(registry.admissionOpen).toBe(true);
});

it("includes standalone read-only renders in the barrier while rejecting unowned native writers", async () => {
  const registry = new RenderOwnership(); const owner = {}; const known = registry.create(owner, { writer: owner }); const readOnly = registry.create({});
  const scopes = await registry.hold(new Set([owner])); expect(scopes).toEqual([known, readOnly]); registry.release(scopes);
});
it("preserves the owner and its children when failed pending work prevents safe teardown", async () => {
  const registry = new RenderOwnership(); const owner = {}; let draft = "9"; const childClose = vi.fn(async () => {});
  const scope = registry.create(owner, { writer: owner, close: async () => { draft = ""; } }); scope.child({ close: childClose });
  await expect(scope.run(async () => { throw new Error("pending write failed"); }, "write")).rejects.toThrow("pending write failed");
  await expect(scope.close()).rejects.toThrow("pending write failed");
  expect(draft).toBe("9"); expect(childClose).not.toHaveBeenCalled(); expect(registry.select(new Set([owner]))).toEqual([scope]);
});
it("does not retain an already reported transient read failure after successful reload or cleanup", async () => {
  const registry = new RenderOwnership(); const scope = registry.create({});
  await expect(scope.run(async () => { throw new Error("transient read"); })).rejects.toThrow("transient read");
  await scope.run(async () => {}); await expect(scope.close()).resolves.toBeUndefined();
  const failed = registry.create({}); await expect(failed.run(async () => { throw new Error("missing note"); })).rejects.toThrow("missing note");
  await expect(failed.close()).resolves.toBeUndefined();
});
it("keeps a pre-destructor failure until its explicit retry succeeds, without retiring siblings", async () => {
  const registry = new RenderOwnership(); const owner = {}; const root = registry.create(owner);
  const close = vi.fn(async () => {}); root.child({ close }); const failed = root.child();
  let oldToken!: { current(): boolean };
  await expect(failed.run(async token => { oldToken = token; throw new Error("row failed"); }, "row")).rejects.toThrow("row failed");
  await expect(root.close()).rejects.toThrow("row failed"); expect(close).not.toHaveBeenCalled();
  await expect(failed.run(async () => {}, "unrelated")).resolves.toBeUndefined();
  await expect(root.close()).rejects.toThrow("row failed"); expect(close).not.toHaveBeenCalled();
  await failed.retry(async () => {}, "row"); expect(oldToken.current()).toBe(false); await root.close(); expect(close).toHaveBeenCalledOnce();
});
it("does not reopen a child under a failed partially destroyed parent", async () => {
  const registry = new RenderOwnership(); const root = registry.create({}); const child = root.child();
  root.child({ close: async () => { throw new Error("destructor failed"); } });
  await expect(root.close()).rejects.toThrow("destructor failed");
  expect(() => child.run(async () => {})).toThrow(/admission/i);
});
it("preflights every descendant before any close preparation can flush", async () => {
  const registry = new RenderOwnership(); const flush = vi.fn(async () => {}); let draft = true;
  const root = registry.create({}, { prepareClose: flush }); const close = vi.fn(async () => {});
  root.child({ preflightClose: () => { if (draft) throw new Error("active draft"); }, close });
  await expect(root.close()).rejects.toThrow("active draft"); expect(flush).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  draft = false; await root.close(); expect(flush).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});
it("releases every retained owner and the admission latch even if one resume callback fails", async () => {
  const registry = new RenderOwnership(); const one = {}; const two = {}; const resumed = vi.fn();
  registry.create(one, { resume: () => { throw new Error("render resume failed"); } }); registry.create(two, { resume: resumed });
  const held = await registry.hold(new Set([one, two])); expect(() => registry.release(held)).toThrow("render resume failed");
  expect(resumed).toHaveBeenCalledOnce(); expect(registry.admissionOpen).toBe(true);
});
