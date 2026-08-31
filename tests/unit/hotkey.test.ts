import { describe, expect, it } from "vitest";
import {
  bindingIdentity,
  displayHotkey,
  legacyHotkeyToBinding,
  comboFromParts,
  eventToHotkey,
  inputToHotkey,
  resolveGuestHotkey,
  type HotkeyInput,
} from "../../src/shared/hotkey";

/**
 * The host document and a `<webview>` guest describe the same keystroke with
 * two different shapes: a DOM KeyboardEvent in the renderer, an Electron
 * `Input` in the main process. The bridge only works if both normalize to a
 * byte-identical combo string, so parity is the thing under test here.
 */
function keyEvent(init: {
  key: string;
  code?: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}): KeyboardEvent {
  return {
    key: init.key,
    code: init.code ?? (init.key.length === 1 && /[a-z]/i.test(init.key) ? `Key${init.key.toUpperCase()}` : init.key === "," ? "Comma" : init.key === " " ? "Space" : init.key),
    metaKey: init.meta ?? false,
    ctrlKey: init.ctrl ?? false,
    altKey: init.alt ?? false,
    shiftKey: init.shift ?? false,
  } as KeyboardEvent;
}

function keyInput(init: {
  key: string;
  code?: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  type?: string;
}): HotkeyInput {
  return {
    type: init.type ?? "keyDown",
    key: init.key,
    code: init.code ?? (init.key.length === 1 && /[a-z]/i.test(init.key) ? `Key${init.key.toUpperCase()}` : init.key === "," ? "Comma" : init.key === " " ? "Space" : init.key),
    meta: init.meta ?? false,
    control: init.ctrl ?? false,
    alt: init.alt ?? false,
    shift: init.shift ?? false,
  };
}

const cases: { name: string; init: { key: string; meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }; combo: string }[] = [
  { name: "Cmd+W", init: { key: "w", meta: true }, combo: "Mod+KeyW" },
  { name: "Ctrl+W", init: { key: "w", ctrl: true }, combo: "Ctrl+KeyW" },
  { name: "Cmd+Shift+F", init: { key: "F", meta: true, shift: true }, combo: "Mod+Shift+KeyF" },
  { name: "Cmd+,", init: { key: ",", meta: true }, combo: "Mod+Comma" },
  { name: "Cmd+Alt+I", init: { key: "i", meta: true, alt: true }, combo: "Mod+Alt+KeyI" },
  { name: "Escape (no modifiers)", init: { key: "Escape" }, combo: "Escape" },
  { name: "Cmd+Space", init: { key: " ", meta: true }, combo: "Mod+Space" },
  { name: "bare Space", init: { key: " " }, combo: "Space" },
  { name: "ArrowDown", init: { key: "ArrowDown" }, combo: "ArrowDown" },
];

describe("shared hotkey normalizer", () => {
  it("stores physical codes, normalizes modifier order, and adapts legacy defaults", () => {
    expect(legacyHotkeyToBinding("Shift+Mod+P")).toEqual({ modifiers: ["Mod", "Shift"], code: "KeyP" });
    expect(bindingIdentity({ modifiers: ["Shift", "Mod"], code: "KeyP" })).toBe("Mod+Shift+KeyP");
    expect(displayHotkey({ modifiers: ["Mod", "Shift"], code: "Comma" }, "MacIntel")).toBe("⌘⇧,");
  });

  it("fails closed when a DOM or Electron event has no physical code", () => {
    expect(eventToHotkey({ ...keyEvent({ key: "p", meta: true }), code: "" } as KeyboardEvent)).toBe("");
    expect(inputToHotkey({ ...keyInput({ key: "p", meta: true }), code: "" })).toBe("");
  });
  it.each(cases)("eventToHotkey and inputToHotkey agree on $name", ({ init, combo }) => {
    expect(eventToHotkey(keyEvent(init))).toBe(combo);
    expect(inputToHotkey(keyInput(init))).toBe(combo);
  });

  it("orders modifiers Mod, Alt, Shift regardless of how they arrive", () => {
    expect(comboFromParts({ mod: true, alt: true, shift: true, key: "k" })).toBe("Mod+Alt+Shift+KeyK");
  });

  it("uppercases single-character keys but leaves named keys alone", () => {
    expect(comboFromParts({ mod: true, alt: false, shift: false, key: "p" })).toBe("Mod+KeyP");
    expect(comboFromParts({ mod: false, alt: false, shift: false, key: "Enter" })).toBe("Enter");
  });

  it('maps " " to "Space"', () => {
    expect(comboFromParts({ mod: false, alt: false, shift: false, key: " " })).toBe("Space");
  });

  it("returns an empty combo for modifier-only keystrokes", () => {
    for (const key of ["Meta", "Control", "Alt", "Shift"]) {
      expect(eventToHotkey(keyEvent({ key, meta: true }))).toBe("");
      expect(inputToHotkey(keyInput({ key, meta: true }))).toBe("");
    }
  });

  it("returns an empty combo for a missing key rather than a dangling 'Mod+'", () => {
    expect(comboFromParts({ mod: true, alt: false, shift: false, key: "" })).toBe("");
  });

  it("ignores anything that is not a keyDown", () => {
    expect(inputToHotkey(keyInput({ key: "w", meta: true, type: "keyUp" }))).toBe("");
    expect(inputToHotkey(keyInput({ key: "w", meta: true, type: "char" }))).toBe("");
    expect(inputToHotkey(keyInput({ key: "w", meta: true, type: "rawKeyDown" }))).toBe("");
  });
});

describe("resolveGuestHotkey", () => {
  const combos = new Set(["Mod+KeyW", "Mod+KeyP", "Mod+Shift+KeyF"]);

  it("returns the combo when the renderer has it bound", () => {
    expect(resolveGuestHotkey(keyInput({ key: "w", meta: true }), combos)).toBe("Mod+KeyW");
    expect(resolveGuestHotkey(keyInput({ key: "F", meta: true, shift: true }), combos)).toBe(
      "Mod+Shift+KeyF",
    );
  });

  it("returns null for a combo the renderer has not bound", () => {
    // Cmd+A / Cmd+C must keep working as ordinary page/OS shortcuts inside a
    // web page, so an unbound combo has to fall through untouched.
    expect(resolveGuestHotkey(keyInput({ key: "a", meta: true }), combos)).toBeNull();
    expect(resolveGuestHotkey(keyInput({ key: "c", meta: true }), combos)).toBeNull();
  });

  it("returns null for plain typing", () => {
    expect(resolveGuestHotkey(keyInput({ key: "w" }), combos)).toBeNull();
    expect(resolveGuestHotkey(keyInput({ key: "p" }), combos)).toBeNull();
  });

  it("returns null for key-up of a bound combo, so one press fires once", () => {
    expect(resolveGuestHotkey(keyInput({ key: "w", meta: true, type: "keyUp" }), combos)).toBeNull();
  });

  it("returns null when the renderer has published nothing yet", () => {
    expect(resolveGuestHotkey(keyInput({ key: "w", meta: true }), new Set())).toBeNull();
  });

  it("accepts an array of combos as well as a set", () => {
    expect(resolveGuestHotkey(keyInput({ key: "w", meta: true }), ["Mod+KeyW"])).toBe("Mod+KeyW");
    expect(resolveGuestHotkey(keyInput({ key: "w", meta: true }), [])).toBeNull();
  });
});
