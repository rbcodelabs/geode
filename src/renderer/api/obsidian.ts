/**
 * Geode's Obsidian-compatible API surface. This is what a plugin gets from
 * `require('obsidian')` (and, as a superset, `require('geode')`). It
 * re-exports Geode's own primitives where they already match Obsidian's
 * shape, and adds shim implementations of the Obsidian symbols Geode
 * doesn't natively have (`ItemView`, `Modal`, `Setting`, `Menu`, `Notice`,
 * …). The goal is behavioural compatibility sufficient to *host real
 * Obsidian plugins* (Claude Threads is the reference target), not a
 * byte-for-byte reimplementation of Obsidian's private internals.
 */
import { Component } from "../component";
import { Plugin as GeodePlugin } from "../plugin";
import type { App } from "../app";
import { buildViewHeaderNavButtons, type WorkspaceLeaf, type View as GeodeView } from "../workspace";
import { installObsidianDomExtensions } from "./obsidian-dom";
import { addIcon, setIcon } from "./icons";
import type {
  MarkdownPostProcessor,
  MarkdownPostProcessorContext,
} from "../markdown/processor-registry";
import { Scope, EditorSuggest } from "./suggest";
import moment from "moment";

// Ensure the DOM helpers exist the moment the compat module is first
// evaluated (i.e. when a plugin requires 'obsidian'), even if the host
// forgot to install them at boot.
installObsidianDomExtensions();

// Obsidian bundles moment and puts it on window as well as re-exporting it
// from the 'obsidian' module, and some plugins reference `window.moment`
// directly at module scope (before onload() runs). Attach it here, at
// module-eval time, mirroring the DOM-extensions install-at-eval-time
// pattern above. Guard on `typeof window` since this module is also
// imported by Node-environment unit tests. `??=` avoids clobbering a
// host-provided moment (e.g. a real Obsidian-compatible environment that
// already set one).
if (typeof window !== "undefined") {
  (window as unknown as { moment?: unknown }).moment ??= moment;
}

// --- Re-exports of Geode primitives that already match Obsidian ------------
export { Component } from "../component";
export { Events } from "../events";
export { Vault } from "../vault";
export { Workspace, WorkspaceLeaf, TabGroup } from "../workspace";
export { MetadataCache, parseMetadata } from "../metadata-cache";
export { MarkdownView } from "../views/markdown-view";
export { isTFile, isTFolder, normalizePath } from "../types";
export type { App } from "../app";
export type { TAbstractFile, CachedMetadata } from "../types";
// Keymap + in-editor suggest primitives. `EditorSuggest` must be a real,
// subclassable export (plugins do `class X extends EditorSuggest` at
// module-eval time) and `Scope` backs `app.scope` (installed below). See
// ./suggest for the PR-2a "loads, doesn't yet drive a popover" scope.
export { Scope, EditorSuggest } from "./suggest";
export type {
  KeymapEventHandler,
  KeymapEventListener,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
} from "./suggest";

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Debounce, matching Obsidian's signature (returns a debounced fn with .cancel/.run). */
export function debounce<T extends (...args: any[]) => any>(fn: T, timeout = 0, resetTimer = false) {
  let handle: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: any[] = [];
  const debounced = (...args: any[]) => {
    lastArgs = args;
    if (handle && resetTimer) {
      clearTimeout(handle);
      handle = null;
    }
    if (!handle) {
      handle = setTimeout(() => {
        handle = null;
        fn(...lastArgs);
      }, timeout);
    }
  };
  (debounced as any).cancel = () => {
    if (handle) clearTimeout(handle);
    handle = null;
  };
  (debounced as any).run = () => fn(...lastArgs);
  return debounced as T & { cancel(): void; run(): void };
}

// Icons resolve to real Lucide SVGs (Obsidian's icon set) — see api/icons.ts.
export { addIcon, setIcon };
export { moment };
export function setTooltip(el: HTMLElement, tooltip: string): void {
  el.setAttribute("aria-label", tooltip);
  el.setAttribute("title", tooltip);
}

