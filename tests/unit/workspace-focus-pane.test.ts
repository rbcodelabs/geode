import { describe, expect, it, vi } from "vitest";
import { TabGroup, Workspace } from "../../src/renderer/workspace";

function classList() {
  const set = new Set<string>();
  return {
    set,
    add: (c: string) => void set.add(c),
    remove: (c: string) => void set.delete(c),
    contains: (c: string) => set.has(c),
  };
}

function setup() {
  const workspace = Object.create(Workspace.prototype) as Workspace;
  const split = { containerEl: { classList: classList() }, parent: null as any };
  const makeGroup = (parent: any, sidebar?: object) => {
    const g = Object.create(TabGroup.prototype) as TabGroup;
    Object.assign(g, { containerEl: { classList: classList() }, parent, sidebar });
    return g;
  };
  const a = makeGroup(split);
  const b = makeGroup(split);
  const side = makeGroup(null, {});
  const groups = [a, b];
  Object.defineProperty(workspace, "groups", { get: () => groups, configurable: true });
  const events: unknown[] = [];
  Object.assign(workspace, {
    rootEl: { classList: classList() },
    focusedGroup: null,
    activeGroup: a,
    trigger: vi.fn((name: string, arg: unknown) => { if (name === "focus-pane-change") events.push(arg); }),
    isCompactMobile: () => false,
    getActiveLeaf: () => null,
    syncAdaptivePresentation() {},
  });
  return { workspace, split, a, b, side, groups, events };
}

describe("focus pane", () => {
  it("enters and exits by toggling classes only, emitting focus-pane-change", () => {
    const { workspace, split, a, b, events } = setup();
    workspace.toggleFocusPane();
    expect(workspace.focusedGroup).toBe(a);
    expect((workspace.rootEl as any).classList.contains("is-focus-pane")).toBe(true);
    expect((a.containerEl as any).classList.contains("is-focused-pane")).toBe(true);
    expect((b.containerEl as any).classList.contains("is-focused-pane")).toBe(false);
    expect(split.containerEl.classList.contains("has-focused-pane")).toBe(true);
    workspace.toggleFocusPane();
    expect(workspace.focusedGroup).toBeNull();
    expect((workspace.rootEl as any).classList.contains("is-focus-pane")).toBe(false);
    expect(split.containerEl.classList.contains("has-focused-pane")).toBe(false);
    expect(events).toEqual([a, null]);
  });

  it("refuses sidebar groups and compact mobile", () => {
    const { workspace, side } = setup();
    expect(workspace.enterFocusPane(side)).toBe(false);
    (workspace as any).isCompactMobile = () => true;
    expect(workspace.enterFocusPane()).toBe(false);
    expect(workspace.focusedGroup).toBeNull();
  });

  it("activating another group exits focus; activating the focused group does not", () => {
    const { workspace, a, b } = setup();
    workspace.enterFocusPane(a);
    workspace.setActiveGroup(a);
    expect(workspace.focusedGroup).toBe(a);
    workspace.setActiveGroup(b);
    expect(workspace.focusedGroup).toBeNull();
  });

  it("focusing a non-active group activates it and keeps focus", () => {
    const { workspace, b } = setup();
    workspace.enterFocusPane(b);
    expect(workspace.focusedGroup).toBe(b);
    expect(workspace.activeGroup).toBe(b);
  });

  it("toggleSidebar while focused only exits focus", () => {
    const { workspace, a } = setup();
    const toggle = vi.fn();
    Object.assign(workspace, { leftSidebar: { toggle }, usesDrawer: () => false });
    workspace.enterFocusPane(a);
    workspace.toggleSidebar("left");
    expect(workspace.focusedGroup).toBeNull();
    expect(toggle).not.toHaveBeenCalled();
    workspace.toggleSidebar("left");
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("revealLeaf of a leaf outside the focused group exits focus", () => {
    const { workspace, a } = setup();
    workspace.enterFocusPane(a);
    workspace.revealLeaf({ group: { setActiveLeaf: vi.fn() } } as any);
    expect(workspace.focusedGroup).toBeNull();
    workspace.enterFocusPane(a);
    workspace.revealLeaf({ group: { ...a, setActiveLeaf: vi.fn() } } as any);
    expect(workspace.focusedGroup).toBeNull();
    workspace.enterFocusPane(a);
    (a as any).setActiveLeaf = vi.fn();
    workspace.revealLeaf({ group: a } as any);
    expect(workspace.focusedGroup).toBe(a);
  });
});
