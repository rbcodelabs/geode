/**
 * Obsidian's `AbstractInputSuggest`: a suggestion popover attached to a text
 * input (settings fields, modal inputs). Plugins subclass it and implement
 * `getSuggestions` / `renderSuggestion` / `selectSuggestion`; the host owns
 * the popover lifecycle, keyboard navigation and positioning.
 *
 * Kept free of `obsidian.ts` imports so it can be required by it without a
 * cycle. The pure navigation helpers are exported for unit tests; the DOM
 * behaviour is covered by the TaskNotes Electron spec.
 */
import type { App } from "../app";
import { computeAnchoredMenuPosition } from "../menu-position";
import { Scope } from "./suggest";

/** Wrap-around selection movement; stays at -1 (nothing selectable) for an empty list. */
export function moveSuggestionIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  const start = current < 0 ? (delta > 0 ? -1 : 0) : current;
  return (((start + delta) % length) + length) % length;
}

/** Clamp a stale selection after the list is replaced: first row, or none when empty. */
export function initialSuggestionIndex(length: number): number {
  return length > 0 ? 0 : -1;
}

type SuggestInput = HTMLInputElement | HTMLTextAreaElement | HTMLDivElement;

export abstract class AbstractInputSuggest<T> {
  app: App;
  scope: Scope;
  textInputEl: SuggestInput;
  /** Max suggestions shown. */
  limit = 100;
  isOpen = false;

  private containerEl: HTMLElement | null = null;
  private suggestions: T[] = [];
  private selectedIndex = -1;
  private generation = 0;
  private selecting = false;
  private selectCallbacks: Array<(value: T, evt: MouseEvent | KeyboardEvent) => void> = [];

  private readonly onInput = () => {
    if (this.selecting) return; // programmatic input events fired from selectSuggestion must not reopen us
    void this.refresh();
  };
  private readonly onFocus = () => {
    void this.refresh();
  };
  private readonly onBlur = () => this.close();
  private readonly onWindowResize = () => this.close();

  constructor(app: App, textInputEl: SuggestInput) {
    this.app = app;
    this.textInputEl = textInputEl;
    this.scope = new Scope((app as unknown as { scope?: Scope }).scope ?? null);
    textInputEl.addEventListener("input", this.onInput);
    textInputEl.addEventListener("focus", this.onFocus);
    textInputEl.addEventListener("blur", this.onBlur);
    // Navigation keys go through this suggest's own Scope, pushed on the app
    // keymap while open: a hosting Modal's Escape handler lives in its scope and
    // would otherwise close the whole dialog instead of just this popover.
    this.scope.register([], "ArrowDown", () => this.moveSelection(1));
    this.scope.register([], "ArrowUp", () => this.moveSelection(-1));
    this.scope.register([], "Enter", (evt) => {
      const value = this.suggestions[this.selectedIndex];
      if (value === undefined) return true;
      this.choose(value, evt);
      return false;
    });
    this.scope.register([], "Escape", () => {
      this.close();
      return false;
    });
  }