/** Sanitize an HTML string into a DocumentFragment (Obsidian uses this for untrusted HTML). */
export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  // Strip script elements defensively.
  template.content.querySelectorAll("script").forEach((s) => s.remove());
  return template.content;
}

export interface RequestUrlParam {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
  throw?: boolean;
}
export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: any;
  text: string;
}
/** HTTP client matching Obsidian's requestUrl, implemented over the renderer's fetch. */
export async function requestUrl(param: RequestUrlParam | string): Promise<RequestUrlResponse> {
  const p: RequestUrlParam = typeof param === "string" ? { url: param } : param;
  const headers = { ...(p.headers ?? {}) };
  if (p.contentType) headers["Content-Type"] = p.contentType;
  const res = await fetch(p.url, { method: p.method ?? "GET", headers, body: p.body as any });
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(buf);
  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (respHeaders[k] = v));
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  if (p.throw !== false && res.status >= 400) {
    throw new Error(`requestUrl ${p.url} failed: ${res.status}`);
  }
  return { status: res.status, headers: respHeaders, arrayBuffer: buf, json, text };
}

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
export const Platform = {
  isDesktop: true,
  isMobile: false,
  isDesktopApp: true,
  isMobileApp: false,
  isPhone: false,
  isTablet: false,
  isMacOS: /Mac/.test(ua),
  isWin: /Win/.test(ua),
  isLinux: /Linux/.test(ua),
  isIosApp: false,
  isAndroidApp: false,
  isSafari: /^((?!chrome|android).)*safari/i.test(ua),
  resourcePathPrefix: "app://local/",
};

// ---------------------------------------------------------------------------
// Notice — a transient toast
// ---------------------------------------------------------------------------

export class Notice {
  noticeEl: HTMLElement;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(message: string | DocumentFragment, duration = 4000) {
    let host = document.querySelector(".notice-container") as HTMLElement | null;
    if (!host) {
      host = document.createElement("div");
      host.className = "notice-container";
      document.body.appendChild(host);
    }
    this.noticeEl = document.createElement("div");
    this.noticeEl.className = "notice";
    this.setMessage(message);
    host.appendChild(this.noticeEl);
    if (duration > 0) this.hideTimer = setTimeout(() => this.hide(), duration);
  }

  setMessage(message: string | DocumentFragment): this {
    if (typeof message === "string") this.noticeEl.textContent = message;
    else {
      this.noticeEl.textContent = "";
      this.noticeEl.appendChild(message);
    }
    return this;
  }

  hide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.noticeEl.remove();
  }
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export class Modal {
  app: App;
  containerEl: HTMLElement;
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  private scopeEl: HTMLElement;

  constructor(app: App) {
    this.app = app;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "modal-container mod-dim";
    this.scopeEl = document.createElement("div");
    this.scopeEl.className = "modal-bg";
    this.modalEl = document.createElement("div");
    this.modalEl.className = "modal";
    const closeEl = document.createElement("div");
    closeEl.className = "modal-close-button";
    closeEl.addEventListener("click", () => this.close());
    this.titleEl = document.createElement("div");
    this.titleEl.className = "modal-title";
    this.contentEl = document.createElement("div");
    this.contentEl.className = "modal-content";
    this.modalEl.append(closeEl, this.titleEl, this.contentEl);
    this.containerEl.append(this.scopeEl, this.modalEl);
    this.scopeEl.addEventListener("click", () => this.close());
  }

  open(): void {
    document.body.appendChild(this.containerEl);
    this.onOpen();
  }

  close(): void {
    this.onClose();
    this.containerEl.remove();
  }

  setTitle(title: string): this {
    this.titleEl.textContent = title;
    return this;
  }

  setContent(content: string | DocumentFragment): this {
    this.contentEl.empty();
    if (typeof content === "string") this.contentEl.textContent = content;
    else this.contentEl.appendChild(content);
    return this;
  }

  onOpen(): void {}
  onClose(): void {}
}

// ---------------------------------------------------------------------------
// Setting / SettingComponents
// ---------------------------------------------------------------------------

