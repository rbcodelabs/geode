import type { Rect } from "./feedback-contract";

/**
 * Guest <-> embedder protocol for the artifact element inspector (ADR 0006, D4).
 *
 * Dependency-free (types only from the feedback contract) because it is bundled
 * into the sandboxed guest preload as well as the renderer. The protocol integer
 * lives in the channel names and is internal to Geode: the preload and the
 * embedder ship in one bundle.
 */

export const INSPECT_PROTOCOL_VERSION = 1 as const;
const PREFIX = "geode-artifact:inspect:v1:";

export const INSPECT_CHANNEL = {
  /** embedder to guest */
  mode: `${PREFIX}mode`,
  /** embedder to guest */
  key: `${PREFIX}key`,
  /** guest to embedder */
  ready: `${PREFIX}ready`,
  hover: `${PREFIX}hover`,
  select: `${PREFIX}select`,
  cancel: `${PREFIX}cancel`,
  /** guest to embedder (Phase 2a): the CURRENT rect of the hovered or selected element after a scroll, resize or mutation. */
  rect: `${PREFIX}rect`,
  /** embedder to guest (Phase 2b-i): replace the set of anchors the guest resolves and tracks. */
  anchors: `${PREFIX}anchors`,
  /** embedder to guest (Phase 2b-i): scroll to and/or flash one resolved anchor. */
  anchorFocus: `${PREFIX}anchor-focus`,
  /** guest to embedder (Phase 2b-i): the outcome of a resolve pass. */
  anchorResults: `${PREFIX}anchor-results`,
  /** guest to embedder (Phase 2b-i): current rects of the resolved anchors after a scroll, resize or layout change. */
  anchorRects: `${PREFIX}anchor-rects`,
} as const;

export const INSPECT_GUEST_TO_EMBEDDER_CHANNELS: readonly string[] = [
  INSPECT_CHANNEL.ready,
  INSPECT_CHANNEL.hover,
  INSPECT_CHANNEL.select,
  INSPECT_CHANNEL.cancel,
  INSPECT_CHANNEL.rect,
  INSPECT_CHANNEL.anchorResults,
  INSPECT_CHANNEL.anchorRects,
];

export type InspectMode = "off" | "pick" | "hold";
export type InspectKey = "parent" | "child" | "select";

export interface InspectModeMessage { readonly mode: InspectMode; readonly redactText: boolean }
export interface InspectKeyMessage { readonly key: InspectKey }
export interface InspectReadyMessage { readonly protocol: typeof INSPECT_PROTOCOL_VERSION }
export interface InspectHoverMessage {
  readonly tag: string;
  readonly rect: Rect;
  readonly via: "pointer" | "keyboard";
  /** Only for `keyboard`; accessible name, at most 80. */
  readonly label?: string;
}
export interface InspectCancelMessage { readonly reason: "escape" }
/**
 * Phase 2a. The live viewport rect of what the user is pointing at. `hover` follows the highlighted element while
 * picking; `selected` follows the element the popover is about. `connected: false` (rect null) means the element left
 * the document. Carries no identity and no selection data: it can only move or hide embedder UI.
 */
export interface InspectRectMessage {
  readonly target: "hover" | "selected";
  readonly connected: boolean;
  /** Guest viewport CSS px; null exactly when `connected` is false. */
  readonly rect: Rect | null;
  /** Only on a connected `hover` report: the lower-case tag of the element the rect belongs to (keeps the chip atomic). */
  readonly tag?: string;
}

/**
 * Phase 2b-i (ADR 0006 addendum 2): pins. The embedder hands the guest page-derived anchor data only (never comment
 * text, ids, ordinals or status); the guest answers with enums, booleans and rects.
 */
export interface InspectAnchorQuery {
  /** /^a[0-9]{1,3}$/, minted per set by the embedder; the comment id never goes to the guest. */
  readonly key: string;
  readonly route: string;
  readonly tag: string;
  readonly selector: string;
  readonly alternates: readonly string[];
  readonly textAnchor: { readonly tag: string; readonly text: string };
  readonly landmark: string | null;
}
export interface InspectAnchorsMessage {
  /** Strictly increasing; results and rects for any other epoch are dropped. */
  readonly epoch: number;
  readonly redactText: boolean;
  readonly anchors: readonly InspectAnchorQuery[];
}
export type InspectAnchorFocusBehavior = "scroll" | "flash";
export interface InspectAnchorFocusMessage {
  readonly epoch: number;
  readonly key: string;
  readonly behavior: InspectAnchorFocusBehavior;
}
export type InspectAnchorMatch = "selector" | "text" | "landmark" | "detached" | "other-route";
export interface InspectAnchorResult {
  readonly key: string;
  readonly match: InspectAnchorMatch;
  /** true when a selector hit was corroborated by the text anchor, or there is no text anchor to compare (redacted); true for a text match from a complete scan, false when the scan was truncated or interrupted. */
  readonly agrees: boolean;
  /** Guest viewport CSS px; null exactly when `match` is `detached` or `other-route`. */
  readonly rect: Rect | null;
  /** The rect intersects the viewport. Always false when `rect` is null. */
  readonly visible: boolean;
}
export interface InspectAnchorRect {
  readonly key: string;
  /** null when the element left the document. */
  readonly rect: Rect | null;
  readonly visible: boolean;
}
export interface InspectAnchorResultsMessage { readonly epoch: number; readonly results: readonly InspectAnchorResult[] }
export interface InspectAnchorRectsMessage { readonly epoch: number; readonly rects: readonly InspectAnchorRect[] }