  abstract getSuggestions(input: string): T[] | Promise<T[]>;
  abstract renderSuggestion(value: T, el: HTMLElement): void;
  abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): void;

  getValue(): string {
    const el = this.textInputEl;
    return el instanceof HTMLDivElement ? el.textContent ?? "" : el.value;
  }

  setValue(value: string): void {
    const el = this.textInputEl;
    if (el instanceof HTMLDivElement) el.textContent = value;
    else el.value = value;
  }

  /** Called after a suggestion is chosen, in addition to `selectSuggestion`. */
  onSelect(callback: (value: T, evt: MouseEvent | KeyboardEvent) => void): this {
    this.selectCallbacks.push(callback);
    return this;
  }

  /** Show the popover with suggestions for the current input value. */
  open(): void {
    void this.refresh();
  }

  close(): void {
    this.generation++; // invalidate any in-flight getSuggestions
    if (this.isOpen) this.keymap()?.popScope(this.scope);
    this.isOpen = false;
    this.containerEl?.remove();
    this.containerEl = null;
    this.suggestions = [];
    this.selectedIndex = -1;
    window.removeEventListener("resize", this.onWindowResize);
  }

  /** Detach all listeners. Not part of Obsidian's API; used by hosts that tear inputs down. */
  destroy(): void {
    this.close();
    this.textInputEl.removeEventListener("input", this.onInput);
    this.textInputEl.removeEventListener("focus", this.onFocus);
    this.textInputEl.removeEventListener("blur", this.onBlur);
  }

  private keymap(): { pushScope(scope: Scope): void; popScope(scope: Scope): void } | undefined {
    return (this.app as unknown as { keymap?: { pushScope(scope: Scope): void; popScope(scope: Scope): void } }).keymap;
  }

  /** Scope handler: move the selection; returning false marks the key handled. */
  private moveSelection(delta: number): boolean {
    this.selectedIndex = moveSuggestionIndex(this.selectedIndex, delta, this.suggestions.length);
    this.renderList();
    return false;
  }

  private async refresh(): Promise<void> {
    const generation = ++this.generation;
    let results: T[];
    try {
      results = await this.getSuggestions(this.getValue());
    } catch (error) {
      console.error("AbstractInputSuggest.getSuggestions failed", error);
      if (generation === this.generation) this.close();
      return;
    }
    if (generation !== this.generation || !this.textInputEl.isConnected) return;
    this.suggestions = results.slice(0, this.limit);
    if (!this.suggestions.length) {
      this.close();
      return;
    }
    this.selectedIndex = initialSuggestionIndex(this.suggestions.length);
    if (!this.containerEl) {
      this.containerEl = document.createElement("div");
      this.containerEl.className = "suggestion-container geode-input-suggest";
      // mousedown would blur the input (closing us) before click lands.
      this.containerEl.addEventListener("mousedown", (e) => e.preventDefault());
      document.body.appendChild(this.containerEl);
      window.addEventListener("resize", this.onWindowResize);
    }
    if (!this.isOpen) this.keymap()?.pushScope(this.scope);
    this.isOpen = true;
    this.renderList();
    this.position();
  }

  private renderList(): void {
    const container = this.containerEl;
    if (!container) return;
    container.replaceChildren();
    const list = document.createElement("div");
    list.className = "suggestion";
    this.suggestions.forEach((value, index) => {
      const item = document.createElement("div");
      item.className = "suggestion-item" + (index === this.selectedIndex ? " is-selected" : "");
      this.renderSuggestion(value, item);
      item.addEventListener("mousemove", (e) => {
        if (e.movementX === 0 && e.movementY === 0) return;
        if (this.selectedIndex !== index) {
          this.selectedIndex = index;
          list.querySelector(".is-selected")?.classList.remove("is-selected");
          item.classList.add("is-selected");
        }
      });
      item.addEventListener("click", (e) => this.choose(value, e));
      list.appendChild(item);
    });
    container.appendChild(list);
    list.children[this.selectedIndex]?.scrollIntoView({ block: "nearest" });
  }

  private position(): void {
    const container = this.containerEl;
    if (!container) return;
    const anchor = this.textInputEl.getBoundingClientRect();
    container.style.minWidth = `${Math.round(anchor.width)}px`;
    const size = container.getBoundingClientRect();
    const { left, top } = computeAnchoredMenuPosition({
      anchor,
      menu: { width: size.width, height: size.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      margin: 8,
      gap: 2,
      horizontalAlign: "start",
    });
    container.style.left = `${left}px`;
    container.style.top = `${top}px`;
  }

  private choose(value: T, evt: MouseEvent | KeyboardEvent): void {
    this.selecting = true;
    try {
      this.selectSuggestion(value, evt);
      for (const callback of this.selectCallbacks) callback(value, evt);
    } finally {
      this.selecting = false;
    }
    this.close();
  }
}