class ValueComponent<T> {
  protected changeCb?: (value: T) => any;
  onChange(cb: (value: T) => any): this {
    this.changeCb = cb;
    return this;
  }
}

export class ButtonComponent {
  buttonEl: HTMLButtonElement;
  constructor(container: HTMLElement) {
    this.buttonEl = document.createElement("button");
    container.appendChild(this.buttonEl);
  }
  setButtonText(text: string): this {
    this.buttonEl.textContent = text;
    return this;
  }
  setIcon(icon: string): this {
    setIcon(this.buttonEl, icon);
    return this;
  }
  setCta(): this {
    this.buttonEl.classList.add("mod-cta");
    return this;
  }
  setWarning(): this {
    this.buttonEl.classList.add("mod-warning");
    return this;
  }
  setTooltip(tooltip: string): this {
    setTooltip(this.buttonEl, tooltip);
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.buttonEl.disabled = disabled;
    return this;
  }
  onClick(cb: (evt: MouseEvent) => any): this {
    this.buttonEl.addEventListener("click", cb);
    return this;
  }
}

export class TextComponent extends ValueComponent<string> {
  inputEl: HTMLInputElement;
  constructor(container: HTMLElement) {
    super();
    this.inputEl = document.createElement("input");
    this.inputEl.type = "text";
    container.appendChild(this.inputEl);
    this.inputEl.addEventListener("input", () => this.changeCb?.(this.inputEl.value));
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.inputEl.disabled = disabled;
    return this;
  }
}

export class TextAreaComponent extends ValueComponent<string> {
  inputEl: HTMLTextAreaElement;
  constructor(container: HTMLElement) {
    super();
    this.inputEl = document.createElement("textarea");
    container.appendChild(this.inputEl);
    this.inputEl.addEventListener("input", () => this.changeCb?.(this.inputEl.value));
  }
  getValue(): string {
    return this.inputEl.value;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  setPlaceholder(placeholder: string): this {
    this.inputEl.placeholder = placeholder;
    return this;
  }
}

export class ToggleComponent extends ValueComponent<boolean> {
  toggleEl: HTMLElement;
  private value = false;
  constructor(container: HTMLElement) {
    super();
    this.toggleEl = document.createElement("div");
    this.toggleEl.className = "checkbox-container";
    container.appendChild(this.toggleEl);
    this.toggleEl.addEventListener("click", () => this.setValue(!this.value, true));
  }
  getValue(): boolean {
    return this.value;
  }
  setValue(value: boolean, fireChange = false): this {
    this.value = value;
    this.toggleEl.classList.toggle("is-enabled", value);
    if (fireChange) this.changeCb?.(value);
    return this;
  }
}

export class DropdownComponent extends ValueComponent<string> {
  selectEl: HTMLSelectElement;
  constructor(container: HTMLElement) {
    super();
    this.selectEl = document.createElement("select");
    container.appendChild(this.selectEl);
    this.selectEl.addEventListener("change", () => this.changeCb?.(this.selectEl.value));
  }
  addOption(value: string, display: string): this {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = display;
    this.selectEl.appendChild(opt);
    return this;
  }
  addOptions(options: Record<string, string>): this {
    for (const [value, display] of Object.entries(options)) this.addOption(value, display);
    return this;
  }
  getValue(): string {
    return this.selectEl.value;
  }
  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }
}

export class SecretComponent extends TextComponent {
  constructor(container: HTMLElement) {
    super(container);
    this.inputEl.type = "password";
  }
}

export class Setting {
  settingEl: HTMLElement;
  infoEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;
  components: unknown[] = [];

  constructor(container: HTMLElement) {
    this.settingEl = document.createElement("div");
    this.settingEl.className = "setting-item";
    this.infoEl = document.createElement("div");
    this.infoEl.className = "setting-item-info";
    this.nameEl = document.createElement("div");
    this.nameEl.className = "setting-item-name";
    this.descEl = document.createElement("div");
    this.descEl.className = "setting-item-description";
    this.controlEl = document.createElement("div");
    this.controlEl.className = "setting-item-control";
    this.infoEl.append(this.nameEl, this.descEl);
    this.settingEl.append(this.infoEl, this.controlEl);
    container.appendChild(this.settingEl);
  }

