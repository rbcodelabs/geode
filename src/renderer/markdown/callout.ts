/**
 * Shared Obsidian-style callout support: parsing the `[!type]` blockquote
 * marker and looking up the canonical CSS class / Lucide icon for a callout
 * type. Pure, DOM-free logic shared by Reading view (render.ts) and Live
 * Preview (live-preview.ts) so both render the same set of types/icons.
 */

export interface ParsedCalloutHeader {
  /** Callout type as written in the source, lowercased (e.g. "tip", "hint"). */
  type: string;
  /** Fold marker: "" (not foldable), "+" (expanded), "-" (collapsed). */
  fold: "" | "+" | "-";
  /** Title text following the marker, trimmed. Empty string if none given. */
  title: string;
  /** The full matched prefix (e.g. "[!tip]- My Title"), for callers that need to slice past it. */
  raw: string;
}

/** Matches `[!type]+/- Title` at the start of a callout header line. */
const CALLOUT_HEADER_RE = /^\[!(\w+)\]([+-]?)\s*([^\n<]*)/;

/**
 * Parses the first line of a callout blockquote (with the leading `> `
 * already stripped), e.g. `"[!tip]- Careful"` → type "tip", fold "-", title
 * "Careful". Returns null if the text doesn't start with a `[!type]` marker.
 */
export function parseCalloutHeader(headerText: string): ParsedCalloutHeader | null {
  const m = headerText.match(CALLOUT_HEADER_RE);
  if (!m) return null;
  const fold = m[2] === "+" || m[2] === "-" ? m[2] : "";
  return { type: m[1].toLowerCase(), fold, title: m[3].trim(), raw: m[0] };
}

/** Matches just the `[!type]+/-` marker plus trailing whitespace — no title. */
const CALLOUT_MARKER_RE = /^\[!\w+\][+-]?\s*/;

/**
 * Length of the `[!type]+/- ` marker prefix in headerText, excluding the
 * title. Used by Live Preview to hide/replace only the marker (with an icon
 * widget) while leaving the title text visible and editable. Returns null if
 * headerText doesn't start with a callout marker.
 */
export function calloutMarkerLength(headerText: string): number | null {
  const m = headerText.match(CALLOUT_MARKER_RE);
  return m ? m[0].length : null;
}

export interface CalloutMeta {
  /** Canonical CSS class bucket (e.g. `callout-tip`), also used as the Live Preview line class. */
  cssClass: string;
  /** Lucide icon id (kebab-case), resolved via getIconSvg/setIcon. */
  icon: string;
}

const NOTE_META: CalloutMeta = { cssClass: "note", icon: "pencil" };

/** type/alias → canonical metadata. Aliases map to the same meta as their canonical type. */
const CALLOUT_META: Record<string, CalloutMeta> = {
  note: NOTE_META,
  abstract: { cssClass: "abstract", icon: "clipboard-list" },
  summary: { cssClass: "abstract", icon: "clipboard-list" },
  tldr: { cssClass: "abstract", icon: "clipboard-list" },
  info: { cssClass: "info", icon: "info" },
  todo: { cssClass: "todo", icon: "circle-check" },
  tip: { cssClass: "tip", icon: "flame" },
  hint: { cssClass: "tip", icon: "flame" },
  important: { cssClass: "tip", icon: "flame" },
  success: { cssClass: "success", icon: "check" },
  check: { cssClass: "success", icon: "check" },
  done: { cssClass: "success", icon: "check" },
  question: { cssClass: "question", icon: "help-circle" },
  help: { cssClass: "question", icon: "help-circle" },
  faq: { cssClass: "question", icon: "help-circle" },
  warning: { cssClass: "warning", icon: "alert-triangle" },
  caution: { cssClass: "warning", icon: "alert-triangle" },
  attention: { cssClass: "warning", icon: "alert-triangle" },
  failure: { cssClass: "failure", icon: "x" },
  fail: { cssClass: "failure", icon: "x" },
  missing: { cssClass: "failure", icon: "x" },
  danger: { cssClass: "danger", icon: "zap" },
  error: { cssClass: "danger", icon: "zap" },
  bug: { cssClass: "bug", icon: "bug" },
  example: { cssClass: "example", icon: "list" },
  quote: { cssClass: "quote", icon: "quote" },
  cite: { cssClass: "quote", icon: "quote" },
};

/** Canonical CSS class + Lucide icon for a callout type. Unknown/custom types fall back to "note" styling. */
export function calloutMeta(type: string): CalloutMeta {
  return CALLOUT_META[type.toLowerCase()] ?? NOTE_META;
}

/** Title to show when the callout header has no explicit title text. */
export function defaultCalloutTitle(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}
