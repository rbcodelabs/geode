import { installObsidianAppCompat } from "../../src/renderer/api/obsidian";
import { describe, expect, it, vi } from "vitest";
const api = await import("../../src/renderer/properties/property-types").catch(() => ({})) as typeof import("../../src/renderer/properties/property-types");

describe("vault property type registry", () => {
  it("persists case-folded assignments, special names and unknown imported types without prototype keys", async () => {
    expect(api.PropertyTypes).toBeTypeOf("function");
    let stored: unknown = JSON.parse('{"future":{"keep":true},"types":{"Due":"date","__proto__":"future-kind","Alien":"custom"}}');
    const config = { read: vi.fn(async () => stored), write: vi.fn(async (_: string, value: unknown) => { stored = structuredClone(value); }) };
    const registry = new api.PropertyTypes(); await registry.load(config);
    expect(registry.getType("DUE", null)).toBe("date");
    expect(registry.getType("__proto__", null)).toBe("future-kind");
    expect(registry.getType("tags", "one")).toBe("tags");
    expect(() => registry.setType("TAGS", "text")).toThrow(/reserved/i);
    expect(registry.setType("Created", "datetime")).toBeUndefined();
    await registry.flush();
    const reopened = new api.PropertyTypes(); await reopened.load(config);
    expect(reopened.getPropertyInfo("CREATED")).toMatchObject({ type: "datetime" });
    expect(stored).toMatchObject({ future: { keep: true }, types: { alien: "custom", due: "date", created: "datetime" } });
    expect(Object.getPrototypeOf(registry.getAllProperties())).toBe(null);
  });
  it("rolls back a failed write, reports it, and serializes later changes against the corrected map", async () => {
    const registry = new api.PropertyTypes();
    const saved: unknown[] = []; let first = true;
    await registry.load({ read: async () => null, write: async (_: string, value: unknown) => { if (first) { first = false; throw new Error("disk full"); } saved.push(structuredClone(value)); } });
    const errors = vi.fn(); registry.onError(errors);
    registry.setType("Due", "date"); registry.setType("Other", "number");
    await registry.flush();
    expect(registry.getPropertyInfo("Due")).toBe(null);
    expect(registry.getType("Other", null)).toBe("number");
    expect(saved).toEqual([{ types: { other: "number" } }]); expect(errors).toHaveBeenCalledOnce();
  });
  it("restores the acknowledged type after multiple same-key failures", async () => {
    const registry = new api.PropertyTypes();
    await registry.load({ read: async () => ({ types: { due: "text" } }), write: async () => { throw new Error("offline"); } });
    registry.setType("Due", "date"); registry.setType("Due", "datetime"); await registry.flush();
    expect(registry.getType("Due", null)).toBe("text");
  });
  it("drains writes before close and rejects stale owners, while a second vault has independent types", async () => {
    const first = new api.PropertyTypes(), second = new api.PropertyTypes();
    let release!: () => void; let done = false;
    await first.load({ read: async () => null, write: () => new Promise<void>(resolve => { release = resolve; }) });
    await second.load({ read: async () => null, write: async () => {} });
    first.setType("Due", "date"); const close = first.close().then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false); release(); await close;
    expect(() => first.setType("Due", "text")).toThrow(/closed/i);
    expect(second.getPropertyInfo("Due")).toBe(null);
  });
  it("retains local date/time seconds without timezone conversion and refuses incompatible values", () => {
    expect(api.isPropertyTypeValue("datetime", "2026-10-14T22:49:31")).toBe(true);
    expect(api.isPropertyTypeValue("date", "2026-02-29")).toBe(false);
    expect(api.isPropertyTypeValue("date", "2024-02-29")).toBe(true);
    expect(api.isPropertyTypeValue("datetime", "2026-10-14T22:49:31Z")).toBe(false);
    expect(api.isPropertyTypeValue("date", null)).toBe(true);
    expect(api.isPropertyTypeValue("number", "12")).toBe(false);
    expect(api.isPropertyTypeValue("custom", "unrecognized")).toBe(false);
  });
});

it("installs the plugin compatibility adapter over the same owner and keeps a safe test fallback", async () => {
  const registry = new api.PropertyTypes();
  const app: any = { propertyTypes: registry };
  installObsidianAppCompat(app);
  expect(app.metadataTypeManager.setType("Due", "date")).toBeUndefined();
  expect(registry.getType("due", null)).toBe("date");
  registry.setType("Due", "datetime");
  expect(app.metadataTypeManager.getAllProperties().due.type).toBe("datetime");
  const fallback: any = {}; installObsidianAppCompat(fallback);
  fallback.metadataTypeManager.setType("__proto__", "text");
  expect(fallback.metadataTypeManager.getPropertyInfo("__proto__").type).toBe("text");
});

it("refuses mutations after a failed read without replacing unknown persisted data", async () => {
  const registry = new api.PropertyTypes(), write = vi.fn(async () => {});
  await expect(registry.load({ read: async () => { throw new Error("unavailable"); }, write })).rejects.toThrow("unavailable");
  expect(() => registry.setType("Due", "date")).toThrow(); expect(write).not.toHaveBeenCalled();
});
it("persists one ordered assignment at a time, without admitting later optimistic values early", async () => {
  const registry = new api.PropertyTypes(), saved: unknown[] = [];
  await registry.load({ read: async () => null, write: async (_: string, value: unknown) => { saved.push(structuredClone(value)); } });
  registry.setType("First", "date"); registry.setType("Second", "number"); await registry.flush();
  expect(saved).toEqual([{ types: { first: "date" } }, { types: { first: "date", second: "number" } }]);
});
it("refuses a non-map imported type document without overwriting it", async () => {
  const registry = new api.PropertyTypes(), write = vi.fn(async () => {});
  await expect(registry.load({ read: async () => ({ types: ["future document"] }), write })).rejects.toThrow(/format/i);
  expect(() => registry.setType("Due", "date")).toThrow(); expect(write).not.toHaveBeenCalled();
});
it("does not expose the previous vault's assignments if the next vault read fails", async () => {
  const registry = new api.PropertyTypes();
  await registry.load({ read: async () => ({ types: { private: "date" } }), write: async () => {} });
  await registry.close();
  await expect(registry.load({ read: async () => { throw new Error("new vault unavailable"); }, write: async () => {} })).rejects.toThrow();
  expect(registry.getPropertyInfo("private")).toBe(null);
});
