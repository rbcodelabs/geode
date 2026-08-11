import { describe, expect, it, vi } from "vitest";
import { Component } from "../../src/renderer/component";

/** Minimal addEventListener/removeEventListener mock — no real DOM needed. */
function fakeEventTarget() {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener(type: string, cb: EventListener) {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(cb);
    },
    removeEventListener(type: string, cb: EventListener) {
      listeners.get(type)?.delete(cb);
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

describe("Component", () => {
  it("calls onload() when loaded and onunload() when unloaded", () => {
    const onload = vi.fn();
    const onunload = vi.fn();
    class C extends Component {
      onload = onload;
      onunload = onunload;
    }
    const c = new C();
    expect(c.loaded).toBe(false);
    c.load();
    expect(c.loaded).toBe(true);
    expect(onload).toHaveBeenCalledTimes(1);
    expect(onunload).not.toHaveBeenCalled();
    c.unload();
    expect(c.loaded).toBe(false);
    expect(onunload).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: load()/unload() called twice only fire once", () => {
    const onload = vi.fn();
    const onunload = vi.fn();
    class C extends Component {
      onload = onload;
      onunload = onunload;
    }
    const c = new C();
    c.load();
    c.load();
    expect(onload).toHaveBeenCalledTimes(1);
    c.unload();
    c.unload();
    expect(onunload).toHaveBeenCalledTimes(1);
  });

  it("runs register()'d cleanups on unload, most-recently-registered first", () => {
    const order: number[] = [];
    const c = new Component();
    c.register(() => order.push(1));
    c.register(() => order.push(2));
    c.register(() => order.push(3));
    c.unload(); // register() doesn't require load() first, matching Obsidian
    expect(order).toEqual([3, 2, 1]);
  });

  it("continues running remaining cleanups if one throws", () => {
    const ran: number[] = [];
    const c = new Component();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    c.register(() => ran.push(1));
    c.register(() => {
      throw new Error("boom");
    });
    c.register(() => ran.push(3));
    c.unload();
    expect(ran).toEqual([3, 1]); // reverse order; the throwing one is skipped, not fatal
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("registerEvent registers the given unsubscribe function as a cleanup", () => {
    const unsubscribe = vi.fn();
    const c = new Component();
    c.registerEvent(unsubscribe);
    expect(unsubscribe).not.toHaveBeenCalled();
    c.unload();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("registerDomEvent adds a listener and removes it on unload", () => {
    const target = fakeEventTarget();
    const c = new Component();
    const cb = vi.fn();
    c.registerDomEvent(target as unknown as HTMLElement, "click", cb);
    expect(target.listenerCount("click")).toBe(1);
    c.unload();
    expect(target.listenerCount("click")).toBe(0);
  });

  it("registerInterval clears the interval on unload", () => {
    vi.useFakeTimers();
    try {
      const c = new Component();
      const tick = vi.fn();
      const id = c.registerInterval(setInterval(tick, 100));
      expect(id).toBeDefined();
      vi.advanceTimersByTime(250);
      expect(tick).toHaveBeenCalledTimes(2);
      c.unload();
      vi.advanceTimersByTime(500);
      expect(tick).toHaveBeenCalledTimes(2); // no further ticks after unload
    } finally {
      vi.useRealTimers();
    }
  });

  it("addChild loads an already-loaded parent's child immediately, and unloads it with the parent", () => {
    const child = new Component();
    const childOnunload = vi.spyOn(child, "onunload");
    const parent = new Component();
    parent.load();
    parent.addChild(child);
    expect(child.loaded).toBe(true);
    parent.unload();
    expect(child.loaded).toBe(false);
    expect(childOnunload).toHaveBeenCalledTimes(1);
  });

  it("addChild on a not-yet-loaded parent defers the child's load until parent.load()", () => {
    const child = new Component();
    const parent = new Component();
    parent.addChild(child);
    expect(child.loaded).toBe(false);
    parent.load();
    expect(child.loaded).toBe(true);
  });

  it("removeChild unloads and detaches the child without unloading the parent", () => {
    const child = new Component();
    const parent = new Component();
    parent.load();
    parent.addChild(child);
    parent.removeChild(child);
    expect(child.loaded).toBe(false);
    expect(parent.loaded).toBe(true);
  });
});
