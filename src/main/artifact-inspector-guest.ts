import {
  INSPECT_CHANNEL,
  INSPECT_PROTOCOL_VERSION,
  INSPECTOR_CAPS,
  INSPECTOR_REDACT_KEEP_ATTRIBUTES,
  INSPECTOR_STYLE_ALLOWLIST,
  OUTER_HTML_TRUNCATION_MARKER,
  type GuestSelectMessage,
  type InspectHoverMessage,
  type InspectKey,
  type InspectMode,
} from "../artifacts/inspector-protocol";

/**
 * Guest side of the artifact element inspector (ADR 0006 D4). Pure logic over a
 * `window` and an injected IPC, so it runs under jsdom in unit tests; the Electron
 * wiring lives in `artifact-inspector-preload.ts`.
 *
 * Everything here treats the page as hostile: it never exposes an API to the page,
 * only talks to the embedder via IPC, ignores events with `isTrusted === false`,
 * does bounded work (node, character and time budgets), and sends the least data
 * that can do the job (hover = tag + rect only).
 */

export interface InspectorGuestIpc {
  send(channel: string, payload: unknown): void;
  on(channel: string, handler: (payload: unknown) => void): void;
}

export interface InspectorGuestEnv {
  window: Window & typeof globalThis;
  ipc: InspectorGuestIpc;
  now?: () => number;
  requestFrame?: (callback: () => void) => number;
  setInterval?: (callback: () => void, ms: number) => number;
  clearInterval?: (handle: number) => void;
}

export interface InspectorGuest {
  readonly mode: InspectMode;
  dispose(): void;
}

const SWALLOWED_POINTER_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu"] as const;
const KEY_EVENTS = ["keydown", "keypress", "keyup"] as const;
const LISTENED_EVENTS = [...SWALLOWED_POINTER_EVENTS, "mousemove", ...KEY_EVENTS] as const;
const HANDLED_KEYS = new Set(["[", "]", "Enter", "Escape"]);
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const SKIP_TEXT_PARENTS = new Set(["script", "style", "noscript", "template"]);
const TAG_FALLBACK = "unknown";
const REATTACH_WINDOW_MS = 1000;
const REASSERT_INTERVAL_MS = 1000;
const ATTRIBUTE_LIMIT = 24;
const SIBLING_SCAN_LIMIT = 2000;
const TEXT_NODE_BUDGET = 200;
const TEXT_CHAR_BUDGET = 400;
const HIGHLIGHT_COLOR = "#7c3aed";

const IMPLICIT_ROLES: Record<string, string> = {
  button: "button", select: "combobox", textarea: "textbox", ul: "list", ol: "list", li: "listitem",
  nav: "navigation", main: "main", header: "banner", footer: "contentinfo", aside: "complementary",
  form: "form", table: "table", dialog: "dialog", h1: "heading", h2: "heading", h3: "heading",
  h4: "heading", h5: "heading", h6: "heading", img: "img",
};
const INPUT_ROLES: Record<string, string> = {
  button: "button", submit: "button", reset: "button", checkbox: "checkbox", radio: "radio", range: "slider",
  text: "textbox", search: "searchbox", email: "textbox", url: "textbox", tel: "textbox", password: "textbox", number: "spinbutton",
};

