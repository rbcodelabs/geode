import { describe, expect, it } from "vitest";
import { CommandRegistry, type Command } from "../../src/renderer/commands";

function cmd(id: string, extra: Partial<Command> = {}): Command {
  return { id, name: id, ...extra };
}

describe("CommandRegistry", () => {
  it("backs `commands` with a plain Record, not a Map (Obsidian's app.commands.commands shape)", () => {
    const registry = new CommandRegistry();
    registry.add(cmd("a"));
    expect(registry.commands).not.toBeInstanceOf(Map);
    const proto = Object.getPrototypeOf(registry.commands);
    expect(proto === Object.prototype || proto === null).toBe(true);
    expect(registry.commands["a"]).toEqual(cmd("a"));
  });

  it("keeps live object identity: mutating the stored command through `commands[id]` is visible everywhere", () => {
    const registry = new CommandRegistry();
    const c = cmd("live");
    registry.add(c);
    registry.commands["live"].name = "Renamed";
    expect(registry.findCommand("live")?.name).toBe("Renamed");
    expect(c.name).toBe("Renamed"); // same object, not a copy
  });

  it("addCommand/removeCommand/findCommand are aliases for add/remove/(commands[id])", () => {
    const registry = new CommandRegistry();
    const c = cmd("aliased");
    registry.addCommand(c);
    expect(registry.commands["aliased"]).toBe(c);
    expect(registry.findCommand("aliased")).toBe(c);
    registry.removeCommand("aliased");
    expect(registry.commands["aliased"]).toBeUndefined();
    expect(registry.findCommand("aliased")).toBeUndefined();
  });

  it("delete semantics: remove() actually deletes the key (not just sets it undefined)", () => {
    const registry = new CommandRegistry();
    registry.add(cmd("gone"));
    registry.remove("gone");
    expect(Object.prototype.hasOwnProperty.call(registry.commands, "gone")).toBe(false);
    expect(registry.has("gone")).toBe(false);
    // Removing twice, or a never-added id, is a no-op (idempotent).
    expect(() => registry.remove("gone")).not.toThrow();
    expect(() => registry.remove("never-existed")).not.toThrow();
  });

  it('has()/findCommand() use hasOwnProperty, so "toString" (an inherited Object.prototype key) is not a command', () => {
    const registry = new CommandRegistry();
    expect(registry.has("toString")).toBe(false);
    expect(registry.findCommand("toString")).toBeUndefined();
    expect(registry.execute("toString")).toBe(false);
  });

  it("listCommands() returns every registered command unfiltered, including checkCallback-unavailable ones", () => {
    const registry = new CommandRegistry();
    registry.add(cmd("always"));
    registry.add(cmd("gated", { checkCallback: (checking) => (checking ? false : undefined) }));
    const all = registry.listCommands();
    expect(all).toHaveLength(2);
    expect(all.map((c) => c.id).sort()).toEqual(["always", "gated"]);
  });

  it("list() filters to checkCallback-available commands and sorts by name (command-palette contract)", () => {
    const registry = new CommandRegistry();
    registry.add(cmd("z-cmd", { name: "Zeta" }));
    registry.add(cmd("a-cmd", { name: "Alpha" }));
    registry.add(cmd("gated", { name: "Gated", checkCallback: (checking) => (checking ? false : undefined) }));
    const available = registry.list();
    expect(available.map((c) => c.id)).toEqual(["a-cmd", "z-cmd"]); // sorted, gated excluded
    // The deliberate divergence from listCommands(), pinned:
    expect(registry.listCommands()).toHaveLength(3);
  });

  it("execute()/executeCommandById() return true and run the callback for a known, available command", () => {
    const registry = new CommandRegistry();
    let fired = 0;
    registry.add(cmd("runnable", { callback: () => fired++ }));
    expect(registry.executeCommandById("runnable")).toBe(true);
    expect(fired).toBe(1);
    expect(registry.execute("runnable")).toBe(true);
    expect(fired).toBe(2);
  });

  it("execute()/executeCommandById() return false for an unknown id, without throwing", () => {
    const registry = new CommandRegistry();
    expect(registry.execute("nope")).toBe(false);
    expect(registry.executeCommandById("nope")).toBe(false);
  });

  it("execute() returns false and does not run a checkCallback-gated command that reports unavailable", () => {
    const registry = new CommandRegistry();
    let fired = 0;
    registry.add(
      cmd("gated", {
        checkCallback: (checking) => {
          if (checking) return false;
          fired++;
        },
      })
    );
    expect(registry.execute("gated")).toBe(false);
    expect(fired).toBe(0);
  });
});
