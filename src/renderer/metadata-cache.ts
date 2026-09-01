import { parse as parseYaml } from "yaml";
import { Events } from "./events";
import { Vault } from "./vault";
import { projectCanvasFileLinks } from "./canvas/canvas-data";
import { recordMeasure, withPerfMark } from "./perf-instrumentation";
import {
  CachedMetadata,
  HeadingCache,
  LinkCache,
  ListItemCache,
  Loc,
  Pos,
  SectionCache,
  TFile,
  TagCache,
  pathName,
  splitExt,
} from "./types";
import {
  DEFAULT_METADATA_SCAN_CAP_BYTES,
  isPersistedMetadataIndexSnapshot,
  METADATA_SNAPSHOT_CHUNK_MAX_BYTES,
  METADATA_SNAPSHOT_CHUNK_MAX_ENTRIES,
  resolveMetadataScanCapBytes,
  type PersistedMetadataIndexEntry,
  type PersistedMetadataIndexSnapshot,
} from "../indexer/metadata-indexer";

const WIKILINK_RE = /(!)?\[\[([^\[\]\n]+)\]\]/g;
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\/-]*[\p{L}_\/-][\p{L}\p{N}_\/-]*)/gu;
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?$/;
// A list item: leading indent, a bullet (-,*,+) or ordered marker (1. / 1)),
// then optionally a `[x]` checkbox, then the content. Group 1 = indent,
// group 2 = the checkbox character (present only for tasks).
const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])[ \t]+(?:\[(.)\][ \t]?)?/;
// Trailing block id, e.g. `- [ ] do it ^abc-123`.
const BLOCK_ID_RE = /[ \t]\^([A-Za-z0-9-]+)\s*$/;

/**
 * Yields to the event loop via a MessageChannel round-trip rather than
 * setTimeout — setTimeout(0) gets clamped to a 4ms floor after a few levels
 * of nesting, which would add real overhead across the ~500 yields needed
 * to index an 8,000-file vault. MessageChannel dispatches as a fresh
 * macrotask with no such clamp, and — unlike requestAnimationFrame — is a
 * real global under plain Node (no jsdom needed), so it's usable as-is
 * under vitest (environment: "node", confirmed in vitest.config.mts).
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(undefined);
  });
}

/** Concurrent IPC reads in flight during indexing. Tuned to hide IPC
 * round-trip latency without overwhelming Node's libuv threadpool (default
 * size 4, which `fsp.readFile` in the main process runs on) — higher just
 * queues extra requests behind the same 4 threadpool slots while making
 * each batch's synchronous-parse jank window bigger. */
export const INDEX_CONCURRENCY = 16;
export const METADATA_CACHE_SCHEMA_VERSION = 1;

function toLinkRecord(counts: Map<string, number>): Record<string, number> {
  const record: Record<string, number> = Object.create(null);
  for (const [path, count] of counts) record[path] = count;
  return record;
}

/**
 * Conservative size estimate for one persisted entry, used only to decide
 * batch boundaries for the chunked renderer->main cache handoff (see
 * `persistCache`). UTF-16 code-unit count from `JSON.stringify` is a close
 * enough proxy for serialized byte size for this purpose — it only needs to
 * keep chunks in the right ballpark, not be byte-exact — and, unlike
 * `Buffer.byteLength` (which `chunkMetadataSnapshot` uses on the main-process
 * side), has no dependency on `Buffer` being a global. The desktop renderer
 * happens to have it (nodeIntegration), but this module is also bundled for
 * the mobile renderer, which isn't guaranteed to.
 *
 * A circular `frontmatter` (see `safeStringify`'s doc comment in
 * `metadata-cache-store.ts`) makes `JSON.stringify` throw; the main-process
 * write path already serializes each entry safely and in isolation, so here
 * we only need some bounded fallback estimate that still lets batching
 * proceed sensibly.
 */
function estimateEntryBytes(entry: PersistedMetadataEntry): number {
  try {
    return JSON.stringify(entry).length;
  } catch {
    return METADATA_SNAPSHOT_CHUNK_MAX_BYTES;
  }
}

// The persisted-cache entry/snapshot shape and its validator are imported
// from ../indexer/metadata-indexer (PersistedMetadataIndexEntry,
// PersistedMetadataIndexSnapshot, isPersistedMetadataIndexSnapshot) rather
// than duplicated here. The old locally-duplicated version required a
// `content` field that the indexer's real disk writes never populated —
// silently rejecting every persisted cache the indexer actually wrote.
type PersistedMetadataEntry = PersistedMetadataIndexEntry;
type PersistedMetadataCache = PersistedMetadataIndexSnapshot;

/**
 * Runs `fn` over `items` in fixed-size concurrent chunks of `concurrency`,
 * awaiting each chunk fully before starting the next and yielding to the
 * event loop between chunks (never after the last one). Chunked rather than
 * a sliding pool so there's a clear batch boundary to yield at.
 */
export async function processInBatches<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
  yieldFn: () => Promise<void> = yieldToEventLoop
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.all(batch.map(fn));
    if (i + concurrency < items.length) await yieldFn();
  }
}

/**
 * Builds a sorted array of line-start character offsets for `text`:
 * `lineStarts[i]` is the offset of the first character of (0-indexed) line
 * `i`. `lineStarts[0]` is always `0`. A single O(n) forward scan — computed
 * once per file so `offsetToLoc` can binary-search it instead of re-scanning
 * the document from offset 0 on every call (which made parsing a file
 * O(n²) in file size: one re-scan per heading/link/tag/section, each
 * itself O(n)).
 */
export function buildLineStarts(text: string): number[] {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* "\n" */) lineStarts.push(i + 1);
  }
  return lineStarts;
}

/**
 * Resolves a single character `offset` to a `{ line, ch }` position by
 * binary-searching `lineStarts` (see `buildLineStarts`) for the largest
 * line-start offset that is `<= offset` — O(log lines) instead of the O(n)
 * re-scan-from-zero this replaced.
 */
function locFromOffset(lineStarts: number[], offset: number): Pos {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, ch: offset - lineStarts[lo], offset };
}

/**
 * Converts a `[start, end)` character-offset span into a `Loc`. `lineStarts`
 * must come from `buildLineStarts(text)` for the same `text` these offsets
 * were taken from — see that function's comment for why this is precomputed
 * once per file rather than re-derived on every call.
 */
export function offsetToLoc(lineStarts: number[], start: number, end: number): Loc {
  return {
    start: locFromOffset(lineStarts, start),
    end: locFromOffset(lineStarts, end),
  };
}

/** Strip code fences and inline code so links/tags inside code are ignored. */
function maskCode(text: string): string {
  let masked = text.replace(/```[\s\S]*?(```|$)/g, (m) => m.replace(/[^\n]/g, " "));
  masked = masked.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
  return masked;
}

/** Blank out `[[wikilink]]`/`![[embed]]` spans (length-preserving) so unlinked-mention search skips text that's already a link. */
function maskWikilinks(text: string): string {
  return text.replace(/!?\[\[[^\[\]\n]+\]\]/g, (m) => " ".repeat(m.length));
}

/**
 * Compact search keys for the unlinked-mention candidate index. Word tokens
 * eliminate substring false candidates ("Plan" does not select "Planner").
 * Punctuation-only runs use up-to-three-character grams so names such as
 * "C++" and aliases made entirely of punctuation remain discoverable.
 *
 * The utility process computes and persists these keys. The renderer only
 * hydrates their reverse map in short, yielding slices after initial layout.
 */
export function extractMentionIndexKeys(text: string): string[] {
  const normalized = [...maskWikilinks(maskCode(text))]
    .map((char) => char.toUpperCase().toLowerCase())
    .join("");
  const keys = new Set<string>();
  for (const token of normalized.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu) ?? []) {
    if (/^[\p{L}\p{N}_]/u.test(token)) {
      keys.add(`w:${token}`);
      continue;
    }
    for (let width = 1; width <= Math.min(3, token.length); width++) {
      for (let i = 0; i <= token.length - width; i++) keys.add(`p:${token.slice(i, i + width)}`);
    }
  }
  return [...keys];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if `err` is a benign "file no longer exists" race — e.g. a file
 * deleted between vault enumeration and read, or between a `create`/`modify`
 * event and the follow-up read. This is expected on large vaults and
 * shouldn't spam the console.
 *
 * Deliberately checks `err.message` rather than `err.code === "ENOENT"`:
 * `vault.cachedRead` goes through `ipcRenderer.invoke`, and Electron's IPC
 * only forwards the thrown error's `message` across the main/renderer
 * boundary — custom properties like `.code` are dropped. Matching on `.code`
 * would never fire in production even though it looks correct in a
 * same-process unit test.
 */
