/**
 * `Keymap` — Obsidian's static helpers for reading modifier state off a user
 * event. Views use `Keymap.isModEvent(evt)` to decide how a click should open
 * a link, and pass the result straight to `workspace.openLinkText(…, newLeaf)`.
 *
 * Only the two documented *static* helpers are implemented. `pushScope`/
 * `popScope` need a real scope stack Geode does not have, and are deliberately
 * absent rather than stubbed: a plugin calling them gets a loud TypeError
 * instead of a silent no-op that looks like a working keymap.
 */

export type PaneType = "tab" | "split" | "window";
export type UserEvent = MouseEvent | KeyboardEvent | TouchEvent | PointerEvent;
export type Modifier = "Mod" | "Ctrl" | "Meta" | "Shift" | "Alt";

/**
 * Detected once, from the same `navigator.userAgent` signal `Platform.isMacOS`
 * uses in ./obsidian.ts — imported from there would be a cycle, so the check
 * is repeated rather than the two drifting apart.
 */
const IS_MAC = /Mac/.test(typeof navigator !== "undefined" ? navigator.userAgent : "");

/**
 * Is the platform-appropriate "Mod" key held? Cmd on macOS, Ctrl elsewhere —
 * and strictly one or the other: on macOS, Ctrl-click is the context-menu
 * gesture, so treating it as Mod there would hijack right-click.
 *
 * `isMac` is a parameter rather than a module read so both branches are
 * testable on one machine.
 */
export function isModHeld(evt: { ctrlKey: boolean; metaKey: boolean }, isMac: boolean = IS_MAC): boolean {
  return isMac ? evt.metaKey : evt.ctrlKey;
}

export class Keymap {
  /** Whether `modifier` is held during `evt`. */
  static isModifier(evt: UserEvent, modifier: Modifier): boolean {
    const e = evt as unknown as { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };
    switch (modifier) {
      case "Mod":
        return isModHeld(e);
      case "Ctrl":
        return e.ctrlKey;
      case "Meta":
        return e.metaKey;
      case "Shift":
        return e.shiftKey;
      case "Alt":
        return e.altKey;
    }
  }

  /**
   * Translate an event into the kind of pane that should open, per Obsidian's
   * documented rules:
   *
   * - `'tab'` when Cmd/Ctrl is held, or on a middle-click
   * - `'split'` when Cmd/Ctrl+Alt is held
   * - `'window'` when Cmd/Ctrl+Alt+Shift is held
   * - `false` otherwise
   */
  static isModEvent(evt?: UserEvent | null): PaneType | boolean {
    if (!evt) return false;
    const e = evt as unknown as {
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
      button?: number;
      type?: string;
    };
    if (isModHeld(e)) {
      if (e.altKey && e.shiftKey) return "window";
      if (e.altKey) return "split";
      return "tab";
    }
    // Middle-click. `button` is only meaningful on a MouseEvent, and only on
    // the press/click events where the browser populates it.
    if (e.button === 1) return "tab";
    return false;
  }
}
