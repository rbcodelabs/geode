import type { Rect } from "../../artifacts/feedback-contract";
import {
  INSPECTOR_CAPS,
  INSPECTOR_REDACT_KEEP_ATTRIBUTES,
  INSPECTOR_STYLE_ALLOWLIST,
  type GuestSelectMessage,
  type InspectHoverMessage,
  type InspectRectMessage,
  type InspectViewportSize,
} from "../../artifacts/inspector-protocol";

/**
 * Embedder-side validation of everything the guest page sends (ADR 0006 D3).
 *
 * The page is hostile, so each accepted message is REBUILT from an allowlist of
 * keys ("construct, do not copy"): unknown keys are dropped, a hostile own key
 * (`__proto__`, `constructor`, `prototype`) rejects the whole message, every
 * string and number is range checked, and any violation drops the message (no
 * partial acceptance). Nothing here evaluates or parses markup beyond one linear
 * pass over `outerHTML` for redaction. All functions are pure and return null on rejection.
 */

type Bag = Record<string, unknown>;

const HOSTILE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const STYLE_ALLOWLIST: ReadonlySet<string> = new Set(INSPECTOR_STYLE_ALLOWLIST);
const KEEP_ATTRIBUTES: ReadonlySet<string> = new Set(INSPECTOR_REDACT_KEEP_ATTRIBUTES);
/** Raw style keys examined before rejecting the message as a flood; bounds work on a hostile object. */
const MAX_RAW_STYLE_KEYS = 80;

/** A plain-object view that rejects arrays, null and any hostile own key; null means reject. */
function bag(value: unknown): Bag | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  for (const key of Object.keys(value)) if (HOSTILE_KEYS.has(key)) return null;
  return value as Bag;
}

function str(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length <= max ? value : null;
}
function nullableStr(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  const s = str(value, max);
  return s === null ? undefined : s;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= INSPECTOR_CAPS.numberMagnitude ? value : null;
}
function tag(value: unknown): string | null {
  return typeof value === "string" && INSPECTOR_CAPS.tagPattern.test(value) ? value : null;
}
function rect(value: unknown): Rect | null {
  const b = bag(value);
  if (!b) return null;
  const x = num(b.x), y = num(b.y), width = num(b.width), height = num(b.height);
  if (x === null || y === null || width === null || height === null || width < 0 || height < 0) return null;
  return { x, y, width, height };
}

/** Size gate for a raw IPC argument: at most 64 KB of UTF-8 when serialized. */
export function messageWithinCap(raw: unknown): boolean {
  try {
    const json = JSON.stringify(raw);
    if (typeof json !== "string") return false;
    // UTF-16 units times 3 bounds the UTF-8 size, so only measure exactly when it might matter.
    if (json.length * 3 <= INSPECTOR_CAPS.messageBytes) return true;
    return new TextEncoder().encode(json).byteLength <= INSPECTOR_CAPS.messageBytes;
  } catch {
    return false;
  }
}

export function validateHoverMessage(raw: unknown): InspectHoverMessage | null {
  const b = bag(raw);
  if (!b) return null;
  const t = tag(b.tag);
  const r = rect(b.rect);
  if (t === null || r === null) return null;
  if (b.via === "pointer") return b.label === undefined ? { tag: t, rect: r, via: "pointer" } : null;
  if (b.via !== "keyboard") return null;
  if (b.label === undefined) return { tag: t, rect: r, via: "keyboard" };
  const label = str(b.label, INSPECTOR_CAPS.hoverLabelUnits);
  return label === null ? null : { tag: t, rect: r, via: "keyboard", label };
}

/** The guest viewport size a selected report carries; a positive plain size or null. */
function viewportSize(value: unknown): InspectViewportSize | null {
  const b = bag(value);
  if (!b) return null;
  const width = num(b.width), height = num(b.height);
  return width === null || height === null || width <= 0 || height <= 0 ? null : { width, height };
}