function isBenignEnoent(err: unknown): boolean {
  return (err as Error)?.message?.includes("ENOENT") ?? false;
}

export interface UnlinkedMention {
  /** 0-based line number within the file. */
  line: number;
  /** Trimmed text of that line, for display as context. */
  snippet: string;
  /** Occurrences of any candidate name on this line. */
  count: number;
}

/**
 * Find whole-word, case-insensitive occurrences of any of `names` in `text`
 * that are NOT already inside a `[[wikilink]]`/`![[embed]]` or a code span —
 * Obsidian's "unlinked mentions" concept. One result per matching line
 * (occurrences on the same line are grouped into a single entry with a
 * count). Does not consider markdown-style `[text](path)` links, only
 * wikilinks — matching `parseMetadata`'s link syntax support.
 */
export function findUnlinkedMentions(text: string, names: string[]): UnlinkedMention[] {
  const candidates = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (!candidates.length) return [];
  const pattern = candidates
    .sort((a, b) => b.length - a.length) // longest first so aliases don't shadow a longer overlapping name
    .map(escapeRegExp)
    .join("|");
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`, "giu");
  // Both masking passes preserve string length/newlines, so line N of the
  // masked text lines up exactly with line N of the original.
  const maskedLines = maskWikilinks(maskCode(text)).split("\n");
  const originalLines = text.split("\n");
  const out: UnlinkedMention[] = [];
  for (let i = 0; i < maskedLines.length; i++) {
    const matches = maskedLines[i].match(re);
    if (matches?.length) out.push({ line: i, snippet: originalLines[i].trim(), count: matches.length });
  }
  return out;
}

/**
 * Parses frontmatter and (unless `body.length` exceeds `maxBodyBytesForScan`)
 * the body's wikilinks, embeds, in-body tags, headings, sections, and list
 * items into Obsidian-shaped `CachedMetadata`.
 *
 * `maxBodyBytesForScan` defaults to `DEFAULT_METADATA_SCAN_CAP_BYTES` so
 * every existing call site keeps working unchanged; callers that have a
 * resolved per-vault setting (see `resolveMetadataScanCapBytes`) should pass
 * it explicitly rather than relying on the default — see `MetadataCache`'s
 * `scanCapBytes` field and `indexer-process.ts`'s module-level `scanCapBytes`
 * for the two production call paths that do.
 */
export function parseMetadata(
  text: string,
  maxBodyBytesForScan: number = DEFAULT_METADATA_SCAN_CAP_BYTES
): CachedMetadata {
  const meta: CachedMetadata = {
    // Left undefined (key absent) unless real frontmatter is parsed below —
    // matches Obsidian, whose plugins guard on `frontmatter !== undefined`.
    frontmatterEndOffset: 0,
    links: [],
    embeds: [],
    tags: [],
    headings: [],
    aliases: [],
  };

  // Precomputed once per file (O(n)) so every offsetToLoc call below is an
  // O(log lines) binary search instead of an O(n) re-scan from offset 0 —
  // see offsetToLoc's comment for why this matters.
  const lineStarts = buildLineStarts(text);

  let body = text;
  let bodyOffset = 0;
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (fmMatch) {
    try {
      const fm = parseYaml(fmMatch[1]);
      if (fm && typeof fm === "object" && !Array.isArray(fm)) {
        meta.frontmatter = fm as Record<string, unknown>;
        meta.frontmatterEndOffset = fmMatch[0].length;
        bodyOffset = fmMatch[0].length;
        body = text.slice(bodyOffset);
      }
    } catch {
      // Malformed YAML: treat as body text.
    }
  }

  if (meta.frontmatter) {
    const fmAliases = meta.frontmatter["aliases"] ?? meta.frontmatter["alias"];
    if (Array.isArray(fmAliases)) meta.aliases = fmAliases.map(String);
    else if (typeof fmAliases === "string") meta.aliases = [fmAliases];
    const fmTags = meta.frontmatter["tags"] ?? meta.frontmatter["tag"];
    const tagList = Array.isArray(fmTags)
      ? fmTags.map(String)
      : typeof fmTags === "string"
        ? fmTags.split(/[,\s]+/)
        : [];
    for (const t of tagList) {
      const tag = t.replace(/^#/, "").trim();
      if (tag)
        meta.tags.push({
          tag,
          position: { start: { line: 0, ch: 0, offset: 0 }, end: { line: 0, ch: 0, offset: 0 } },
        });
    }
  }

  // A very large body (rare, but real: AI session transcripts and similar
  // pasted logs can run into the megabytes) makes the exhaustive position-
  // span extraction below — wikilinks, embeds, in-body tags, headings,
  // sections, list items — expensive enough in both CPU and allocated
  // metadata to OOM a vault with many such files (see
  // DEFAULT_METADATA_SCAN_CAP_BYTES's comment for the incident this guards
  // against). Bail out here with just the frontmatter-derived fields
  // already populated above (frontmatter itself, aliases, tags) — those are
  // cheap and unaffected by body size. `meta.listItems`/`meta.sections` are
  // deliberately left unset (not even the "yaml" section for frontmatter),
  // matching this function's normal "present only when computed" contract.
  if (body.length > maxBodyBytesForScan) return meta;

  const masked = maskCode(body);

  for (const m of masked.matchAll(WIKILINK_RE)) {
    const isEmbed = m[1] === "!";
    const inner = m[2];
    const pipe = inner.indexOf("|");
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const display = pipe === -1 ? target : inner.slice(pipe + 1).trim();
    if (!target) continue;
    const start = bodyOffset + m.index!;
    const link: LinkCache = {
      link: target,
      displayText: display,
      position: offsetToLoc(lineStarts, start, start + m[0].length),
      isEmbed,
    };
    (isEmbed ? meta.embeds : meta.links).push(link);
  }

  for (const m of masked.matchAll(TAG_RE)) {
    const tag = m[2];
    if (/^\d+$/.test(tag)) continue; // tags need a non-numeric character
    const start = bodyOffset + m.index! + m[1].length;
    meta.tags.push({ tag, position: offsetToLoc(lineStarts, start, start + tag.length + 1) });
  }

  let offset = bodyOffset;
  let inFence = false;
  const listItems: ListItemCache[] = [];
  const sections: SectionCache[] = [];
  // Ancestor stack for resolving list nesting by indentation: each entry is a
  // still-open ancestor item's (indent width, absolute line). A new item's
  // parent is the nearest shallower ancestor; a shallower/non-list line pops
  // deeper entries.
  const stack: { indent: number; line: number }[] = [];
  // The block section currently being accumulated (a maximal run of adjacent
  // same-type lines). Flushed on a blank line, a type change, or EOF.
  let cur: { type: string; start: number; end: number } | null = null;
  const flush = () => {
    if (cur) {
      sections.push({ type: cur.type, position: offsetToLoc(lineStarts, cur.start, cur.end) });
      cur = null;
    }
  };

  // Frontmatter is its own "yaml" section, matching Obsidian.
  if (meta.frontmatter && meta.frontmatterEndOffset > 0) {
    sections.push({
      type: "yaml",
      position: offsetToLoc(lineStarts, 0, Math.max(0, meta.frontmatterEndOffset - 1)),
    });
  }

  for (const line of body.split("\n")) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const isFence = /^(\s*)(```|~~~)/.test(line);

    if (inFence) {
      // Inside a fenced code block: everything (incl. the closing fence line)
      // belongs to the "code" section.
      if (cur) cur.end = lineEnd;
      if (isFence) {
        inFence = false;
        flush();
      }
    } else if (isFence) {
      flush();
      stack.length = 0;
      inFence = true;
      cur = { type: "code", start: lineStart, end: lineEnd };
    } else if (line.trim() === "") {
      // Blank line ends the current block/section and any list context.
      flush();
      stack.length = 0;
    } else {
      const h = line.match(HEADING_RE);
      const li = h ? null : line.match(LIST_ITEM_RE);
      const type = h ? "heading" : li ? "list" : "paragraph";

      if (type === "heading") {
        flush();
        stack.length = 0;
        meta.headings.push({
          heading: h![2].trim(),
          level: h![1].length,
          position: offsetToLoc(lineStarts, lineStart, lineEnd),
        });
        sections.push({ type: "heading", position: offsetToLoc(lineStarts, lineStart, lineEnd) });
      } else {
        // Extend the current same-type section, or start a new one.
        if (cur && cur.type === type) cur.end = lineEnd;
        else {
          flush();
          cur = { type, start: lineStart, end: lineEnd };
        }

        if (type === "list") {
          const indent = li![1].length;
          const pos = offsetToLoc(lineStarts, lineStart, lineEnd);
          const lineNo = pos.start.line;
          // Discard ancestors at this indent or deeper — they can't be parents.
          while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
          const parent = stack.length ? stack[stack.length - 1].line : -1 - lineNo;
          const item: ListItemCache = { position: pos, parent };
          // li[2] is the checkbox char (only for `[x]`-style task items).
          if (li![2] !== undefined) item.task = li![2];
          const blockId = line.match(BLOCK_ID_RE);
          if (blockId) item.id = blockId[1];
          listItems.push(item);
          stack.push({ indent, line: lineNo });
        } else {
          // A paragraph line ends any list nesting context.
          stack.length = 0;
        }
      }
    }
    offset += line.length + 1;
  }
  flush();

  // Obsidian-faithful: present only when the note actually has content.
  if (listItems.length) meta.listItems = listItems;
  if (sections.length) meta.sections = sections;

  return meta;
}

