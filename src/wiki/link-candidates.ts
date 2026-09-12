/** Internal policies, not a public SDK or a desktop backend replacement. */
export type LinkResolutionPolicy = "desktop-compatibility" | "agent-strict";
export interface CandidateProvider {
  /** Stable synchronous lookup; objects and entries stay adapter-owned. */
  getFileByPath(path: string): unknown | null;
  byBasename: ReadonlyMap<string, Iterable<string>>;
  byAlias: ReadonlyMap<string, Iterable<string>>;
}
export interface CandidateSelection {
  candidates: string[];
  stage: "self" | "exact" | "relative" | "basename" | "alias";
  invalid?: "traversal" | "invalid-target";
}

/** Pure path-component validation; no URL decoding or host filesystem lookup. */
export function normalizeWikiPath(input: string): string | null {
  if (!input || input.startsWith("/") || /^[A-Za-z]:/.test(input) || /[\\\0]/.test(input)) return null;
  const segments: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "..") { if (!segments.length) return null; segments.pop(); }
    else if (segment && segment !== ".") segments.push(segment);
  }
  return segments.length ? segments.join("/") : null;
}

/** One ordered pipeline; parsing, source checks, coverage and subpaths are wrappers. */
export function selectLinkCandidates(
  target: string, sourcePath: string, provider: CandidateProvider, policy: LinkResolutionPolicy,
): CandidateSelection {
  const strict = policy === "agent-strict";
  if (!target) return { candidates: [sourcePath], stage: "self" };
  const slash = sourcePath.lastIndexOf("/");
  const parent = slash > 0 || (strict && slash === 0) ? sourcePath.slice(0, slash + 1) : "";
  const exact = (path: string): string[] => {
    // Preserve nullish fallback: a falsy non-null value must not try .md.
    const direct = provider.getFileByPath(path);
    if (direct != null) return direct ? [path] : [];
    return provider.getFileByPath(path + ".md") ? [path + ".md"] : [];
  };
  if (strict && (target.startsWith("./") || target.startsWith("../"))) {
    const path = normalizeWikiPath(parent + target);
    return path ? { candidates: exact(path), stage: "relative" }
      : { candidates: [], stage: "relative", invalid: "traversal" };
  }
  const path = strict ? normalizeWikiPath(target) : target;
  if (!path) return { candidates: [], stage: "exact", invalid: "invalid-target" };
  let candidates = exact(path);
  if (candidates.length) return { candidates, stage: "exact" };
  if (parent) {
    const relative = strict ? normalizeWikiPath(parent + target) : parent + target;
    if (relative) candidates = exact(relative);
    if (candidates.length) return { candidates, stage: "relative" };
  }
  const key = strict ? target.normalize("NFC").toLowerCase() : target.toLowerCase();
  candidates = [...(provider.byBasename.get(key) ?? [])];
  if (candidates.length) {
    candidates.sort(strict ? compare : (a, b) => a.length - b.length);
    return { candidates: strict ? candidates : candidates.slice(0, 1), stage: "basename" };
  }
  const aliases = provider.byAlias.get(key);
  if (!strict) {
    // Desktop has always used the first indexed alias, regardless of bucket size.
    const first = aliases?.[Symbol.iterator]().next();
    return { candidates: first && !first.done ? [first.value] : [], stage: "alias" };
  }
  return { candidates: [...(aliases ?? [])].sort(compare), stage: "alias" };
}

function compare(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