/** Phase 2a: the live rect of the hovered or selected element. Connected iff the rect is present. */
export function validateRectMessage(raw: unknown): InspectRectMessage | null {
  const b = bag(raw);
  if (!b) return null;
  if (b.target !== "hover" && b.target !== "selected") return null;
  if (typeof b.connected !== "boolean") return null;
  if (!b.connected) return b.rect === null && b.tag === undefined && b.viewport === undefined ? { target: b.target, connected: false, rect: null } : null;
  const r = rect(b.rect);
  if (r === null) return null;
  if (b.viewport !== undefined) {
    // Only the selection box needs the guest-to-embedder scale; a hover report (which has the tag) never carries one.
    const viewport = b.target === "selected" && b.tag === undefined ? viewportSize(b.viewport) : null;
    return viewport === null ? null : { target: b.target, connected: true, rect: r, viewport };
  }
  if (b.tag === undefined) return { target: b.target, connected: true, rect: r };
  // A tag names the hovered element for the chip; it only belongs on a hover report.
  const t = b.target === "hover" ? tag(b.tag) : null;
  return t === null ? null : { target: b.target, connected: true, rect: r, tag: t };
}

/**
 * Linear, bounded redaction pass over guest-built outerHTML. Drops every text node
 * and replaces each attribute value outside the keep list with `...`. The guest
 * already does this when told `redactText`; running it again here means a guest that
 * forgot (or was lied to) cannot leak vault text. Input shape is the guest's own
 * output (double-quoted, escaped values); anything unparseable is dropped.
 */
export function redactHtml(html: string): string {
  let out = "";
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html[i] !== "<") { i++; continue; } // text node: dropped
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end === -1) break;
      out += html.slice(i, end + 3);
      i = end + 3;
      continue;
    }
    // A tag: copy the name, then each attribute.
    let j = i + 1;
    if (html[j] === "/") j++;
    const nameStart = j;
    while (j < n && /[A-Za-z0-9:-]/.test(html[j]!)) j++;
    let piece = html.slice(i, j);
    if (j === nameStart && html[i + 1] !== "/") break;
    let closed = false;
    while (j < n) {
      while (j < n && html[j] === " ") j++;
      if (html[j] === ">") { piece += ">"; j++; closed = true; break; }
      const attrStart = j;
      while (j < n && /[A-Za-z0-9_:.-]/.test(html[j]!)) j++;
      if (j === attrStart) break;
      const name = html.slice(attrStart, j).toLowerCase();
      if (html.startsWith('="', j)) {
        const valueEnd = html.indexOf('"', j + 2);
        if (valueEnd === -1) break;
        const value = KEEP_ATTRIBUTES.has(name) ? html.slice(j + 2, valueEnd) : "...";
        piece += ` ${html.slice(attrStart, j)}="${value}"`;
        j = valueEnd + 1;
      } else {
        piece += ` ${html.slice(attrStart, j)}`;
      }
    }
    if (!closed) break; // dangling partial tag: drop it rather than leak a value
    out += piece;
    i = j;
  }
  return out;
}

