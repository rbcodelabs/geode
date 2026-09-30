import { describe, expect, it, vi } from "vitest";
import { OnboardingRegistry, OnboardingRegistryError } from "../../src/renderer/internal-plugins/onboarding/registry";

const step = (over: Record<string, unknown> = {}) => ({
  id: "acme:first",
  ownerId: "acme",
  title: "First",
  ...over,
});

describe("OnboardingRegistry.registerStep", () => {
  it("registers and lists a step, and the disposer removes it", () => {
    const reg = new OnboardingRegistry();
    const dispose = reg.registerStep(step());
    expect(reg.list().map((s) => s.id)).toEqual(["acme:first"]);
    dispose();
    expect(reg.list()).toEqual([]);
  });

  it("rejects duplicate ids with a clear error naming the owner", () => {
    const reg = new OnboardingRegistry();
    reg.registerStep(step());
    expect(() => reg.registerStep(step({ title: "again" }))).toThrow(OnboardingRegistryError);
    expect(() => reg.registerStep(step())).toThrow(/already registered.*acme/);
  });

  it("rejects ids that are not namespaced by the owner", () => {
    const reg = new OnboardingRegistry();
    expect(() => reg.registerStep(step({ id: "first" }))).toThrow(/namespaced/);
    expect(() => reg.registerStep(step({ id: "other:first" }))).toThrow(/namespaced/);
    expect(() => reg.registerStep(step({ id: "acme:" }))).toThrow(/namespaced/);
  });

  it("rejects a missing title, missing owner, or non-function check", () => {
    const reg = new OnboardingRegistry();
    expect(() => reg.registerStep(step({ title: "  " }))).toThrow(/title/);
    expect(() => reg.registerStep(step({ ownerId: "" }))).toThrow(/ownerId/);
    expect(() => reg.registerStep(step({ check: "yes" }))).toThrow(/check/);
  });

  it("disposer is idempotent and does not remove a later re-registration", () => {
    const reg = new OnboardingRegistry();
    const first = reg.registerStep(step());
    first();
    reg.registerStep(step({ title: "second" }));
    first();
    expect(reg.list()[0].title).toBe("second");
  });

  it("allows re-registering an id after dispose", () => {
    const reg = new OnboardingRegistry();
    reg.registerStep(step())();
    expect(() => reg.registerStep(step())).not.toThrow();
  });

  it("sorts by order then registration sequence", () => {
    const reg = new OnboardingRegistry();
    reg.registerStep(step({ id: "acme:c", title: "c" }));
    reg.registerStep(step({ id: "acme:b", title: "b", order: 1 }));
    reg.registerStep(step({ id: "acme:a", title: "a" }));
    expect(reg.list().map((s) => s.id)).toEqual(["acme:b", "acme:c", "acme:a"]);
  });
});

describe("owner unload", () => {
  it("unregisterOwner removes only that owner's runtime steps and notifies once", () => {
    const reg = new OnboardingRegistry();
    reg.registerStep(step());
    reg.registerStep(step({ id: "acme:second" }));
    reg.registerStep({ id: "zed:one", ownerId: "zed", title: "Zed" });
    const listener = vi.fn();
    reg.onChange(listener);
    expect(reg.unregisterOwner("acme")).toBe(2);
    expect(reg.list().map((s) => s.id)).toEqual(["zed:one"]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(reg.unregisterOwner("acme")).toBe(0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a disposer called after unregisterOwner is harmless", () => {
    const reg = new OnboardingRegistry();
    const dispose = reg.registerStep(step());
    reg.unregisterOwner("acme");
    expect(() => dispose()).not.toThrow();
  });
});

describe("static (manifest) steps", () => {
  it("namespaces bare ids and marks them static", () => {
    const reg = new OnboardingRegistry();
    reg.replaceStaticSteps(new Map([["acme", [{ id: "setup", title: "Set up", commandId: "acme:setup" }]]]));
    const [s] = reg.list();
    expect(s).toMatchObject({ id: "acme:setup", ownerId: "acme", origin: "static", commandId: "acme:setup" });
  });

  it("flags static steps of disabled owners, but not of enabled ones", () => {
    const enabled = new Set(["on"]);
    const reg = new OnboardingRegistry((id) => enabled.has(id));
    reg.replaceStaticSteps(
      new Map([
        ["on", [{ id: "a", title: "A" }]],
        ["off", [{ id: "a", title: "A" }]],
      ])
    );
    const byId = Object.fromEntries(reg.list().map((s) => [s.id, s.ownerEnabled]));
    expect(byId).toEqual({ "on:a": true, "off:a": false });
  });

  it("a runtime registration of the same id upgrades the static step (adds check, keeps position)", () => {
    const reg = new OnboardingRegistry();
    reg.replaceStaticSteps(
      new Map([["acme", [{ id: "a", title: "A", group: "G" }, { id: "b", title: "B" }]]])
    );
    const check = () => true;
    reg.registerStep({ id: "acme:a", ownerId: "acme", title: "A (live)", check });
    const list = reg.list();
    expect(list.map((s) => s.id)).toEqual(["acme:a", "acme:b"]);
    expect(list[0]).toMatchObject({ origin: "runtime", title: "A (live)", group: "G", ownerEnabled: true });
    expect(list[0].check).toBe(check);
  });

  it("disposing the runtime step falls back to the static one", () => {
    const reg = new OnboardingRegistry();
    reg.replaceStaticSteps(new Map([["acme", [{ id: "a", title: "A" }]]]));
    const dispose = reg.registerStep({ id: "acme:a", ownerId: "acme", title: "A live" });
    dispose();
    expect(reg.list()[0]).toMatchObject({ origin: "static", title: "A" });
  });

  it("replaceStaticSteps drops steps of owners no longer present and emits once", () => {
    const reg = new OnboardingRegistry();
    reg.replaceStaticSteps(new Map([["acme", [{ id: "a", title: "A" }]]]));
    const listener = vi.fn();
    reg.onChange(listener);
    reg.replaceStaticSteps(new Map());
    expect(reg.list()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("onChange", () => {
  it("survives a throwing listener", () => {
    const reg = new OnboardingRegistry();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const good = vi.fn();
    reg.onChange(() => {
      throw new Error("boom");
    });
    reg.onChange(good);
    reg.registerStep(step());
    expect(good).toHaveBeenCalled();
    err.mockRestore();
  });
});
