import { parse as parseYaml, parseDocument, isMap, isSeq, isScalar } from "yaml";
import { maskMarkdownCode } from "./code-mask";
import { markdownReferences } from "./markdown-references";
import { scanFootnotes } from "./footnote-scan";
import { maskCommentMetadata, stripCommentMarkerSyntax } from "../renderer/comments/model";
import { DEFAULT_METADATA_SCAN_CAP_BYTES, FRONTMATTER_BLOCK_RE } from "./constants";
import type { CachedMetadata, FrontmatterLinkCache, FootnoteRefCache, LinkCache, ListItemCache, Loc, Pos, ReferenceLinkCache, SectionCache } from "./types";

function isEscaped(text: string, position: number): boolean {
  let slashes = 0;
  for (let index = position - 1; index >= 0 && text[index] === "\\"; index--) slashes++;
  return slashes % 2 === 1;
}

const WIKILINK_RE = /(!)?\[\[([^\[\]\n]+)\]\]/g;
// `[^id]` NOT followed by `:` — that would make it a footnote definition
// rather than a reference to one.
const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\](?!:)/g;
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
  let masked = text.replace(/```[\s\S]*?(```|$)/g, m => m.replace(/[^\n]/g, " "));
  masked = masked.replace(/`[^`\n]*`/g, m => " ".repeat(m.length));
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
  const fmMatch = text.match(FRONTMATTER_BLOCK_RE);
  if (fmMatch) {
    try {
      const fm = parseYaml(fmMatch[1]);
      if (fm && typeof fm === "object" && !Array.isArray(fm)) {
        meta.frontmatter = fm as Record<string, unknown>;
        meta.frontmatterEndOffset = fmMatch[0].length;
        bodyOffset = fmMatch[0].length;
        body = text.slice(bodyOffset);
        meta.frontmatterPosition = offsetToLoc(lineStarts, 0, fmMatch[0].trimEnd().length);
        const frontmatterLinks: FrontmatterLinkCache[] = [];
        const yamlStart = fmMatch[0].indexOf(fmMatch[1]);
        const visit = (node: unknown, key: string) => {
          if (isMap(node)) {
            for (const pair of node.items) if (isScalar(pair.key)) visit(pair.value, key ? `${key}.${String(pair.key.value)}` : String(pair.key.value));
          } else if (isSeq(node)) {
            node.items.forEach((item, index) => visit(item, `${key}.${index}`));
          } else if (isScalar(node) && typeof node.value === "string" && node.range) {
            for (const match of node.value.matchAll(WIKILINK_RE)) {
              if (isEscaped(node.value, match.index!)) continue;
              const [target, ...alias] = match[2].split("|");
              if (!target.trim()) continue;
              frontmatterLinks.push({ key, link: target.trim(), original: match[0], displayText: alias.length ? alias.join("|").trim() : target.trim(),
                position: offsetToLoc(lineStarts, yamlStart + node.range[0], yamlStart + node.range[1]) });
            }
          }
        };
        visit(parseDocument(fmMatch[1]).contents, "");
        if (frontmatterLinks.length) meta.frontmatterLinks = frontmatterLinks;
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

  const codeSafe = maskMarkdownCode(body);
  const comments = [...codeSafe.matchAll(/(?<!\\)%%[\s\S]*?(?<!\\)%%/g)];
  let commentEnd = 0;
  const uncommented: string[] = [];
  for (const comment of comments) {
    uncommented.push(body.slice(commentEnd, comment.index), comment[0].replace(/[^\n\r]/g, " "));
    commentEnd = comment.index! + comment[0].length;
  }
  uncommented.push(body.slice(commentEnd));
  body = uncommented.join("");
  const masked = maskMarkdownCode(body);

  for (const m of masked.matchAll(WIKILINK_RE)) {
    if (isEscaped(masked, m.index!)) continue;
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

  const authored = markdownReferences(body, (start, end) => offsetToLoc(lineStarts, bodyOffset + start, bodyOffset + end));
  meta.links.push(...authored.links);
  meta.embeds.push(...authored.embeds);
  meta.links.sort((a, b) => a.position.start.offset - b.position.start.offset);
  meta.embeds.sort((a, b) => a.position.start.offset - b.position.start.offset);
  if (authored.references.length) meta.referenceLinks = authored.references;
  const definitions = scanFootnotes(text.slice(0, bodyOffset) + body, bodyOffset).definitions;
  if (definitions.length) meta.footnotes = definitions.map(definition => ({ id: definition.id, position: offsetToLoc(lineStarts, definition.from, definition.to) }));

  let offset = bodyOffset;
  let inFence = false;
  let listRoot: number | null = null;
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
      listRoot = null;
      inFence = true;
      cur = { type: "code", start: lineStart, end: lineEnd };
    } else if (line.trim() === "") {
      // Blank line ends the current block/section and any list context.
      flush();
      stack.length = 0;
      listRoot = null;
    } else {
      const h = line.match(HEADING_RE);
      const li = h ? null : line.match(LIST_ITEM_RE);
      const type = h ? "heading" : li ? "list" : "paragraph";

      if (type === "heading") {
        flush();
        stack.length = 0;
      listRoot = null;
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
          if (listRoot === null) listRoot = lineNo;
          const parent = stack.length ? stack[stack.length - 1].line : -listRoot;
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
      listRoot = null;
        }
      }
    }
    offset += line.length + 1;
  }
  flush();

  // Obsidian-faithful: present only when the note actually has content.
  if (listItems.length) meta.listItems = listItems;
  if (sections.length) meta.sections = sections;
  const blocks: NonNullable<CachedMetadata["blocks"]> = Object.create(null);
  for (const item of listItems) if (item.id) blocks[item.id] = { id: item.id, position: item.position };
  for (const section of sections) {
    if (section.type === "code" || section.type === "yaml" || section.type === "list") continue;
    const content = masked.slice(section.position.start.offset - bodyOffset, section.position.end.offset - bodyOffset);
    const id = content.match(BLOCK_ID_RE)?.[1];
    if (id) { section.id = id; blocks[id] = { id, position: section.position }; }
  }
  if (Object.keys(blocks).length) meta.blocks = blocks;

  return meta;
}

/** Internal graph projection; property positions are actual YAML source spans. */
export function metadataReferences(metadata: CachedMetadata): LinkCache[] {
  return [...metadata.links, ...metadata.embeds, ...(metadata.frontmatterLinks ?? []).flatMap(link => link.position ? [{ link: link.link, displayText: link.displayText ?? link.link, position: link.position, isEmbed: false }] : [])]
    .sort((a, b) => a.position.start.offset - b.position.start.offset);
}
export function isExternalReference(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
}
