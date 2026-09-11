import { parseDocument } from "yaml";
import { DEFAULT_METADATA_SCAN_CAP_BYTES } from "../indexer/metadata-indexer";
import { parseMetadata } from "./metadata";
import { normalizeWikiPath, selectLinkCandidates } from "./link-candidates";
export { normalizeWikiPath } from "./link-candidates";
import type { CachedMetadata, LinkCache, Loc } from "./types";

/** Internal capture boundary, not a supported public SDK. Attachment bytes are never supplied. */
export interface CapturedFile { path: string; kind: "note" | "attachment"; text?: string }
export interface Diagnostic { code: string; path?: string; paths?: string[] }
export interface SnapshotLimits {
  maxEntries: number;
  maxVisitedEntries: number;
  maxDepth: number;
  maxNoteBytes: number;
  maxTotalNoteBytes: number;
}
export const DEFAULT_SNAPSHOT_LIMITS: Readonly<SnapshotLimits> = Object.freeze({
  maxEntries: 10_000, maxVisitedEntries: 50_000, maxDepth: 32,
  maxNoteBytes: 2 * 1024 * 1024, maxTotalNoteBytes: 64 * 1024 * 1024,
});
export interface CaptureInfo {
  discoveryComplete?: boolean;
  diagnostics?: Diagnostic[];
  scanStartedAt?: string;
  scanEndedAt?: string;
  limits?: SnapshotLimits;
}
export interface ParserCoverage {
  referenceSyntax: "wikilinks";
  completeMarkdownGraph: false;
  referencesCertain: boolean;
  headingsCertain: boolean;
  blocksCertain: boolean;
  frontmatterCertain: boolean;
  bodyScanned: boolean;
}
export interface CapturedNote {
  path: string;
  text: string;
  metadata: CachedMetadata | null;
  diagnostics: Diagnostic[];
  coverage: ParserCoverage;
}
export interface SubpathResult {
  status: "none" | "found" | "missing" | "ambiguous" | "unknown";
  reason?: string;
  positions?: Loc[];
}
export interface Resolution {
  status: "resolved" | "ambiguous" | "missing" | "invalid" | "external" | "unavailable";
  path?: string;
  candidates: string[];
  reason?: string;
  subpath: SubpathResult;
  discoveryComplete: boolean;
  aliasCoverageComplete: boolean;
}
export interface ResolvedReference extends LinkCache { sourcePath: string; resolution: Resolution }
export type ReadNoteResult = { status: "ok"; note: CapturedNote } | { status: "invalid" | "absent" | "unavailable"; reason: string };
export interface GraphResult {
  status: "ok" | "invalid" | "absent" | "unavailable";
  references: ResolvedReference[];
  coverage: {
    referenceSyntax: "wikilinks"; completeMarkdownGraph: false;
    discoveryComplete: boolean; noteContentComplete: boolean; referencesCertain: boolean;
  };
}
export interface SearchResult {
  status: "ok" | "invalid";
  hits: { path: string; offset: number; snippet: string; snippetOffset: number }[];
  truncated: boolean;
  complete: boolean;
  caseFolding: "ascii";
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const folded = (s: string) => s.normalize("NFC").toLowerCase();
const asciiFold = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase());

/** YAML anchors may share objects or contain cycles. Never recurse without identity tracking. */
function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  // YAML !!binary yields typed arrays, which cannot be frozen. readNote clones before exposure.
  if (ArrayBuffer.isView(value)) return value;
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freeze(child, seen);
    Object.freeze(value);
  }
  return value;
}

