import { parse as parseYaml } from "yaml";
import { maskCommentMetadata, stripCommentMarkerSyntax } from "../renderer/comments/model";
import { DEFAULT_METADATA_SCAN_CAP_BYTES } from "../indexer/metadata-indexer";
import type { CachedMetadata, FootnoteRefCache, LinkCache, ListItemCache, Loc, Pos, ReferenceLinkCache, SectionCache } from "./types";

const WIKILINK_RE = /(!)?\[\[([^\[\]\n]+)\]\]/g;
// `[^id]` NOT followed by `:` — that would make it a footnote definition
// rather than a reference to one.
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\](?!:)/g;
// `[text][id]` (full) and `[text][]` (collapsed) markdown reference links.
// The `!` lookbehind keeps image references out.
const REFERENCE_LINK_RE = /(?<!!)\[([^\[\]\n]+)\]\[([^\[\]\n]*)\]/g;
const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_\/-]*[\p{L}_\/-][\p{L}\p{N}_\/-]*)/gu;
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?$/;
// A list item: leading indent, a bullet (-,*,+) or ordered marker (1. / 1)),
// then optionally a `[x]` checkbox, then the content. Group 1 = indent,
// group 2 = the checkbox character (present only for tasks).
const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])[ \t]+(?:\[(.)\][ \t]?)?/;
// Trailing block id, e.g. `- [ ] do it ^abc-123`.
const BLOCK_ID_RE = /[ \t]\^([A-Za-z0-9-]+)\s*$/;

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
export function maskCode(text: string): string {
  let masked = text.replace(/```[\s\S]*?(```|$)/g, (m) => m.replace(/[^\n]/g, " "));
  masked = masked.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
  return masked;
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
  // Retain raw offsets while recovering heading prose without marker padding.
  const rawText = text;
  text = maskCommentMetadata(text);
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

  // Footnote *references* — `[^id]` used inline. The definition line
  // (`[^id]: text`) is excluded by the negative lookahead, since a definition
  // is not a reference to itself.
  const footnoteRefs: FootnoteRefCache[] = [];
  for (const m of masked.matchAll(FOOTNOTE_REF_RE)) {
    const start = bodyOffset + m.index!;
    footnoteRefs.push({ id: m[1], position: offsetToLoc(lineStarts, start, start + m[0].length) });
  }
  if (footnoteRefs.length) meta.footnoteRefs = footnoteRefs;

  // Markdown reference links — `[text][id]` (full) and `[id][]` (collapsed),
  // where an empty id means the link text doubles as the id.
  const referenceLinks: ReferenceLinkCache[] = [];
  for (const m of masked.matchAll(REFERENCE_LINK_RE)) {
    if (m[1].startsWith("^")) continue; // a footnote ref, handled above
    const id = m[2] || m[1];
    if (!id) continue;
    const start = bodyOffset + m.index!;
    referenceLinks.push({ id, link: m[1], position: offsetToLoc(lineStarts, start, start + m[0].length) });
  }
  if (referenceLinks.length) meta.referenceLinks = referenceLinks;

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
        const cleanHeading = stripCommentMarkerSyntax(rawText.slice(lineStart, lineEnd)).match(HEADING_RE);
        meta.headings.push({
          heading: (cleanHeading?.[2] ?? h![2]).trim(),
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
