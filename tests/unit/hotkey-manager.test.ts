import { describe, expect, it, vi } from "vitest";
import { CommandRegistry, type Command } from "../../src/renderer/commands";

const command = (id: string, extra: Partial<Command> = {}): Command => ({ id, name: id, ...extra });

describe("hotkey override manager", () => {
  it("supports multiple defaults, replacement, disabling, and reset", async () => {
    const write = vi.fn(async () => {});
    const registry = new CommandRegistry({ read: async () => null, write });
    registry.add(command("a", { hotkeys: [{ modifiers: ["Mod"], code: "KeyA" }, { modifiers: ["Alt"], code: "KeyA" }] }));
    await registry.loadHotkeys();
    expect(registry.bindingsFor("a")).toHaveLength(2);
    await registry.setBindings("a", []);
    expect(registry.bindingsFor("a")).toEqual([]);
    await registry.resetBindings("a");
    expect(registry.bindingsFor("a")).toHaveLength(2);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("deduplicates duplicate bindings declared by one command", () => {
    const registry = new CommandRegistry();
    const binding = { modifiers: ["Mod"] as const, code: "KeyA" };
    registry.add(command("a", { hotkeys: [binding, binding] }));
    expect(registry.bindingsFor("a")).toEqual([{ modifiers: ["Mod"], code: "KeyA" }]);
    expect(registry.hotkeys()).toEqual(["Mod+KeyA"]);
  });

  it("returns immutable snapshot objects", () => {
    const registry = new CommandRegistry();
    registry.add(command("a", { hotkey: "Mod+A" }));
    const snapshot = registry.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.bindingsByCommand)).toBe(true);
    expect(Object.isFrozen(snapshot.bindingsByCommand.a)).toBe(true);
    expect(Object.isFrozen(snapshot.bindingsByCommand.a[0])).toBe(true);
  });

  it("preserves unknown command overrides across plugin unload and reload", async () => {
    const saved = { version: 1, overrides: { "plug:run": [{ modifiers: ["Mod"], code: "KeyR" }] } };
    const registry = new CommandRegistry({ read: async () => saved, write: async () => {} });
    await registry.loadHotkeys();
    registry.add(command("plug:run", { hotkey: "Mod+P" }));
    expect(registry.hotkeys()).toEqual(["Mod+KeyR"]);
    registry.remove("plug:run");
    registry.add(command("plug:run", { hotkey: "Mod+P" }));
    expect(registry.hotkeys()).toEqual(["Mod+KeyR"]);
  });

  it("detects an exact conflict without mutation, then atomically reassigns all owners", async () => {
    const write = vi.fn(async () => {});
    const registry = new CommandRegistry({ read: async () => null, write });
    registry.add(command("a", { hotkey: "Mod+P" }));
    registry.add(command("b", { hotkey: "Mod+P" }));
    registry.add(command("target"));
    await registry.loadHotkeys();
    const binding = { modifiers: ["Mod"] as const, code: "KeyP" };
    expect(await registry.assignBinding("target", binding)).toEqual({ status: "conflict", owners: ["a", "b"] });
    expect(write).not.toHaveBeenCalled();
    expect(registry.dispatchHotkey("Mod+KeyP")).toBe(false);
    expect(await registry.assignBinding("target", binding, { reassign: true })).toEqual({ status: "assigned" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(registry.bindingsFor("a")).toEqual([]);
    expect(registry.bindingsFor("b")).toEqual([]);
    expect(registry.bindingsFor("target")).toEqual([{ modifiers: ["Mod"], code: "KeyP" }]);
  });

  it("fails closed for duplicate defaults in every registration order", () => {
    for (const ids of [["a", "b"], ["b", "a"]]) {
      const registry = new CommandRegistry();
      for (const id of ids) registry.add(command(id, { hotkey: "Mod+P", callback: () => { throw new Error("must not run"); } }));
      expect(registry.hotkeys()).toEqual([]);
      expect(registry.dispatchHotkey("Mod+KeyP")).toBe(false);
    }
  });

  it("preserves malformed manual overrides on unrelated writes and fails them closed", async () => {
    const write = vi.fn(async () => {});
    const saved = { version: 1, overrides: { broken: [{ modifiers: ["Mod"], code: "<script>" }] } };
    const registry = new CommandRegistry({ read: async () => saved, write });
    registry.add(command("broken", { hotkey: "Mod+B" })); registry.add(command("other"));
    await registry.loadHotkeys();
    expect(registry.bindingsFor("broken")).toEqual([]);
    await registry.setBindings("other", [{ modifiers: ["Mod"], code: "KeyO" }]);
    expect(write.mock.calls[0][1]).toMatchObject({ overrides: { broken: saved.overrides.broken } });
  });

  it("replaces malformed state when the same registry loads a different vault", async () => {
    const reads = [
      { version: 1, overrides: { shared: [{ modifiers: ["Mod"], code: "<bad>" }], onlyA: "broken" } },
      { version: 1, overrides: { shared: [{ modifiers: ["Mod"], code: "KeyB" }] } },
    ];
    const write = vi.fn(async () => {});
    const registry = new CommandRegistry({ read: async () => reads.shift(), write });
    registry.add(command("shared", { hotkey: "Mod+S" })); registry.add(command("other"));
    await registry.loadHotkeys();
    expect(registry.bindingsFor("shared")).toEqual([]);
    await registry.loadHotkeys();
    expect(registry.bindingsFor("shared")).toEqual([{ modifiers: ["Mod"], code: "KeyB" }]);
    await registry.setBindings("other", [{ modifiers: ["Mod"], code: "KeyO" }]);
    const persisted = write.mock.calls[0][1] as any;
    expect(persisted.overrides.onlyA).toBeUndefined();
    expect(persisted.overrides.shared).toEqual([{ modifiers: ["Mod"], code: "KeyB" }]);
  });

  it("normalizes and deduplicates setBindings inputs and rejects invalid bindings", async () => {
    const write = vi.fn(async () => {});
    const registry = new CommandRegistry({ read: async () => null, write });
    registry.add(command("a")); await registry.loadHotkeys();
    await registry.setBindings("a", [
      { modifiers: ["Shift", "Mod"], code: "KeyA" },
      { modifiers: ["Mod", "Shift"], code: "KeyA" },
    ]);
    expect(registry.bindingsFor("a")).toEqual([{ modifiers: ["Mod", "Shift"], code: "KeyA" }]);
    await expect(registry.setBindings("a", [{ modifiers: ["Mod"], code: "<bad>" }])).rejects.toThrow("Invalid hotkey binding");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not publish state when persistence fails", async () => {
    const registry = new CommandRegistry({ read: async () => null, write: async () => { throw new Error("disk full"); } });
    registry.add(command("a", { hotkey: "Mod+A" }));
    await registry.loadHotkeys();
    await expect(registry.setBindings("a", [{ modifiers: ["Mod"], code: "KeyB" }])).rejects.toThrow("disk full");
    expect(registry.hotkeys()).toEqual(["Mod+KeyA"]);
  });

  it("live snapshots update for plugin registration and unavailable commands never fall through", async () => {
    let fired = 0;
    const registry = new CommandRegistry();
    const changes = vi.fn();
    registry.onChange(changes);
    registry.add(command("blocked", { hotkey: "Mod+G", checkCallback: checking => checking ? false : (fired++, true) }));
    registry.add(command("duplicate", { hotkey: "Mod+G", callback: () => fired++ }));
    expect(registry.dispatchHotkey("Mod+KeyG")).toBe(false);
    registry.remove("duplicate");
    expect(registry.dispatchHotkey("Mod+KeyG")).toBe(false);
    expect(fired).toBe(0);
    expect(changes).toHaveBeenCalledTimes(3);
  });
});