/** The origin-G half of `ElementSelection` as the page's DOM supplies it. Untrusted. */
export interface GuestSelectMessage {
  readonly route: string;
  readonly tag: string;
  readonly selector: string;
  readonly selectorAlternates: readonly string[];
  readonly textAnchor: { readonly tag: string; readonly text: string };
  readonly landmark: string | null;
  readonly outerHTML: { readonly html: string; readonly truncated: boolean };
  readonly ancestors: readonly { readonly tag: string; readonly id: string | null; readonly classes: readonly string[] }[];
  readonly computedStyles: Readonly<Record<string, string>>;
  /** Guest viewport CSS px; the embedder derives the document rect from scroll. */
  readonly boundingBox: { readonly viewport: Rect };
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly devicePixelRatio: number;
    readonly scrollX: number;
    readonly scrollY: number;
  };
  readonly a11y: { readonly role: string | null; readonly name: string | null; readonly tabIndex: number | null };
}

/** Exactly 40 names. The guest reads only these; the embedder drops any other key. */
export const INSPECTOR_STYLE_ALLOWLIST: readonly string[] = [
  "display", "position", "z-index", "opacity", "overflow", "visibility",
  "flex-direction", "flex-wrap", "justify-content", "align-items", "gap", "grid-template-columns",
  "width", "height", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left", "box-sizing",
  "font-family", "font-size", "font-weight", "line-height", "letter-spacing",
  "text-align", "text-transform", "text-decoration-line", "color", "background-color", "background-image",
  "border-top-width", "border-top-style", "border-top-color", "border-radius", "box-shadow", "transform",
];

/** Attribute values kept verbatim when `redactText` is on; every other attribute value becomes `...`. */
export const INSPECTOR_REDACT_KEEP_ATTRIBUTES: readonly string[] = [
  "id", "class", "role", "type", "data-variation", "data-testid",
];

export const INSPECTOR_CAPS = {
  messageBytes: 64 * 1024,
  outerHtmlUnits: 4096,
  attributeValueUnits: 200,
  routeUnits: 512,
  selectorUnits: 512,
  selectorAlternates: 3,
  textAnchorUnits: 80,
  landmarkUnits: 120,
  ancestors: 3,
  ancestorIdUnits: 128,
  ancestorClasses: 8,
  ancestorClassUnits: 64,
  styleValueUnits: 200,
  roleUnits: 64,
  nameUnits: 200,
  hoverLabelUnits: 80,
  numberMagnitude: 1e6,
  tagPattern: /^[a-z][a-z0-9:-]{0,31}$/,
  /** Embedder: all inspector channels combined. */
  messagesPerSecond: 30,
  selectsPerSecond: 4,
  /** Embedder: `rect` reports, a budget of their own so scroll traffic can never starve select or cancel (and vice versa). */
  // 360: comfortably above 144 Hz displays (one report per animation frame at most, so 240 Hz still fits with jitter).
  rectsPerSecond: 360,
  /** Guest: highlight host re-attachments per second before it marks itself degraded. */
  reattachPerSecond: 20,
  /** Guest outerHTML walker budgets. */
  walkerNodes: 600,
  walkerMillis: 25,

  // ---- Phase 2b-i anchors (ADR 0006 addendum 2). Embedder budgets, each its own sliding window. ----
  /** Anchors per set (and entries per result or rect message). */
  anchors: 100,
  anchorKeyPattern: /^a[0-9]{1,3}$/,
  /** Embedder: `anchor-results` per second. A result is one resolve pass; the guest sends at most ~4 per second even under churn. */
  anchorResultsPerSecond: 8,
  /** Embedder: `anchor-rects` per second (one per animation frame at most, up to 120 Hz displays). */
  anchorRectsPerSecond: 120,
  /** Selector grammar (the restricted subset the guest will execute). */
  anchorSelectorCompounds: 12,
  anchorAttributeValueUnits: 128,
  /** Guest: elements of one tag examined for a text anchor, per pass. */
  anchorTextScan: 5000,
  /** Guest: elements read per time-sliced step of a text index build. */
  anchorScanStep: 250,
  /** Guest: anchors resolved per animation frame, and the time slice within it (spike S1, recorded in the ADR addendum). */
  anchorChunk: 8,
  anchorSliceMillis: 4,
  /** Guest: mutation observer scheduling (trailing debounce, hard maximum, and the floors after a slow pass or a storm). */
  anchorDebounceMillis: 250,
  anchorMaxDelayMillis: 1000,
  anchorSlowPassMillis: 20,
  anchorSlowFloorMillis: 1000,
  anchorStormCallbacksPerSecond: 50,
  anchorStormFloorMillis: 2000,
  /**
   * Guest: minimum spacing between `anchor-results` sends (150 ms keeps any 1 s window at 7 messages, under the embedder's 8)
   * with a trailing send of the latest state, and the minimum gap between the end of one resolve pass and the start of the next
   * (so the immediate triggers, a removed node or a history event, cannot run passes back to back).
   */
  anchorResultsSpacingMillis: 150,
  anchorMinPassGapMillis: 250,
  /** Guest: minimum spacing between `anchor-rects` sends (9 ms: at most 112 per second, inside the embedder's 120), with a trailing send of the latest rects. */
  anchorRectsSpacingMillis: 9,
  /** Guest: how long the jump-to flash outline stays. */
  anchorFlashMillis: 1200,
} as const;

export const OUTER_HTML_TRUNCATION_MARKER = "<!--truncated-->";

/** Bounds for the screenshot crop and encode, ADR D6. */
export const INSPECTOR_SCREENSHOT = {
  maxBytes: 512 * 1024,
  paddingPx: 8,
  captureTimeoutMs: 2_000,
  downscaleWidths: [1024, 640] as readonly number[],
} as const;