function stringList(value: unknown, maxItems: number, maxUnits: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const out: string[] = [];
  for (const item of value) {
    const s = str(item, maxUnits);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

function ancestors(value: unknown): GuestSelectMessage["ancestors"] | null {
  if (!Array.isArray(value) || value.length > INSPECTOR_CAPS.ancestors) return null;
  const out: Array<GuestSelectMessage["ancestors"][number]> = [];
  for (const item of value) {
    const b = bag(item);
    if (!b) return null;
    const t = tag(b.tag);
    const id = nullableStr(b.id, INSPECTOR_CAPS.ancestorIdUnits);
    const classes = stringList(b.classes, INSPECTOR_CAPS.ancestorClasses, INSPECTOR_CAPS.ancestorClassUnits);
    if (t === null || id === undefined || classes === null) return null;
    out.push({ tag: t, id, classes });
  }
  return out;
}

function computedStyles(value: unknown): Record<string, string> | null {
  const b = bag(value);
  if (!b) return null;
  const keys = Object.keys(b);
  if (keys.length > MAX_RAW_STYLE_KEYS) return null;
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (!STYLE_ALLOWLIST.has(key)) continue; // not allowlisted: dropped, not an error
    const v = str(b[key], INSPECTOR_CAPS.styleValueUnits);
    if (v === null) return null;
    out[key] = v;
  }
  return out;
}

const MAX_DPR = 16;
const MAX_VIEWPORT_PX = 1e5;

/** The route without its query and fragment: hash-routed pages put data (note titles) there. */
const pathOnly = (route: string): string => route.replace(/[?#].*$/s, "");

/** Returns the rebuilt, validated select message, or null when anything is wrong. */
export function validateGuestSelect(raw: unknown, options: { redacted: boolean }): GuestSelectMessage | null {
  const b = bag(raw);
  if (!b) return null;

  const route = str(b.route, INSPECTOR_CAPS.routeUnits);
  const t = tag(b.tag);
  const selector = str(b.selector, INSPECTOR_CAPS.selectorUnits);
  const rawAlternates = stringList(b.selectorAlternates, INSPECTOR_CAPS.selectorAlternates, INSPECTOR_CAPS.selectorUnits);
  const landmark = nullableStr(b.landmark, INSPECTOR_CAPS.landmarkUnits);
  if (route === null || t === null || selector === null || rawAlternates === null || landmark === undefined) return null;
  const alternates = [...new Set(rawAlternates)].filter((s) => s !== selector);

  const anchor = bag(b.textAnchor);
  const anchorTag = anchor ? tag(anchor.tag) : null;
  const anchorText = anchor ? str(anchor.text, INSPECTOR_CAPS.textAnchorUnits) : null;
  if (anchorTag === null || anchorText === null) return null;

  const outer = bag(b.outerHTML);
  const html = outer ? str(outer.html, INSPECTOR_CAPS.outerHtmlUnits) : null;
  if (html === null || typeof outer!.truncated !== "boolean") return null;

  const anc = ancestors(b.ancestors);
  const styles = computedStyles(b.computedStyles);
  if (anc === null || styles === null) return null;

  const box = bag(b.boundingBox);
  const viewportRect = box ? rect(box.viewport) : null;
  if (viewportRect === null) return null;

  const vp = bag(b.viewport);
  const width = vp ? num(vp.width) : null, height = vp ? num(vp.height) : null;
  const dpr = vp ? num(vp.devicePixelRatio) : null;
  const scrollX = vp ? num(vp.scrollX) : null, scrollY = vp ? num(vp.scrollY) : null;
  if (width === null || height === null || dpr === null || scrollX === null || scrollY === null || width < 0 || height < 0) return null;
  // A zero/negative/absurd ratio or a huge viewport is nonsense from a lying guest; the ratio is forwarded to the plugin.
  if (!(dpr > 0 && dpr <= MAX_DPR) || width > MAX_VIEWPORT_PX || height > MAX_VIEWPORT_PX) return null;

  const a11y = bag(b.a11y);
  const role = a11y ? nullableStr(a11y.role, INSPECTOR_CAPS.roleUnits) : undefined;
  const name = a11y ? nullableStr(a11y.name, INSPECTOR_CAPS.nameUnits) : undefined;
  const tabIndex = a11y ? a11y.tabIndex : undefined;
  if (role === undefined || name === undefined) return null;
  if (tabIndex !== null && !(typeof tabIndex === "number" && Number.isInteger(tabIndex) && tabIndex >= -1 && tabIndex <= 32767)) return null;

  const redacted = options.redacted;
  return {
    route: redacted ? pathOnly(route) : route,
    tag: t,
    selector,
    selectorAlternates: alternates,
    textAnchor: { tag: anchorTag, text: redacted ? "" : anchorText },
    landmark: redacted ? null : landmark,
    outerHTML: { html: redacted ? redactHtml(html) : html, truncated: outer!.truncated as boolean },
    ancestors: anc,
    computedStyles: styles,
    boundingBox: { viewport: viewportRect },
    viewport: { width, height, devicePixelRatio: dpr, scrollX, scrollY },
    a11y: { role, name: redacted ? null : name, tabIndex: tabIndex as number | null },
  };
}