  setName(name: string | DocumentFragment): this {
    if (typeof name === "string") this.nameEl.textContent = name;
    else this.nameEl.appendChild(name);
    return this;
  }
  setDesc(desc: string | DocumentFragment): this {
    if (typeof desc === "string") this.descEl.textContent = desc;
    else this.descEl.appendChild(desc);
    return this;
  }
  setHeading(): this {
    this.settingEl.classList.add("setting-item-heading");
    return this;
  }
  setClass(cls: string): this {
    this.settingEl.classList.add(cls);
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.settingEl.classList.toggle("is-disabled", disabled);
    return this;
  }
  addButton(cb: (c: ButtonComponent) => any): this {
    const c = new ButtonComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }
  addExtraButton(cb: (c: ButtonComponent) => any): this {
    return this.addButton(cb);
  }
  addText(cb: (c: TextComponent) => any): this {
    const c = new TextComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }
  addTextArea(cb: (c: TextAreaComponent) => any): this {
    const c = new TextAreaComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }
  addToggle(cb: (c: ToggleComponent) => any): this {
    const c = new ToggleComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }
  addDropdown(cb: (c: DropdownComponent) => any): this {
    const c = new DropdownComponent(this.controlEl);
    this.components.push(c);
    cb(c);
    return this;
  }
  addSearch(cb: (c: TextComponent) => any): this {
    return this.addText(cb);
  }
  then(cb: (setting: this) => any): this {
    cb(this);
    return this;
  }
}

// ---------------------------------------------------------------------------
// PluginSettingTab
// ---------------------------------------------------------------------------

export abstract class PluginSettingTab {
  app: App;
  plugin: unknown;
  containerEl: HTMLElement;

  constructor(app: App, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "vertical-tab-content";
  }

  abstract display(): void;
  hide(): void {
    this.containerEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

export class MenuItem {
  dom: HTMLElement;
  private clickCb?: (evt: MouseEvent | KeyboardEvent) => any;
  constructor(private menu: Menu) {
    this.dom = document.createElement("div");
    this.dom.className = "menu-item";
    this.dom.addEventListener("click", (e) => {
      this.clickCb?.(e);
      this.menu.hide();
    });
  }
  setTitle(title: string): this {
    let titleEl = this.dom.querySelector(".menu-item-title") as HTMLElement | null;
    if (!titleEl) {
      titleEl = document.createElement("div");
      titleEl.className = "menu-item-title";
      this.dom.appendChild(titleEl);
    }
    titleEl.textContent = title;
    return this;
  }
  setIcon(icon: string | null): this {
    if (!icon) return this;
    const iconEl = document.createElement("div");
    iconEl.className = "menu-item-icon";
    setIcon(iconEl, icon);
    this.dom.prepend(iconEl);
    return this;
  }
  setChecked(checked: boolean): this {
    this.dom.classList.toggle("is-checked", checked);
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.dom.classList.toggle("is-disabled", disabled);
    return this;
  }
  setSection(): this {
    return this;
  }
  onClick(cb: (evt: MouseEvent | KeyboardEvent) => any): this {
    this.clickCb = cb;
    return this;
  }
}

export class Menu {
  dom: HTMLElement;
  items: MenuItem[] = [];
  constructor() {
    this.dom = document.createElement("div");
    this.dom.className = "menu";
  }
  addItem(cb: (item: MenuItem) => any): this {
    const item = new MenuItem(this);
    this.items.push(item);
    this.dom.appendChild(item.dom);
    cb(item);
    return this;
  }
  addSeparator(): this {
    const sep = document.createElement("div");
    sep.className = "menu-separator";
    this.dom.appendChild(sep);
    return this;
  }
  showAtMouseEvent(evt: MouseEvent): this {
    return this.showAtPosition({ x: evt.clientX, y: evt.clientY });
  }
  showAtPosition(pos: { x: number; y: number }): this {
    this.dom.style.position = "fixed";
    this.dom.style.left = `${pos.x}px`;
    this.dom.style.top = `${pos.y}px`;
    document.body.appendChild(this.dom);
    const onDocClick = (e: MouseEvent) => {
      if (!this.dom.contains(e.target as Node)) this.hide();
    };
    setTimeout(() => document.addEventListener("click", onDocClick, { once: true }), 0);
    return this;
  }
  hide(): this {
    this.dom.remove();
    return this;
  }
  onHide(_cb: () => any): this {
    return this;
  }
}

// ---------------------------------------------------------------------------
// View / ItemView
// ---------------------------------------------------------------------------

/**
 * Base View, matching Obsidian's `View`/`ItemView` closely enough that a
 * plugin's `ItemView` subclass renders inside a Geode `WorkspaceLeaf`. Geode
 * leaves already call `onOpen`/`onClose` and read `containerEl` (see
 * workspace.ts's `WorkspaceLeaf.setView`), so an Obsidian ItemView slots in
 * as a Geode `View` implementation. It extends `Component` for the
 * register-and-child-component lifecycle plugins rely on.
 */
export class View extends Component implements GeodeView {
  app: App;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  icon = "document";
  navigation = false;

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = document.createElement("div");
    this.containerEl.className = "workspace-leaf-content view-content-host";
  }

  // Geode View interface:
  get viewType(): string {
    return this.getViewType();
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return this.icon;
  }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}

