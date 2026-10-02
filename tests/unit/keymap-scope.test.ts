import { describe, expect, it, vi } from "vitest";
import { Keymap } from "../../src/renderer/api/keymap";
import { Scope } from "../../src/renderer/api/suggest";

function keyEvent(key: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    preventDefault: vi.fn(function (this: { defaultPrevented: boolean }) {
      this.defaultPrevented = true;
    }),
    stopPropagation: vi.fn(),
    ...extra,
  } as unknown as KeyboardEvent;
}

describe("Keymap scope stack", () => {
  it("dispatches the most recently pushed scope and pops by most recent identity match", () => {
    const root = new Scope();
    const first = new Scope();
    const second = new Scope();
    const calls: string[] = [];
    first.register(null, null, () => { calls.push("first"); });
    second.register(null, null, () => { calls.push("second"); });
    const keymap = new Keymap(root);

    keymap.pushScope(first);
    keymap.pushScope(second);
    keymap.pushScope(first);
    expect(keymap.handleKeydown(keyEvent("x"))).toBe(false);
    expect(calls).toEqual(["first"]);

    calls.length = 0;
    keymap.popScope(first);
    expect(keymap.handleKeydown(keyEvent("x"))).toBe(false);
    expect(calls).toEqual(["second"]);
  });

  it("makes absent and root pops no-ops", () => {
    const root = new Scope();
    const active = new Scope(root);
    const calls: string[] = [];
    active.register(null, null, () => { calls.push("active"); });
    const keymap = new Keymap(root);
    keymap.pushScope(active);

    keymap.popScope(new Scope());
    keymap.popScope(root);
    expect(keymap.handleKeydown(keyEvent("x"))).toBe(true);
    expect(calls).toEqual(["active"]);
  });

  it("walks a child scope through its parent chain before allowing app commands", () => {
    const root = new Scope();
    const child = new Scope(root);
    const calls: string[] = [];
    child.register([], "x", () => { calls.push("child"); });
    root.register([], "x", () => { calls.push("root"); });
    const keymap = new Keymap(root);
    keymap.pushScope(child);

    expect(keymap.handleKeydown(keyEvent("x"))).toBe(true);
    expect(calls).toEqual(["child", "root"]);
  });

  it("isolates app commands while a parentless scope is active without swallowing unhandled DOM input", () => {
    const root = new Scope();
    const isolated = new Scope();
    const keymap = new Keymap(root);
    keymap.pushScope(isolated);
    const event = keyEvent("x");

    expect(keymap.handleKeydown(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it("treats null key/modifiers as wildcards and [] as exactly no modifiers", () => {
    const root = new Scope();
    const calls: string[] = [];
    root.register(null, null, (_event, context) => { calls.push(`wild:${(context as any).vkey}`); });
    root.register([], "k", () => { calls.push("plain-k"); });
    const keymap = new Keymap(root);

    expect(keymap.handleKeydown(keyEvent("k"))).toBe(true);
    expect(calls).toEqual(["wild:k", "plain-k"]);
    calls.length = 0;
    expect(keymap.handleKeydown(keyEvent("k", { shiftKey: true }))).toBe(true);
    expect(calls).toEqual(["wild:k"]);
  });

  it("matches non-null modifiers exactly with platform-aware Mod semantics", () => {
    const root = new Scope();
    const handler = vi.fn();
    root.register(["Mod", "Shift"], "k", handler);
    const keymap = new Keymap(root);

    keymap.handleKeydown(keyEvent("k", { ctrlKey: true, shiftKey: true }), undefined, false);
    keymap.handleKeydown(keyEvent("k", { ctrlKey: true, shiftKey: true, altKey: true }), undefined, false);
    keymap.handleKeydown(keyEvent("k", { metaKey: true, shiftKey: true }), undefined, false);
    keymap.handleKeydown(keyEvent("k", { metaKey: true, shiftKey: true }), undefined, true);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("keeps logical key matching distinct from the physical KeyboardEvent.code", () => {
    const root = new Scope();
    const handler = vi.fn();
    root.register([], "z", handler);
    const keymap = new Keymap(root);

    keymap.handleKeydown(keyEvent("z", { code: "KeyY" }));
    keymap.handleKeydown(keyEvent("y", { code: "KeyZ" }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("treats listener false as handled and prevents default before blocking command dispatch", () => {
    const root = new Scope();
    root.register([], "x", () => false);
    const event = keyEvent("x");

    expect(new Keymap(root).handleKeydown(event)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("ignores key events during IME composition", () => {
    const root = new Scope();
    const handler = vi.fn(() => false);
    root.register(null, null, handler);
    const keymap = new Keymap(root);

    expect(keymap.handleKeydown(keyEvent("Process", { isComposing: true }))).toBe(true);
    expect(keymap.handleKeydown(keyEvent("Unidentified", { keyCode: 229 }))).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});
