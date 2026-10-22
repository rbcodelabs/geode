/**
 * Minimal npm-style semver range matching (ADR 0050, "Pinned GitHub plugins").
 * Pure and dependency-free so the main process, the pack validator and tests
 * share one implementation.
 *
 * Supported: exact versions, comparators (`< <= > >= =`), caret, tilde,
 * x-ranges (`1.x`, `1.2.*`, `*`), partial versions (`1`, `1.2`), hyphen ranges
 * (`1.2.3 - 2.0.0`), AND (whitespace) and OR (`||`).
 *
 * Prerelease rule (npm's): a prerelease version satisfies a comparator set only
 * if some comparator in that set carries a prerelease on the same
 * `major.minor.patch`. `>=1.4.0` therefore never matches `1.5.0-beta.1`, while
 * `>=1.5.0-beta.1` does.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

interface Comparator {
  op: "<" | "<=" | ">" | ">=" | "=";
  version: SemVer;
}

export type ParsedRange = Comparator[][];

const MAX_RANGE_LENGTH = 256;
const VERSION_RE = /^[v=]*(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PARTIAL_RE = /^[v=]*(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function toIdentifiers(raw: string | undefined): Array<string | number> {
  if (!raw) return [];
  return raw.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
}

/** Strict-enough semver parse; tolerates a leading `v` (release tags). Returns null when malformed. */
export function parseVersion(input: string): SemVer | null {
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  const prerelease = toIdentifiers(m[4]);
  if (prerelease.some((id) => typeof id === "number" && !Number.isSafeInteger(id))) return null;
  return { major: nums[0], minor: nums[1], patch: nums[2], prerelease };
}

