import { describe, expect, it, vi } from "vitest";
import { CommandRegistry, type Command } from "../../src/renderer/commands";

function cmd(id: string, extra: Partial<Command> = {}): Command {
  return { id, name: id, ...extra };
}

describe("CommandRegistry", () => {
  const editor = { state: { doc: "live" }, dispatch: vi.fn() };
  const view = { viewType: "markdown", mode: "live", editor };
  const withEditor = () => ({ editor, context: view });

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

  // The <webview> hotkey bridge: main needs the combo list up front (its
  // before-input-event handler is synchronous and cannot ask the renderer),
  // and needs a way to run a command from a combo with no DOM event in hand.
  it("hotkeys() lists every bound combo and drops them when the command is removed", () => {
    const registry = new CommandRegistry();
    registry.add(cmd("palette", { hotkey: "Mod+P" }));
    registry.add(cmd("close-tab", { hotkey: "Mod+W" }));
    registry.add(cmd("no-hotkey"));
    expect(registry.hotkeys().sort()).toEqual(["Mod+KeyP", "Mod+KeyW"]);
    registry.remove("close-tab");
    expect(registry.hotkeys()).toEqual(["Mod+KeyP"]);
  });

  it("onChange() fires on add and remove, and stops firing once unsubscribed", () => {
    const registry = new CommandRegistry();
    let changes = 0;
    const unsubscribe = registry.onChange(() => changes++);
    registry.add(cmd("a", { hotkey: "Mod+A" }));
    expect(changes).toBe(1);
    registry.remove("a");
    expect(changes).toBe(2);
    registry.remove("never-existed"); // no-op removals do not notify
    expect(changes).toBe(2);
    unsubscribe();
    registry.add(cmd("b"));
    expect(changes).toBe(2);
  });

  it("dispatchHotkey() runs the bound command and reports whether it did", () => {
    const registry = new CommandRegistry();
    let fired = 0;
    registry.add(cmd("close-tab", { hotkey: "Mod+W", callback: () => fired++ }));
    expect(registry.dispatchHotkey("Mod+KeyW")).toBe(true);
    expect(fired).toBe(1);
    expect(registry.dispatchHotkey("Mod+KeyQ")).toBe(false);
    expect(fired).toBe(1);
  });

  it("dispatchHotkey() respects checkCallback availability, like the document listener does", () => {
    const registry = new CommandRegistry();
    let fired = 0;
    registry.add(
      cmd("gated", {
        hotkey: "Mod+G",
        checkCallback: (checking) => {
          if (checking) return false;
          fired++;
        },
      })
    );
    expect(registry.dispatchHotkey("Mod+G")).toBe(false);
    expect(fired).toBe(0);
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

  it("lists and executes editorCallback commands with the exact active editor context", () => {
    const registry = new (CommandRegistry as any)(undefined, withEditor) as CommandRegistry;
    const callback = vi.fn();
    registry.add(cmd("editor", { editorCallback: callback } as any));

    expect(registry.list().map((command) => command.id)).toContain("editor");
    expect(registry.executeCommandById("editor")).toBe(true);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(editor, view);
  });

  it("uses editorCheckCallback checking=true for availability and checking=false for execution", () => {
    const registry = new (CommandRegistry as any)(undefined, withEditor) as CommandRegistry;
    const calls: Array<[boolean, unknown, unknown]> = [];
    registry.add(cmd("editor-check", {
      hotkey: "Mod+J",
      editorCheckCallback: (checking: boolean, activeEditor: unknown, context: unknown) => {
        calls.push([checking, activeEditor, context]);
        return checking ? true : undefined;
      },
    } as any));

    expect(registry.list().map((command) => command.id)).toContain("editor-check");
    expect(calls).toEqual([[true, editor, view]]);
    calls.length = 0;

    expect(registry.dispatchHotkey("Mod+KeyJ")).toBe(true);
    expect(calls).toEqual([
      [true, editor, view],
      [false, editor, view],
    ]);
  });

  it.each([false, undefined])("hides editorCheckCallback commands unless checking=true returns true (%s)", (available) => {
    const registry = new (CommandRegistry as any)(undefined, withEditor) as CommandRegistry;
    const callback = vi.fn((checking: boolean) => checking ? available : undefined);
    registry.add(cmd("gated-editor", { editorCheckCallback: callback } as any));

    expect(registry.list()).toEqual([]);
    expect(registry.execute("gated-editor")).toBe(false);
    expect(callback).not.toHaveBeenCalledWith(false, expect.anything(), expect.anything());
  });

  it("keeps editorCallback commands unavailable without editor context", () => {
    const registry = new (CommandRegistry as any)(undefined, () => null) as CommandRegistry;
    const editorCallback = vi.fn();
    registry.add(cmd("editor-without-context", {
      hotkey: "Mod+J",
      editorCallback,
    } as any));

    expect(registry.list()).toEqual([]);
    expect(registry.executeCommandById("editor-without-context")).toBe(false);
    expect(registry.dispatchHotkey("Mod+KeyJ")).toBe(false);
    expect(editorCallback).not.toHaveBeenCalled();
  });

  it("keeps editorCheckCallback commands unavailable without editor context", () => {
    const registry = new (CommandRegistry as any)(undefined, () => null) as CommandRegistry;
    const editorCheckCallback = vi.fn(() => true);
    registry.add(cmd("editor-check-without-context", {
      hotkey: "Mod+J",
      editorCheckCallback,
    } as any));

    expect(registry.list()).toEqual([]);
    expect(registry.executeCommandById("editor-check-without-context")).toBe(false);
    expect(registry.dispatchHotkey("Mod+KeyJ")).toBe(false);
    expect(editorCheckCallback).not.toHaveBeenCalled();
  });

  it("resolves editor context once so availability and execution share the same pair", () => {
    const secondEditor = { state: { doc: "second" } };
    const secondView = { viewType: "markdown", mode: "source", editor: secondEditor };
    const provider = vi.fn()
      .mockReturnValueOnce({ editor, context: view })
      .mockReturnValue({ editor: secondEditor, context: secondView });
    const registry = new (CommandRegistry as any)(undefined, provider) as CommandRegistry;
    const calls: unknown[][] = [];
    registry.add(cmd("stable-context", {
      editorCheckCallback: (checking: boolean, activeEditor: unknown, context: unknown) => {
        calls.push([checking, activeEditor, context]);
        return true;
      },
    } as any));

    expect(registry.execute("stable-context")).toBe(true);
    expect(provider).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      [true, editor, view],
      [false, editor, view],
    ]);
  });
});
