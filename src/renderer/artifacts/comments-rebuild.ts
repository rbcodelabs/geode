import {
  ARTIFACT_COMMENT_ID_PATTERN,
  ARTIFACT_COMMENTS_CAPS,
  ARTIFACT_COMMENTS_REQUEST_ID_PATTERN,
  type ArtifactComment,
  type ArtifactCommentAnchor,
  type ArtifactCommentDetail,
  type ArtifactCommentsChange,
  type ArtifactCommentsRejectReason,
  type ArtifactCommentsResult,
  type ArtifactCommentsSnapshot,
  type BatchSendReport,
} from "../../artifacts/feedback-contract-v2";
import type { ElementSelection, Rect } from "../../artifacts/feedback-contract";
import { INSPECTOR_CAPS, INSPECTOR_STYLE_ALLOWLIST } from "../../artifacts/inspector-protocol";

/**
 * Allowlist rebuild of everything a comments provider returns (ADR 0006 Addendum 1, design note 1.3 and T10).
 *
 * The provider is another plugin's code: its output is untrusted data. Each function reads only the keys it knows, by
 * own data descriptor (an accessor property is refused without being invoked, a Proxy trap that throws is caught),
 * rejects hostile own keys, re-checks every pattern, length and enum, builds a fresh object that shares nothing with
 * the input, and freezes it. Any violation makes the whole value `null`; the caller turns that into a rejected
 * "failed" result and a console.warn. Nothing here throws to its caller.
 *
 * Strings that are only displayed (label, notice, messages) are control-stripped and truncated. Identity and anchor
 * strings (ids, selectors, text) are validated strictly instead and never altered.
 */

const FAIL = Symbol("comments-rebuild-violation");
const fail = (): never => { throw FAIL; };

const HOSTILE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SELECTION_ID = /^sel_[0-9a-f]{32}$/;
const STORE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KIND = /^[a-z][a-z0-9-]{0,31}$/;
const MAGNITUDE = INSPECTOR_CAPS.numberMagnitude;
/** Sanity bound on array length before any element is read (the real caps are applied after). */
const SCAN_LIMIT = 10_000;
const STYLE_KEYS: ReadonlySet<string> = new Set(INSPECTOR_STYLE_ALLOWLIST);

const STATUSES: ReadonlySet<string> = new Set(["open", "pending", "sent", "resolved", "dismissed"]);
const PROVENANCES: ReadonlySet<string> = new Set(["local", "foreign"]);
const HEALTHS: ReadonlySet<string> = new Set(["ok", "recovered", "read-only", "unavailable"]);
const OUTCOMES: ReadonlySet<string> = new Set(["sent", "queued", "failed", "unknown"]);
const BATCH_OUTCOMES: ReadonlySet<string> = new Set(["sent", "queued", "partial", "none"]);
const BATCH_RESULTS: ReadonlySet<string> = new Set(["sent", "queued", "deferred", "skipped"]);
const SKIP_REASONS: ReadonlySet<string> = new Set(["not-found", "not-sendable", "foreign", "too-large", "conflict"]);
const CHANGE_REASONS: ReadonlySet<string> = new Set(["local", "send-result", "external", "recovered"]);
const PRESETS: ReadonlySet<string> = new Set(["desktop", "tablet", "mobile", "custom", "fill"]);
export const COMMENTS_REJECT_REASONS: ReadonlySet<string> = new Set<ArtifactCommentsRejectReason>([
  "not-found", "conflict", "invalid", "invalid-transition", "limit", "read-only", "foreign", "busy", "unavailable", "failed",
]);

type Dict = Record<string, unknown>;

/** A plain data object: Object.prototype or null prototype, no hostile own keys. Anything else is a violation. */
function dict(value: unknown): Dict {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return fail();
  for (const name of Object.getOwnPropertyNames(value)) if (HOSTILE_KEYS.has(name)) return fail();
  return value as Dict;
}

/** Own data value of `key`, or undefined when absent. Accessors are refused without being called. */
function field(holder: Dict, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(holder, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) return fail();
  return descriptor.value;
}

function elements(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) return fail();
  const length = value.length;
  if (!Number.isSafeInteger(length) || length > SCAN_LIMIT || length > max) return fail();
  const out: unknown[] = [];
  for (let i = 0; i < length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (descriptor === undefined || !("value" in descriptor)) return fail();
    out.push(descriptor.value);
  }
  return out;
}