  // Obsidian View interface:
  getViewType(): string {
    return "";
  }
  getState(): unknown {
    return {};
  }
  async setState(_state: unknown): Promise<void> {}
  onResize(): void {}
}

export abstract class ItemView extends View {
  contentEl: HTMLElement;
  private headerTitleEl: HTMLElement;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    // Obsidian ItemView layout: containerEl > .view-header + .view-content.
    // Plugins render into contentEl. This base ItemView has no backing file,
    // so its header is title-only (no breadcrumb) — matching real Obsidian's
    // plugin views (Kanban Board, Skills Manager, …).
    const header = document.createElement("div");
    header.className = "view-header";

    const left = document.createElement("div");
    left.className = "view-header-left";
    // Back/forward nav belongs to the main pane only — real Obsidian never
    // renders it in a docked sidebar pane. `this.leaf` is set in `super()`
    // above, so the container kind is known here at construction time.
    if (!this.leaf.group?.isSidebar) left.append(buildViewHeaderNavButtons());

    const titleContainer = document.createElement("div");
    titleContainer.className = "view-header-title-container";
    this.headerTitleEl = document.createElement("div");
    this.headerTitleEl.className = "view-header-title";
    titleContainer.append(this.headerTitleEl);
    left.append(titleContainer);

    const actions = document.createElement("div");
    actions.className = "view-actions";

    header.append(left, actions);
    this.contentEl = document.createElement("div");
    this.contentEl.className = "view-content";
    this.containerEl.append(header, this.contentEl);

    // `getDisplayText()` is commonly overridden using fields the subclass
    // sets in its own constructor body, which hasn't run yet at this point
    // (we're still inside `super()`). Defer the first read to a microtask,
    // after the subclass constructor completes, so it sees real state.
    Promise.resolve().then(() => this.refreshHeaderTitle());
  }

  /** Refresh the header's title text from `getDisplayText()`. Also called by `WorkspaceLeaf.updateHeader()`. */
  refreshHeaderTitle(): void {
    this.headerTitleEl.textContent = this.getDisplayText();
  }

  abstract getViewType(): string;
  abstract getDisplayText(): string;
}

