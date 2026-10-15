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
  const registry = new RenderOwnership(); const owner = {}; registry.create(owner); registry.create({});
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
it("propagates a rejected native initialization or pending row write through the barrier", async () => {
  const registry = new RenderOwnership(); const root = registry.create({});
  await expect(root.run(async () => { throw new Error("source row write failed"); })).rejects.toThrow("source row write failed");
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
