import { expect, it, vi } from "vitest";
import { RenderOwnership, RenderScope } from "../../src/renderer/workspaces/render-ownership";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const closeWith = (scope: RenderScope, context: object) => Reflect.apply(scope.close, scope, [context]) as Promise<void>;

it("forwards one immutable close context only to root preflight and prepare callbacks", async () => {
  const registry = new RenderOwnership(), context = Object.freeze({});
  const roots: unknown[] = [], children: unknown[] = [];
  const root = registry.create({}, { preflightClose: (value?: object) => { roots.push(value); }, prepareClose: async (value?: object) => { roots.push(value); } });
  root.child({ preflightClose: (value?: object) => { children.push(value); }, prepareClose: async (value?: object) => { children.push(value); } });
  await closeWith(root, context);
  expect(roots.length).toBeGreaterThanOrEqual(3); expect(roots.every(value => value === context)).toBe(true);
  expect(children.length).toBeGreaterThanOrEqual(3); expect(children.every(value => value === undefined)).toBe(true);
});
it("keeps readiness and prepared retirement contextless", async () => {
  const registry = new RenderOwnership(); const seen: unknown[] = [];
  const scope = registry.create({}, { preflightClose: (value?: object) => { seen.push(value); }, prepareClose: async (value?: object) => { seen.push(value); } });
  scope.assertRetirementReady(); const prepared = await RenderScope.prepareRetirement([scope]); await prepared.commit();
  expect(seen.length).toBeGreaterThanOrEqual(4); expect(seen.every(value => value === undefined)).toBe(true);
});
it("does not let a root exception authorize a strict descendant", async () => {
  const registry = new RenderOwnership(), context = {}; const close = vi.fn(async () => {});
  const root = registry.create({}, { preflightClose: (value?: object) => { if (value !== context) throw Error("wrong root context"); }, close });
  root.child({ preflightClose: (value?: object) => { expect(value).toBeUndefined(); throw Error("finish descendant"); }, close });
  await expect(closeWith(root, context)).rejects.toThrow("finish descendant"); expect(close).not.toHaveBeenCalled(); expect(root.admissionAllowed).toBe(true);
});
it("joins a pending contextless close without upgrading it", async () => {
  const registry = new RenderOwnership(), gate = deferred(), context = {}; const seen: unknown[] = [];
  const root = registry.create({}, { preflightClose: (value?: object) => { seen.push(value); }, prepareClose: async (value?: object) => { seen.push(value); await gate.promise; } });
  const first = root.close(); const repeated = closeWith(root, context); expect(repeated).toBe(first);
  gate.resolve(); await repeated; expect(seen.every(value => value === undefined)).toBe(true);
});
it("joins repeated ordinary close without substituting a later context", async () => {
  const registry = new RenderOwnership(), gate = deferred(), firstContext = {}, otherContext = {}; const seen: unknown[] = [];
  const root = registry.create({}, { preflightClose: (value?: object) => { seen.push(value); }, prepareClose: async (value?: object) => { seen.push(value); await gate.promise; } });
  const first = closeWith(root, firstContext); expect(closeWith(root, otherContext)).toBe(first);
  gate.resolve(); await first; expect(seen.length).toBeGreaterThanOrEqual(3); expect(seen.every(value => value === firstContext)).toBe(true);
});
it.each(["frozen", "registry"])("refuses a new contextual close while %s admission is unavailable", async state => {
  const registry = new RenderOwnership(); const close = vi.fn(async () => {}); const root = registry.create({}, { close });
  if (state === "frozen") root.freezeAdmission(); else registry.admissionOpen = false;
  await expect(closeWith(root, {})).rejects.toThrow(/admission|paused|owner/i); expect(close).not.toHaveBeenCalled();
});
it("retains contextless cleanup for an already frozen root", async () => {
  const registry = new RenderOwnership(); const close = vi.fn(async () => {}); const root = registry.create({}, { close });
  root.freezeAdmission(); await root.close(); expect(close).toHaveBeenCalledOnce();
});