/**
 * Obsidian's `FileView` compat: real plugins use `instanceof FileView` to
 * test "is this view showing a file at all" (e.g. the vendored Calendar
 * fixture's `updateActiveFile`/`revealActiveNote`, checking the active
 * leaf's view before reading `.file`). Geode's own file-backed view
 * (`MarkdownView`) isn't a class in this hierarchy — it `implements View`
 * directly (see src/renderer/views/markdown-view.ts) rather than
 * subclassing the plugin-facing `View`/`ItemView` above — so, like
 * `TFile`/`TFolder`, this customises `instanceof` via `Symbol.hasInstance`
 * instead of relying on a real prototype chain: anything exposing a
 * `getFile()` method (Geode's own convention for "this view shows a file",
 * already used by `Workspace.getActiveFile()`) satisfies
 * `instanceof FileView`. No plugin in this repo's test fixtures subclasses
 * `FileView` itself, so a lightweight instanceof-only shim (vs. a fully
 * extendable base class with `file`/`onLoadFile`/`onUnloadFile`) is
 * sufficient.
 */
export class FileView {
  static [Symbol.hasInstance](obj: unknown): boolean {
    return !!obj && typeof (obj as { getFile?: unknown }).getFile === "function";
  }
}

// ---------------------------------------------------------------------------
// FileSystemAdapter
// ---------------------------------------------------------------------------

/**
 * `FileSystemAdapter` is defined in the leaf `../types` module (alongside the
 * `TFile`/`TFolder` runtime classes) so that `vault.ts` can construct real
 * instances for `vault.adapter` without importing this module — importing
 * `api/obsidian.ts` from `vault.ts` would form a cycle, since this module
 * already re-exports `Vault` from `vault.ts`. Re-exported here so plugins get
 * it from `require('obsidian').FileSystemAdapter`.
 */
export { FileSystemAdapter } from "../types";

// ---------------------------------------------------------------------------
// TFile / TFolder classes (for `instanceof`)
// ---------------------------------------------------------------------------

export { TFileClass as TFile, TFolderClass as TFolder } from "../types";

// ---------------------------------------------------------------------------
// Plugin (Geode's, extended with the Obsidian Plugin methods)
// ---------------------------------------------------------------------------

/**
 * Add the app-level Obsidian APIs Geode's `App` doesn't natively have but
 * that hosted plugins expect on `this.app`: `secretStorage` (async secret
 * get/set, persisted in localStorage — a fuller keychain-backed store is a
 * follow-up), and the `plugins`/`internalPlugins` registries. Idempotent;
 * runs when the first Obsidian-compat plugin is constructed.
 */
function installObsidianAppCompat(app: App): void {
  const a = app as any;
  if (!a.secretStorage) {
    // Obsidian's secretStorage.getSecret/setSecret are synchronous (plugins
    // call `storedKey.startsWith(...)` on the result without awaiting), so
    // these return values directly. `await` on a plain value is still fine
    // for the call sites that do await.
    const key = (k: string) => `geode:secret:${k}`;
    a.secretStorage = {
      getSecret(k: string): string | null {
        return window.localStorage.getItem(key(k));
      },
      setSecret(k: string, value: string): void {
        window.localStorage.setItem(key(k), value);
      },
      deleteSecret(k: string): void {
        window.localStorage.removeItem(key(k));
      },
      isEncryptionAvailable(): boolean {
        return false;
      },
    };
  }
  if (!a.plugins) {
    a.plugins = {
      plugins: {},
      enabledPlugins: new Set<string>(),
      manifests: {},
      getPlugin: (id: string) => a.pluginManager?.getPlugin?.(id) ?? null,
      enablePlugin: (id: string) => a.pluginManager?.enable?.(id),
      disablePlugin: (id: string) => a.pluginManager?.disable?.(id),
    };
  }
  if (!a.internalPlugins) {
    // "daily-notes" is the one internal plugin id real community plugins
    // actually query (e.g. Calendar, via the bundled
    // obsidian-daily-notes-interface library, reads
    // `getPluginById("daily-notes")?.instance?.options` for
    // folder/format/template, and separately checks
    // `internalPlugins.plugins["daily-notes"]?.enabled` — see
    // tests/fixtures/plugins/calendar/main.js). Both lookups are backed
    // live by App.dailyNoteSettings so hosted plugins and Geode's own
    // daily-notes feature (App.openDailyNote) agree on config. Every other
    // internal plugin id still resolves to null/disabled — Geode has no
    // compat shim for them.
    const dailyNotesDescriptor = () => ({
      enabled: true,
      instance: { options: (app as any).dailyNoteSettings },
    });
    a.internalPlugins = {
      plugins: {
        get "daily-notes"() {
          return dailyNotesDescriptor();
        },
      },
      getPluginById: (id: string) => (id === "daily-notes" ? dailyNotesDescriptor() : null),
      getEnabledPluginById: (id: string) => (id === "daily-notes" ? dailyNotesDescriptor() : null),
    };
  }
  if (!a.scope) {
    // Root keymap scope. Plugins that build editor suggests register hotkey
    // handlers against `app.scope` at construction time (e.g. obsidian-tasks
    // does `app.scope.register([], "Tab", …)` inside its EditorSuggest
    // subclass constructor). STORE-ONLY for now — Geode has no keymap stack,
    // so handlers are recorded but never dispatched (see ./suggest). This
    // just has to exist and not throw so those plugins finish loading.
    a.scope = new Scope();
  }
  if (!a.foldManager) {
    // Obsidian's fold-state manager (collapsed headings/list items per
    // file). Geode doesn't persist fold state, but real plugins call
    // `app.foldManager.save(file, info)`/`.load(file)` unguarded when
    // creating a note (e.g. obsidian-daily-notes-interface's
    // `createDailyNote`, bundled into the vendored Calendar fixture) — so
    // this must exist and never throw. `load` always reports "no saved
    // fold state" (null); `save` is a no-op.
    a.foldManager = {
      load: (_file: unknown) => null,
      save: (_file: unknown, _info: unknown) => {},
    };
  }
}

