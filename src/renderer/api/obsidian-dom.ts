/**
 * Obsidian's DOM prototype extensions. Obsidian augments `Node`/`Element`/
 * `HTMLElement` (and exposes a few globals) with ergonomic helpers —
 * `createEl`, `createDiv`, `empty`, `addClass`, `setText`, `find`, … — that
 * plugin UIs use pervasively (Claude Threads calls `createEl` 470+ times).
 * They are part of Obsidian's *runtime environment*, not its importable
 * `obsidian` module, so they must be installed on the prototypes once at
 * app startup for plugin view code to run at all.
 *
 * `installObsidianDomExtensions()` is idempotent and only adds a helper if
 * it isn't already present, so it never clobbers a native or
 * previously-installed method.
 */

declare global {
  interface Node {
    empty(): this;
    detach(): this;
    appendText(text: string): this;
    /**
     * Cross-window capable `instanceof`, per Obsidian's documented `Node`
     * augmentation. A node adopted into a popout window is constructed by
     * *that* window's realm, so a plain `instanceof HTMLElement` against the
     * main window's constructor returns false. This checks the node's own
     * realm too.
     */
    instanceOf<T>(type: { new (...args: any[]): T }): this is T;
    /** The document this node belongs to, or the global document. */
    readonly doc: Document;
  }
  interface Event {
    /**
     * Cross-window capable `instanceof` for events. Obsidian documents this
     * on `UIEvent`; installing it on `Event` is a strict superset (there is
     * no native `Event.prototype.instanceOf` to clobber) and means a plugin
     * that reaches for it on a non-UI event gets working behaviour instead
     * of a `TypeError`.
     */
    instanceOf<T>(type: { new (...args: any[]): T }): this is T;
  }
  interface Element {
    addClass(...classes: string[]): this;
    removeClass(...classes: string[]): this;
    toggleClass(classes: string | string[], value?: boolean): this;
    hasClass(cls: string): boolean;
    setAttr(key: string, value: string | number | boolean | null): this;
    setAttrs(attrs: Record<string, string | number | boolean | null>): this;
    getAttr(key: string): string | null;
    find(selector: string): HTMLElement | null;
    findAll(selector: string): HTMLElement[];
  }
  interface HTMLElement {
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      o?: DomElementInfo | string,
      callback?: (el: HTMLElementTagNameMap[K]) => void
    ): HTMLElementTagNameMap[K];
    createDiv(o?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
    createSpan(o?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement;
    setText(text: string | DocumentFragment): this;
    setCssStyles(styles: Partial<CSSStyleDeclaration>): this;
    setCssProps(props: Record<string, string>): this;
    onClickEvent(cb: (ev: MouseEvent) => unknown): this;
    /**
     * Delegated event registration — Obsidian's 3-argument `on`. The
     * listener fires only when the event's target is (or is inside) an
     * element matching `selector` within this subtree, and receives that
     * matched element as its second argument.
     */
    on<K extends keyof HTMLElementEventMap>(
      type: K,
      selector: string,
      listener: (this: HTMLElement, ev: HTMLElementEventMap[K], delegateTarget: HTMLElement) => any,
      options?: boolean | AddEventListenerOptions
    ): void;
    /** Remove a delegated listener previously registered with the same `type`/`selector`/`listener`. */
    off<K extends keyof HTMLElementEventMap>(
      type: K,
      selector: string,
      listener: (this: HTMLElement, ev: HTMLElementEventMap[K], delegateTarget: HTMLElement) => any,
      options?: boolean | AddEventListenerOptions
    ): void;
  }
  interface Document {
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      o?: DomElementInfo | string,
      callback?: (el: HTMLElementTagNameMap[K]) => void
    ): HTMLElementTagNameMap[K];
    createDiv(o?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
    createSpan(o?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement;
    find(selector: string): HTMLElement | null;
    findAll(selector: string): HTMLElement[];
    on<K extends keyof DocumentEventMap>(
      type: K,
      selector: string,
      listener: (this: Document, ev: DocumentEventMap[K], delegateTarget: HTMLElement) => any,
      options?: boolean | AddEventListenerOptions
    ): void;
    off<K extends keyof DocumentEventMap>(
      type: K,
      selector: string,
      listener: (this: Document, ev: DocumentEventMap[K], delegateTarget: HTMLElement) => any,
      options?: boolean | AddEventListenerOptions
    ): void;
  }
  interface DocumentFragment {
    createEl<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      o?: DomElementInfo | string,
      callback?: (el: HTMLElementTagNameMap[K]) => void
    ): HTMLElementTagNameMap[K];
    createDiv(o?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
    createSpan(o?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement;
  }
  function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    o?: DomElementInfo | string,
    callback?: (el: HTMLElementTagNameMap[K]) => void
  ): HTMLElementTagNameMap[K];
  function createDiv(o?: DomElementInfo | string, callback?: (el: HTMLDivElement) => void): HTMLDivElement;
  function createSpan(o?: DomElementInfo | string, callback?: (el: HTMLSpanElement) => void): HTMLSpanElement;
  function createFragment(cb?: (frag: DocumentFragment) => void): DocumentFragment;
}

export interface DomElementInfo {
  cls?: string | string[];
  text?: string | DocumentFragment;
  attr?: Record<string, string | number | boolean | null>;
  title?: string;
  /** For inputs etc. */
  type?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  /** Where to insert relative to the parent: default append. */
  prepend?: boolean;
}

type ElInfoOrTag = DomElementInfo | string;

function normalizeInfo(o?: ElInfoOrTag): DomElementInfo {
  if (o === undefined) return {};
  if (typeof o === "string") return { cls: o };
  return o;
}

function applyInfo(el: HTMLElement, info: DomElementInfo): void {
  if (info.cls) {
    const classes = Array.isArray(info.cls) ? info.cls : info.cls.split(/\s+/).filter(Boolean);
    el.classList.add(...classes);
  }
  if (info.text !== undefined) {
    if (typeof info.text === "string") el.textContent = info.text;
    else el.appendChild(info.text);
  }
  if (info.attr) {
    for (const [k, v] of Object.entries(info.attr)) {
      if (v === null || v === false) continue;
      el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  if (info.title !== undefined) el.setAttribute("title", info.title);
  if (info.type !== undefined) el.setAttribute("type", info.type);
  if (info.value !== undefined) (el as HTMLInputElement).value = info.value;
  if (info.placeholder !== undefined) el.setAttribute("placeholder", info.placeholder);
  if (info.href !== undefined) el.setAttribute("href", info.href);
}

function createElOn<K extends keyof HTMLElementTagNameMap>(
  parent: Node,
  tag: K,
  o?: ElInfoOrTag,
  callback?: (el: HTMLElementTagNameMap[K]) => void
): HTMLElementTagNameMap[K] {
  const info = normalizeInfo(o);
  const el = document.createElement(tag);
  applyInfo(el, info);
  if (info.prepend && parent.firstChild) parent.insertBefore(el, parent.firstChild);
  else parent.appendChild(el);
  callback?.(el);
  return el;
}

/**
 * Elements `sanitizeHTMLToDom` removes outright.
 *
 * Obsidian's sanitizer is DOMPurify with its stock configuration, so this
 * tracks DOMPurify's default policy rather than inventing one: `script`,
 * `iframe`, `object` and `embed` are not in its default tag allowlist (its
 * threat model calls out `object`/`embed` explicitly, for loading arbitrary
 * external content via `data=`/`src=`), and `link`/`meta`/`base` are
 * document-head elements that are not in the default body allowlist. `base`
 * matters most of the three here: it re-points relative-URL resolution for
 * the *whole* document a fragment is appended into.
 *
 * Two tags are deliberately *not* listed, to stay compatible with real
 * Obsidian rather than be gratuitously stricter than it:
 * - `style` — DOMPurify default-allows it.
 * - `form` — DOMPurify's default attribute allowlist includes `action` and
 *   `enctype`, so forms survive its default config. `action`/`formaction`
 *   are scheme-checked below instead.
 */
export const SANITIZE_FORBIDDEN_TAGS: ReadonlySet<string> = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
]);

/** Attributes whose value is a URL, and therefore carries a scheme to vet. */
const URL_ATTRIBUTES = new Set(["href", "src", "xlink:href", "action", "formaction"]);

/**
 * Elements that may legitimately carry an inline `data:` payload —
 * DOMPurify's `DEFAULT_DATA_URI_TAGS`. This is the case that keeps
 * `![alt](data:image/png;base64,…)` markdown rendering.
 */
const DATA_URI_TAGS = new Set(["img", "audio", "video", "source", "image", "track"]);

/** The attributes those elements carry that payload in (`image` is SVG's). */
const DATA_URI_ATTRIBUTES = new Set(["src", "href", "xlink:href"]);

/** Media types allowed in a `data:` URI on one of `DATA_URI_TAGS`. */
const SAFE_DATA_URI_MEDIA = /^data:(?:image|audio|video)\//;

/**
 * Reduce a URL to a form the scheme test can trust.
 *
 * The HTML URL parser discards ASCII tab, LF and CR from *anywhere* in a URL
 * and trims leading/trailing C0 controls and spaces, so `java&#9;script:x`,
 * `\n javascript:x` and `JaVaScRiPt:x` are all live navigations that a naive
 * `startsWith("javascript:")` misses. Stripping the whole C0 range plus DEL
 * is broader than the parser, which is the safe direction: it can only make
 * a value look *more* dangerous, and a benign URL with a space in its path
 * still does not start with a blocked scheme afterwards.
 */
function normalizeUrlForSchemeCheck(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    // Codes at or below 0x20 are the C0 controls plus space; 0x7f is DEL.
    if (code > 0x20 && code !== 0x7f) out += ch;
  }
  return out.toLowerCase();
}

/** Whether `name` is an inline event handler (`onclick`, `onerror`, …). */
export function isEventHandlerAttribute(name: string): boolean {
  return name.toLowerCase().startsWith("on");
}

/**
 * Whether a URL-bearing attribute's value must be dropped.
 *
 * Scheme handling is a denylist rather than DOMPurify's allowlist on
 * purpose: Geode and its plugins legitimately emit `app://`, `geode://` and
 * `obsidian://` URLs into sanitized HTML, and an allowlist would silently
 * break them. The executable schemes are what matter for XSS.
 *
 * @param tag Lower-cased tag name of the element carrying the attribute.
 * @param attr Attribute name; compared case-insensitively.
 */
export function isUnsafeUrlAttribute(tag: string, attr: string, value: string): boolean {
  const name = attr.toLowerCase();
  if (!URL_ATTRIBUTES.has(name)) return false;
  const url = normalizeUrlForSchemeCheck(value);
  if (url.startsWith("javascript:") || url.startsWith("vbscript:")) return true;
  if (!url.startsWith("data:")) return false;
  // Anything outside the media cases is a navigation into attacker-authored
  // content — `<a href="data:text/html,<script>…">` most of all.
  return !(
    DATA_URI_ATTRIBUTES.has(name) &&
    DATA_URI_TAGS.has(tag) &&
    SAFE_DATA_URI_MEDIA.test(url)
  );
}

/**
 * Strip unsafe elements and attributes from an already-parsed tree, in place.
 *
 * Split out from `sanitizeHTMLToDom` so callers that build a fragment some
 * other way can reuse the same policy.
 */
export function scrubUnsafeHTML(root: ParentNode): void {
  // Snapshot: the walk mutates the tree, and removing a forbidden element
  // detaches descendants that are still in the list (harmless — the
  // remaining operations on a detached node are no-ops).
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const tag = el.tagName.toLowerCase();
    if (SANITIZE_FORBIDDEN_TAGS.has(tag)) {
      el.remove();
      continue;
    }
    for (const attr of Array.from(el.attributes)) {
      if (isEventHandlerAttribute(attr.name) || isUnsafeUrlAttribute(tag, attr.name, attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

/**
 * Sanitize an HTML string into a DocumentFragment (Obsidian uses this for
 * untrusted HTML). Lives here rather than in `./obsidian.ts` so the low-level
 * value classes in `./bases-values.ts` can use it without an import cycle;
 * `./obsidian.ts` re-exports it, which is where plugins get it from.
 *
 * Plugins feed this `marked.parse()` output — markdown-derived, so only as
 * trustworthy as the note or conversation it came from. The app's CSP
 * currently blocks inline handlers anyway, but that is an unrelated control
 * that a popout window, a webview or a custom-protocol page can be served
 * under a looser copy of; the sanitizer has to stand on its own.
 */
export function sanitizeHTMLToDom(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  scrubUnsafeHTML(template.content);
  return template.content;
}

function define(proto: object, name: string, value: (...args: any[]) => any): void {
  if (Object.prototype.hasOwnProperty.call(proto, name)) return;
  Object.defineProperty(proto, name, { value, writable: true, configurable: true, enumerable: false });
}

/** Idempotent counterpart to `define` for accessor properties (`.doc`). */
function defineGetter(proto: object, name: string, get: (this: any) => unknown): void {
  if (Object.prototype.hasOwnProperty.call(proto, name)) return;
  Object.defineProperty(proto, name, { get, configurable: true, enumerable: false });
}

/**
 * Minimal structural view of the objects `crossRealmInstanceOf` inspects, so
 * the predicate is unit-testable without a DOM. A real `Node` supplies
 * `ownerDocument`; a real `UIEvent` supplies `view`; a plain `Event` supplies
 * `target`.
 */
interface RealmBearer {
  ownerDocument?: { defaultView?: unknown } | null;
  view?: unknown;
  target?: unknown;
}

/**
 * Cross-window-capable `instanceof`, backing `Node.instanceOf` and
 * `Event.instanceOf`.
 *
 * A DOM object created inside a popout window is an instance of *that*
 * window's `HTMLElement`, not the main window's, so a plain `instanceof`
 * against the imported global returns false. Obsidian's documented helper
 * exists precisely to paper over that. We first try the cheap native check,
 * then re-resolve the constructor by name from the object's own realm.
 *
 * Exported for unit testing; callers should use `node.instanceOf(Type)`.
 */
export function crossRealmInstanceOf(obj: unknown, type: { new (...args: any[]): any }): boolean {
  if (obj === null || obj === undefined) return false;
  if (obj instanceof type) return true;

  const name = type.name;
  if (!name) return false;

  const bearer = obj as RealmBearer;
  // A Node knows its document directly; a UIEvent exposes the originating
  // window as `view`; anything else, fall back to the target node's document.
  const targetDoc = (bearer.target as RealmBearer | undefined)?.ownerDocument;
  const candidateWindows = [bearer.ownerDocument?.defaultView, bearer.view, targetDoc?.defaultView];

  for (const win of candidateWindows) {
    if (!win || typeof win !== "object") continue;
    const ctor = (win as Record<string, unknown>)[name];
    if (typeof ctor === "function" && obj instanceof (ctor as { new (...args: any[]): any })) return true;
  }
  return false;
}

/** Structural slice of the DOM API `resolveDelegateTarget` needs — keeps it unit-testable. */
interface ClosestTarget {
  closest(selector: string): ClosestTarget | null;
}

/**
 * Resolve the delegated target for an event: the nearest ancestor-or-self of
 * `target` matching `selector`, provided it is still inside `container`.
 *
 * Returns `null` when the event did not originate in a matching element, or
 * when the match lies outside the container (which happens for events that
 * bubble through a portal/popover reparented elsewhere in the document).
 *
 * Exported for unit testing; callers should use `el.on(type, selector, fn)`.
 */
export function resolveDelegateTarget<T extends ClosestTarget>(
  target: unknown,
  selector: string,
  container: { contains(other: any): boolean }
): T | null {
  if (!target || typeof (target as ClosestTarget).closest !== "function") return null;
  const match = (target as ClosestTarget).closest(selector);
  if (!match) return null;
  return container.contains(match) ? (match as T) : null;
}

type DelegatedListener = (ev: Event, delegateTarget: HTMLElement) => unknown;

/**
 * Registered delegated listeners, keyed so `off(type, selector, listener)`
 * can find the wrapper that was actually handed to `addEventListener`.
 * A `WeakMap` keyed on the host element means an element going out of scope
 * takes its registrations with it — no leak, no manual cleanup required.
 */
const delegatedListeners = new WeakMap<EventTarget, Map<string, EventListener>>();

function delegationKey(type: string, selector: string, listener: DelegatedListener, useCapture: boolean): string {
  // The listener identity can't go in a string key, so registrations are
  // bucketed by type/selector/capture and disambiguated by identity in `off`.
  return `${type}\u0000${selector}\u0000${useCapture ? "1" : "0"}`;
}

function isCapture(options?: boolean | AddEventListenerOptions): boolean {
  return typeof options === "boolean" ? options : (options?.capture ?? false);
}

function installDelegatedEvents(proto: object): void {
  define(proto, "on", function (
    this: EventTarget & { contains(other: any): boolean },
    type: string,
    selector: string,
    listener: DelegatedListener,
    options?: boolean | AddEventListenerOptions
  ) {
    const wrapper: EventListener = (ev: Event) => {
      const delegateTarget = resolveDelegateTarget<HTMLElement>(ev.target, selector, this);
      if (delegateTarget) listener.call(this, ev, delegateTarget);
    };
    let bucket = delegatedListeners.get(this);
    if (!bucket) {
      bucket = new Map();
      delegatedListeners.set(this, bucket);
    }
    // One bucket entry per (type, selector, capture, listener-identity) pair.
    bucket.set(`${delegationKey(type, selector, listener, isCapture(options))}\u0000${identityOf(listener)}`, wrapper);
    this.addEventListener(type, wrapper, options);
  });

  define(proto, "off", function (
    this: EventTarget,
    type: string,
    selector: string,
    listener: DelegatedListener,
    options?: boolean | AddEventListenerOptions
  ) {
    const bucket = delegatedListeners.get(this);
    if (!bucket) return;
    const key = `${delegationKey(type, selector, listener, isCapture(options))}\u0000${identityOf(listener)}`;
    const wrapper = bucket.get(key);
    if (!wrapper) return;
    bucket.delete(key);
    this.removeEventListener(type, wrapper, options);
  });
}

/**
 * Stable per-function id, so `off` can match the exact listener that `on`
 * registered without stringifying function bodies (two distinct closures can
 * share a source text).
 */
let identityCounter = 0;
const identities = new WeakMap<object, string>();
function identityOf(fn: object): string {
  let id = identities.get(fn);
  if (!id) {
    id = String(++identityCounter);
    identities.set(fn, id);
  }
  return id;
}

let installed = false;

export function installObsidianDomExtensions(): void {
  if (installed) return;
  // No-op outside a DOM environment (e.g. Node-based unit tests), so importing
  // the compat module doesn't throw where there are no element prototypes.
  if (typeof document === "undefined" || typeof Node === "undefined") return;
  installed = true;

  const nodeProto = Node.prototype as any;
  const elProto = Element.prototype as any;
  const htmlProto = HTMLElement.prototype as any;
  const fragProto = DocumentFragment.prototype as any;
  const docProto = Document.prototype as any;

  // --- createEl / createDiv / createSpan (on Element, Document, Fragment) --
  for (const proto of [htmlProto, docProto, fragProto]) {
    define(proto, "createEl", function (this: Node, tag: string, o?: ElInfoOrTag, cb?: any) {
      return createElOn(this, tag as any, o, cb);
    });
    define(proto, "createDiv", function (this: Node, o?: ElInfoOrTag, cb?: any) {
      return createElOn(this, "div", o, cb);
    });
    define(proto, "createSpan", function (this: Node, o?: ElInfoOrTag, cb?: any) {
      return createElOn(this, "span", o, cb);
    });
  }

  // --- empty / detach / appendText -----------------------------------------
  define(nodeProto, "empty", function (this: Node) {
    while (this.firstChild) this.removeChild(this.firstChild);
    return this;
  });
  define(nodeProto, "detach", function (this: Node) {
    (this as ChildNode).parentNode?.removeChild(this);
    return this;
  });
  define(nodeProto, "appendText", function (this: Node, text: string) {
    this.appendChild(document.createTextNode(text));
    return this;
  });
  define(htmlProto, "setText", function (this: HTMLElement, text: string | DocumentFragment) {
    if (typeof text === "string") this.textContent = text;
    else {
      this.textContent = "";
      this.appendChild(text);
    }
    return this;
  });

  // --- class helpers -------------------------------------------------------
  define(elProto, "addClass", function (this: Element, ...cls: string[]) {
    this.classList.add(...cls.filter(Boolean));
    return this;
  });
  define(elProto, "removeClass", function (this: Element, ...cls: string[]) {
    this.classList.remove(...cls.filter(Boolean));
    return this;
  });
  define(elProto, "toggleClass", function (this: Element, cls: string | string[], value?: boolean) {
    const classes = Array.isArray(cls) ? cls : [cls];
    for (const c of classes) this.classList.toggle(c, value);
    return this;
  });
  define(elProto, "hasClass", function (this: Element, cls: string) {
    return this.classList.contains(cls);
  });

  // --- attribute helpers ---------------------------------------------------
  define(elProto, "setAttr", function (this: Element, k: string, v: string | number | boolean | null) {
    if (v === null || v === false) this.removeAttribute(k);
    else this.setAttribute(k, v === true ? "" : String(v));
    return this;
  });
  define(elProto, "setAttrs", function (this: Element, attrs: Record<string, any>) {
    for (const [k, v] of Object.entries(attrs)) (this as any).setAttr(k, v);
    return this;
  });
  define(elProto, "getAttr", function (this: Element, k: string) {
    return this.getAttribute(k);
  });

  // --- query helpers -------------------------------------------------------
  define(elProto, "find", function (this: Element, selector: string) {
    return this.querySelector(selector);
  });
  define(elProto, "findAll", function (this: Element, selector: string) {
    return Array.from(this.querySelectorAll(selector));
  });
  define(docProto, "find", function (this: Document, selector: string) {
    return this.querySelector(selector);
  });
  define(docProto, "findAll", function (this: Document, selector: string) {
    return Array.from(this.querySelectorAll(selector));
  });

  // --- style / event convenience -------------------------------------------
  define(htmlProto, "setCssStyles", function (this: HTMLElement, styles: Record<string, string>) {
    Object.assign(this.style, styles);
    return this;
  });
  define(htmlProto, "setCssProps", function (this: HTMLElement, props: Record<string, string>) {
    for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v);
    return this;
  });
  define(htmlProto, "onClickEvent", function (this: HTMLElement, cb: (ev: MouseEvent) => any) {
    this.addEventListener("click", cb);
    return this;
  });

  // Obsidian's show/hide/isShown visibility helpers. Toggle the `is-hidden`
  // convention (display:none) and report current visibility. obsidian-tasks'
  // query renderer calls `containerEl.isShown()` (via an IntersectionObserver
  // callback) to decide whether to (re)render, so this must exist.
  define(htmlProto, "show", function (this: HTMLElement) {
    this.style.removeProperty("display");
    this.removeClass?.("is-hidden");
  });
  define(htmlProto, "hide", function (this: HTMLElement) {
    this.style.setProperty("display", "none");
  });
  define(htmlProto, "isShown", function (this: HTMLElement) {
    return this.style.getPropertyValue("display") !== "none" && !this.hasClass?.("is-hidden");
  });
  define(htmlProto, "toggleVisibility", function (this: HTMLElement, visible: boolean) {
    if (visible) (this as any).show();
    else (this as any).hide();
    return this;
  });

  // --- cross-window instanceOf + owning document ---------------------------
  // Obsidian documents `instanceOf` on `Node` and `UIEvent`, and `doc` on
  // `Node`. Bases views lean on all three: the Kanban view resolves its
  // delegated click targets with `cardEl.instanceOf(HTMLElement)` and creates
  // its colour-picker popover through `anchorEl.doc.createElement`.
  define(nodeProto, "instanceOf", function (this: Node, type: { new (...args: any[]): unknown }) {
    return crossRealmInstanceOf(this, type);
  });
  defineGetter(nodeProto, "doc", function (this: Node) {
    // `Document.ownerDocument` is null by spec, so a Document is its own doc.
    return this.ownerDocument ?? (this as unknown as Document);
  });
  if (typeof Event !== "undefined") {
    define(Event.prototype as any, "instanceOf", function (this: Event, type: { new (...args: any[]): unknown }) {
      return crossRealmInstanceOf(this, type);
    });
  }

  // --- delegated events: el.on(type, selector, handler) --------------------
  installDelegatedEvents(htmlProto);
  installDelegatedEvents(docProto);

  // --- globals: createEl / createDiv / createSpan / createFragment ----------
  const g = globalThis as any;
  if (typeof g.createDiv !== "function")
    g.createDiv = (o?: ElInfoOrTag, cb?: any) => createElOn(document.body, "div", o, cb);
  if (typeof g.createSpan !== "function")
    g.createSpan = (o?: ElInfoOrTag, cb?: any) => createElOn(document.body, "span", o, cb);
  if (typeof g.createEl !== "function")
    g.createEl = (tag: string, o?: ElInfoOrTag, cb?: any) =>
      createElOn(document.body, tag as any, o, cb);
  if (typeof g.createFragment !== "function")
    g.createFragment = (cb?: (frag: DocumentFragment) => void) => {
      const frag = document.createDocumentFragment();
      cb?.(frag);
      return frag;
    };
}
