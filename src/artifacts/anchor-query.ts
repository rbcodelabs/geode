import { INSPECTOR_CAPS, type InspectAnchorQuery } from "./inspector-protocol";

/**
 * The one definition of a well-formed anchor query (ADR 0006 addendum 2). The embedder rebuilds every query with it
 * before sending (so a caller that attaches a comment, an id or a status cannot leak it), and the guest rebuilds
 * again on receipt (belt and braces). Dependency-free: it is bundled into the sandboxed guest preload as well as the
 * renderer. Null means reject; a hostile own key (`__proto__`, `constructor`, `prototype`) rejects.
 */

type Bag = Record<string, unknown>;

const HOSTILE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export function plainBag(value: unknown): Bag | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  for (const key of Object.keys(value)) if (HOSTILE_KEYS.has(key)) return null;
  return value as Bag;
}
/** Own property only: an inherited value (a prototype someone controls) is never read. */
export const ownField = (b: Bag, key: string): unknown => (Object.prototype.hasOwnProperty.call(b, key) ? b[key] : undefined);

const str = (value: unknown, max: number): string | null => (typeof value === "string" && value.length <= max ? value : null);
const tag = (value: unknown): string | null => (typeof value === "string" && INSPECTOR_CAPS.tagPattern.test(value) ? value : null);

export function sanitizeAnchorQuery(raw: unknown): InspectAnchorQuery | null {
  const b = plainBag(raw);
  if (!b) return null;
  const key = ownField(b, "key");
  const route = str(ownField(b, "route"), INSPECTOR_CAPS.routeUnits);
  const t = tag(ownField(b, "tag"));
  const selector = str(ownField(b, "selector"), INSPECTOR_CAPS.selectorUnits);
  const rawAlternates = ownField(b, "alternates");
  const anchor = plainBag(ownField(b, "textAnchor"));
  const anchorTag = anchor ? tag(ownField(anchor, "tag")) : null;
  const anchorText = anchor ? str(ownField(anchor, "text"), INSPECTOR_CAPS.textAnchorUnits) : null;
  const rawLandmark = ownField(b, "landmark");
  const landmark = rawLandmark === null ? null : str(rawLandmark, INSPECTOR_CAPS.landmarkUnits);
  if (typeof key !== "string" || !INSPECTOR_CAPS.anchorKeyPattern.test(key)) return null;
  if (route === null || t === null || selector === null || anchorTag === null || anchorText === null) return null;
  if (rawLandmark === undefined || (rawLandmark !== null && landmark === null)) return null;
  // One bounded read of the (untrusted) array: copy at most cap + 1 entries, then only ever look at the copy.
  const copy = Array.isArray(rawAlternates) ? rawAlternates.slice(0, INSPECTOR_CAPS.selectorAlternates + 1) : null;
  if (!copy || copy.length > INSPECTOR_CAPS.selectorAlternates) return null;
  const alternates: string[] = [];
  for (const alt of copy) {
    const s = str(alt, INSPECTOR_CAPS.selectorUnits);
    if (s === null) return null;
    alternates.push(s);
  }
  return { key, route, tag: t, selector, alternates, textAnchor: { tag: anchorTag, text: anchorText }, landmark };
}
