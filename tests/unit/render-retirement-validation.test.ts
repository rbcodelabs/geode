import { expect, it, vi } from "vitest";
import { RenderOwnership, RenderScope } from "../../src/renderer/workspaces/render-ownership";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

it("validates only after every affected tree has completed mutating preparation", async () => {
  const registry = new RenderOwnership(); const gate = deferred(); const events: string[] = [];
  const first = registry.create({}, { validateClose: async () => { events.push("validate"); expect(events).toContain("child prepared"); expect(events).toContain("sibling prepared"); } });
  first.child({ prepareClose: async () => { events.push("child prepared"); } });
  const second = registry.create({}, { prepareClose: async () => { await gate.promise; events.push("sibling prepared"); } });
  const preparing = RenderScope.prepareRetirement([first, second]);
  await Promise.resolve(); expect(events).not.toContain("validate"); gate.resolve(); const handle = await preparing;
  expect(events.at(-1)).toBe("validate"); expect(handle.destructionStarted).toBe(false); await handle.commit(); expect(handle.destructionStarted).toBe(true);
});
it("read-only rejection does not become an acknowledged-write requirement", async () => {
  const registry = new RenderOwnership(); let readable = false; const close = vi.fn(async () => {});
  const scope = registry.create({}, { failureKey: "save", prepareClose: async () => {}, validateClose: async () => { if (!readable) throw new Error("copy unavailable"); }, close });
  await expect(scope.close()).rejects.toThrow("copy unavailable"); expect(scope.hasUnacknowledgedWrites).toBe(false); expect(scope.admissionAllowed).toBe(true);
  readable = true; await scope.close(); expect(close).toHaveBeenCalledOnce();
});
it("retains actual preparation write failures even if read validation is repaired", async () => {
  const registry = new RenderOwnership(); let writable = false;
  const scope = registry.create({}, { failureKey: "save", prepareClose: async () => { if (!writable) throw new Error("write failed"); }, validateClose: async () => {} });
  await expect(scope.close()).rejects.toThrow("write failed"); writable = true;
  await expect(scope.close()).rejects.toThrow("write failed"); await scope.retry(async () => {}, "save"); await scope.close();
});
it("waits for started sibling validation before resuming a refused forest", async () => {
  const registry = new RenderOwnership(); const gate = deferred(); let finished = false;
  const first = registry.create({}, { validateClose: async () => { throw new Error("invalid"); } });
  const second = registry.create({}, { validateClose: async () => { await gate.promise; finished = true; } });
  const preparing = RenderScope.prepareRetirement([first, second]); const refusal = expect(preparing).rejects.toThrow("invalid");
  await Promise.resolve(); await Promise.resolve(); expect(first.admissionAllowed).toBe(false); gate.resolve(); await refusal;
  expect(finished).toBe(true); expect(first.admissionAllowed).toBe(true); expect(second.admissionAllowed).toBe(true);
});
it("checks late child drafts after validation before any ordinary destructor", async () => {
  const registry = new RenderOwnership(); let draft = false; const close = vi.fn(async () => {});
  const root = registry.create({}, { validateClose: async () => { draft = true; }, close });
  root.child({ preflightClose: () => { if (draft) throw new Error("finish draft"); }, close });
  await expect(root.close()).rejects.toThrow("finish draft"); expect(close).not.toHaveBeenCalled(); expect(root.admissionAllowed).toBe(true);
});
it("aborts a rejected commit before destruction exactly once and cannot revive that handle", async () => {
  const registry = new RenderOwnership(); let draft = false; const close = vi.fn(async () => {}); const resume = vi.fn();
  const first = registry.create({}, { close, resume }); const second = registry.create({}, { preflightClose: () => { if (draft) throw new Error("late draft"); }, close, resume });
  const handle = await RenderScope.prepareRetirement([first, second]); draft = true;
  await expect(handle.commit()).rejects.toThrow("late draft"); expect(handle.destructionStarted).toBe(false); expect(close).not.toHaveBeenCalled();
  handle.abort(); handle.abort(); expect(resume).toHaveBeenCalledTimes(2); expect(first.admissionAllowed).toBe(true); expect(second.admissionAllowed).toBe(true);
  draft = false; await expect(handle.commit()).rejects.toThrow(); expect(close).not.toHaveBeenCalled();
});
it("never resumes a forest after a partial destructor failure", async () => {
  const registry = new RenderOwnership(); const resume = vi.fn();
  const first = registry.create({}, { close: async () => {}, resume }); const second = registry.create({}, { close: async () => { throw new Error("destructor failed"); }, resume });
  const handle = await RenderScope.prepareRetirement([first, second]); await expect(handle.commit()).rejects.toThrow("destructor failed");
  expect(handle.destructionStarted).toBe(true); handle.abort(); expect(resume).not.toHaveBeenCalled(); expect(first.closed).toBe(true); expect(second.closed).toBe(true);
});
it("waits for already-started sibling work before resuming a failed preparation", async () => {
  const registry = new RenderOwnership(); const root = registry.create({}); const first = root.child(); const second = root.child(); const gate = deferred();
  await first.run(async () => { throw new Error("retained write"); }, "save").catch(() => {});
  const pending = second.run(async token => { await gate.promise; token.check(); }); void pending.catch(() => {}); await Promise.resolve();
  let settled = false; const preparing = RenderScope.prepareRetirement([root]).finally(() => { settled = true; }); const refusal = expect(preparing).rejects.toThrow("retained write");
  await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false); expect(root.admissionAllowed).toBe(false);
  gate.resolve(); await refusal; expect(root.admissionAllowed).toBe(true);
});
it("waits for a delayed sibling prepare after another prepare rejects", async () => {
  const registry = new RenderOwnership(); const gate = deferred(); let settled = false;
  const first = registry.create({}, { prepareClose: async () => { throw new Error("save failed"); } });
  const second = registry.create({}, { prepareClose: async () => { await gate.promise; settled = true; } });
  const preparing = RenderScope.prepareRetirement([first, second]); const refusal = expect(preparing).rejects.toThrow("save failed");
  await new Promise(resolve => setImmediate(resolve)); expect(first.admissionAllowed).toBe(false); gate.resolve(); await refusal; expect(settled).toBe(true);
});
