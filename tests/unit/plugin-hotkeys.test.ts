import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../../src/renderer/commands";
import { Plugin } from "../../src/renderer/plugin";

class ProbePlugin extends Plugin {}
const manifest = { id: "probe", name: "Probe", version: "1.0.0", minAppVersion: "0.1.0", description: "", author: "" };

describe("Plugin structured hotkeys", () => {
  it("preserves multiple defaults through add, unload, and re-register with saved overrides", async () => {
    const saved = { version: 1, overrides: { "probe:run": [{ modifiers: ["Mod"], code: "KeyR" }] } };
    const registry = new CommandRegistry({ read: async () => saved, write: async () => {} });
    await registry.loadHotkeys();
    const app = { commands: registry } as any;
    const plugin = new ProbePlugin(app, manifest);
    const defaults = [{ modifiers: ["Mod"] as const, code: "KeyP" }, { modifiers: ["Alt"] as const, code: "KeyP" }];
    const command = plugin.addCommand({ id: "run", name: "Run", hotkeys: defaults, callback: () => {} });
    expect(command.hotkeys).toEqual(defaults);
    expect(registry.bindingsFor("probe:run")).toEqual([{ modifiers: ["Mod"], code: "KeyR" }]);
    plugin.unload();
    expect(registry.has("probe:run")).toBe(false);
    new ProbePlugin(app, manifest).addCommand({ id: "run", name: "Run", hotkeys: defaults, callback: () => {} });
    expect(registry.bindingsFor("probe:run")).toEqual([{ modifiers: ["Mod"], code: "KeyR" }]);
  });
});

describe("Plugin editor commands", () => {
  it.each([
    ["zero styles", {}],
    ["callback plus checkCallback", { callback: () => {}, checkCallback: () => true }],
    ["callback plus editorCallback", { callback: () => {}, editorCallback: () => {} }],
    ["editorCallback plus editorCheckCallback", { editorCallback: () => {}, editorCheckCallback: () => true }],
    ["all four styles", {
      callback: () => {},
      checkCallback: () => true,
      editorCallback: () => {},
      editorCheckCallback: () => true,
    }],
  ])("rejects %s before registry or cleanup registration", (_label, styles) => {
    const commands = { add: vi.fn(), remove: vi.fn() };
    const plugin = new ProbePlugin({ commands } as any, manifest);
    const register = vi.spyOn(plugin, "register");

    expect(() => plugin.addCommand({ id: "invalid", name: "Invalid", ...styles })).toThrow(
      new TypeError("Command \"invalid\" must define exactly one execution style"),
    );
    expect(commands.add).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();

    plugin.unload();
    expect(commands.remove).not.toHaveBeenCalled();
  });

  it("registers guarded editor callback variants and removes them on unload", () => {
    const registry = new CommandRegistry();
    const plugin = new ProbePlugin({ commands: registry } as any, manifest);
    const editorCallback = vi.fn();
    const editorCheckCallback = vi.fn(() => true);

    const editorCommand = plugin.addCommand({ id: "edit", name: "Edit", editorCallback } as any) as any;
    const checkedCommand = plugin.addCommand({ id: "checked", name: "Checked", editorCheckCallback } as any) as any;

    expect(editorCommand.editorCallback).toBeTypeOf("function");
    expect(checkedCommand.editorCheckCallback).toBeTypeOf("function");
    expect(editorCommand.editorCallback).not.toBe(editorCallback);
    expect(checkedCommand.editorCheckCallback).not.toBe(editorCheckCallback);
    editorCommand.editorCallback("editor", "view");
    checkedCommand.editorCheckCallback(true, "editor", "view");
    expect(editorCallback).toHaveBeenCalledWith("editor", "view");
    expect(editorCheckCallback).toHaveBeenCalledWith(true, "editor", "view");

    plugin.unload();
    expect(registry.has("probe:edit")).toBe(false);
    expect(registry.has("probe:checked")).toBe(false);
  });
});