/** Lowercased basename + full-name keys a file path contributes to `byBasename`. */
function nameKeysFor(path: string): { basenameKey: string; nameKey: string } {
  const name = pathName(path);
  const { basename } = splitExt(name);
  return { basenameKey: basename.toLowerCase(), nameKey: name.toLowerCase() };
}

/** All lowercased name-index keys a present file provides: basename, full name, and aliases. */
function providedKeys(path: string, aliases: string[]): Set<string> {
  const { basenameKey, nameKey } = nameKeysFor(path);
  const keys = new Set<string>([basenameKey, nameKey]);
  for (const a of aliases) keys.add(a.toLowerCase());
  return keys;
}

function isMdPath(path: string): boolean {
  return splitExt(pathName(path)).extension === "md";
}

function isCanvasPath(path: string): boolean {
  return splitExt(pathName(path)).extension === "canvas";
}

function isMetadataSourcePath(path: string): boolean {
  return isMdPath(path) || isCanvasPath(path);
}

function parseCanvasLinkMetadata(source: string): { metadata: CachedMetadata; contexts: string[] } {
  const projected = projectCanvasFileLinks(source) ?? [];
  let offset = 0;
  const links = projected.map(({ link, context }, line) => {
    const start = { line, ch: 0, offset };
    offset += context.length;
    const end = { line, ch: context.length, offset };
    offset += 1;
    return { link, displayText: link, position: { start, end }, isEmbed: false };
  });
  return {
    metadata: {
      frontmatterEndOffset: 0,
      links,
      embeds: [],
      tags: [],
      headings: [],
      aliases: [],
    },
    contexts: projected.map(({ context }) => context),
  };
}

/** Push `value` into the string[] at `key`, keeping the list de-duplicated and path-sorted. */
function pushSorted(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) ?? [];
  if (!list.includes(value)) {
    list.push(value);
    list.sort();
  }
  map.set(key, list);
}

/** Remove `value` from the string[] at `key`, dropping the key entirely once empty. */
function pullValue(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (!list) return;
  const filtered = list.filter((v) => v !== value);
  if (filtered.length) map.set(key, filtered);
  else map.delete(key);
}

