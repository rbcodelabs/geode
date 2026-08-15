// ---------------------------------------------------------------------------
// Scope + EditorSuggest — Obsidian-compat keymap/suggest primitives
// ---------------------------------------------------------------------------
//
// These exist so community plugins that subclass `EditorSuggest` and register
// keymap handlers via `app.scope` (e.g. obsidian-tasks, linear-integration)
// can *load* under Geode. The plugin subclass is defined at module-eval time
// (`class extends obsidian.EditorSuggest`), so `EditorSuggest` must be a real,
// subclassable export — an undefined base throws
// "Class extends value undefined" before the plugin's onload() ever runs.
//
// SCOPE OF THIS MODULE (PR 2a): make these plugins construct without throwing.
// `Scope` is store-only — it records handlers but does NOT yet dispatch key
// events (Geode has no global keymap infrastructure), mirroring the
// store-only `hoverLinkSources` shim. `EditorSuggest` is constructable and
// subclassable but does NOT yet drive an autocomplete popover. Real keymap
// dispatch and suggest-popover rendering are follow-up work (PR 2b).

import type { App } from "../app";

/** A registered keymap handler, as returned by `Scope.register`. */
export interface KeymapEventHandler {
  modifiers: string | null;
  key: string | null;
  func: KeymapEventListener;
  /** Present on real Obsidian handlers; plugins occasionally read it. */
  scope?: Scope;
}

export type KeymapEventListener = (evt: KeyboardEvent, ctx: unknown) => boolean | void;

/**
 * A keymap scope. In real Obsidian a Scope owns a set of hotkey handlers that
 * are active while the scope is on the keymap stack. Geode has no keymap stack
 * yet, so this is STORE-ONLY: `register`/`unregister` maintain the handler
 * list (so plugin code that registers, inspects, and later unregisters
 * handlers behaves correctly) but no handler is ever invoked. This is a
 * well-behaved no-op, not a working keymap — enough for plugin load.
 */
export class Scope {
  /** Parent scope, if this was created as a child (real Obsidian passes one). */
  parent: Scope | null;
  /** Live handlers registered on this scope. */
  keys: KeymapEventHandler[] = [];

  constructor(parent?: Scope | null) {
    this.parent = parent ?? null;
  }

  /**
   * Register a keymap handler. `modifiers` is an array of modifier names
   * (Obsidian's public signature) which we normalize to the comma-joined
   * string real handlers carry; `key` is a key name (or null for "any").
   * Returns the handler object, which is the token passed back to
   * `unregister`.
   */
  register(
    modifiers: string[] | null,
    key: string | null,
    func: KeymapEventListener
  ): KeymapEventHandler {
    const handler: KeymapEventHandler = {
      modifiers: modifiers ? modifiers.join(",") : null,
      key,
      func,
      scope: this,
    };
    this.keys.push(handler);
    return handler;
  }

  /** Remove a previously registered handler. Idempotent. */
  unregister(handler: KeymapEventHandler): void {
    const i = this.keys.indexOf(handler);
    if (i !== -1) this.keys.splice(i, 1);
  }
}

/** The editor-suggest trigger info a subclass returns from `onTrigger`. */
export interface EditorSuggestTriggerInfo {
  start: { line: number; ch: number };
  end: { line: number; ch: number };
  query: string;
}

/** Context passed to `getSuggestions` while a suggest session is open. */
export interface EditorSuggestContext {
  editor: unknown;
  file: unknown;
  start: { line: number; ch: number };
  end: { line: number; ch: number };
  query: string;
}

/**
 * Base class community plugins subclass to provide in-editor autocomplete.
 *
 * PR 2a scope: constructable and subclassable so a plugin's
 * `class X extends EditorSuggest { constructor(app){ super(app); ... } }`
 * loads. The constructor mirrors real Obsidian's shape — it stores `app`,
 * creates an owned child `scope`, and initializes `context` to null — so
 * subclass constructors that read `this.app`/`this.scope`/`this.context` or
 * call `app.scope.register(...)` don't throw.
 *
 * The suggest *behavior* (opening a popover, calling `onTrigger` on keystroke,
 * rendering/selecting suggestions) is NOT wired yet — the lifecycle methods
 * are safe no-ops and the trigger callbacks are overridden by the subclass.
 * Driving them from the editor is PR 2b.
 */
export abstract class EditorSuggest<T> {
  app: App;
  /** This suggest's own keymap scope (child of `app.scope`), per Obsidian. */
  scope: Scope;
  /** The active trigger context while a suggest session is open, else null. */
  context: EditorSuggestContext | null = null;
  /** Max suggestions to show. Read by some subclasses. */
  limit = 100;

  constructor(app: App) {
    this.app = app;
    this.scope = new Scope((app as unknown as { scope?: Scope }).scope ?? null);
  }

  /** Show the suggest popover. No-op until PR 2b wires the popover. */
  open(): void {}
  /** Hide the suggest popover. No-op until PR 2b. */
  close(): void {}
  /** Set the popover instruction footer. No-op until PR 2b. */
  setInstructions(_instructions: { command: string; purpose: string }[]): void {}

  /**
   * Decide whether to open the suggest at the current cursor. Subclasses
   * override; the base returns null (never triggers) so an un-overridden
   * instance is inert rather than throwing.
   */
  onTrigger(_cursor: unknown, _editor: unknown, _file: unknown): EditorSuggestTriggerInfo | null {
    return null;
  }

  /** Produce suggestions for a context. Overridden by subclasses. */
  getSuggestions(_context: EditorSuggestContext): T[] | Promise<T[]> {
    return [];
  }

  /** Render one suggestion. Overridden by subclasses. */
  renderSuggestion(_value: T, _el: HTMLElement): void {}

  /** Handle selecting a suggestion. Overridden by subclasses. */
  selectSuggestion(_value: T, _evt: MouseEvent | KeyboardEvent): void {}
}