function str(value: unknown, min: number, max: number): string {
  if (typeof value !== "string" || value.length < min || value.length > max) return fail();
  return value;
}
function pattern(value: unknown, re: RegExp): string {
  if (typeof value !== "string" || !re.test(value)) return fail();
  return value;
}
function int(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return fail();
  return value;
}
function num(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > MAGNITUDE) return fail();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") return fail();
  return value;
}
function oneOf<T extends string>(value: unknown, allowed: ReadonlySet<string>): T {
  if (typeof value !== "string" || !allowed.has(value)) return fail();
  return value as T;
}
function iso(value: unknown): string {
  const text = pattern(value, ISO_UTC);
  if (!Number.isFinite(Date.parse(text))) return fail();
  return text;
}
function nullable<T>(value: unknown, parse: (v: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

// eslint-disable-next-line no-control-regex
const CONTROLS_AND_BIDI = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;
// eslint-disable-next-line no-control-regex
const CONTROLS_KEEP_NEWLINE_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

function dropTrailingHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/** Display-only text: tabs and newlines become spaces, controls and bidi overrides are removed, then truncated to `max` units. */
export function cleanDisplayText(value: unknown, max: number): string {
  if (typeof value !== "string") return fail();
  // Truncate before cleaning: the input is untrusted and may be tens of MB. Four times the cap leaves room for the
  // characters cleaning removes; the final slice enforces the cap itself.
  const head = value.length > max * 4 ? value.slice(0, max * 4) : value;
  const cleaned = head.replace(/[\t\n\r]+/g, " ").replace(CONTROLS_AND_BIDI, "");
  return cleaned.length > max ? dropTrailingHighSurrogate(cleaned.slice(0, max)) : cleaned;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze((value as Dict)[key]);
  return Object.freeze(value);
}

/** Runs a rebuild step and converts a violation (or any unexpected throw, such as a Proxy trap) into null. */
function guarded<T>(build: () => T): T | null {
  try {
    return deepFreeze(build());
  } catch {
    return null;
  }
}

function rect(value: unknown): Rect {
  const source = dict(value);
  return { x: num(field(source, "x")), y: num(field(source, "y")), width: num(field(source, "width")), height: num(field(source, "height")) };
}

function textAnchor(value: unknown): { tag: string; text: string } {
  const source = dict(value);
  return { tag: pattern(field(source, "tag"), INSPECTOR_CAPS.tagPattern), text: str(field(source, "text"), 0, INSPECTOR_CAPS.textAnchorUnits) };
}

function selectorAlternates(value: unknown): string[] {
  return elements(value, INSPECTOR_CAPS.selectorAlternates).map((entry) => str(entry, 0, INSPECTOR_CAPS.selectorUnits));
}

function anchor(value: unknown): ArtifactCommentAnchor {
  const source = dict(value);
  return {
    route: str(field(source, "route"), 0, INSPECTOR_CAPS.routeUnits),
    tag: pattern(field(source, "tag"), INSPECTOR_CAPS.tagPattern),
    selector: str(field(source, "selector"), 0, INSPECTOR_CAPS.selectorUnits),
    selectorAlternates: selectorAlternates(field(source, "selectorAlternates")),
    textAnchor: textAnchor(field(source, "textAnchor")),
    landmark: nullable(field(source, "landmark"), (v) => str(v, 0, INSPECTOR_CAPS.landmarkUnits)),
    lastRect: nullable(field(source, "lastRect"), rect),
  };
}

/** Healed anchors from `reportAnchors` input use the same caps; exported for the outbound validator. */
export function rebuildHealedAnchor(value: unknown): Pick<ArtifactCommentAnchor, "selector" | "selectorAlternates" | "textAnchor" | "landmark" | "lastRect"> | null {
  return guarded(() => {
    const source = dict(value);
    return {
      selector: str(field(source, "selector"), 0, INSPECTOR_CAPS.selectorUnits),
      selectorAlternates: selectorAlternates(field(source, "selectorAlternates")),
      textAnchor: textAnchor(field(source, "textAnchor")),
      landmark: nullable(field(source, "landmark"), (v) => str(v, 0, INSPECTOR_CAPS.landmarkUnits)),
      lastRect: nullable(field(source, "lastRect"), rect),
    };
  });
}

function comment(value: unknown): ArtifactComment {
  const source = dict(value);
  const selectionId = pattern(field(source, "selectionId"), SELECTION_ID);
  const id = pattern(field(source, "id"), ARTIFACT_COMMENT_ID_PATTERN);
  // The id is derived from the selection id (design note A2.4); a mismatch means the provider invented an id.
  if (id !== `cmt_${selectionId.slice(4)}`) return fail();
  const rawText = field(source, "text");
  if (typeof rawText !== "string" || rawText.length > ARTIFACT_COMMENTS_CAPS.maxTextUnits) return fail();
  const text = rawText.replace(CONTROLS_KEEP_NEWLINE_TAB, "");
  if (text.length < 1 || text.length > ARTIFACT_COMMENTS_CAPS.maxTextUnits) return fail();
  const send = dict(field(source, "send"));
  const built: ArtifactComment = {
    id,
    selectionId,
    ordinal: int(field(source, "ordinal"), 1),
    version: int(field(source, "version"), 1),
    // 13e: consumers tolerate kinds they do not know, so a well-formed unknown kind is kept (and typed as the union).
    kind: pattern(field(source, "kind"), KIND) as ArtifactComment["kind"],
    status: oneOf(field(source, "status"), STATUSES),
    provenance: oneOf(field(source, "provenance"), PROVENANCES),
    text,
    createdAt: iso(field(source, "createdAt")),
    updatedAt: iso(field(source, "updatedAt")),
    sentAt: nullable(field(source, "sentAt"), iso),
    artifactRevision: int(field(source, "artifactRevision"), 0),
    viewSessionId: str(field(source, "viewSessionId"), 1, 128),
    anchor: anchor(field(source, "anchor")),
    label: cleanDisplayText(field(source, "label"), ARTIFACT_COMMENTS_CAPS.maxLabelUnits),
    hasScreenshot: bool(field(source, "hasScreenshot")),
    redacted: bool(field(source, "redacted")),
    send: {
      attempts: int(field(send, "attempts"), 0),
      lastOutcome: nullable(field(send, "lastOutcome"), (v) => oneOf<"sent" | "queued" | "failed" | "unknown">(v, OUTCOMES)),
      maybeSent: bool(field(send, "maybeSent")),
      lastMessage: nullable(field(send, "lastMessage"), (v) => cleanDisplayText(v, ARTIFACT_COMMENTS_CAPS.maxMessageUnits)),
    },
  };
  // A comment pinned on a vault:read artifact carries no page text and no pixels (design note T11).
  if (built.redacted && (built.anchor.textAnchor.text !== "" || built.hasScreenshot)) return fail();
  return built;
}

function selection(value: unknown): ElementSelection {
  const source = dict(value);
  if (field(source, "schemaVersion") !== 1) return fail();
  const html = dict(field(source, "outerHTML"));
  const box = dict(field(source, "boundingBox"));
  const view = dict(field(source, "viewport"));
  const a11y = dict(field(source, "a11y"));
  const styles = dict(field(source, "computedStyles"));
  const computedStyles: Record<string, string> = {};
  for (const name of Object.getOwnPropertyNames(styles)) {
    if (!STYLE_KEYS.has(name)) continue;
    computedStyles[name] = str(field(styles, name), 0, INSPECTOR_CAPS.styleValueUnits);
  }
  const dpr = num(field(view, "devicePixelRatio"));
  if (dpr <= 0) return fail();
  const built: ElementSelection = {
    schemaVersion: 1,
    selectionId: pattern(field(source, "selectionId"), SELECTION_ID),
    artifactId: str(field(source, "artifactId"), 1, 256),
    artifactRevision: int(field(source, "artifactRevision"), 0),
    viewSessionId: str(field(source, "viewSessionId"), 1, 128),
    viewportPreset: oneOf(field(source, "viewportPreset"), PRESETS),
    capturedAt: iso(field(source, "capturedAt")),
    redacted: bool(field(source, "redacted")),
    route: str(field(source, "route"), 0, INSPECTOR_CAPS.routeUnits),
    tag: pattern(field(source, "tag"), INSPECTOR_CAPS.tagPattern),
    selector: str(field(source, "selector"), 0, INSPECTOR_CAPS.selectorUnits),
    selectorAlternates: selectorAlternates(field(source, "selectorAlternates")),
    textAnchor: textAnchor(field(source, "textAnchor")),
    landmark: nullable(field(source, "landmark"), (v) => str(v, 0, INSPECTOR_CAPS.landmarkUnits)),
    outerHTML: { html: str(field(html, "html"), 0, INSPECTOR_CAPS.outerHtmlUnits), truncated: bool(field(html, "truncated")) },
    ancestors: elements(field(source, "ancestors"), INSPECTOR_CAPS.ancestors).map((entry) => {
      const item = dict(entry);
      return {
        tag: pattern(field(item, "tag"), INSPECTOR_CAPS.tagPattern),
        id: nullable(field(item, "id"), (v) => str(v, 0, INSPECTOR_CAPS.ancestorIdUnits)),
        classes: elements(field(item, "classes"), INSPECTOR_CAPS.ancestorClasses).map((c) => str(c, 0, INSPECTOR_CAPS.ancestorClassUnits)),
      };
    }),
    computedStyles,
    boundingBox: { viewport: rect(field(box, "viewport")), document: rect(field(box, "document")) },
    viewport: {
      width: num(field(view, "width")),
      height: num(field(view, "height")),
      devicePixelRatio: dpr,
      scrollX: num(field(view, "scrollX")),
      scrollY: num(field(view, "scrollY")),
    },
    a11y: {
      role: nullable(field(a11y, "role"), (v) => str(v, 0, INSPECTOR_CAPS.roleUnits)),
      name: nullable(field(a11y, "name"), (v) => str(v, 0, INSPECTOR_CAPS.nameUnits)),
      tabIndex: nullable(field(a11y, "tabIndex"), (v) => int(v, -1, 32767)),
    },
  };
  // A redacted selection (vault:read) carries neither text anchor text nor an accessible name.
  if (built.redacted && (built.textAnchor.text !== "" || built.a11y.name !== null)) return fail();
  return built;
}

export function rebuildComment(value: unknown): ArtifactComment | null {
  return guarded(() => comment(value));
}

export function rebuildSelection(value: unknown): ElementSelection | null {
  return guarded(() => selection(value));
}

/** `target`, when given, is the artifact the call was made for: the stored selection must belong to it. */
export function rebuildDetail(value: unknown, target?: { readonly artifactId: string }): ArtifactCommentDetail | null {
  return guarded((): ArtifactCommentDetail => {
    const source = dict(value);
    const built = comment(field(source, "comment"));
    const stored = nullable(field(source, "selection"), selection);
    if (stored !== null) {
      // The sidecar must be the selection this comment was pinned from, on this artifact, with the same redaction.
      if (stored.selectionId !== built.selectionId) return fail();
      if (target !== undefined && stored.artifactId !== target.artifactId) return fail();
      if (stored.redacted !== built.redacted) return fail();
    }
    return { comment: built, selection: stored };
  });
}

/** Geode-authored note appended when a snapshot was cut to the cap, within the notice limit. */
function truncationNotice(plugin: string | null, total: number): string {
  const ours = `Showing the first ${ARTIFACT_COMMENTS_CAPS.maxComments} of ${total} comments.`;
  if (plugin === null || plugin === "") return ours;
  return `${plugin.slice(0, ARTIFACT_COMMENTS_CAPS.maxNoticeUnits - ours.length - 1)} ${ours}`;
}

export function rebuildSnapshot(value: unknown): ArtifactCommentsSnapshot | null {
  return guarded((): ArtifactCommentsSnapshot => {
    const source = dict(value);
    const rawComments = field(source, "comments");
    if (!Array.isArray(rawComments)) return fail();
    // More than the cap is truncated (design note 1.3: "caps at 200"); everything kept is fully validated.
    const bounded = elements(rawComments.length > ARTIFACT_COMMENTS_CAPS.maxComments ? rawComments.slice(0, ARTIFACT_COMMENTS_CAPS.maxComments) : rawComments, ARTIFACT_COMMENTS_CAPS.maxComments);
    const comments = bounded.map(comment);
    if (new Set(comments.map((c) => c.id)).size !== comments.length) return fail();
    if (new Set(comments.map((c) => c.ordinal)).size !== comments.length) return fail();
    comments.sort((a, b) => a.ordinal - b.ordinal);
    const total = rawComments.length;
    const notice = nullable(field(source, "notice"), (v) => cleanDisplayText(v, ARTIFACT_COMMENTS_CAPS.maxNoticeUnits));
    return {
      storeId: pattern(field(source, "storeId"), STORE_ID),
      revision: int(field(source, "revision"), 0),
      health: oneOf(field(source, "health"), HEALTHS),
      notice: total > ARTIFACT_COMMENTS_CAPS.maxComments ? truncationNotice(notice, total) : notice,
      comments,
      foreignCount: int(field(source, "foreignCount"), 0),
    };
  });
}

export function rebuildBatchReport(value: unknown): BatchSendReport | null {
  return guarded((): BatchSendReport => {
    const source = dict(value);
    const items = elements(field(source, "items"), ARTIFACT_COMMENTS_CAPS.maxBatch).map((entry) => {
      const item = dict(entry);
      const result = oneOf<"sent" | "queued" | "deferred" | "skipped">(field(item, "result"), BATCH_RESULTS);
      const reason = field(item, "reason");
      const id = pattern(field(item, "id"), ARTIFACT_COMMENT_ID_PATTERN);
      if (result === "skipped") return { id, result, reason: oneOf<"not-found" | "not-sendable" | "foreign" | "too-large" | "conflict">(reason, SKIP_REASONS) };
      if (reason !== undefined) return fail();
      return { id, result };
    });
    if (new Set(items.map((item) => item.id)).size !== items.length) return fail();
    return {
      requestId: pattern(field(source, "requestId"), ARTIFACT_COMMENTS_REQUEST_ID_PATTERN),
      outcome: oneOf(field(source, "outcome"), BATCH_OUTCOMES),
      items,
      message: cleanDisplayText(field(source, "message"), ARTIFACT_COMMENTS_CAPS.maxMessageUnits),
    };
  });
}

export function rebuildChange(value: unknown): ArtifactCommentsChange | null {
  return guarded((): ArtifactCommentsChange => {
    const source = dict(value);
    const rawIds = field(source, "ids");
    const ids = rawIds === "all" ? "all" : elements(rawIds, ARTIFACT_COMMENTS_CAPS.maxComments).map((id) => pattern(id, ARTIFACT_COMMENT_ID_PATTERN));
    return {
      storeId: pattern(field(source, "storeId"), STORE_ID),
      revision: int(field(source, "revision"), 0),
      reason: oneOf(field(source, "reason"), CHANGE_REASONS),
      ids,
    };
  });
}

export function rebuildSaved(value: unknown): { readonly comment: ArtifactComment; readonly created: boolean } | null {
  return guarded(() => {
    const source = dict(value);
    return { comment: comment(field(source, "comment")), created: bool(field(source, "created")) };
  });
}

export function rebuildRemoved(value: unknown): { readonly id: string } | null {
  return guarded(() => ({ id: pattern(field(dict(value), "id"), ARTIFACT_COMMENT_ID_PATTERN) }));
}

export function rebuildAdopted(value: unknown): { readonly adopted: readonly string[] } | null {
  return guarded(() => {
    const ids = elements(field(dict(value), "adopted"), ARTIFACT_COMMENTS_CAPS.maxBatch).map((id) => pattern(id, ARTIFACT_COMMENT_ID_PATTERN));
    return { adopted: ids };
  });
}

export function rebuildApplied(value: unknown): { readonly applied: number } | null {
  return guarded(() => ({ applied: int(field(dict(value), "applied"), 0, ARTIFACT_COMMENTS_CAPS.maxReportAnchors) }));
}

/** Rebuilds `{status: "ok", value}` through `rebuildValue`, or `{status: "rejected", reason, message}`. Null when malformed. */
export function rebuildResult<T>(value: unknown, rebuildValue: (raw: unknown) => T | null): ArtifactCommentsResult<T> | null {
  return guarded<ArtifactCommentsResult<T>>(() => {
    const source = dict(value);
    const status = field(source, "status");
    if (status === "ok") {
      const built = rebuildValue(field(source, "value"));
      if (built === null) return fail();
      return { status: "ok", value: built };
    }
    if (status === "rejected") {
      return {
        status: "rejected",
        reason: oneOf<ArtifactCommentsRejectReason>(field(source, "reason"), COMMENTS_REJECT_REASONS),
        message: cleanDisplayText(field(source, "message"), ARTIFACT_COMMENTS_CAPS.maxMessageUnits),
      };
    }
    return fail();
  });
}
