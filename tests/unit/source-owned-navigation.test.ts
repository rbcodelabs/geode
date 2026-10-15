import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
import { describe, expect, it } from "vitest";
import { SourceOwnedNavigation, captureNavigationOrigin } from "../../src/renderer/markdown/source-owned-navigation";

function fixture() {
  let current = true, dirty = false;
  const calls: string[] = [];
  const navigation = new SourceOwnedNavigation({
    capture: () => {
      calls.push("capture");
      return () => { calls.push("current"); if (!current) throw new Error("Owner replaced"); };
    },
    preflight: () => { calls.push("preflight"); if (dirty) throw new Error("Finish native edit"); },
    execute: async (_request, validate) => { calls.push("queued"); validate(); calls.push("effect"); },
    notify: message => calls.push(message),
  });
  return { navigation, calls, dirty: () => { dirty = true; }, replace: () => { current = false; } };
}

describe("source-owned navigation intent", () => {
  const request = { kind: "link" as const, linktext: "Other", sourcePath: "Host.md", newTab: false };
  it("refuses a dirty owner synchronously before any queued effect", async () => {
    const state = fixture(); state.dirty();
    const intent = state.navigation.prepareNavigation(request);
    expect(intent.state).toBe("refused");
    expect(await intent.completion).toEqual({ status: "refused" });
    expect(state.calls).not.toContain("queued");
    expect(state.calls).toContain("Finish native edit");
  });
  it("stages without effects and dispatches once through the current owner", async () => {
    const state = fixture(); const intent = state.navigation.prepareNavigation(request);
    expect(intent.state).toBe("staged"); expect(state.calls).not.toContain("queued");
    const first = intent.dispatch(); const second = intent.dispatch();
    expect(first).toBe(second);
    expect(await first).toEqual({ status: "completed" });
    expect(state.calls.filter(call => call === "effect")).toHaveLength(1);
  });
  it("refuses an owner replaced between pointer preparation and click", async () => {
    const state = fixture(); const intent = state.navigation.prepareNavigation(request); state.replace();
    expect(await intent.dispatch()).toEqual({ status: "refused" });
    expect(state.calls).not.toContain("queued");
  });
  it("rechecks dirty state at actual click rather than trusting preparation", async () => {
    const state = fixture(); const intent = state.navigation.prepareNavigation(request); state.dirty();
    expect(await intent.dispatch()).toEqual({ status: "refused" });
    expect(state.calls).not.toContain("effect");
  });
  it("cancels a staged gesture without admitting its later click", async () => {
    const state = fixture(); const intent = state.navigation.prepareNavigation(request);
    intent.cancel();
    expect(await intent.completion).toEqual({ status: "cancelled" });
    expect(await intent.dispatch()).toEqual({ status: "cancelled" });
    expect(state.calls).not.toContain("effect");
  });
  it("rechecks the owner when queued work starts after an external change", async () => {
    let valid = true, release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    const effects: string[] = [];
    const navigation = new SourceOwnedNavigation({
      capture: () => () => { if (!valid) throw new Error("Owner replaced"); },
      preflight: () => {}, notify: () => {},
      execute: async (_request, validate) => { await gate; validate(); effects.push("write"); },
    });
    const intent = navigation.prepareNavigation(request); const completion = intent.dispatch();
    valid = false; release();
    expect(await completion).toEqual({ status: "refused" });
    expect(effects).toEqual([]);
  });

});

// These controls use actual lifecycle tokens without registering navigation as render work.

describe("source navigation descendant lifetime", () => {
  const request = { kind: "link" as const, linktext: "Other", sourcePath: "Host.md", newTab: false };
  it("refuses a retired Host even while the outer owner remains current", async () => {
    const state = fixture(), root = new RenderOwnership().create({}), host = root.child({});
    const intent = state.navigation.prepareNavigation(request, captureNavigationOrigin(host));
    await host.close();
    expect(await intent.dispatch()).toEqual({ status: "refused" });
    expect(state.calls).not.toContain("effect"); expect(root.closed).toBe(false);
  });
  it("rejects the old generation and admits a fresh gesture after resume", async () => {
    const state = fixture(), root = new RenderOwnership().create({}), host = root.child({});
    const old = state.navigation.prepareNavigation(request, captureNavigationOrigin(host));
    root.freezeAdmission(); root.resume();
    expect(await old.dispatch()).toEqual({ status: "refused" });
    expect(await state.navigation.prepareNavigation(request, captureNavigationOrigin(host)).dispatch()).toEqual({ status: "completed" });
  });
});
