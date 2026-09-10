import { describe, expect, it } from "vitest";
import { parsePropertyId, toPropertyId } from "../../src/renderer/api/bases-property-id";
import { Keymap, isModHeld } from "../../src/renderer/api/keymap";

/**
 * A hosted view calls `parsePropertyId(id).name` to pick the frontmatter key
 * it writes to, so getting the split wrong corrupts notes rather than just
 * rendering oddly. And Geode's engine accepts property paths Obsidian's id
 * type does not (bare shorthand, a `this.` root), so ids must be normalized on
 * the way out of the API boundary.
 */

describe("parsePropertyId", () => {
  it("splits a prefixed id into source and name", () => {
    expect(parsePropertyId("note.status")).toEqual({ type: "note", name: "status" });
    expect(parsePropertyId("file.name")).toEqual({ type: "file", name: "name" });
    expect(parsePropertyId("formula.total")).toEqual({ type: "formula", name: "total" });
  });

  it("splits on the FIRST dot only, so nested frontmatter paths survive", () => {
    expect(parsePropertyId("note.meta.owner")).toEqual({ type: "note", name: "meta.owner" });
  });

  it("treats an unrecognised prefix as a frontmatter key, not as a source", () => {
    // `kanban.status` is a frontmatter key literally named "kanban.status",
    // not a property from a "kanban" source.
    expect(parsePropertyId("kanban.status")).toEqual({ type: "note", name: "kanban.status" });
  });

  it("treats a bare id as frontmatter shorthand", () => {
    expect(parsePropertyId("status")).toEqual({ type: "note", name: "status" });
  });

  it("does not mistake a leading dot for a prefix", () => {
    expect(parsePropertyId(".hidden")).toEqual({ type: "note", name: ".hidden" });
  });
});

describe("toPropertyId", () => {
  it("passes already-prefixed ids through unchanged", () => {
    expect(toPropertyId("note.status")).toBe("note.status");
    expect(toPropertyId("file.name")).toBe("file.name");
    expect(toPropertyId("formula.total")).toBe("formula.total");
  });

  it("prefixes bare shorthand, which `resolveColumns` can emit", () => {
    expect(toPropertyId("status")).toBe("note.status");
  });

  it("rewrites a `this.` root to `note.`, since the property is still frontmatter", () => {
    expect(toPropertyId("this.status")).toBe("note.status");
  });

  it("round-trips through parsePropertyId back to the right frontmatter key", () => {
    for (const path of ["status", "this.status", "note.status"]) {
      expect(parsePropertyId(toPropertyId(path)).name).toBe("status");
    }
  });
});

/** Build a minimal event shaped like the fields Keymap reads. */
function evt(over: Partial<Record<string, unknown>> = {}) {
  return { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, button: 0, ...over } as any;
}

describe("isModHeld", () => {
  it("uses Cmd on macOS and ignores Ctrl there (Ctrl-click is the context menu)", () => {
    expect(isModHeld(evt({ metaKey: true }), true)).toBe(true);
    expect(isModHeld(evt({ ctrlKey: true }), true)).toBe(false);
  });

  it("uses Ctrl off macOS and ignores Meta there", () => {
    expect(isModHeld(evt({ ctrlKey: true }), false)).toBe(true);
    expect(isModHeld(evt({ metaKey: true }), false)).toBe(false);
  });
});

describe("Keymap.isModEvent", () => {
  /** Both modifiers held, so the assertion holds on any host platform. */
  const mod = { ctrlKey: true, metaKey: true };

  it("returns false for a plain click", () => {
    expect(Keymap.isModEvent(evt())).toBe(false);
  });

  it("returns 'tab' when the platform Mod key is held", () => {
    expect(Keymap.isModEvent(evt(mod))).toBe("tab");
  });

  it("returns 'split' for Mod+Alt and 'window' for Mod+Alt+Shift", () => {
    expect(Keymap.isModEvent(evt({ ...mod, altKey: true }))).toBe("split");
    expect(Keymap.isModEvent(evt({ ...mod, altKey: true, shiftKey: true }))).toBe("window");
  });

  it("returns 'tab' for a middle-click with no modifier", () => {
    expect(Keymap.isModEvent(evt({ button: 1 }))).toBe("tab");
  });

  it("ignores Alt/Shift on their own — they are not pane modifiers", () => {
    expect(Keymap.isModEvent(evt({ altKey: true }))).toBe(false);
    expect(Keymap.isModEvent(evt({ shiftKey: true }))).toBe(false);
  });

  it("is null/undefined safe", () => {
    expect(Keymap.isModEvent(null)).toBe(false);
    expect(Keymap.isModEvent(undefined)).toBe(false);
  });
});

describe("Keymap.isModifier", () => {
  it("reads each named modifier off the event", () => {
    expect(Keymap.isModifier(evt({ shiftKey: true }), "Shift")).toBe(true);
    expect(Keymap.isModifier(evt({ altKey: true }), "Alt")).toBe(true);
    expect(Keymap.isModifier(evt({ ctrlKey: true }), "Ctrl")).toBe(true);
    expect(Keymap.isModifier(evt({ metaKey: true }), "Meta")).toBe(true);
    expect(Keymap.isModifier(evt(), "Shift")).toBe(false);
  });

  it("resolves 'Mod' to the platform key", () => {
    expect(Keymap.isModifier(evt({ ctrlKey: true, metaKey: true }), "Mod")).toBe(true);
    expect(Keymap.isModifier(evt(), "Mod")).toBe(false);
  });
});
