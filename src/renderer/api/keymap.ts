/**
 * `Keymap` — Obsidian's static helpers for reading modifier state off a user
 * event. Views use `Keymap.isModEvent(evt)` to decide how a click should open
 * a link, and pass the result straight to `workspace.openLinkText(…, newLeaf)`.
 *
 * Instance methods own the active Scope stack used by plugins to temporarily
 * take keyboard control (modals and terminal panes are common consumers).
 */

import { Scope, type KeymapEventHandler } from "./suggest";

export type PaneType = "tab" | "split" | "window";
export type UserEvent = MouseEvent | KeyboardEvent | TouchEvent | PointerEvent;
export type Modifier = "Mod" | "Ctrl" | "Meta" | "Shift" | "Alt";
export interface KeymapContext {
  key: string | null;
  modifiers: string | null;
  vkey: string;
}

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
  private scopes: Scope[];

  constructor(readonly rootScope: Scope = new Scope()) {
    this.scopes = [rootScope];
  }

  /** Activate a scope. Repeated pushes are retained as distinct stack entries. */
  pushScope(scope: Scope): void {
    if (scope === this.rootScope) return;
    this.scopes.push(scope);
  }

  /** Remove the most recently pushed entry with this exact scope identity. */
  popScope(scope: Scope): void {
    if (scope === this.rootScope) return;
    const index = this.scopes.lastIndexOf(scope);
    if (index !== -1) this.scopes.splice(index, 1);
  }

  /**
   * Run logical-key Scope handlers before CommandRegistry's physical-code
   * bindings. `true` lets command dispatch continue; `false` gates it.
   */
  handleKeydown(
    event: KeyboardEvent,
    isMac: boolean = IS_MAC,
  ): boolean {
    const active = this.scopes[this.scopes.length - 1] ?? this.rootScope;
    if (event.isComposing || event.keyCode === 229) return reachesRoot(active, this.rootScope);
    const context = keymapContext(event);

    const visited = new Set<Scope>();
    let scope: Scope | null = active;
    while (scope && !visited.has(scope)) {
      visited.add(scope);
      for (const handler of [...scope.keys]) {
        if (!matchesHandler(handler, event, isMac)) continue;
        if (handler.func(event, context) === false) {
          event.preventDefault();
          event.stopPropagation();
          return false;
        }
      }
      if (scope === this.rootScope) return true;
      scope = scope.parent;
    }
    return false;
  }

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

function keymapContext(event: KeyboardEvent): KeymapContext {
  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.metaKey) modifiers.push("Meta");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return {
    key: event.key || null,
    modifiers: modifiers.sort().join(","),
    vkey: event.key,
  };
}

function reachesRoot(scope: Scope, root: Scope): boolean {
  const visited = new Set<Scope>();
  let current: Scope | null = scope;
  while (current && !visited.has(current)) {
    if (current === root) return true;
    visited.add(current);
    current = current.parent;
  }
  return false;
}

function matchesHandler(handler: KeymapEventHandler, event: KeyboardEvent, isMac: boolean): boolean {
  if (handler.key !== null && normalizeLogicalKey(handler.key) !== normalizeLogicalKey(event.key)) return false;
  if (handler.modifiers === null) return true;

  const requested = new Set(handler.modifiers === "" ? [] : handler.modifiers.split(","));
  const expected = {
    ctrl: requested.has("Ctrl") || (!isMac && requested.has("Mod")),
    meta: requested.has("Meta") || (isMac && requested.has("Mod")),
    shift: requested.has("Shift"),
    alt: requested.has("Alt"),
  };
  return event.ctrlKey === expected.ctrl
    && event.metaKey === expected.meta
    && event.shiftKey === expected.shift
    && event.altKey === expected.alt;
}

function normalizeLogicalKey(key: string): string {
  return key.length === 1 ? key.toLocaleLowerCase() : key;
}