function characterize(path: string, text: string): CapturedNote {
  const diagnostics: Diagnostic[] = [];
  const add = (code: string) => diagnostics.push({ code, path });
  let metadata: CachedMetadata | null;
  try { metadata = parseMetadata(text); }
  catch { metadata = null; add("parser-failed"); }
  const coverage: ParserCoverage = {
    referenceSyntax: "wikilinks", completeMarkdownGraph: false,
    referencesCertain: metadata !== null, headingsCertain: metadata !== null,
    blocksCertain: metadata !== null, frontmatterCertain: metadata !== null,
    bodyScanned: metadata !== null,
  };
  if (text.includes("\r\n")) { add("crlf-headings"); coverage.headingsCertain = false; }
  if (/^\ufeff---\r?\n/.test(text)) {
    add("frontmatter-bom-unsupported"); coverage.frontmatterCertain = false;
    coverage.referencesCertain = false; coverage.headingsCertain = false; coverage.blocksCertain = false;
  }
  if (/^.+\r?\n[ \t]*(?:=+|-+)[ \t]*\r?$/m.test(text.slice(metadata?.frontmatterEndOffset ?? 0))) {
    add("setext-headings-unsupported"); coverage.headingsCertain = false;
  }
  if (/^\s*~~~/m.test(text)) {
    add("tilde-fence-references"); coverage.referencesCertain = false;
    coverage.headingsCertain = false; coverage.blocksCertain = false;
  }
  if (/(?:\[[^\]\n]*\]\([^\n]*|\[[^\]\n]*\]\[[^\]\n]*\]|^\s*\[[^\]\n]+\]:)/m.test(text)) add("markdown-links-unsupported");
  if (/^---\r?\n/.test(text) && !metadata?.frontmatter) {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) add("frontmatter-unterminated");
    else {
      try { add(parseDocument(match[1]).errors.length ? "frontmatter-malformed" : "frontmatter-nonmapping"); }
      catch { add("frontmatter-malformed"); }
    }
    coverage.frontmatterCertain = false;
    coverage.headingsCertain = false; coverage.blocksCertain = false; coverage.referencesCertain = false;
  }
  // The existing parser's misleadingly named cap counts JS code units, not UTF-8 bytes.
  if (text.length - (metadata?.frontmatterEndOffset ?? 0) > DEFAULT_METADATA_SCAN_CAP_BYTES) {
    add("parser-body-cap"); coverage.bodyScanned = false;
    coverage.headingsCertain = false; coverage.blocksCertain = false; coverage.referencesCertain = false;
  }
  // Existing sections don't capture paragraph block IDs. Keep this limitation visible.
  const parsedBlockOffsets = new Set(metadata?.listItems?.filter(i => i.id).map(i => i.position.start.offset));
  let offset = 0;
  for (const line of text.split("\n")) {
    if (/[ \t]\^[A-Za-z0-9-]+\s*$/.test(line) && !parsedBlockOffsets.has(offset)) {
      add("paragraph-block-ids-unsupported"); coverage.blocksCertain = false; break;
    }
    offset += line.length + 1;
  }
  return freeze({ path, text, metadata, diagnostics, coverage });
}

