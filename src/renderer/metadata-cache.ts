import { parse as parseYaml } from "yaml";
import { Events } from "./events";
import { Vault } from "./vault";
import {
  CachedMetadata,
  HeadingCache,
  LinkCache,
  Loc,
  TFile,
  TagCache,
} from "./types";

const WIKILINK_RE = /(!)?\[\[([^\[\]\n]+)\]\]/g;
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\/-]*[\p{L}_\/-][\p{L}\p{N}_\/-]*)/gu;
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?$/;

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

export function parseMetadata(text: string): CachedMetadata {
  const meta: CachedMetadata = {
    frontmatter: null,
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
  for (const line of body.split("\n")) {
    const fence = line.match(/^(```|~~~)/);
    if (fence) inFence = !inFence;
    if (!inFence) {
      const h = line.match(HEADING_RE);
      if (h) {
        meta.headings.push({
          heading: h[2].trim(),
          level: h[1].length,
          position: offsetToLoc(text, offset, offset + line.length),
        });
      }
    }
    offset += line.length + 1;
  }

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
    await Promise.all(
      files.map(async (f) => {
        try {
          const text = await this.vault.cachedRead(f);
          this.cache.set(f.path, parseMetadata(text));
        } catch (err) {
          console.error(`Failed to index ${f.path}`, err);
        }
      })
    );
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
      console.error(`Failed to index ${file.path}`, err);
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