export abstract class Plugin extends GeodePlugin {
  constructor(app: App, manifest: import("../plugin-manifest").PluginManifest) {
    super(app, manifest);
    installObsidianAppCompat(app);
  }

  /** Add a clickable icon to the left ribbon. Returns the created element. */
  addRibbonIcon(icon: string, title: string, callback: (evt: MouseEvent) => any): HTMLElement {
    const el = document.createElement("div");
    el.className = "side-dock-ribbon-action";
    setIcon(el, icon);
    setTooltip(el, title);
    el.addEventListener("click", callback);
    (this.app as any).addRibbonIcon?.(el);
    this.register(() => el.remove());
    return el;
  }

  /** Add an element to the status bar. Returns the created element. */
  addStatusBarItem(): HTMLElement {
    const el = document.createElement("div");
    el.className = "status-bar-item plugin-" + this.manifest.id;
    (this.app as any).addStatusBarItem?.(el);
    this.register(() => el.remove());
    return el;
  }

  /** Register a settings tab. */
  addSettingTab(tab: PluginSettingTab): void {
    (this.app as any).registerSettingTab?.(this.manifest.id, tab);
    this.register(() => (this.app as any).unregisterSettingTab?.(this.manifest.id));
  }

  /** Register an obsidian:// protocol handler (no-op host, stored for completeness). */
  registerObsidianProtocolHandler(action: string, handler: (params: any) => any): void {
    (this.app as any).registerProtocolHandler?.(action, handler);
  }

  /**
   * Register a reading-view post processor that runs over the whole rendered
   * document. Returns the `MarkdownPostProcessor` handle (with `sortOrder`);
   * auto-unregistered on `onunload()`.
   */
  registerMarkdownPostProcessor(
    processor: (el: HTMLElement, ctx: MarkdownPostProcessorContext) => void | Promise<any>,
    sortOrder = 0
  ): MarkdownPostProcessor {
    const handle: MarkdownPostProcessor | undefined = (this.app as any).registerMarkdownPostProcessor?.(
      processor,
      sortOrder
    );
    this.register(() => (this.app as any).unregisterMarkdownPostProcessor?.(handle ?? processor));
    return handle ?? (Object.assign(processor, { sortOrder }) as MarkdownPostProcessor);
  }

