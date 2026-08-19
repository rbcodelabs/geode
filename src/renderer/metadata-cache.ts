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
  SectionCache,
  TFile,
  TagCache,
  pathName,
  splitExt,
} from "./types";

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

interface PersistedMetadataEntry {
  mtimeMs: number;
  size: number;
  content: string;
  metadata: CachedMetadata;
}

interface PersistedMetadataCache {
  schemaVersion: number;
  entries: Record<string, PersistedMetadataEntry>;
}

function isPersistedMetadataCache(value: unknown): value is PersistedMetadataCache {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedMetadataCache>;
  if (candidate.schemaVersion !== METADATA_CACHE_SCHEMA_VERSION) return false;
  if (!candidate.entries || typeof candidate.entries !== "object" || Array.isArray(candidate.entries)) return false;
  return Object.values(candidate.entries).every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const item = entry as Partial<PersistedMetadataEntry>;
    return (
      typeof item.mtimeMs === "number" &&
      typeof item.size === "number" &&
      typeof item.content === "string" &&
      !!item.metadata &&
      typeof item.metadata === "object" &&
      Array.isArray(item.metadata.links) &&
      Array.isArray(item.metadata.embeds) &&
      Array.isArray(item.metadata.tags) &&
      Array.isArray(item.metadata.headings) &&
      Array.isArray(item.metadata.aliases)
    );
  });
}

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