export function formatVersion(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}${v.prerelease.length ? `-${v.prerelease.join(".")}` : ""}`;
}

function compareIdentifiers(a: string | number, b: string | number): number {
  const an = typeof a === "number";
  const bn = typeof b === "number";
  if (an && bn) return a === b ? 0 : (a as number) < (b as number) ? -1 : 1;
  if (an) return -1; // numeric identifiers sort before alphanumeric
  if (bn) return 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Semver precedence (build metadata ignored). */
export function compareVersions(a: SemVer, b: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1; // a release outranks its prereleases
  if (!b.prerelease.length) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.prerelease.length) return -1;
    if (i >= b.prerelease.length) return 1;
    const c = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (c) return c;
  }
  return 0;
}

const v = (major: number, minor: number, patch: number, prerelease: Array<string | number> = []): SemVer => ({ major, minor, patch, prerelease });

interface Partial3 {
  major: number | null;
  minor: number | null;
  patch: number | null;
  prerelease: Array<string | number>;
}

function parsePartial(token: string): Partial3 {
  const m = PARTIAL_RE.exec(token);
  if (!m) throw new Error(`Invalid version "${token}"`);
  const part = (s: string | undefined): number | null => {
    if (s === undefined || /^[xX*]$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isSafeInteger(n)) throw new Error(`Invalid version "${token}"`);
    return n;
  };
  const major = part(m[1]);
  const minor = major === null ? null : part(m[2]);
  const patch = minor === null ? null : part(m[3]);
  if (m[4] && patch === null) throw new Error(`Invalid version "${token}": a prerelease needs major.minor.patch`);
  return { major, minor, patch, prerelease: toIdentifiers(m[4]) };
}

const ANY: Comparator = { op: ">=", version: v(0, 0, 0) };

/** `>=` and `<` pair covering a (possibly partial) version, i.e. the x-range / exact semantics. */
function xRange(p: Partial3): Comparator[] {
  if (p.major === null) return [ANY];
  if (p.minor === null) return [{ op: ">=", version: v(p.major, 0, 0) }, { op: "<", version: v(p.major + 1, 0, 0) }];
  if (p.patch === null) return [{ op: ">=", version: v(p.major, p.minor, 0) }, { op: "<", version: v(p.major, p.minor + 1, 0) }];
  return [{ op: "=", version: v(p.major, p.minor, p.patch, p.prerelease) }];
}

function caret(p: Partial3): Comparator[] {
  if (p.major === null) return [ANY];
  const lower = v(p.major, p.minor ?? 0, p.patch ?? 0, p.prerelease);
  let upper: SemVer;
  if (p.major > 0 || p.minor === null) upper = v(p.major + 1, 0, 0);
  else if (p.minor > 0 || p.patch === null) upper = v(0, p.minor + 1, 0);
  else upper = v(0, 0, p.patch + 1);
  return [{ op: ">=", version: lower }, { op: "<", version: upper }];
}

function tilde(p: Partial3): Comparator[] {
  if (p.major === null) return [ANY];
  const lower = v(p.major, p.minor ?? 0, p.patch ?? 0, p.prerelease);
  const upper = p.minor === null ? v(p.major + 1, 0, 0) : v(p.major, p.minor + 1, 0);
  return [{ op: ">=", version: lower }, { op: "<", version: upper }];
}

function primitive(op: string, p: Partial3): Comparator[] {
  const lowerFull = v(p.major ?? 0, p.minor ?? 0, p.patch ?? 0, p.prerelease);
  switch (op) {
    case "^": return caret(p);
    case "~": return tilde(p);
    case "": case "=": return xRange(p);
    case ">=": return p.major === null ? [ANY] : [{ op: ">=", version: lowerFull }];
    case "<":
      if (p.major === null) return [{ op: "<", version: v(0, 0, 0) }]; // `<*` matches nothing
      return [{ op: "<", version: lowerFull }];
    case ">": {
      if (p.major === null) return [{ op: "<", version: v(0, 0, 0) }];
      if (p.minor === null) return [{ op: ">=", version: v(p.major + 1, 0, 0) }];
      if (p.patch === null) return [{ op: ">=", version: v(p.major, p.minor + 1, 0) }];
      return [{ op: ">", version: lowerFull }];
    }
    case "<=": {
      if (p.major === null) return [ANY];
      if (p.minor === null) return [{ op: "<", version: v(p.major + 1, 0, 0) }];
      if (p.patch === null) return [{ op: "<", version: v(p.major, p.minor + 1, 0) }];
      return [{ op: "<=", version: lowerFull }];
    }
    default: throw new Error(`Unsupported operator "${op}"`);
  }
}

function parseSet(raw: string): Comparator[] {
  let text = raw.trim();
  if (!text || text === "*" || /^[xX]$/.test(text)) return [ANY];

  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
  if (hyphen) {
    const lo = parsePartial(hyphen[1]);
    const hi = parsePartial(hyphen[2]);
    const out: Comparator[] = lo.major === null ? [ANY] : [{ op: ">=", version: v(lo.major, lo.minor ?? 0, lo.patch ?? 0, lo.prerelease) }];
    if (hi.major !== null) out.push(...primitive("<=", hi));
    return out;
  }

  text = text.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1");
  const out: Comparator[] = [];
  for (const token of text.split(/\s+/)) {
    const m = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token);
    if (!m) throw new Error(`Invalid range "${raw}"`);
    out.push(...primitive(m[1] ?? "", parsePartial(m[2])));
  }
  return out;
}

/** Parses a range. Throws an `Error` with a readable message on anything malformed. */
export function parseRange(input: string): ParsedRange {
  if (typeof input !== "string") throw new Error("A version range must be a string");
  if (input.length > MAX_RANGE_LENGTH) throw new Error("Version range is too long");
  if (!input.trim()) throw new Error("A version range cannot be empty");
  try {
    const alternatives = input.split("||");
    // `*` is the explicit match-anything; an empty alternative (`^1 ||`) is a typo, not a wildcard.
    if (alternatives.length > 1 && alternatives.some((a) => !a.trim())) throw new Error("empty alternative around ||");
    return alternatives.map(parseSet);
  } catch (err) {
    throw new Error(`Invalid version range "${input}": ${(err as Error).message}`);
  }
}

export function isValidRange(input: unknown): input is string {
  if (typeof input !== "string") return false;
  try {
    parseRange(input);
    return true;
  } catch {
    return false;
  }
}

/** True when any comparator names a prerelease, so the author opted into prereleases. */
export function rangeIncludesPrerelease(range: ParsedRange | string): boolean {
  const parsed = typeof range === "string" ? parseRange(range) : range;
  return parsed.some((set) => set.some((c) => c.version.prerelease.length > 0));
}

function testComparator(version: SemVer, c: Comparator): boolean {
  const cmp = compareVersions(version, c.version);
  switch (c.op) {
    case "<": return cmp < 0;
    case "<=": return cmp <= 0;
    case ">": return cmp > 0;
    case ">=": return cmp >= 0;
    case "=": return cmp === 0;
  }
}

/** Whether `version` satisfies `range`. A malformed version never satisfies anything. */
export function satisfies(version: string | SemVer, range: ParsedRange | string): boolean {
  const ver = typeof version === "string" ? parseVersion(version) : version;
  if (!ver) return false;
  const parsed = typeof range === "string" ? parseRange(range) : range;
  return parsed.some((set) => {
    if (!set.every((c) => testComparator(ver, c))) return false;
    if (!ver.prerelease.length) return true;
    return set.some(
      (c) => c.version.prerelease.length > 0 && c.version.major === ver.major && c.version.minor === ver.minor && c.version.patch === ver.patch,
    );
  });
}
