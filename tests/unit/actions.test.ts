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

/**
 * `resolve()` evaluates label/icon/checked BEFORE availability and returns
 * them together, so an action scoped to one kind of context (say, web tabs)
 * is still asked for its label in every other context. A dynamic label that
 * assumes its field is present therefore throws for every caller that
 * enumerates actions: the command palette polls availability across every
 * command, and each context menu composes whole specs.
 *
 * These two tests pin both halves of the contract in place.
 */
describe("ActionRegistry dynamic presentation contract", () => {
  type ScopedContext = { page?: { title: string } | null };

  /** Written total, the way every scoped label callback has to be. */
  const scoped: ActionDefinition<ScopedContext> = {
    id: "page.reload",
    label: (ctx) => ctx.page?.title ?? "Reload",
    icon: (ctx) => (ctx.page ? "rotate-cw" : null),
    checked: (ctx) => !!ctx.page,
    isAvailable: (ctx) => !!ctx.page,
    run: vi.fn(),
  };

  it("survives a context missing the field its dynamic callbacks read", () => {
    const registry = new ActionRegistry<ScopedContext>();
    registry.register(scoped);
    // Neither call may throw: this is the exact shape of context the command
    // palette and a markdown tab's context menu hand to every action.
    expect(() => composeMenu(registry, {}, [{ section: "page", actions: ["page.reload"] }])).not.toThrow();
    const command = createActionCommand(registry, "page.reload", "Reload page", () => ({}));
    expect(command.checkCallback?.(true)).toBe(false);
  });

  it("still resolves a real label for an unavailable action", () => {
    const registry = new ActionRegistry<ScopedContext>();
    registry.register({ ...scoped, label: (ctx) => ctx.page?.title ?? "Reload" });
    // Menu specs opt into rendering unavailable items greyed out (TAB_MENU_SPEC's
    // tab section does), and those items must read as themselves, not as their
    // action id. Short-circuiting resolve() when unavailable would break that.
    const items = composeMenu(registry, {}, [
      { section: "page", actions: ["page.reload"], includeUnavailable: true },
    ]);
    expect(items).toEqual([
      expect.objectContaining({ id: "page.reload", title: "Reload", disabled: true }),
    ]);
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