function offsetToLoc(text: string, start: number, end: number): Loc {
  // Line/ch computed lazily and cheaply: count newlines up to offset.
  const before = text.slice(0, start);
  const line = (before.match(/\n/g) ?? []).length;
  const lineStart = before.lastIndexOf("\n") + 1;
  const endBefore = text.slice(0, end);
  const endLine = (endBefore.match(/\n/g) ?? []).length;
  const endLineStart = endBefore.lastIndexOf("\n") + 1;
  return {
    start: { line, ch: start - lineStart, offset: start },
    end: { line: endLine, ch: end - endLineStart, offset: end },
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

export function parseMetadata(text: string): CachedMetadata {
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
      position: offsetToLoc(text, start, start + m[0].length),
      isEmbed,
    };
    (isEmbed ? meta.embeds : meta.links).push(link);
  }

  for (const m of masked.matchAll(TAG_RE)) {
    const tag = m[2];
    if (/^\d+$/.test(tag)) continue; // tags need a non-numeric character
    const start = bodyOffset + m.index! + m[1].length;
    meta.tags.push({ tag, position: offsetToLoc(text, start, start + tag.length + 1) });
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
      sections.push({ type: cur.type, position: offsetToLoc(text, cur.start, cur.end) });
      cur = null;
    }
  };

  // Frontmatter is its own "yaml" section, matching Obsidian.
  if (meta.frontmatter && meta.frontmatterEndOffset > 0) {
    sections.push({
      type: "yaml",
      position: offsetToLoc(text, 0, Math.max(0, meta.frontmatterEndOffset - 1)),
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
          position: offsetToLoc(text, lineStart, lineEnd),
        });
        sections.push({ type: "heading", position: offsetToLoc(text, lineStart, lineEnd) });
      } else {
        // Extend the current same-type section, or start a new one.
        if (cur && cur.type === type) cur.end = lineEnd;
        else {
          flush();
          cur = { type, start: lineStart, end: lineEnd };
        }

        if (type === "list") {
          const indent = li![1].length;
          const pos = offsetToLoc(text, lineStart, lineEnd);
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
  private workerMetadata = new Map<string, CachedMetadata>();
  private backgroundIndexerActive = false;
  private backgroundSnapshot: PersistedMetadataCache | null = null;
  private snapshotSequence = 0;
  private snapshotReceiving = false;
  private deferredIndexerMessages: any[] = [];
  private backgroundRefreshRunning = false;
  private backgroundRefreshPending = false;
  private backgroundUnavailable = false;
  private backgroundTask: Promise<void> = Promise.resolve();

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
      return isPersistedMetadataCache(value) ? value : null;
    } catch {
      return null;
    }
  }

  private async persistCache(): Promise<void> {
    try {
      const api = typeof window === "undefined" ? undefined : window.geode;
      if (!api?.writeMetadataCache) return;
      const entries: Record<string, PersistedMetadataEntry> = {};
      for (const file of this.vault.getMarkdownFiles()) {
        const metadata = this.cache.get(file.path);
        const content = this.vault.getCachedContent(file.path);
        if (metadata && content !== undefined) {
          entries[file.path] = { mtimeMs: file.mtime, size: file.size, content, metadata };
        }
      }
      await api.writeMetadataCache({ schemaVersion: METADATA_CACHE_SCHEMA_VERSION, entries });
    } catch (error) {
      console.error("Failed to persist metadata cache", error);
    }
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
    const api = typeof window === "undefined" ? undefined : window.geode;
    api?.onMetadataIndexerMessage?.((message) => this.onIndexerMessage(message));
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
      this.workerMetadata.set(message.path, message.entry.metadata);
      this.vault.primeCachedContent(message.path, message.entry.content);
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
          const fromWorker = isMdPath(path) ? this.workerMetadata.get(path) : undefined;
          if (fromWorker) {
            newMeta.set(path, fromWorker);
            this.workerMetadata.delete(path);
          } else if (isCanvasPath(path)) {
            const parsed = parseCanvasLinkMetadata(await this.vault.cachedRead(file));
            newMeta.set(path, parsed.metadata);
            newCanvasContexts.set(path, parsed.contexts);
          } else {
            newMeta.set(path, parseMetadata(await this.vault.cachedRead(file)));
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
    await withPerfMark("metadata-initialize", async () => {
      const markdownFiles = this.vault.getMarkdownFiles();
      const canvasFiles = this.vault.getFiles().filter((file) => file.extension === "canvas");
      const api = typeof window === "undefined" ? undefined : window.geode;
      const attemptedBackground = !!api?.startMetadataIndexer;
      if (attemptedBackground) {
        // Starting the worker must never make the renderer wait for a full
        // vault reconciliation. On endpoint-protected filesystems that can
        // take minutes. Hydrate from the last persisted snapshot below and
        // merge the worker result when snapshot-complete arrives.
        void api?.startMetadataIndexer?.().then((available) => {
          if (available === true) this.backgroundIndexerActive = true;
          else {
            this.backgroundUnavailable = true;
            if (this.initialized) this.scheduleBackground(() => this.applyRendererFallback());
          }
        }).catch(() => {
          this.backgroundIndexerActive = false;
          this.backgroundUnavailable = true;
          if (this.initialized) this.scheduleBackground(() => this.applyRendererFallback());
        });
      }
      const persisted = await this.loadPersistedCache();
      await withPerfMark("metadata-renderer-apply", async () => {
        this.cache.clear();
        this.canvasLinkContexts.clear();
        const toRead: TFile[] = [];
        for (const file of markdownFiles) {
          const entry = persisted?.entries[file.path];
          if (entry && entry.mtimeMs === file.mtime && entry.size === file.size) {
            this.cache.set(file.path, entry.metadata);
            this.vault.primeCachedContent(file.path, entry.content);
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
              this.cache.set(f.path, parseMetadata(text));
            }
          } catch (err) {
            if (!isBenignEnoent(err)) console.error(`Failed to index ${f.path}`, err);
          }
        });
      });
      withPerfMark("metadata-renderer-resolve", () => {
        this.rebuildNameIndex();
        this.resolveAll();
      });
      for (const file of markdownFiles) if (this.cache.has(file.path)) this.trigger("resolve", file);
      if (!attemptedBackground) await this.persistCache();
    });
    this.initialized = true;
    this.trigger("resolved");
    if (this.backgroundRefreshPending) this.scheduleBackground(() => this.applyBackgroundSnapshot());
    else if (this.backgroundUnavailable) this.scheduleBackground(() => this.applyRendererFallback());
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
      const entries = Object.entries(snapshot.entries);
      await processInBatches(entries, 50, async ([path, snapshotEntry]) => {
        const file = currentMarkdown.get(path);
        if (!file) return;
        const live = this.workerMetadata.get(path);
        if (!live && (snapshotEntry.mtimeMs !== file.mtime || snapshotEntry.size !== file.size)) return;
        const entry = live
          ? { metadata: live, content: this.vault.getCachedContent(path) ?? snapshotEntry.content }
          : snapshotEntry;
        this.cache.set(path, entry.metadata);
        this.vault.primeCachedContent(path, entry.content);
      });
      await yieldToEventLoop();
      withPerfMark("metadata-background-resolve", () => {
        this.rebuildNameIndex();
        this.resolveAll();
      });
      const files = [...currentMarkdown.values()].filter((file) => this.cache.has(file.path));
      await processInBatches(files, 50, async (file) => { this.trigger("resolve", file); });
      this.trigger("resolved");
    } finally {
      this.backgroundRefreshRunning = false;
      if (this.backgroundRefreshPending) this.scheduleBackground(() => this.applyBackgroundSnapshot());
    }
  }

  /** Progressive safety net used only when the utility process is absent. */
  private async applyRendererFallback(): Promise<void> {
    if (!this.backgroundUnavailable) return;
    this.backgroundUnavailable = false;
    const files = this.vault.getMarkdownFiles();
    await processInBatches(files, INDEX_CONCURRENCY, async (file) => {
      try {
        const content = await this.vault.cachedRead(file);
        this.cache.set(file.path, parseMetadata(content));
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
    this.trigger("resolved");
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
   */
  getBacklinksWithContext(
    file: TFile
  ): { source: TFile; count: number; snippets: string[] }[] {
    const out: { source: TFile; count: number; snippets: string[] }[] = [];
    for (const [src, targets] of this.resolvedLinkMap) {
      const count = targets.get(file.path);
      if (!count) continue;
      const srcFile = this.vault.getFileByPath(src);
      if (!srcFile) continue;
      const meta = this.cache.get(src);
      const lines = srcFile.extension === "canvas"
        ? this.canvasLinkContexts.get(src) ?? []
        : this.vault.getCachedContent(src)?.split("\n") ?? [];
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
   */
  getUnlinkedMentions(file: TFile): { source: TFile; mentions: UnlinkedMention[] }[] {
    const names = [file.basename, ...(this.cache.get(file.path)?.aliases ?? [])];
    const out: { source: TFile; mentions: UnlinkedMention[] }[] = [];
    for (const src of this.cache.keys()) {
      if (src === file.path) continue;
      if (!isMdPath(src)) continue;
      const content = this.vault.getCachedContent(src);
      if (content === undefined) continue;
      const mentions = findUnlinkedMentions(content, names);
      if (!mentions.length) continue;
      const srcFile = this.vault.getFileByPath(src);
      if (srcFile) out.push({ source: srcFile, mentions });
    }
    return out.sort((a, b) => a.source.basename.localeCompare(b.source.basename));
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