  /**
   * Register a reading-view processor for a fenced code-block language (e.g.
   * ```tasks). The handler receives the block's raw source, a fresh container
   * element (which replaces the rendered `<pre>`), and the render context.
   * Auto-unregistered on `onunload()`.
   */
  registerMarkdownCodeBlockProcessor(
    lang: string,
    handler: (
      source: string,
      el: HTMLElement,
      ctx: MarkdownPostProcessorContext
    ) => void | Promise<any>,
    _sortOrder = 0
  ): MarkdownPostProcessor {
    const handle: MarkdownPostProcessor | undefined = (
      this.app as any
    ).registerMarkdownCodeBlockProcessor?.(lang, handler);
    this.register(() => (this.app as any).unregisterMarkdownCodeBlockProcessor?.(lang, handler));
    return handle ?? (Object.assign((_el: HTMLElement) => {}, { sortOrder: 0 }) as MarkdownPostProcessor);
  }

  registerEditorExtension(_ext: unknown): void {}

  /**
   * Register a hover-link source. STORE-ONLY: Geode has no hover-preview
   * infrastructure yet, so this just stashes `id`/`info` on the app (removed
   * on `onunload()`) rather than wiring any rendering behavior — a
   * well-behaved stub, not a working hover preview.
   */
  registerHoverLinkSource(id: string, info: unknown): void {
    (this.app as any).hoverLinkSources?.set(id, info);
    this.register(() => (this.app as any).hoverLinkSources?.delete(id));
  }

  /**
   * Register an in-editor autocomplete suggest. STORE-ONLY: Geode does not
   * yet drive the suggest popover from the editor (that's follow-up work), so
   * this stashes the suggest on the app — making the registration inspectable
   * and cleaned up on `onunload()` — rather than silently dropping it. The
   * suggest still constructs (see `EditorSuggest`/`app.scope`), which is what
   * unblocks plugin *load*; its trigger callbacks just aren't invoked yet.
   */
  registerEditorSuggest(suggest: unknown): void {
    (this.app as any).editorSuggests?.add(suggest);
    this.register(() => (this.app as any).editorSuggests?.delete(suggest));
  }
  registerExtensions(_exts: string[], _viewType: string): void {}
}

// ---------------------------------------------------------------------------
// Markdown reading-view processor API surface
// ---------------------------------------------------------------------------

export { MarkdownRenderChild, MarkdownProcessorRegistry } from "../markdown/processor-registry";
export type {
  MarkdownPostProcessorContext,
  MarkdownPostProcessor,
  MarkdownSectionInformation,
  MarkdownCodeBlockProcessor,
} from "../markdown/processor-registry";

/**
 * Static Markdown-rendering helper mirroring Obsidian's `MarkdownRenderer`
 * class. Plugins (obsidian-tasks among them) call
 * `MarkdownRenderer.render(app, markdown, el, sourcePath, component)` to
 * render arbitrary markdown into a container; this delegates to the app's
 * shared reading-view renderer.
 *
 * NB: the internal instance renderer lives in `../markdown/render.ts` (also
 * named `MarkdownRenderer`); this class is the plugin-facing static facade and
 * is deliberately separate.
 */
export class MarkdownRenderer {
  /**
   * Render `markdown` into `el` as reading-view HTML. `component` owns any
   * child lifecycles a plugin attaches; Geode's renderer ties the surfaces it
   * mounts (bases, render children) to `el` and tears them down on re-render,
   * so the argument is accepted for API parity but not separately tracked.
   */
  static async render(
    app: App,
    markdown: string,
    el: HTMLElement,
    sourcePath: string,
    _component: Component
  ): Promise<void> {
    await app.markdownRenderer.render(markdown, el, sourcePath);
  }

  /**
   * Deprecated Obsidian alias for {@link MarkdownRenderer.render}. Geode
   * requires `app` as the first argument (there is no global app singleton to
   * fall back on, unlike Obsidian's legacy no-`app` signature).
   */
  static async renderMarkdown(
    app: App,
    markdown: string,
    el: HTMLElement,
    sourcePath: string,
    _component: Component
  ): Promise<void> {
    await app.markdownRenderer.render(markdown, el, sourcePath);
  }
}
