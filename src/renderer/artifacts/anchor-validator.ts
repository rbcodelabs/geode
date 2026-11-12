import type { Rect } from "../../artifacts/feedback-contract";
import { ownField, plainBag, sanitizeAnchorQuery } from "../../artifacts/anchor-query";
import {
  INSPECTOR_CAPS,
  type InspectAnchorMatch,
  type InspectAnchorRect,
  type InspectAnchorRectsMessage,
  type InspectAnchorResult,
  type InspectAnchorResultsMessage,
} from "../../artifacts/inspector-protocol";

/**
 * Embedder-side validation for the anchor channels (ADR 0006 addendum 2, A.4). Same rules as `selection-validator`:
 * the page is hostile, so a message is accepted only if it is for the CURRENT epoch and mentions only keys the
 * embedder sent in that epoch, and what is accepted is REBUILT from an allowlist. Unknown extra properties are
 * dropped, a hostile own key (`__proto__`, `constructor`, `prototype`) rejects the whole message, and any violation
 * drops the message whole (no partial acceptance). Pure; null means reject.
 *
 * Kept apart from `selection-validator.ts` so the v1 validator is untouched.
 */

const MATCHES: ReadonlySet<string> = new Set<InspectAnchorMatch>(["selector", "text", "landmark", "detached", "other-route"]);

const bag = plainBag;
const own = ownField;
type Bag = NonNullable<ReturnType<typeof plainBag>>;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= INSPECTOR_CAPS.numberMagnitude ? value : null;

function rect(value: unknown): Rect | null {
  const b = bag(value);
  if (!b) return null;
  const x = num(own(b, "x")), y = num(own(b, "y")), width = num(own(b, "width")), height = num(own(b, "height"));
  if (x === null || y === null || width === null || height === null || width < 0 || height < 0) return null;
  return { x, y, width, height };
}

/** `rect`: absent (undefined) is a violation; null is the explicit "no rect". */
function nullableRect(value: unknown): Rect | null | undefined {
  if (value === null) return null;
  const r = rect(value);
  return r === null ? undefined : r;
}

function keyOf(value: unknown, keys: ReadonlySet<string>, seen: Set<string>): string | null {
  if (typeof value !== "string" || !INSPECTOR_CAPS.anchorKeyPattern.test(value) || !keys.has(value) || seen.has(value)) return null;
  seen.add(value);
  return value;
}

export interface AnchorMessageContext {
  /** The epoch of the last `anchors` message the embedder sent. */
  readonly epoch: number;
  /** The keys sent in that epoch. */
  readonly keys: ReadonlySet<string>;
}

function list(b: Bag, field: string, ctx: AnchorMessageContext): unknown[] | null {
  const epoch = own(b, "epoch");
  if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch !== ctx.epoch) return null;
  const items = own(b, field);
  // Length first: a 10,000 entry flood is dropped without looking at a single entry.
  if (!Array.isArray(items) || items.length > INSPECTOR_CAPS.anchors || items.length > ctx.keys.size) return null;
  return items;
}

export function validateAnchorResults(raw: unknown, ctx: AnchorMessageContext): InspectAnchorResultsMessage | null {
  const b = bag(raw);
  if (!b) return null;
  const items = list(b, "results", ctx);
  if (!items) return null;
  const seen = new Set<string>();
  const results: InspectAnchorResult[] = [];
  for (const item of items) {
    const r = bag(item);
    if (!r) return null;
    const key = keyOf(own(r, "key"), ctx.keys, seen);
    const match = own(r, "match");
    const agrees = own(r, "agrees");
    const box = nullableRect(own(r, "rect"));
    const visible = own(r, "visible");
    if (key === null || typeof match !== "string" || !MATCHES.has(match) || typeof agrees !== "boolean" || box === undefined || typeof visible !== "boolean") return null;
    const unplaced = match === "detached" || match === "other-route";
    if (unplaced !== (box === null)) return null; // a rect exists exactly when the anchor was placed
    if (box === null && visible) return null;
    results.push({ key, match: match as InspectAnchorMatch, agrees, rect: box, visible });
  }
  return { epoch: ctx.epoch, results };
}

export function validateAnchorRects(raw: unknown, ctx: AnchorMessageContext): InspectAnchorRectsMessage | null {
  const b = bag(raw);
  if (!b) return null;
  const items = list(b, "rects", ctx);
  if (!items) return null;
  const seen = new Set<string>();
  const rects: InspectAnchorRect[] = [];
  for (const item of items) {
    const r = bag(item);
    if (!r) return null;
    const key = keyOf(own(r, "key"), ctx.keys, seen);
    const box = nullableRect(own(r, "rect"));
    const visible = own(r, "visible");
    if (key === null || box === undefined || typeof visible !== "boolean") return null;
    if (box === null && visible) return null;
    rects.push({ key, rect: box, visible });
  }
  return { epoch: ctx.epoch, rects };
}

/** Re-exported: the embedder's gate on what it sends to the guest is the shared definition of a well-formed query. */
export { sanitizeAnchorQuery };
