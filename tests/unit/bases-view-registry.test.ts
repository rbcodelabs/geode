import { describe, expect, it, vi } from "vitest";
import {
  BasesView,
  BUILTIN_BASES_VIEW_TYPES,
  QueryController,
  registerBasesViewIn,
  unregisterBasesViewIn,
  type BasesViewHost,
  type BasesViewRegistration,
} from "../../src/renderer/api/bases-view";
import type { App } from "../../src/renderer/app";

/**
 * The Bases view registry, exercised through the same guard rails
 * `Workspace.registerViewFactory` uses. `BaseView` used to hardcode
 * `type === "cards" ? cards : table`, so — since `BaseViewDefinition.type` is
 * an open `string` — an unknown view type silently rendered as a table.
 */

/**
 * The registry rules as free functions over the map — exactly what
 * `App.registerBasesView`/`unregisterBasesView` delegate to, without needing
 * to construct an `App` (which would drag in the whole renderer).
 */
function makeRegistry() {
  const map = new Map<string, BasesViewRegistration>();
  return {
    map,
    register: (t: string, r: BasesViewRegistration) => registerBasesViewIn(map, t, r),
    unregister: (t: string, r: BasesViewRegistration) => unregisterBasesViewIn(map, t, r),
  };
}

const registration = (name: string): BasesViewRegistration => ({
  name,
  icon: "columns",
  factory: () => {
    throw new Error("not used");
  },
});

describe("App.registerBasesView", () => {
  it("registers a new view type", () => {
    const r = makeRegistry();
    expect(r.register("kanban-view", registration("Kanban"))).toBe(true);
    expect(r.map.get("kanban-view")?.name).toBe("Kanban");
  });

  it("refuses a built-in type, so a plugin cannot hijack the table view", () => {
    const r = makeRegistry();
    for (const builtin of BUILTIN_BASES_VIEW_TYPES) {
      expect(() => r.register(builtin, registration("Hijack"))).toThrow(/reserved or built-in/);
    }
    expect(r.map.size).toBe(0);
  });

  it("returns false rather than clobbering a type another plugin already claimed", () => {
    const r = makeRegistry();
    const first = registration("First");
    expect(r.register("kanban-view", first)).toBe(true);
    expect(r.register("kanban-view", registration("Second"))).toBe(false);
    expect(r.map.get("kanban-view")).toBe(first);
  });

  it("unregisters only the registration that is actually installed", () => {
    const r = makeRegistry();
    const mine = registration("Mine");
    r.register("kanban-view", mine);

    // A stale unregister from a different registration must not evict it.
    r.unregister("kanban-view", registration("Someone else's"));
    expect(r.map.has("kanban-view")).toBe(true);

    r.unregister("kanban-view", mine);
    expect(r.map.has("kanban-view")).toBe(false);
  });
});

/** Minimal host wiring — enough to construct a BasesView. */
function makeHost(over: Partial<BasesViewHost> = {}): BasesViewHost {
  return {
    app: {} as App,
    config: { name: "Board" } as BasesViewHost["config"],
    data: { data: [] } as unknown as BasesViewHost["data"],
    allProperties: ["note.status"],
    createFileForView: () => Promise.reject(new Error("not supported")),
    ...over,
  };
}

class TestView extends BasesView {
  type = "kanban-view";
  updates = 0;
  closed = 0;
  constructor(controller: QueryController) {
    super(controller);
  }
  onDataUpdated(): void {
    this.updates++;
  }
  onClose(): void {
    this.closed++;
  }
}

describe("BasesView", () => {
  it("takes app, config, data and allProperties from the controller", () => {
    const host = makeHost();
    const view = new TestView(new QueryController(host));
    expect(view.app).toBe(host.app);
    expect(view.config).toBe(host.config);
    expect(view.data).toBe(host.data);
    expect(view.allProperties).toEqual(["note.status"]);
  });

  it("forwards onunload to the view's onClose", () => {
    // Component's documented teardown hook is onunload(), but real Bases
    // views put their teardown in an undocumented onClose(). Without the
    // forward, a view leaks its timers and drag handlers on every close.
    const view = new TestView(new QueryController(makeHost()));
    view.load();
    view.unload();
    expect(view.closed).toBe(1);
  });

  it("does not throw for a view that has no onClose", () => {
    class Bare extends BasesView {
      type = "bare";
      onDataUpdated(): void {}
    }
    const view = new Bare(new QueryController(makeHost()));
    view.load();
    expect(() => view.unload()).not.toThrow();
  });

  it("rejects from createFileForView rather than resolving quietly", async () => {
    // The Bases write path is not implemented. A silent no-op would let an
    // "add card" button appear to work while creating nothing.
    const createFileForView = vi.fn(() => Promise.reject(new Error("Geode does not support")));
    const view = new TestView(new QueryController(makeHost({ createFileForView })));
    await expect(view.createFileForView("New card")).rejects.toThrow(/does not support/);
    expect(createFileForView).toHaveBeenCalledWith("New card", undefined);
  });
});
