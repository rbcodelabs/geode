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

function define(proto: object, name: string, value: (...args: any[]) => any): void {
  if (Object.prototype.hasOwnProperty.call(proto, name)) return;
  Object.defineProperty(proto, name, { value, writable: true, configurable: true, enumerable: false });
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
