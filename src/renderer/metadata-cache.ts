import { parse as parseYaml } from "yaml";
import { Events } from "./events";
import { Vault } from "./vault";
import {
  CachedMetadata,
  HeadingCache,
  LinkCache,
  ListItemCache,
  Loc,
  SectionCache,
  TFile,
  TagCache,
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

/**
 * Vault-wide metadata index. Parses every markdown file, resolves links to
 * files, and maintains backlink/tag indices. Events: 'resolved' (initial
 * index complete), 'changed' (file: TFile).
 */
export class MetadataCache extends Events {
  private cache = new Map<string, CachedMetadata>();
  /** basename (lowercase) -> file paths with that basename */
  private byBasename = new Map<string, string[]>();
  /** alias (lowercase) -> file paths */
  private byAlias = new Map<string, string[]>();
  /** source path -> set of resolved target paths */
  resolvedLinks = new Map<string, Map<string, number>>();
  /** source path -> unresolved link text -> count */
  unresolvedLinks = new Map<string, Map<string, number>>();
  initialized = false;

  constructor(private vault: Vault) {
    super();
    vault.on("create", (f: TFile) => {
      if (f?.kind === "file" && f.extension === "md") this.indexFile(f);
      else this.rebuildNameIndex();
    });
    vault.on("modify", (f: TFile) => {
      if (f?.kind === "file" && f.extension === "md") this.indexFile(f);
    });
    vault.on("delete", (f: TFile) => {
      if (!f) return;
      this.cache.delete(f.path);
      this.resolvedLinks.delete(f.path);
      this.unresolvedLinks.delete(f.path);
      this.rebuildNameIndex();
      this.resolveAll();
      this.trigger("changed", f);
    });
    vault.on("rename", (f: TFile, oldPath: string) => {
      if (!f) return;
      const meta = this.cache.get(oldPath);
      this.cache.delete(oldPath);
      if (meta && f.kind === "file") this.cache.set(f.path, meta);
      this.rebuildNameIndex();
      this.resolveAll();
      this.trigger("changed", f, oldPath);
    });
  }

  async initialize(): Promise<void> {
    const files = this.vault.getMarkdownFiles();
    await processInBatches(files, INDEX_CONCURRENCY, async (f) => {
      try {
        const text = await this.vault.cachedRead(f);
        this.cache.set(f.path, parseMetadata(text));
      } catch (err) {
        if (!isBenignEnoent(err)) console.error(`Failed to index ${f.path}`, err);
      }
    });
    this.rebuildNameIndex();
    this.resolveAll();
    this.initialized = true;
    this.trigger("resolved");
  }

  private async indexFile(file: TFile) {
    try {
      const text = await this.vault.cachedRead(file);
      this.cache.set(file.path, parseMetadata(text));
      this.rebuildNameIndex();
      this.resolveAll();
      this.trigger("changed", file);
    } catch (err) {
      if (!isBenignEnoent(err)) console.error(`Failed to index ${file.path}`, err);
    }
  }

  private rebuildNameIndex() {
    this.byBasename.clear();
    this.byAlias.clear();
    for (const f of this.vault.getFiles()) {
      const key = f.basename.toLowerCase();
      const list = this.byBasename.get(key) ?? [];
      list.push(f.path);
      this.byBasename.set(key, list);
      // Full name (with extension) also resolvable, e.g. [[img.png]]
      const nameKey = f.name.toLowerCase();
      if (nameKey !== key) {
        const nlist = this.byBasename.get(nameKey) ?? [];
        nlist.push(f.path);
        this.byBasename.set(nameKey, nlist);
      }
    }
    for (const [path, meta] of this.cache) {
      for (const alias of meta.aliases) {
        const key = alias.toLowerCase();
        const list = this.byAlias.get(key) ?? [];
        list.push(path);
        this.byAlias.set(key, list);
      }
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

  private resolveAll() {
    this.resolvedLinks.clear();
    this.unresolvedLinks.clear();
    for (const [path, meta] of this.cache) {
      const resolved = new Map<string, number>();
      const unresolved = new Map<string, number>();
      for (const link of [...meta.links, ...meta.embeds]) {
        const dest = this.getFirstLinkpathDest(link.link, path);
        if (dest) resolved.set(dest.path, (resolved.get(dest.path) ?? 0) + 1);
        else {
          const key = link.link.split("#")[0].trim();
          if (key) unresolved.set(key, (unresolved.get(key) ?? 0) + 1);
        }
      }
      this.resolvedLinks.set(path, resolved);
      this.unresolvedLinks.set(path, unresolved);
    }
  }

  getFileCache(file: TFile): CachedMetadata | null {
    return this.cache.get(file.path) ?? null;
  }

  /** All files containing links that resolve to `file`. */
  getBacklinks(file: TFile): { source: TFile; count: number }[] {
    const out: { source: TFile; count: number }[] = [];
    for (const [src, targets] of this.resolvedLinks) {
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
    for (const [src, targets] of this.resolvedLinks) {
      const count = targets.get(file.path);
      if (!count) continue;
      const srcFile = this.vault.getFileByPath(src);
      if (!srcFile) continue;
      const meta = this.cache.get(src);
      const lines = this.vault.getCachedContent(src)?.split("\n") ?? [];
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