function addToSet(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function removeFromSet(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(value);
  if (set.size === 0) map.delete(key);
}

/** Per-file operation accumulated during a burst: whether the path existed before the burst and whether it's present after it. */
interface DirtyOp {
  existedBefore: boolean;
  present: boolean;
}

/**
 * Vault-wide metadata index. Parses every markdown file, resolves links to
 * files, and maintains backlink/tag indices. Public events mirror Obsidian's
 * changed/deleted/resolve/resolved metadata lifecycle.
 *
 * Cold start (`initialize()`) does one batched full pass. Per-edit vault
 * events (create/modify/delete/rename) are coalesced into a dirty set and
 * flushed ONCE per microtask burst via an incremental pass that touches only
 * the minimal set of affected files — never the whole vault — so a sync/
 * git-pull/bulk-rename burst of N events is O(affected), not O(N × files).
 * By the time each `changed` fires, `resolvedLinks`/`byBasename`/`byAlias`
 * are globally correct (graph + sidebar panes read them wholesale).
 */
export class MetadataCache extends Events {
  private cache = new Map<string, CachedMetadata>();
  /** Readable synthetic lines paired with Canvas file-card LinkCache entries. */
  private canvasLinkContexts = new Map<string, string[]>();
  /**
   * Memoized `getUnlinkedMentions` results, keyed by target file path.
   * `"resolved"` fires as the unconditional last step of every mutation path
   * (flush/initialize/background snapshot/renderer fallback, including
   * renames), so clearing the whole map on `"resolved"` is a complete
   * invalidation signal — no need for separate `"changed"`/`"deleted"`
   * listeners or per-entry version tracking.
   */
  private unlinkedMentionsCache = new Map<string, { source: TFile; mentions: UnlinkedMention[] }[]>();
  /** Compact token/punctuation key -> Markdown source paths that contain it. */
  private mentionSourcesByKey = new Map<string, Set<string>>();
  /** Authoritative per-file keys, persisted and computed by the utility process. */
  private mentionKeysBySource = new Map<string, string[]>();
  private mentionIndexReady = false;
  private mentionIndexGeneration = 0;
  /** basename/name (lowercase) -> file paths, path-sorted */
  private byBasename = new Map<string, string[]>();
  /** alias (lowercase) -> file paths, path-sorted */
  private byAlias = new Map<string, string[]>();
  /** Public Obsidian-compatible source path -> target path -> count records. */
  resolvedLinks: Record<string, Record<string, number>> = Object.create(null);
  unresolvedLinks: Record<string, Record<string, number>> = Object.create(null);
  /** Collision-safe internal graphs used by Geode's index and backlink code. */
  private resolvedLinkMap = new Map<string, Map<string, number>>();
  private unresolvedLinkMap = new Map<string, Map<string, number>>();
  /** Reverse of resolvedLinks: target path -> source paths that resolve to it. */
  private resolvedBy = new Map<string, Set<string>>();
  /** Reverse of unresolvedLinks keys: lowercased dangling key -> source paths that use it. */
  private unresolvedByKey = new Map<string, Set<string>>();
  initialized = false;

  /** Paths touched in the current burst, flushed once on a microtask. */
  private dirty = new Map<string, DirtyOp>();
  /** Files to fire `changed` for after the flush, keyed by (current) path. */
  private pendingChanged = new Map<string, TFile>();
  /** Deleted files and their best-effort cache snapshot for the public event. */
  private pendingDeleted = new Map<string, { file: TFile; previous: CachedMetadata | null }>();
  private flushScheduled = false;
  /** Parsed entries delivered by the utility process, keyed by dirty path. */
  private workerEntries = new Map<string, PersistedMetadataEntry>();
  private backgroundIndexerActive = false;
  private backgroundSnapshot: PersistedMetadataCache | null = null;
  private snapshotSequence = 0;
  private snapshotReceiving = false;
  private deferredIndexerMessages: any[] = [];
  private backgroundRefreshRunning = false;
  private backgroundRefreshPending = false;
  private backgroundUnavailable = false;
  /** Why `backgroundUnavailable` was set — surfaced to diagnostic.log when `applyRendererFallback` runs. */
  private backgroundUnavailableReason: string | null = null;
  private backgroundTask: Promise<void> = Promise.resolve();
  private stopIndexerMessages: (() => void) | null = null;
  /**
   * The renderer-side scan cap passed to every `parseMetadata` call this
   * class makes (flush/initialize/background-snapshot-fill/renderer-
   * fallback). A field rather than a module-level global so it stays
   * explicit and per-instance — App calls `setScanCapBytes` once per vault
   * open/switch, right after loading that vault's `.geode/app.json`
   * (`AppSettings.metadataScanCapBytes`) and before `initialize()`.
   */
  private scanCapBytes: number = DEFAULT_METADATA_SCAN_CAP_BYTES;

  /** Update the configured scan cap (see `resolveMetadataScanCapBytes`); clamps/validates `bytes`. */
  setScanCapBytes(bytes: number): void {
    this.scanCapBytes = resolveMetadataScanCapBytes(bytes);
  }

  private scheduleBackground(task: () => Promise<void>): void {
    this.backgroundTask = this.backgroundTask.then(task).catch((error) => {
      console.error("Background metadata refresh failed", error);
    });
  }

  /** Await currently queued background metadata work (primarily for lifecycle tests). */
  waitForBackgroundIdle(): Promise<void> {
    return this.backgroundTask;
  }

  private async loadPersistedCache(): Promise<PersistedMetadataCache | null> {
    try {
      const api = typeof window === "undefined" ? undefined : window.geode;
      if (!api?.readMetadataCache) return null;
      const value = await api.readMetadataCache();
      return isPersistedMetadataIndexSnapshot(value) ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Persist the current in-memory cache for every markdown file the vault
   * knows about right now.
   *
   * On hosts that support it (Electron desktop — see `upsertMetadataCache
   * Entries`/`pruneMetadataCache` in `preload.ts`), this streams files into
   * bounded batches (same size limits the utility process's own outbound
   * snapshot uses — `METADATA_SNAPSHOT_CHUNK_MAX_*`) and upserts each batch
   * as soon as it's full, discarding it before building the next. This used
   * to build one `entries` object covering the ENTIRE vault, then hand it to
   * a single `writeMetadataCache` IPC call — for a vault with gigabytes of
   * metadata (many files, or even a few pathologically large ones) that
   * meant a full-vault-sized duplicate living in the renderer AND a second
   * full-vault-sized copy materializing in the main process the instant the
   * structured-clone IPC payload arrived, which is what pushed peak memory
   * past the OOM ceiling. Peak memory here is now O(one batch), not O(vault
   * size), on both sides of the IPC boundary — see `pruneMetadataEntries`'s
   * doc comment in `metadata-cache-store.ts` for how the final state stays
   * equivalent to the old atomic replace-all.
   *
   * Hosts that don't implement the chunked methods (mobile/browser, via
   * `createLegacyGeodeFacade` — see `preload.ts`'s `GeodeApi` doc comment)
   * fall back to the original single-shot `writeMetadataCache` call. Those
   * hosts' vaults are small enough that this was never the OOM's mechanism,
   * so preserving the exact old call keeps their behavior (and every
   * pre-existing test for it) unchanged.
   */
  private async persistCache(): Promise<void> {
    try {
      const api = typeof window === "undefined" ? undefined : window.geode;
      if (!api?.writeMetadataCache) return;
      const files = this.vault.getMarkdownFiles();

      if (api.upsertMetadataCacheEntries && api.pruneMetadataCache) {
        const upsertBatch = api.upsertMetadataCacheEntries;
        let batch: Record<string, PersistedMetadataEntry> = {};
        let batchCount = 0;
        let batchBytes = 0;
        const flushBatch = async () => {
          if (!batchCount) return;
          await upsertBatch({ schemaVersion: METADATA_CACHE_SCHEMA_VERSION, entries: batch });
          batch = {};
          batchCount = 0;
          batchBytes = 0;
        };

        for (const file of files) {
          const metadata = this.cache.get(file.path);
          if (!metadata) continue;
          const entry: PersistedMetadataEntry = {
            mtimeMs: file.mtime,
            size: file.size,
            metadata,
            mentionKeys: this.mentionKeysBySource.get(file.path),
          };
          const entryBytes = estimateEntryBytes(entry);
          if (batchCount && (batchCount >= METADATA_SNAPSHOT_CHUNK_MAX_ENTRIES || batchBytes + entryBytes > METADATA_SNAPSHOT_CHUNK_MAX_BYTES)) {
            await flushBatch();
          }
          batch[file.path] = entry;
          batchCount += 1;
          batchBytes += entryBytes;
        }
        await flushBatch();

        // Drop rows for files that no longer exist — the counterpart to the
        // old replace-all's implicit "anything not in this snapshot is gone".
        await api.pruneMetadataCache(files.map((file) => file.path));
        return;
      }

      // Legacy single-shot fallback (see doc comment above).
      const entries: Record<string, PersistedMetadataEntry> = {};
      for (const file of files) {
        const metadata = this.cache.get(file.path);
        if (metadata) {
          entries[file.path] = {
            mtimeMs: file.mtime,
            size: file.size,
            metadata,
            mentionKeys: this.mentionKeysBySource.get(file.path),
          };
        }
      }
      await api.writeMetadataCache({ schemaVersion: METADATA_CACHE_SCHEMA_VERSION, entries });
    } catch (error) {
      console.error("Failed to persist metadata cache", error);
    }
  }

  private removeMentionSourceFromReverseIndex(path: string, keys: string[]): void {
    for (const key of keys) {
      const sources = this.mentionSourcesByKey.get(key);
      sources?.delete(path);
      if (sources?.size === 0) this.mentionSourcesByKey.delete(key);
    }
  }

  private addMentionSourceToReverseIndex(path: string, keys: string[]): void {
    for (const key of keys) {
      let sources = this.mentionSourcesByKey.get(key);
      if (!sources) this.mentionSourcesByKey.set(key, sources = new Set());
      sources.add(path);
    }
  }

  private setMentionSourceKeys(path: string, keys: string[] | undefined): void {
    const previous = this.mentionKeysBySource.get(path) ?? [];
    if (this.mentionIndexReady) this.removeMentionSourceFromReverseIndex(path, previous);
    if (keys && isMdPath(path)) this.mentionKeysBySource.set(path, keys);
    else this.mentionKeysBySource.delete(path);
    if (this.mentionIndexReady && keys && isMdPath(path)) this.addMentionSourceToReverseIndex(path, keys);
    this.mentionIndexGeneration += 1;
  }

  /**
   * Build the renderer's reverse map in <=8ms slices. A vault mutation that
   * lands while a slice is yielded invalidates the local build and restarts
   * from the current authoritative per-file keys, preventing stale entries.
   */
  private async rebuildMentionIndex(): Promise<void> {
    this.mentionIndexReady = false;
    do {
      const generation = this.mentionIndexGeneration;
      const next = new Map<string, Set<string>>();
      let sliceStarted = performance.now();
      let keysSinceYield = 0;
      for (const [path, keys] of this.mentionKeysBySource) {
        for (const key of keys) {
          let sources = next.get(key);
          if (!sources) next.set(key, sources = new Set());
          sources.add(path);
          keysSinceYield += 1;
          if (keysSinceYield >= 1_000 ||
              (keysSinceYield % 128 === 0 && performance.now() - sliceStarted >= 8)) {
            await yieldToEventLoop();
            sliceStarted = performance.now();
            keysSinceYield = 0;
          }
        }
      }
      if (generation !== this.mentionIndexGeneration) continue;
      this.mentionSourcesByKey = next;
      this.mentionIndexReady = true;
      if (this.initialized) this.trigger("resolved");
      return;
    } while (true);
  }

  constructor(private vault: Vault) {
    super();
    vault.on("create", (f: TFile) => this.enqueue(f, false, true, !(this.backgroundIndexerActive && f?.extension === "md")));
    vault.on("modify", (f: TFile) => {
      // Markdown and Canvas are renderer metadata sources. Other file
      // modifies are content-only with unchanged names and remain ignored.
      if (f?.kind === "file" && (f.extension === "md" || f.extension === "canvas")) {
        this.enqueue(f, true, true, f.extension === "canvas" || !this.backgroundIndexerActive);
      }
    });
    vault.on("delete", (f: TFile) => this.enqueue(f, true, false, !(this.backgroundIndexerActive && f?.extension === "md")));
    vault.on("rename", (f: TFile, oldPath: string) => this.enqueueRename(f, oldPath));
    // See unlinkedMentionsCache's doc comment: "resolved" alone is sufficient invalidation.
    this.on("resolved", () => this.unlinkedMentionsCache.clear());
    const host = (vault as Vault).host?.metadataIndex;
    if (host) {
      this.stopIndexerMessages = host.onMessage((message) => this.onIndexerMessage(message));
    } else {
      const stop = typeof window === "undefined"
        ? undefined
        : window.geode?.onMetadataIndexerMessage?.((message) => this.onIndexerMessage(message));
      if (typeof stop === "function") this.stopIndexerMessages = stop as () => void;
    }
  }

  dispose(): void {
    this.stopIndexerMessages?.();
    this.stopIndexerMessages = null;
  }

  private onIndexerMessage(message: any): void {
    if (message?.type === "performance") {
      recordMeasure(message.operation, message.duration);
      return;
    }
    if (message?.type === "unavailable") {
      this.backgroundIndexerActive = false;
      if (this.dirty.size) this.scheduleFlush();
      return;
    }
    if (message?.type === "snapshot-start") {
      this.backgroundSnapshot = { schemaVersion: message.schemaVersion, entries: {} };
      this.snapshotSequence = 0;
      this.snapshotReceiving = true;
      return;
    }
    if (message?.type === "snapshot-chunk") {
      if (!this.snapshotReceiving || message.sequence !== this.snapshotSequence || !message.entries) {
        this.backgroundSnapshot = null;
        this.snapshotReceiving = false;
        return;
      }
      Object.assign(this.backgroundSnapshot!.entries, message.entries);
      this.snapshotSequence += 1;
      return;
    }
    if (message?.type === "snapshot-complete") {
      if (message.totalChunks !== this.snapshotSequence) this.backgroundSnapshot = null;
      this.snapshotReceiving = false;
      const deferred = this.deferredIndexerMessages.splice(0);
      for (const item of deferred) this.onIndexerMessage(item);
      if (this.initialized) this.scheduleBackground(() => this.applyBackgroundSnapshot());
      else this.backgroundRefreshPending = true;
      return;
    }
    if (this.snapshotReceiving && message?.type === "delta") {
      this.deferredIndexerMessages.push(message);
      return;
    }
    if (message?.type !== "delta") return;
    if (message.entry) {
      this.workerEntries.set(message.path, message.entry);
    }
    // The raw vault event normally arrives first and records the public
    // changed-event payload. Be defensive if a platform delivers the worker
    // message first: the next raw event will schedule the same path.
    if (this.dirty.has(message.path)) this.scheduleFlush();
  }

  /** Record a single-path create/modify/delete event and schedule a flush. */
  private enqueue(f: TFile, existedBefore: boolean, present: boolean, schedule = true): void {
    // Folders carry no metadata and never appear in the name index; their
    // descendant files fire their own file events (see Vault.rename), so
    // folder events are index no-ops.
    if (!f || f.kind !== "file") return;
    const cur = this.dirty.get(f.path);
    if (cur) cur.present = present;
    else this.dirty.set(f.path, { existedBefore, present });
    if (f.extension === "md") {
      if (present) this.pendingChanged.set(f.path, f);
      else {
        this.pendingChanged.delete(f.path);
        this.pendingDeleted.set(f.path, { file: f, previous: this.cache.get(f.path) ?? null });
      }
    }
    if (schedule) this.scheduleFlush();
  }

  /** Record a rename as a delete of the old path + a create of the new path. */
  private enqueueRename(f: TFile, oldPath: string): void {
    if (!f || f.kind !== "file") return;
    const old = this.dirty.get(oldPath);
    if (old) old.present = false;
    else this.dirty.set(oldPath, { existedBefore: true, present: false });
    const nw = this.dirty.get(f.path);
    if (nw) nw.present = true;
    else this.dirty.set(f.path, { existedBefore: false, present: true });
    // Obsidian explicitly does not emit MetadataCache `changed` on rename.
    this.pendingChanged.delete(oldPath);
    this.pendingChanged.delete(f.path);
    this.pendingDeleted.delete(oldPath);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => void this.flush());
  }

  /**
   * Apply one incremental pass for the whole burst, then fire `changed` per
   * changed file. Ordering within the pass matters: the name index is brought
   * fully up to date BEFORE any link resolution, so `getFirstLinkpathDest`
   * sees current names.
   */
  private async flush(): Promise<void> {
    this.flushScheduled = false;
    const dirty = this.dirty;
    this.dirty = new Map();
    const pendingChanged = this.pendingChanged;
    this.pendingChanged = new Map();
    const pendingDeleted = this.pendingDeleted;
    this.pendingDeleted = new Map();
    if (dirty.size === 0) return;

    // Paths whose content read failed this flush — excluded from the index
    // update AND from `changed` firing (a read failure is a no-op, matching
    // the pre-incremental indexFile()'s early return on error).
    const failed = new Set<string>();

    await withPerfMark("metadata-renderer-apply-resolve", async () => {
      // Phase 1 — read + parse every present renderer metadata source.
      const newMeta = new Map<string, CachedMetadata>();
      const newMentionKeys = new Map<string, string[]>();
      const newCanvasContexts = new Map<string, string[]>();
      const toRead: string[] = [];
      for (const [path, op] of dirty) if (op.present && isMetadataSourcePath(path)) toRead.push(path);
      await processInBatches(toRead, INDEX_CONCURRENCY, async (path) => {
        const file = this.vault.getFileByPath(path);
        if (!file) {
          failed.add(path);
          return;
        }
        try {
          const fromWorker = isMdPath(path) ? this.workerEntries.get(path) : undefined;
          if (fromWorker) {
            newMeta.set(path, fromWorker.metadata);
            // mentionKeys is always populated by current indexer writes; the
            // `?? []` guard is only defensive typing, not a real fallback path.
            newMentionKeys.set(path, fromWorker.mentionKeys ?? []);
            this.workerEntries.delete(path);
          } else if (isCanvasPath(path)) {
            const parsed = parseCanvasLinkMetadata(await this.vault.cachedRead(file));
            newMeta.set(path, parsed.metadata);
            newCanvasContexts.set(path, parsed.contexts);
          } else {
            const content = await this.vault.cachedRead(file);
            newMeta.set(path, parseMetadata(content, this.scanCapBytes));
            newMentionKeys.set(path, extractMentionIndexKeys(content));
          }
        } catch (err) {
          failed.add(path);
          if (!isBenignEnoent(err)) console.error(`Failed to index ${path}`, err);
        }
      });

      // Phase 2 — compute the MINIMAL affected source set from the reverse
      // indices, BEFORE mutating any index (so lookups reflect prior state).
      const affected = new Set<string>();
      for (const [path, op] of dirty) {
        if (failed.has(path)) continue;
        const md = isMdPath(path);
        const metadataSource = isMetadataSourcePath(path);
        const oldAliases = op.existedBefore ? this.cache.get(path)?.aliases ?? [] : [];
        const newAliases = op.present && md ? newMeta.get(path)?.aliases ?? [] : [];
        const oldProvided = op.existedBefore ? providedKeys(path, oldAliases) : new Set<string>();
        const newProvided = op.present ? providedKeys(path, newAliases) : new Set<string>();
        // A removed key (delete, rename-away, or alias removal) means anything
        // that resolved TO this path must re-resolve (sibling or unresolved).
        let removedKey = false;
        for (const k of oldProvided) {
          if (!newProvided.has(k)) {
            removedKey = true;
            break;
          }
        }
        if (removedKey) for (const src of this.resolvedBy.get(path) ?? []) affected.add(src);
        // A newly provided key (create, rename-in, alias addition) can (a)
        // satisfy any source that currently has that key dangling, and (b)
        // STEAL a link from a same-key file that a source currently resolves
        // to, because this path may now win the shortest-path / first-alias
        // tiebreak. Re-resolving the competitor's backlinks is idempotent when
        // this path doesn't actually win, and is still bounded by same-key
        // backlinks rather than the whole vault.
        for (const k of newProvided) {
          if (oldProvided.has(k)) continue;
          for (const src of this.unresolvedByKey.get(k) ?? []) affected.add(src);
          for (const q of this.byBasename.get(k) ?? []) {
            for (const src of this.resolvedBy.get(q) ?? []) affected.add(src);
          }
          for (const q of this.byAlias.get(k) ?? []) {
            for (const src of this.resolvedBy.get(q) ?? []) affected.add(src);
          }
        }
        // A present Markdown/Canvas source's outgoing links must be (re)resolved.
        if (op.present && metadataSource) affected.add(path);
      }

      // Phase 3a — bring the name index + cache fully up to date.
      for (const [path, op] of dirty) {
        if (failed.has(path)) continue;
        const md = isMdPath(path);
        const metadataSource = isMetadataSourcePath(path);
        if (op.existedBefore) {
          const oldAliases = this.cache.get(path)?.aliases ?? [];
          this.removeNameEntries(path, oldAliases);
        }
        if (op.present && metadataSource) {
          const meta = newMeta.get(path);
          if (meta) this.cache.set(path, meta);
        } else {
          this.cache.delete(path);
        }
        this.setMentionSourceKeys(path, op.present && md ? newMentionKeys.get(path) : undefined);
        this.canvasLinkContexts.delete(path);
        if (op.present && isCanvasPath(path)) {
          this.canvasLinkContexts.set(path, newCanvasContexts.get(path) ?? []);
        }
        if (op.present) {
          const newAliases = md ? this.cache.get(path)?.aliases ?? [] : [];
          this.addNameEntries(path, newAliases);
        }
      }

      // Phase 3b — re-resolve the affected sources plus deleted metadata paths
      // (the latter to purge their own forward + reverse entries).
      for (const [path, op] of dirty) {
        if (failed.has(path)) continue;
        if (!op.present && isMetadataSourcePath(path)) affected.add(path);
      }
      for (const src of affected) {
        this.resolveFile(src);
        const file = this.vault.getFileByPath(src);
        if (file?.extension === "md") this.trigger("resolve", file);
      }

    });

    // Fire `changed` once per changed file (skipping reads that failed), so
    // BaseView per-file semantics + the public plugin contract are preserved.
    for (const file of pendingChanged.values()) {
      if (failed.has(file.path)) continue;
      const metadata = this.cache.get(file.path);
      if (metadata) this.trigger("changed", file, this.vault.getCachedContent(file.path) ?? "", metadata);
    }
    for (const { file, previous } of pendingDeleted.values()) this.trigger("deleted", file, previous);
    this.trigger("resolved");
  }

  async initialize(): Promise<void> {
    let attemptedBackground = false;
    let completePersistedMentionIndex = false;
    await withPerfMark("metadata-initialize", async () => {
      const markdownFiles = this.vault.getMarkdownFiles();
      const canvasFiles = this.vault.getFiles().filter((file) => file.extension === "canvas");
      const api = typeof window === "undefined" ? undefined : window.geode;
      attemptedBackground = !!api?.startMetadataIndexer;
      if (attemptedBackground) {
        // Starting the worker must never make the renderer wait for a full
        // vault reconciliation. On endpoint-protected filesystems that can
        // take minutes. Hydrate from the last persisted snapshot below and
        // merge the worker result when snapshot-complete arrives.
        void api?.startMetadataIndexer?.().then((available) => {
          if (available === true) this.backgroundIndexerActive = true;
          else {
            this.backgroundUnavailable = true;
            this.backgroundUnavailableReason = "startMetadataIndexer resolved to a non-true value";
            if (this.initialized) this.scheduleBackground(() => this.applyRendererFallback());
          }
        }).catch((error) => {
          this.backgroundIndexerActive = false;
          this.backgroundUnavailable = true;
          this.backgroundUnavailableReason = `startMetadataIndexer rejected: ${(error as Error)?.message ?? String(error)}`;
          if (this.initialized) this.scheduleBackground(() => this.applyRendererFallback());
        });
      }
      const persisted = await this.loadPersistedCache();
      await withPerfMark("metadata-renderer-apply", async () => {
        this.cache.clear();
        this.canvasLinkContexts.clear();
        this.mentionSourcesByKey.clear();
        this.mentionKeysBySource.clear();
        this.mentionIndexReady = false;
        const toRead: TFile[] = [];
        for (const file of markdownFiles) {
          const entry = persisted?.entries[file.path];
          if (entry && entry.mtimeMs === file.mtime && entry.size === file.size) {
            this.cache.set(file.path, entry.metadata);
            if (entry.mentionKeys) this.setMentionSourceKeys(file.path, entry.mentionKeys);
          } else if (!attemptedBackground) {
            toRead.push(file);
          }
        }
        // Canvas projection is renderer-only and intentionally never enters the
        // utility-process or persisted Markdown cache schema.
        toRead.push(...canvasFiles);
        await processInBatches(toRead, INDEX_CONCURRENCY, async (f) => {
          try {
            const text = await this.vault.cachedRead(f);
            if (f.extension === "canvas") {
              const parsed = parseCanvasLinkMetadata(text);
              this.cache.set(f.path, parsed.metadata);
              this.canvasLinkContexts.set(f.path, parsed.contexts);
            } else {
              this.cache.set(f.path, parseMetadata(text, this.scanCapBytes));
              this.setMentionSourceKeys(f.path, extractMentionIndexKeys(text));
            }
          } catch (err) {
            if (!isBenignEnoent(err)) console.error(`Failed to index ${f.path}`, err);
          }
        });
      });
      completePersistedMentionIndex = this.mentionKeysBySource.size === markdownFiles.length;
      withPerfMark("metadata-renderer-resolve", () => {
        this.rebuildNameIndex();
        this.resolveAll();
      });
      for (const file of markdownFiles) if (this.cache.has(file.path)) this.trigger("resolve", file);
      if (!attemptedBackground) {
        await this.rebuildMentionIndex();
        await this.persistCache();
      }
    });
    this.initialized = true;
    this.trigger("resolved");
    if (this.backgroundRefreshPending) this.scheduleBackground(() => this.applyBackgroundSnapshot());
    else if (this.backgroundUnavailable) this.scheduleBackground(() => this.applyRendererFallback());
    else if (attemptedBackground && completePersistedMentionIndex) {
      this.scheduleBackground(() => this.rebuildMentionIndex());
    }
  }

  /**
   * Merge the utility process's authoritative snapshot after initial layout
   * readiness. Work is deliberately chunked so a large work vault cannot turn
   * a slow background reconciliation into one renderer-blocking completion
   * burst. A newer live delta wins over the snapshot entry for the same path.
   */
  private async applyBackgroundSnapshot(): Promise<void> {
    if (this.backgroundRefreshRunning) {
      this.backgroundRefreshPending = true;
      return;
    }
    const snapshot = this.backgroundSnapshot;
    if (!snapshot || snapshot.schemaVersion !== METADATA_CACHE_SCHEMA_VERSION) return;
    this.backgroundRefreshRunning = true;
    this.backgroundRefreshPending = false;
    this.backgroundIndexerActive = true;
    try {
      const currentMarkdown = new Map(this.vault.getMarkdownFiles().map((file) => [file.path, file]));
      this.mentionIndexReady = false;
      this.mentionSourcesByKey.clear();
      for (const path of this.mentionKeysBySource.keys()) {
        if (!currentMarkdown.has(path)) this.setMentionSourceKeys(path, undefined);
      }
      const entries = Object.entries(snapshot.entries);
      await processInBatches(entries, 50, async ([path, snapshotEntry]) => {
        const file = currentMarkdown.get(path);
        if (!file) return;
        const live = this.workerEntries.get(path);
        if (!live && (snapshotEntry.mtimeMs !== file.mtime || snapshotEntry.size !== file.size)) return;
        const entry = live
          ? live
          : snapshotEntry;
        this.cache.set(path, entry.metadata);
        // mentionKeys is always populated by current indexer writes; the
        // `?? []` guard is only defensive typing, not a real fallback path.
        this.setMentionSourceKeys(path, entry.mentionKeys ?? []);
      });
      // Oversized entries are deliberately omitted from utility snapshot IPC.
      // Fill only those missing paths here, one file per yielded batch, so a
      // legacy cache upgrade remains complete without recreating one giant
      // renderer task over the whole vault.
      const missing = [...currentMarkdown.values()].filter((file) =>
        !this.cache.has(file.path) || !this.mentionKeysBySource.has(file.path)
      );
      await processInBatches(missing, 1, async (file) => {
        try {
          const content = await this.vault.cachedRead(file);
          if (!this.cache.has(file.path)) this.cache.set(file.path, parseMetadata(content, this.scanCapBytes));
          this.setMentionSourceKeys(file.path, extractMentionIndexKeys(content));
        } catch (err) {
          if (!isBenignEnoent(err)) console.error(`Failed to index ${file.path}`, err);
        }
      });
      await yieldToEventLoop();
      withPerfMark("metadata-background-resolve", () => {
        this.rebuildNameIndex();
        this.resolveAll();
      });
      const files = [...currentMarkdown.values()].filter((file) => this.cache.has(file.path));
      await processInBatches(files, 50, async (file) => { this.trigger("resolve", file); });
      await this.rebuildMentionIndex();
    } finally {
      this.backgroundRefreshRunning = false;
      if (this.backgroundRefreshPending) this.scheduleBackground(() => this.applyBackgroundSnapshot());
    }
  }

  /**
   * Progressive safety net used only when the utility process is absent.
   *
   * This path used to be completely silent — see the diagnostic report below
   * — which made a real production OOM (a vault whose renderer-side fallback
   * scan + persist ballooned past several GB) invisible until it crashed.
   * Reporting here, rather than only where `backgroundUnavailable` is set,
   * captures the moment the expensive full-vault work actually starts.
   */
  private async applyRendererFallback(): Promise<void> {
    if (!this.backgroundUnavailable) return;
    this.backgroundUnavailable = false;
    const files = this.vault.getMarkdownFiles();
    const reason = this.backgroundUnavailableReason ?? "unknown";
    this.backgroundUnavailableReason = null;
    const api = typeof window === "undefined" ? undefined : window.geode;
    void api?.reportMetadataFallback?.({ reason, fileCount: files.length })?.catch(() => {});
    this.mentionIndexReady = false;
    this.mentionSourcesByKey.clear();
    await processInBatches(files, INDEX_CONCURRENCY, async (file) => {
      try {
        const content = await this.vault.cachedRead(file);
        this.cache.set(file.path, parseMetadata(content, this.scanCapBytes));
        this.setMentionSourceKeys(file.path, extractMentionIndexKeys(content));
      } catch (err) {
        if (!isBenignEnoent(err)) console.error(`Failed to index ${file.path}`, err);
      }
    });
    await yieldToEventLoop();
    this.rebuildNameIndex();
    this.resolveAll();
    await processInBatches(files.filter((file) => this.cache.has(file.path)), 50, async (file) => {
      this.trigger("resolve", file);
    });
    await this.rebuildMentionIndex();
    await this.persistCache();
  }

  /** Add a present file's basename/name (+ alias) keys to the name index. */
  private addNameEntries(path: string, aliases: string[]): void {
    const { basenameKey, nameKey } = nameKeysFor(path);
    pushSorted(this.byBasename, basenameKey, path);
    if (nameKey !== basenameKey) pushSorted(this.byBasename, nameKey, path);
    for (const a of aliases) pushSorted(this.byAlias, a.toLowerCase(), path);
  }

  /** Remove a path's basename/name (+ alias) keys from the name index. */
  private removeNameEntries(path: string, aliases: string[]): void {
    const { basenameKey, nameKey } = nameKeysFor(path);
    pullValue(this.byBasename, basenameKey, path);
    if (nameKey !== basenameKey) pullValue(this.byBasename, nameKey, path);
    for (const a of aliases) pullValue(this.byAlias, a.toLowerCase(), path);
  }

  /**
   * Full rebuild of the name index from scratch. Used by `initialize()` and
   * as the equivalence oracle for the incremental `add`/`removeNameEntries`
   * mutators. Lists are path-sorted so a from-scratch rebuild is byte-for-byte
   * identical to the incrementally maintained index.
   */
  private rebuildNameIndex() {
    this.byBasename.clear();
    this.byAlias.clear();
    for (const f of this.vault.getFiles()) this.addNameEntries(f.path, []);
    for (const [path, meta] of this.cache) {
      for (const alias of meta.aliases) pushSorted(this.byAlias, alias.toLowerCase(), path);
    }
  }

  /**
   * Resolve a link target ("Note", "folder/Note", "Note#Heading") relative to
   * a source path, Obsidian-style: exact vault path first, then shortest
   * basename match.
   */
  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    let target = linkpath.split("#")[0].split("^")[0].trim();
    if (!target) {
      return this.vault.getFileByPath(sourcePath); // [[#Heading]] self-link
    }
    // Exact path (with and without .md)
    const direct =
      this.vault.getFileByPath(target) ?? this.vault.getFileByPath(target + ".md");
    if (direct) return direct;
    // Relative to source folder
    const srcParent = sourcePath.includes("/")
      ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
      : "";
    if (srcParent) {
      const rel =
        this.vault.getFileByPath(`${srcParent}/${target}`) ??
        this.vault.getFileByPath(`${srcParent}/${target}.md`);
      if (rel) return rel;
    }
    // Basename match: shortest path wins
    const candidates = this.byBasename.get(target.toLowerCase());
    if (candidates?.length) {
      const sorted = [...candidates].sort((a, b) => a.length - b.length);
      return this.vault.getFileByPath(sorted[0]);
    }
    const aliasMatch = this.byAlias.get(target.toLowerCase());
    if (aliasMatch?.length) return this.vault.getFileByPath(aliasMatch[0]);
    return null;
  }

  /**
   * From-scratch resolution of every cached file's links, rebuilding both the
   * forward maps (`resolvedLinks`/`unresolvedLinks`) and the reverse indices
   * (`resolvedBy`/`unresolvedByKey`). Used by `initialize()` and as the
   * equivalence oracle for the incremental `resolveFile`.
   */
  private resolveAll() {
    this.resolvedLinkMap.clear();
    this.unresolvedLinkMap.clear();
    this.resolvedLinks = Object.create(null);
    this.unresolvedLinks = Object.create(null);
    this.resolvedBy.clear();
    this.unresolvedByKey.clear();
    for (const [path, meta] of this.cache) {
      const canvasSource = isCanvasPath(path);
      const resolved = new Map<string, number>();
      const unresolved = new Map<string, number>();
      for (const link of [...meta.links, ...meta.embeds]) {
        const dest = this.getFirstLinkpathDest(link.link, path);
        if (dest) {
          if (canvasSource && dest.extension !== "md") continue;
          resolved.set(dest.path, (resolved.get(dest.path) ?? 0) + 1);
        }
        else {
          const key = link.link.split("#")[0].trim();
          if (key && (!canvasSource || isMdPath(key))) {
            unresolved.set(key, (unresolved.get(key) ?? 0) + 1);
          }
        }
      }
      this.resolvedLinkMap.set(path, resolved);
      this.unresolvedLinkMap.set(path, unresolved);
      this.resolvedLinks[path] = toLinkRecord(resolved);
      this.unresolvedLinks[path] = toLinkRecord(unresolved);
      for (const target of resolved.keys()) addToSet(this.resolvedBy, target, path);
      for (const key of unresolved.keys()) addToSet(this.unresolvedByKey, key.toLowerCase(), path);
    }
  }

  /**
   * Incrementally (re)resolve a single source file's outgoing links, keeping
   * the forward maps AND the reverse indices consistent. Resolution semantics
   * are identical to `resolveAll` (same `getFirstLinkpathDest`), only the
   * scope differs. When `path` has no cache entry (a deleted/non-md file) its
   * entries + reverse contributions are simply purged.
   */
  private resolveFile(path: string): void {
    withPerfMark("metadata-resolve-file", () => {
      // Retract this file's previous contributions to the reverse indices.
      const prevResolved = this.resolvedLinkMap.get(path);
      if (prevResolved) {
        for (const target of prevResolved.keys()) removeFromSet(this.resolvedBy, target, path);
      }
      const prevUnresolved = this.unresolvedLinkMap.get(path);
      if (prevUnresolved) {
        for (const key of prevUnresolved.keys()) removeFromSet(this.unresolvedByKey, key.toLowerCase(), path);
      }

      const meta = this.cache.get(path);
      if (!meta) {
        this.resolvedLinkMap.delete(path);
        this.unresolvedLinkMap.delete(path);
        delete this.resolvedLinks[path];
        delete this.unresolvedLinks[path];
        return;
      }

      const resolved = new Map<string, number>();
      const unresolved = new Map<string, number>();
      const canvasSource = isCanvasPath(path);
      for (const link of [...meta.links, ...meta.embeds]) {
        const dest = this.getFirstLinkpathDest(link.link, path);
        if (dest) {
          if (canvasSource && dest.extension !== "md") continue;
          resolved.set(dest.path, (resolved.get(dest.path) ?? 0) + 1);
        }
        else {
          const key = link.link.split("#")[0].trim();
          if (key && (!canvasSource || isMdPath(key))) {
            unresolved.set(key, (unresolved.get(key) ?? 0) + 1);
          }
        }
      }
      this.resolvedLinkMap.set(path, resolved);
      this.unresolvedLinkMap.set(path, unresolved);
      this.resolvedLinks[path] = toLinkRecord(resolved);
      this.unresolvedLinks[path] = toLinkRecord(unresolved);
      for (const target of resolved.keys()) addToSet(this.resolvedBy, target, path);
      for (const key of unresolved.keys()) addToSet(this.unresolvedByKey, key.toLowerCase(), path);
    });
  }

  getFileCache(file: TFile): CachedMetadata | null {
    return this.cache.get(file.path) ?? null;
  }

  getCache(path: string): CachedMetadata | null {
    return this.cache.get(path) ?? null;
  }

  fileToLinktext(file: TFile, _sourcePath: string, omitMdExtension = false): string {
    const duplicateName = this.vault
      .getFiles()
      .some((candidate) => candidate.path !== file.path && candidate.name === file.name);
    const linktext = duplicateName ? file.path : file.name;
    return omitMdExtension && file.extension === "md" ? linktext.slice(0, -3) : linktext;
  }

  /** All files containing links that resolve to `file`. */
  getBacklinks(file: TFile): { source: TFile; count: number }[] {
    const out: { source: TFile; count: number }[] = [];
    for (const [src, targets] of this.resolvedLinkMap) {
      const count = targets.get(file.path);
      if (count) {
        const srcFile = this.vault.getFileByPath(src);
        if (srcFile) out.push({ source: srcFile, count });
      }
    }
    return out.sort((a, b) => a.source.basename.localeCompare(b.source.basename));
  }

  /**
   * Like `getBacklinks`, but each source file also carries a trimmed
   * snippet of the line surrounding each resolved link/embed occurrence,
   * for display as context in the Backlinks pane.
   *
   * Async: content is no longer pre-warmed for every file (the indexer's
   * wire format and persisted cache no longer carry raw content — see the
   * SQLite metadata-store migration), so a source file's text is fetched
   * on demand via `vault.cachedRead()` (a single cheap IPC round trip,
   * cached for subsequent reads). The candidate set here is bounded by
   * `file`'s backlink sources, not the whole vault, so the added await is
   * invisible in practice — this fires on navigation, not per-keystroke.
   */
  async getBacklinksWithContext(
    file: TFile
  ): Promise<{ source: TFile; count: number; snippets: string[] }[]> {
    const out: { source: TFile; count: number; snippets: string[] }[] = [];
    for (const [src, targets] of this.resolvedLinkMap) {
      const count = targets.get(file.path);
      if (!count) continue;
      const srcFile = this.vault.getFileByPath(src);
      if (!srcFile) continue;
      const meta = this.cache.get(src);
      let lines: string[];
      if (srcFile.extension === "canvas") {
        lines = this.canvasLinkContexts.get(src) ?? [];
      } else {
        try {
          lines = (await this.vault.cachedRead(srcFile)).split("\n");
        } catch {
          lines = [];
        }
      }
      const snippets: string[] = [];
      for (const link of [...(meta?.links ?? []), ...(meta?.embeds ?? [])]) {
        if (this.getFirstLinkpathDest(link.link, src)?.path !== file.path) continue;
        const lineText = lines[link.position.start.line]?.trim();
        if (lineText) snippets.push(lineText);
      }
      out.push({ source: srcFile, count, snippets });
    }
    return out.sort((a, b) => a.source.basename.localeCompare(b.source.basename));
  }

  /**
   * Files that mention `file`'s basename or aliases as plain text without
   * an actual `[[wikilink]]` to it — Obsidian's "unlinked mentions".
   *
   * Async for the same reason as `getBacklinksWithContext`: candidate
   * sources' content is fetched on demand via `vault.cachedRead()` rather
   * than assumed pre-warmed. The candidate set is bounded by the mention-key
   * index (not the whole vault), so this stays cheap.
   */
  async getUnlinkedMentions(file: TFile): Promise<{ source: TFile; mentions: UnlinkedMention[] }[]> {
    const cached = this.unlinkedMentionsCache.get(file.path);
    if (cached) return cached;
    // Never fall back to a vault-wide synchronous scan. The Backlinks view
    // exposes an explicit indexing state until the yielding reverse-map
    // hydration completes, then rerenders on the resulting `resolved` event.
    if (!this.mentionIndexReady) return [];

    const names = [file.basename, ...(this.cache.get(file.path)?.aliases ?? [])];
    const candidates = new Set<string>();
    for (const name of names) {
      const keys = extractMentionIndexKeys(name.trim());
      if (!keys.length) continue;
      const sourceSets = keys.map((key) => this.mentionSourcesByKey.get(key) ?? new Set<string>());
      sourceSets.sort((a, b) => a.size - b.size);
      for (const src of sourceSets[0]) {
        if (sourceSets.every((sources) => sources.has(src))) candidates.add(src);
      }
    }

    const out: { source: TFile; mentions: UnlinkedMention[] }[] = [];
    for (const src of candidates) {
      if (src === file.path) continue;
      if (!isMdPath(src)) continue;
      const srcFile = this.vault.getFileByPath(src);
      if (!srcFile) continue;
      let content: string;
      try {
        content = await this.vault.cachedRead(srcFile);
      } catch {
        continue;
      }
      const mentions = findUnlinkedMentions(content, names);
      if (!mentions.length) continue;
      out.push({ source: srcFile, mentions });
    }
    out.sort((a, b) => a.source.basename.localeCompare(b.source.basename));
    this.unlinkedMentionsCache.set(file.path, out);
    return out;
  }

  isUnlinkedMentionsReady(): boolean {
    return this.mentionIndexReady;
  }

  /**
   * Cache-only lookup for `getUnlinkedMentions` — never computes. Returns
   * `undefined` until `getUnlinkedMentions` has been called at least once
   * for this file since the last `"resolved"` invalidation.
   */
  peekUnlinkedMentions(file: TFile): { source: TFile; mentions: UnlinkedMention[] }[] | undefined {
    return this.unlinkedMentionsCache.get(file.path);
  }

  /** tag (no '#') -> usage count, across the whole vault. */
  getAllTags(): Map<string, number> {
    const tags = new Map<string, number>();
    for (const meta of this.cache.values()) {
      for (const t of meta.tags) tags.set(t.tag, (tags.get(t.tag) ?? 0) + 1);
    }
    return tags;
  }

  getHeadings(file: TFile): HeadingCache[] {
    return this.cache.get(file.path)?.headings ?? [];
  }
}