/** Build a detached index from adapter-owned captured bytes. All returned data is recursively frozen. */
export function createWikiSnapshot(captured: readonly CapturedFile[], captureInfo: CaptureInfo = {}) {
  const files = new Map<string, { path: string; kind: "note" | "attachment" }>();
  const notes = new Map<string, CapturedNote>();
  const byBasename = new Map<string, Set<string>>();
  const byAlias = new Map<string, Set<string>>();
  const collisions = new Map<string, string[]>();
  const addIndex = (index: Map<string, Set<string>>, key: string, path: string) => {
    const normalized = folded(key);
    if (!index.has(normalized)) index.set(normalized, new Set());
    index.get(normalized)!.add(path);
  };
  const diagnostics = structuredClone(captureInfo.diagnostics ?? []);
  for (const entry of [...captured].sort((a, b) => compare(a.path, b.path))) {
    if (normalizeWikiPath(entry.path) !== entry.path || files.has(entry.path)) throw Error("Invalid or duplicate captured identity");
    files.set(entry.path, freeze({ path: entry.path, kind: entry.kind }));
    const basename = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    addIndex(byBasename, basename, entry.path);
    if (entry.kind === "note") addIndex(byBasename, basename.replace(/\.md$/i, ""), entry.path);
    const key = folded(entry.path);
    if (!collisions.has(key)) collisions.set(key, []);
    collisions.get(key)!.push(entry.path);
    if (entry.kind === "note" && entry.text !== undefined) {
      const note = characterize(entry.path, entry.text);
      notes.set(entry.path, note);
      diagnostics.push(...note.diagnostics);
      for (const alias of note.metadata?.aliases ?? []) addIndex(byAlias, alias, entry.path);
    }
  }
  for (const paths of collisions.values()) if (paths.length > 1) diagnostics.push({ code: "portability-collision", paths });
  const discoveryComplete = captureInfo.discoveryComplete ?? true;
  const noteContentComplete = [...files.values()].every(file => file.kind !== "note" || notes.has(file.path));
  const aliasCoverageComplete = discoveryComplete && noteContentComplete && [...notes.values()].every(n => n.coverage.frontmatterCertain);
  const graphCoverage = freeze({
    referenceSyntax: "wikilinks" as const, completeMarkdownGraph: false as const,
    discoveryComplete, noteContentComplete,
    referencesCertain: discoveryComplete && noteContentComplete && [...notes.values()].every(n => n.coverage.referencesCertain),
  });
  const info = freeze({
    consistency: "scan" as const,
    scanStartedAt: captureInfo.scanStartedAt ?? new Date().toISOString(),
    scanEndedAt: captureInfo.scanEndedAt ?? new Date().toISOString(),
    discoveryComplete, noteContentComplete, aliasCoverageComplete, diagnostics,
    limits: { ...(captureInfo.limits ?? DEFAULT_SNAPSHOT_LIMITS) },
    exclusionPolicy: ["dot-prefixed path segments", "node_modules directories", "descendant symlinks", "special files"],
    referenceSyntax: "wikilinks" as const,
    parserLimitations: ["Markdown links are not in the graph", "CRLF heading coverage", "setext headings", "BOM-prefixed frontmatter", "tilde fence reference masking", "paragraph block IDs", "body scan cap in code units"],
    parserBodyCapCodeUnits: DEFAULT_METADATA_SCAN_CAP_BYTES,
  });

  function subpath(path: string, selector: string | undefined): SubpathResult {
    if (selector === undefined) return { status: "none" };
    if (!selector || selector.includes("#") || (selector.includes("^") && !/^\^[A-Za-z0-9-]+$/.test(selector))) return { status: "unknown", reason: "unsupported-selector" };
    const note = notes.get(path);
    if (!note?.metadata) return { status: "unknown", reason: "content-unavailable" };
    const block = selector.startsWith("^");
    const positions = block
      ? [...(note.metadata.sections ?? []), ...(note.metadata.listItems ?? [])].filter(i => i.id === selector.slice(1)).map(i => i.position)
      : note.metadata.headings.filter(h => h.heading === selector).map(h => h.position);
    // A section and item can describe the same block; count unique source positions.
    const unique = [...new Map(positions.map(p => [p.start.offset, p])).values()];
    if (unique.length > 1) return { status: "ambiguous", positions: unique };
    if (!(block ? note.coverage.blocksCertain : note.coverage.headingsCertain)) return { status: "unknown", reason: "parser-coverage", positions: unique };
    return unique.length ? { status: "found", positions: unique } : { status: "missing" };
  }

  function resolve(sourcePath: string, target: string): Resolution {
    const result = (status: Resolution["status"], extra: Partial<Resolution> = {}): Resolution => freeze({ status, candidates: [], subpath: { status: "none" }, discoveryComplete, aliasCoverageComplete, ...extra });
    const source = normalizeWikiPath(sourcePath);
    if (!source) return result("invalid", { reason: "invalid-source" });
    if (!files.has(source)) return result("unavailable", { reason: "source-absent" });
    const raw = target.trim();
    if (!raw || /[\\\0]/.test(raw) || raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || /^file:/i.test(raw)) return result("invalid", { reason: "invalid-target" });
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return result("external");
    const hash = raw.indexOf("#");
    const filePart = hash < 0 ? raw : raw.slice(0, hash);
    const selector = hash < 0 ? undefined : raw.slice(hash + 1);
    const selection = selectLinkCandidates(filePart, source, {
      getFileByPath: path => files.get(path) ?? null, byBasename, byAlias,
    }, "agent-strict");
    if (selection.invalid) return result("invalid", { reason: selection.invalid });
    const { candidates } = selection;
    if (selection.stage === "alias" && !aliasCoverageComplete && candidates.length < 2) {
      return result("unavailable", { reason: "alias-coverage", candidates });
    }
    if (!candidates.length) return result("missing");
    if (candidates.length > 1) return result("ambiguous", { candidates });
    const path = candidates[0];
    return result("resolved", { path, candidates, subpath: subpath(path, selector) });
  }

  const outgoingIndex = new Map<string, ResolvedReference[]>();
  const backlinkIndex = new Map<string, ResolvedReference[]>();
  for (const note of notes.values()) {
    const references = [...(note.metadata?.links ?? []), ...(note.metadata?.embeds ?? [])]
      .sort((a, b) => a.position.start.offset - b.position.start.offset)
      .map(ref => freeze({ ...ref, sourcePath: note.path, resolution: resolve(note.path, ref.link) }));
    outgoingIndex.set(note.path, references);
    for (const ref of references) if (ref.resolution.status === "resolved") {
      const path = ref.resolution.path!;
      if (!backlinkIndex.has(path)) backlinkIndex.set(path, []);
      backlinkIndex.get(path)!.push(ref);
    }
  }

  function readNote(path: string): ReadNoteResult {
    const normalized = normalizeWikiPath(path);
    if (!normalized) return freeze({ status: "invalid", reason: "invalid-path" });
    if (!files.has(normalized)) return freeze({ status: "absent", reason: "not-in-snapshot" });
    const note = notes.get(normalized);
    // Freezing a Map/Set doesn't freeze its entries; YAML supports both tags. Clone at exposure.
    return note ? freeze({ status: "ok", note: structuredClone(note) }) : freeze({ status: "unavailable", reason: "content-unavailable" });
  }
  function graph(path: string, outgoing: boolean): GraphResult {
    const normalized = normalizeWikiPath(path);
    const status = !normalized ? "invalid" : !files.has(normalized) ? "absent" : outgoing && !notes.get(normalized)?.metadata ? "unavailable" : "ok";
    const references = status === "ok" ? (outgoing ? outgoingIndex : backlinkIndex).get(normalized!) ?? [] : [];
    return freeze({ status, references, coverage: graphCoverage });
  }
  function search(query: string, limit = 50): SearchResult {
    const base = { hits: [], truncated: false, complete: discoveryComplete && noteContentComplete, caseFolding: "ascii" as const };
    if (query.length > 1024 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) return freeze({ ...base, status: "invalid" });
    const needle = asciiFold(query.trim());
    const hits: SearchResult["hits"] = [];
    let truncated = false;
    if (needle) for (const note of notes.values()) {
      const offset = asciiFold(note.text).indexOf(needle);
      if (offset < 0) continue;
      if (hits.length === limit) { truncated = true; break; }
      const lineStart = note.text.lastIndexOf("\n", offset - 1) + 1;
      const nextNewline = note.text.indexOf("\n", offset);
      const lineEnd = nextNewline < 0 ? note.text.length : nextNewline;
      const start = Math.max(lineStart, offset - 100);
      const end = Math.min(lineEnd, start + 250);
      hits.push({ path: note.path, offset, snippet: note.text.slice(start, end), snippetOffset: start });
    }
    return freeze({ ...base, status: "ok", hits, truncated });
  }
  const listing = freeze([...files.values()]);
  return freeze({ info, listFiles: () => listing, readNote, search, resolve,
    outgoing: (path: string) => graph(path, true), backlinks: (path: string) => graph(path, false) });
}
export type WikiSnapshot = ReturnType<typeof createWikiSnapshot>;
