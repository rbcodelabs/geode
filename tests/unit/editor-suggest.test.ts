import { describe, expect, it } from "vitest";
import {
  Scope,
  EditorSuggest,
  type EditorSuggestContext,
  type EditorSuggestTriggerInfo,
} from "../../src/renderer/api/suggest";

/**
 * PR 2a coverage: community plugins (obsidian-tasks, linear-integration)
 * subclass `EditorSuggest` and register keymap handlers on `app.scope` at
 * construction time. These primitives exist so that *loading* those plugins
 * doesn't throw. The suggest popover / keymap dispatch itself is not wired
 * yet (PR 2b), so this only asserts the load-safety contract, not behavior.
 */

describe("Scope", () => {
  it("registers a handler and returns it as the unregister token", () => {
    const scope = new Scope();
    const cb = () => true;
    const handler = scope.register([], "Tab", cb);
    expect(scope.keys).toContain(handler);
    expect(handler.func).toBe(cb);
    expect(handler.key).toBe("Tab");
    scope.unregister(handler);
    expect(scope.keys).not.toContain(handler);
  });

  it("normalizes modifiers to a comma-joined string, and null to null", () => {
    const scope = new Scope();
    expect(scope.register(["Mod", "Shift"], "K", () => {}).modifiers).toBe("Mod,Shift");
    expect(scope.register(null, "K", () => {}).modifiers).toBeNull();
    expect(scope.register([], null, () => {}).key).toBeNull();
  });

  it("unregister is idempotent and does not disturb other handlers", () => {
    const scope = new Scope();
    const a = scope.register([], "A", () => {});
    const b = scope.register([], "B", () => {});
    scope.unregister(a);
    scope.unregister(a); // second time: no-op, no throw
    expect(scope.keys).toEqual([b]);
  });

  it("records its parent when created as a child scope", () => {
    const root = new Scope();
    const child = new Scope(root);
    expect(child.parent).toBe(root);
    expect(new Scope().parent).toBeNull();
  });
});

describe("EditorSuggest", () => {
  // A minimal stand-in for App carrying a root scope, matching what
  // `installObsidianAppCompat` puts on the real app.
  const makeApp = () => ({ scope: new Scope() }) as any;

  it("is constructable via a concrete subclass and stores app + child scope + null context", () => {
    class Impl extends EditorSuggest<string> {}
    const app = makeApp();
    const s = new Impl(app);
    expect(s.app).toBe(app);
    expect(s.scope).toBeInstanceOf(Scope);
    // its scope is parented to app.scope, per Obsidian
    expect(s.scope.parent).toBe(app.scope);
    expect(s.context).toBeNull();
  });

  it("tolerates an app with no scope (parent falls back to null)", () => {
    class Impl extends EditorSuggest<string> {}
    const s = new Impl({} as any);
    expect(s.scope.parent).toBeNull();
  });

  it("base lifecycle methods are safe no-ops and base triggers are inert", () => {
    class Impl extends EditorSuggest<string> {}
    const s = new Impl(makeApp());
    expect(() => {
      s.open();
      s.close();
      s.setInstructions([{ command: "↹", purpose: "indent" }]);
    }).not.toThrow();
    expect(s.onTrigger({}, {}, {})).toBeNull();
    expect(s.getSuggestions({} as EditorSuggestContext)).toEqual([]);
  });

  it("reproduces the obsidian-tasks load pattern: subclass ctor calls super(app) then app.scope.register — no throw", () => {
    // Mirrors: class extends EditorSuggest { constructor(e){ super(e);
    // e.scope.register([],"Tab",cb) } }, instantiated as new X(app).
    let registered: EditorSuggestTriggerInfo | null = null;
    class TasksLikeSuggest extends EditorSuggest<string> {
      constructor(app: any) {
        super(app);
        app.scope.register([], "Tab", () => {
          const editor = this.context?.editor;
          return editor ? false : true;
        });
      }
      onTrigger() {
        return (registered = { start: { line: 0, ch: 0 }, end: { line: 0, ch: 1 }, query: "x" });
      }
      getSuggestions() {
        return ["a", "b"];
      }
    }
    const app = makeApp();
    let instance!: TasksLikeSuggest;
    expect(() => {
      instance = new TasksLikeSuggest(app);
    }).not.toThrow();
    // the Tab handler landed on app.scope
    expect(app.scope.keys).toHaveLength(1);
    expect(app.scope.keys[0].key).toBe("Tab");
    // overridden methods work
    expect(instance.getSuggestions({} as EditorSuggestContext)).toEqual(["a", "b"]);
    expect(instance.onTrigger()).toBe(registered);
  });
});
