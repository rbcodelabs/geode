import { describe, expect, it, vi } from "vitest";
import {
  ActionRegistry,
  composeMenu,
  createActionCommand,
  tabCloseTargets,
  type ActionDefinition,
} from "../../src/renderer/actions";

type Context = { kind: "file"; writable: boolean; name: string };

describe("ActionRegistry", () => {
  const rename: ActionDefinition<Context> = {
    id: "file.rename",
    label: (ctx) => `Rename ${ctx.name}…`,
    icon: "pencil",
    isAvailable: (ctx) => ctx.writable,
    run: vi.fn(),
  };

  it("resolves dynamic state and refuses unavailable execution", async () => {
    const registry = new ActionRegistry<Context>();
    registry.register(rename);
    expect(registry.resolve("file.rename", { kind: "file", writable: true, name: "A" })).toMatchObject({
      id: "file.rename",
      label: "Rename A…",
      icon: "pencil",
      available: true,
    });
    expect(await registry.execute("file.rename", { kind: "file", writable: false, name: "A" })).toBe(false);
    expect(rename.run).not.toHaveBeenCalled();
  });

  it("composes ordered menu sections and omits unavailable actions", () => {
    const registry = new ActionRegistry<Context>();
    registry.register(rename);
    registry.register({ id: "file.delete", label: "Delete", warning: true, run: vi.fn() });
    const items = composeMenu(registry, { kind: "file", writable: false, name: "A" }, [
      { section: "file", actions: ["file.rename", "file.delete"] },
    ]);
    expect(items).toEqual([
      expect.objectContaining({ id: "file.delete", title: "Delete", section: "file", warning: true }),
    ]);
  });

  it("adapts an internal action to the public command shape using active context", () => {
    const registry = new ActionRegistry<Context>();
    const run = vi.fn();
    registry.register({ id: "file.rename", label: "Rename…", isAvailable: (c) => c.writable, run });
    let current: Context | null = { kind: "file", writable: false, name: "A" };
    const command = createActionCommand(registry, "file.rename", "Rename current file", () => current);
    expect(command.checkCallback?.(true)).toBe(false);
    current = { kind: "file", writable: true, name: "A" };
    expect(command.checkCallback?.(true)).toBe(true);
    command.checkCallback?.(false);
    expect(run).toHaveBeenCalledWith(current);
  });
});

describe("tabCloseTargets", () => {
  const leaf = (id: string, pinned = false) => ({ id, pinned });

  it("snapshots clicked-group targets, preserving pinned siblings for bulk closes", () => {
    const leaves = [leaf("a"), leaf("b", true), leaf("c"), leaf("d")];
    expect(tabCloseTargets(leaves, leaves[2], "others").map((l) => l.id)).toEqual(["a", "d"]);
    expect(tabCloseTargets(leaves, leaves[0], "right").map((l) => l.id)).toEqual(["c", "d"]);
    expect(tabCloseTargets(leaves, leaves[1], "self").map((l) => l.id)).toEqual(["b"]);
  });
});