/** CSS.escape for an identifier (CSSOM "serialize an identifier"); not assumed present in the guest. */
function cssEscapeIdent(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0) out += "\uFFFD";
    else if ((c >= 1 && c <= 0x1f) || c === 0x7f
      || (i === 0 && c >= 0x30 && c <= 0x39)
      || (i === 1 && c >= 0x30 && c <= 0x39 && value.charCodeAt(0) === 0x2d)) out += `\\${c.toString(16)} `;
    else if (i === 0 && c === 0x2d && value.length === 1) out += "\\-";
    else if (c >= 0x80 || c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) out += value[i];
    else out += `\\${value[i]}`;
  }
  return out;
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();
const finite = (n: number): number => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
// eslint-disable-next-line no-control-regex
const hasControl = (s: string): boolean => /[\u0000-\u001f\u007f]/.test(s);
const elideDataUrls = (value: string): string => value.replace(/url\(\s*["']?data:[^)]*\)/gi, "url(data:...elided)");
const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, "&quot;");

export function startInspector(env: InspectorGuestEnv): InspectorGuest | null {
  const win = env.window;
  // Top frame only (frame-src is 'none' for artifacts, but a preload registered per frame still runs everywhere).
  if (win !== win.top) return null;
  const doc = win.document;
  const now = env.now ?? (() => win.performance.now());
  const requestFrame = env.requestFrame ?? ((cb) => win.requestAnimationFrame(cb));
  const setTimer = env.setInterval ?? ((cb, ms) => win.setInterval(cb, ms));
  const clearTimer = env.clearInterval ?? ((handle) => win.clearInterval(handle));
  const send = (channel: string, payload: unknown): void => { try { env.ipc.send(channel, payload); } catch { /* embedder gone */ } };

  // Captured at document start. In the isolated world the page cannot reach these anyway; this is belt and braces.
  const nativeGBCR = win.Element.prototype.getBoundingClientRect;
  const nativeGCS = win.getComputedStyle.bind(win);
  const nativeAttachShadow = win.Element.prototype.attachShadow;
  const nativeQSA = win.Document.prototype.querySelectorAll;
  const nativeElementFromPoint = typeof doc.elementFromPoint === "function" ? doc.elementFromPoint.bind(doc) : null;
  const addListener = win.addEventListener.bind(win);
  const removeListener = win.removeEventListener.bind(win);
  const ElementCtor = win.Element;

  let mode: InspectMode = "off";
  let redact = false;
  let current: Element | null = null;
  let lastSentKey = "";
  let degraded = false;
  let reattachTimes: number[] = [];
  let hoverQueued: { x: number; y: number } | null = null;
  let hoverFrameScheduled = false;
  let healScheduled = false;
  let selectToken = 0;
  let host: HTMLElement | null = null;
  let boxSheet: CSSStyleSheet | null = null;
  let highlightUnsupported = false;
  let tickHandle: number | null = null;
  let observer: MutationObserver | null = null;
  let disposed = false;

  const isElement = (value: unknown): value is Element => value instanceof ElementCtor;
  const isOwnHost = (el: Element | null): boolean => el !== null && host !== null && el === host;
  const rectOf = (el: Element): { x: number; y: number; width: number; height: number } => {
    const r = nativeGBCR.call(el) as DOMRect;
    return { x: finite(r.x ?? r.left), y: finite(r.y ?? r.top), width: finite(r.width), height: finite(r.height) };
  };
  const safeTag = (el: Element): string => {
    const lowered = el.localName.toLowerCase().replace(/[^a-z0-9:-]/g, "-").replace(/^[^a-z]+/, "").slice(0, 32);
    return INSPECTOR_CAPS.tagPattern.test(lowered) ? lowered : TAG_FALLBACK;
  };

  // ---- bounded text ----
  function collectText(root: Element): string {
    let out = "";
    let visited = 0;
    let node: Node | null = root.firstChild;
    const stack: Node[] = [];
    while (node && visited < TEXT_NODE_BUDGET && out.length < TEXT_CHAR_BUDGET) {
      visited++;
      if (node.nodeType === 3) {
        out += `${(node as Text).data} `;
      } else if (isElement(node) && !SKIP_TEXT_PARENTS.has(node.localName) && node.firstChild) {
        stack.push(node);
        node = node.firstChild;
        continue;
      }
      while (node && !node.nextSibling && stack.length > 0) node = stack.pop() ?? null;
      node = node ? node.nextSibling : null;
    }
    return normalize(out);
  }

  // ---- accessible name and role ----
  function roleOf(el: Element): string | null {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0]!.slice(0, INSPECTOR_CAPS.roleUnits) || null;
    const tag = el.localName;
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "input") return INPUT_ROLES[(el.getAttribute("type") ?? "text").toLowerCase()] ?? "textbox";
    return IMPLICIT_ROLES[tag] ?? null;
  }
  function nameOf(el: Element): string {
    const label = el.getAttribute("aria-label");
    if (label && label.trim()) return normalize(label).slice(0, INSPECTOR_CAPS.nameUnits);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const parts: string[] = [];
      for (const id of by.split(/\s+/).slice(0, 4)) {
        const ref = id ? doc.getElementById(id) : null;
        if (ref) parts.push(collectText(ref));
      }
      const joined = normalize(parts.join(" "));
      if (joined) return joined.slice(0, INSPECTOR_CAPS.nameUnits);
    }
    const alt = el.getAttribute("alt");
    if (alt && alt.trim()) return normalize(alt).slice(0, INSPECTOR_CAPS.nameUnits);
    const text = collectText(el);
    if (text) return text.slice(0, INSPECTOR_CAPS.nameUnits);
    const title = el.getAttribute("title");
    return title ? normalize(title).slice(0, INSPECTOR_CAPS.nameUnits) : "";
  }

  // ---- selectors ----
  const querySelectorAllSafe = (selector: string): ArrayLike<Element> | null => {
    try { return nativeQSA.call(doc, selector) as unknown as ArrayLike<Element>; } catch { return null; }
  };
  const resolvesTo = (selector: string, el: Element): boolean => {
    const found = querySelectorAllSafe(selector);
    return found !== null && found.length === 1 && found[0] === el;
  };
  const uniqueId = (el: Element): string | null => {
    const id = el.getAttribute("id");
    if (!id || id.length > INSPECTOR_CAPS.ancestorIdUnits) return null;
    return resolvesTo(`#${cssEscapeIdent(id)}`, el) ? `#${cssEscapeIdent(id)}` : null;
  };
  /** 1-based position among same-tag siblings, or null when scanning would be unbounded. */
  function positionAmong(el: Element, sameTagOnly: boolean): { index: number; total: number } | null {
    let index = 1;
    let steps = 0;
    for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (++steps > SIBLING_SCAN_LIMIT) return null;
      if (!sameTagOnly || sib.localName === el.localName) index++;
    }
    let total = index;
    for (let sib = el.nextElementSibling; sib; sib = sib.nextElementSibling) {
      if (++steps > SIBLING_SCAN_LIMIT) return null;
      if (!sameTagOnly || sib.localName === el.localName) total++;
    }
    return { index, total };
  }
  function structuralPath(el: Element, kind: "of-type" | "child"): string | null {
    const segments: string[] = [];
    let cur: Element | null = el;
    for (let depth = 0; cur && depth < 12; depth++) {
      if (cur !== el) {
        const anchored = uniqueId(cur);
        if (anchored) { segments.unshift(anchored); break; }
      }
      const tag = cur.localName.toLowerCase();
      if (!/^[a-z][a-z0-9-]*$/.test(tag)) return null;
      if (cur === doc.body || cur === doc.documentElement) { segments.unshift(tag); break; }
      const pos = positionAmong(cur, kind === "of-type");
      if (!pos) return null;
      segments.unshift(kind === "of-type"
        ? (pos.total > 1 ? `${tag}:nth-of-type(${pos.index})` : tag)
        : `${tag}:nth-child(${pos.index})`);
      cur = cur.parentElement;
    }
    return segments.join(" > ");
  }
  function selectorCandidates(el: Element): Array<() => string | null> {
    return [
      () => {
        const value = el.getAttribute("data-testid");
        return value && value.length <= 128 && !hasControl(value) ? `[data-testid="${value.replace(/["\\]/g, "\\$&")}"]` : null;
      },
      () => uniqueId(el),
      () => {
        const classes = [...el.classList].filter((c) => c.length <= INSPECTOR_CAPS.ancestorClassUnits).slice(0, 2);
        return classes.length > 0 ? `${el.localName.toLowerCase()}${classes.map((c) => `.${cssEscapeIdent(c)}`).join("")}` : null;
      },
      () => structuralPath(el, "of-type"),
      () => structuralPath(el, "child"),
    ];
  }
  function buildSelectors(el: Element): { selector: string; alternates: string[] } {
    const verified: string[] = [];
    for (const candidate of selectorCandidates(el)) {
      if (verified.length > INSPECTOR_CAPS.selectorAlternates) break;
      let selector: string | null = null;
      try { selector = candidate(); } catch { selector = null; }
      if (!selector || selector.length > INSPECTOR_CAPS.selectorUnits || verified.includes(selector)) continue;
      if (resolvesTo(selector, el)) verified.push(selector);
    }
    return { selector: verified[0] ?? "", alternates: verified.slice(1, 1 + INSPECTOR_CAPS.selectorAlternates) };
  }

  // ---- landmark, ancestors, styles ----
  function landmarkOf(el: Element): string | null {
    let cur: Element | null = el;
    for (let level = 0; cur && level < 12; level++) {
      const variation = cur.getAttribute("data-variation");
      if (variation && variation.trim()) return normalize(variation).slice(0, INSPECTOR_CAPS.landmarkUnits);
      if (!redact) {
        let scanned = 0;
        for (let sib = cur.previousElementSibling; sib && scanned < 20; sib = sib.previousElementSibling, scanned++) {
          if (/^h[1-6]$/.test(sib.localName)) {
            const text = collectText(sib);
            if (text) return text.slice(0, INSPECTOR_CAPS.landmarkUnits);
          }
        }
      }
      cur = cur.parentElement;
    }
    return null;
  }
  function ancestorsOf(el: Element): GuestSelectMessage["ancestors"] {
    const out: Array<GuestSelectMessage["ancestors"][number]> = [];
    for (let cur = el.parentElement; cur && cur !== doc.documentElement && out.length < INSPECTOR_CAPS.ancestors; cur = cur.parentElement) {
      const id = cur.getAttribute("id");
      out.push({
        tag: safeTag(cur),
        id: id && id.length <= INSPECTOR_CAPS.ancestorIdUnits ? id : null,
        classes: [...cur.classList].filter((c) => c.length <= INSPECTOR_CAPS.ancestorClassUnits).slice(0, INSPECTOR_CAPS.ancestorClasses),
      });
    }
    return out;
  }
  function stylesOf(el: Element): Record<string, string> {
    const cs = nativeGCS(el);
    const out: Record<string, string> = {};
    for (const name of INSPECTOR_STYLE_ALLOWLIST) {
      const value = cs.getPropertyValue(name);
      if (typeof value === "string" && value !== "") out[name] = elideDataUrls(value).slice(0, INSPECTOR_CAPS.styleValueUnits);
    }
    return out;
  }

  // ---- bounded outerHTML ----
  function boundedOuterHtml(root: Element): { html: string; truncated: boolean } {
    const limit = INSPECTOR_CAPS.outerHtmlUnits - OUTER_HTML_TRUNCATION_MARKER.length;
    const keep = new Set(INSPECTOR_REDACT_KEEP_ATTRIBUTES);
    const out: string[] = [];
    let length = 0;
    let nodes = 0;
    let truncated = false;
    const started = now();
    const emit = (piece: string): boolean => {
      if (length + piece.length > limit) { truncated = true; return false; }
      out.push(piece);
      length += piece.length;
      return true;
    };
    const attributeText = (el: Element): string => {
      let text = "";
      const attrs = el.attributes;
      for (let i = 0; i < attrs.length && i < ATTRIBUTE_LIMIT; i++) {
        const attr = attrs[i]!;
        const name = attr.name.toLowerCase();
        if (!/^[a-z_:][-a-z0-9_:.]*$/.test(name)) continue;
        let value = attr.value;
        if (redact) {
          value = keep.has(name) ? value : "...";
        } else if (name.startsWith("on") || name === "srcdoc") {
          value = "...";
        } else if (/^\s*data:/i.test(value)) {
          value = "data:...elided";
        } else if (name === "style") {
          value = elideDataUrls(value);
        }
        if (value.length > INSPECTOR_CAPS.attributeValueUnits) value = `${value.slice(0, INSPECTOR_CAPS.attributeValueUnits)}...`;
        text += ` ${name}="${escapeAttr(value)}"`;
      }
      return text;
    };
    const closeOf = (el: Element): string => (VOID_ELEMENTS.has(el.localName) ? "" : `</${safeTag(el)}>`);

    const stack: Element[] = [];
    let cur: Node | null = root;
    let descending = true;
    walk: while (cur) {
      if (descending) {
        nodes++;
        if (nodes > INSPECTOR_CAPS.walkerNodes || ((nodes & 15) === 0 && now() - started > INSPECTOR_CAPS.walkerMillis)) { truncated = true; break; }
        if (isElement(cur)) {
          if (!emit(`<${safeTag(cur)}${attributeText(cur)}>`)) break;
          if (cur.firstChild && !VOID_ELEMENTS.has(cur.localName) && cur.localName !== "script") {
            stack.push(cur);
            cur = cur.firstChild;
            continue;
          }
          if (!emit(closeOf(cur))) break;
        } else if (cur.nodeType === 3 && !redact) {
          const text = escapeHtml((cur as Text).data.replace(/\s+/g, " "));
          if (text.trim() !== "") {
            const room = limit - length;
            if (text.length > room) { if (room > 0) out.push(text.slice(0, room)); length = limit; truncated = true; break; }
            emit(text);
          }
        }
      }
      for (;;) {
        if (cur === root) break walk;
        const next: ChildNode | null = (cur as ChildNode).nextSibling;
        if (next) { cur = next; descending = true; continue walk; }
        const parent = stack.pop();
        if (!parent) break walk;
        if (!emit(closeOf(parent))) break walk;
        cur = parent;
        descending = false;
      }
    }
    return { html: truncated ? `${out.join("")}${OUTER_HTML_TRUNCATION_MARKER}` : out.join(""), truncated };
  }

  function buildSelection(el: Element): GuestSelectMessage {
    const { selector, alternates } = buildSelectors(el);
    const tag = safeTag(el);
    const name = redact ? null : nameOf(el);
    return {
      route: `${win.location.pathname}${win.location.hash}`.slice(0, INSPECTOR_CAPS.routeUnits),
      tag,
      selector,
      selectorAlternates: alternates,
      textAnchor: { tag, text: redact ? "" : collectText(el).slice(0, INSPECTOR_CAPS.textAnchorUnits) },
      landmark: landmarkOf(el),
      outerHTML: boundedOuterHtml(el),
      ancestors: ancestorsOf(el),
      computedStyles: stylesOf(el),
      boundingBox: { viewport: rectOf(el) },
      viewport: {
        width: finite(win.innerWidth), height: finite(win.innerHeight), devicePixelRatio: finite(win.devicePixelRatio),
        scrollX: finite(win.scrollX), scrollY: finite(win.scrollY),
      },
      a11y: {
        role: roleOf(el),
        name: name ? name : null,
        tabIndex: el.hasAttribute("tabindex")
          ? Math.max(-1, Math.min(32767, Number.parseInt(el.getAttribute("tabindex") ?? "", 10) || 0))
          : ((el as HTMLElement).tabIndex >= 0 ? (el as HTMLElement).tabIndex : null),
      },
    };
  }

  // ---- highlight (closed shadow root, adoptedStyleSheets only: no <style>, no style attribute) ----
  function paint(rect: { x: number; y: number; width: number; height: number } | null): void {
    if (!boxSheet) return;
    const box = rect
      ? `.b{position:fixed;box-sizing:border-box;pointer-events:none;border:2px solid ${HIGHLIGHT_COLOR};background:rgba(124,58,237,.14);left:${finite(rect.x)}px;top:${finite(rect.y)}px;width:${finite(rect.width)}px;height:${finite(rect.height)}px;z-index:2147483647}`
      : ".b{display:none}";
    try { boxSheet.replaceSync(`:host{all:initial}${box}`); } catch { highlightUnsupported = true; }
  }
  function ensureHost(): boolean {
    if (highlightUnsupported || degraded || disposed) return false;
    if (!host) {
      try {
        const created = doc.createElement("div");
        const shadow = nativeAttachShadow.call(created, { mode: "closed" }) as ShadowRoot;
        const sheet = new win.CSSStyleSheet();
        shadow.adoptedStyleSheets = [sheet];
        const box = doc.createElement("div");
        box.className = "b";
        shadow.appendChild(box);
        host = created;
        boxSheet = sheet;
      } catch {
        highlightUnsupported = true;
        return false;
      }
    }
    if (!host.isConnected && doc.documentElement) doc.documentElement.appendChild(host);
    return host.isConnected;
  }
  function removeHost(): void {
    if (host?.isConnected) host.remove();
    host = null;
    boxSheet = null;
  }
  function heal(): void {
    healScheduled = false;
    if (mode !== "pick" || !host || host.isConnected || degraded || !doc.documentElement) return;
    const t = now();
    reattachTimes = reattachTimes.filter((at) => t - at < REATTACH_WINDOW_MS);
    if (reattachTimes.length >= INSPECTOR_CAPS.reattachPerSecond) { degraded = true; return; }
    reattachTimes.push(t);
    doc.documentElement.appendChild(host);
  }
  function scheduleHeal(): void {
    if (healScheduled) return;
    healScheduled = true;
    requestFrame(heal);
  }
  function observe(): void {
    if (!observer) observer = new win.MutationObserver(() => { if (mode === "pick" && host && !host.isConnected) scheduleHeal(); });
    // childList on the document and its root element only: cheap, and sees the host being removed or the document replaced.
    try {
      observer.observe(doc, { childList: true });
      if (doc.documentElement) observer.observe(doc.documentElement, { childList: true });
    } catch { /* detached document */ }
  }

  // ---- candidate and hover ----
  function candidate(): Element | null {
    if (current && current.isConnected && !isOwnHost(current)) return current;
    const active = doc.activeElement;
    if (active && active !== doc.body && active !== doc.documentElement && !isOwnHost(active)) return active;
    return doc.body ?? doc.documentElement;
  }
  function hoverElement(el: Element, via: "pointer" | "keyboard"): void {
    if (mode !== "pick" || isOwnHost(el)) return;
    const rect = rectOf(el);
    const key = `${via}|${rect.x}|${rect.y}|${rect.width}|${rect.height}`;
    if (el === current && key === lastSentKey) return;
    current = el;
    lastSentKey = key;
    if (ensureHost()) paint(rect);
    const message: { tag: string; rect: typeof rect; via: "pointer" | "keyboard"; label?: string } = { tag: safeTag(el), rect, via };
    if (via === "keyboard" && !redact) {
      const label = nameOf(el).slice(0, INSPECTOR_CAPS.hoverLabelUnits);
      if (label) message.label = label;
    }
    send(INSPECT_CHANNEL.hover, message satisfies InspectHoverMessage);
  }
  function flushHover(): void {
    hoverFrameScheduled = false;
    const point = hoverQueued;
    hoverQueued = null;
    if (!point || mode !== "pick" || !nativeElementFromPoint) return;
    const el = nativeElementFromPoint(point.x, point.y);
    if (el && isElement(el)) hoverElement(el, "pointer");
  }

  function walk(direction: "parent" | "child"): void {
    if (mode !== "pick") return;
    const from = candidate();
    if (!from) return;
    let next: Element | null = null;
    if (direction === "parent") {
      if (from === doc.body || from === doc.documentElement) return;
      next = from.parentElement;
      if (!next || next === doc.documentElement) next = doc.body;
    } else {
      next = from.firstElementChild;
    }
    if (next) hoverElement(next, "keyboard");
  }

  // ---- select ----
  function beginSelect(el: Element | null): void {
    if (mode !== "pick" || !el || isOwnHost(el)) return;
    // Local hold first: no further click or key can act, and the highlight is gone before any pixels are captured.
    setMode("hold", redact, false);
    const token = ++selectToken;
    requestFrame(() => requestFrame(() => {
      if (disposed || token !== selectToken || mode !== "hold") return;
      if (!el.isConnected) { setMode("pick", redact, false); return; }
      let message: GuestSelectMessage;
      try {
        message = buildSelection(el);
      } catch {
        setMode("pick", redact, false);
        return;
      }
      send(INSPECT_CHANNEL.select, message);
    }));
  }
  function handleKey(key: InspectKey): void {
    if (key === "parent" || key === "child") walk(key);
    else beginSelect(candidate());
  }

  // ---- event handling ----
  function onEvent(event: Event): void {
    if (mode === "off" || !event.isTrusted) return;
    const type = event.type;
    if (type === "mousemove") {
      if (mode !== "pick") return;
      const m = event as MouseEvent;
      hoverQueued = { x: m.clientX, y: m.clientY };
      if (!hoverFrameScheduled) { hoverFrameScheduled = true; requestFrame(flushHover); }
      return;
    }
    if (type === "keydown" || type === "keypress" || type === "keyup") {
      const k = event as KeyboardEvent;
      if (k.ctrlKey || k.metaKey || k.altKey || !HANDLED_KEYS.has(k.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (type !== "keydown" || k.repeat) return;
      if (k.key === "Escape") send(INSPECT_CHANNEL.cancel, { reason: "escape" });
      else if (mode === "pick") handleKey(k.key === "[" ? "parent" : k.key === "]" ? "child" : "select");
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (type === "click" && mode === "pick" && (event as MouseEvent).button === 0) {
      const m = event as MouseEvent;
      const hit = nativeElementFromPoint ? nativeElementFromPoint(m.clientX, m.clientY) : null;
      const target = hit && isElement(hit) && !isOwnHost(hit) ? hit : isElement(event.target) ? event.target : null;
      beginSelect(target);
    }
  }
  function attachListeners(): void {
    for (const type of LISTENED_EVENTS) addListener(type, onEvent, true);
  }
  function detachListeners(): void {
    for (const type of LISTENED_EVENTS) removeListener(type, onEvent, true);
  }
  function reassert(): void {
    if (disposed || mode === "off") return;
    attachListeners();
    observe();
    if (mode === "pick" && host && !host.isConnected) scheduleHeal();
  }

  function setMode(next: InspectMode, nextRedact: boolean, fromEmbedder: boolean): void {
    if (fromEmbedder) { selectToken++; degraded = false; reattachTimes = []; }
    mode = next;
    redact = nextRedact;
    current = null;
    lastSentKey = "";
    hoverQueued = null;
    if (next !== "pick") removeHost();
    if (next === "off") {
      if (tickHandle !== null) { clearTimer(tickHandle); tickHandle = null; }
      return;
    }
    if (next === "pick") observe();
    if (tickHandle === null) tickHandle = setTimer(reassert, REASSERT_INTERVAL_MS);
  }

  function onModeMessage(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const { mode: next, redactText } = payload as { mode?: unknown; redactText?: unknown };
    if ((next !== "off" && next !== "pick" && next !== "hold") || typeof redactText !== "boolean") return;
    setMode(next, redactText, true);
  }
  function onKeyMessage(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const { key } = payload as { key?: unknown };
    if (key === "parent" || key === "child" || key === "select") handleKey(key);
  }

  // Registered at document start, in the capture phase, before any page script can run.
  attachListeners();
  env.ipc.on(INSPECT_CHANNEL.mode, onModeMessage);
  env.ipc.on(INSPECT_CHANNEL.key, onKeyMessage);
  send(INSPECT_CHANNEL.ready, { protocol: INSPECT_PROTOCOL_VERSION });

  return {
    get mode() { return mode; },
    dispose() {
      disposed = true;
      detachListeners();
      observer?.disconnect();
      if (tickHandle !== null) { clearTimer(tickHandle); tickHandle = null; }
      removeHost();
      mode = "off";
    },
  };
}
