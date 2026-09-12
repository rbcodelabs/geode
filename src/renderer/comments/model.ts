import { GFM, parser, type BlockParser, type MarkdownConfig } from "@lezer/markdown";
import { getFrontMatterInfo } from "../api/frontmatter";

export interface CommentAuthor {
  type: "user" | "agent";
  name: string;
}

export interface CommentMessage {
  id: string;
  author: CommentAuthor;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface CommentPayload {
  messages: CommentMessage[];
  resolvedAt?: string;
}

export interface ParsedCommentThread extends CommentPayload {
  id: string;
  from: number;
  to: number;
  markerFrom: number;
  markerTo: number;
  openFrom: number;
  openTo: number;
  closeFrom: number;
  closeTo: number;
  anchorText: string;
  detached: boolean;
}

export interface CommentParseError {
  from: number;
  to: number;
  message: string;
}

export class CommentFormatError extends Error {}

const OPEN_EXACT = /^<!-- geode-comment:v1 id="([^"]+)" data="([^"]*)" -->$/;
const END_EXACT = /^<!-- geode-comment-end:([^\s<>]+) -->$/;
const CANDIDATE_RE = /<!--\s*geode-comment[\s\S]*?(?:-->|$)/g;

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function isAuthor(value: unknown): value is CommentAuthor {
  if (!value || typeof value !== "object") return false;
  const author = value as Partial<CommentAuthor>;
  return (author.type === "user" || author.type === "agent") && typeof author.name === "string" && !!author.name.trim();
}

function isMessage(value: unknown): value is CommentMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<CommentMessage>;
  return typeof message.id === "string" && !!message.id && isAuthor(message.author) &&
    typeof message.body === "string" && !!message.body.trim() &&
    typeof message.createdAt === "string" && typeof message.updatedAt === "string";
}

function decodePayload(encoded: string): CommentPayload {
  const value = JSON.parse(decodeBase64Url(encoded)) as Partial<CommentPayload>;
  if (!Array.isArray(value.messages) || !value.messages.every(isMessage)) throw new Error("Invalid message payload");
  if (value.resolvedAt !== undefined && typeof value.resolvedAt !== "string") throw new Error("Invalid resolved timestamp");
  return { messages: value.messages, ...(value.resolvedAt ? { resolvedAt: value.resolvedAt } : {}) };
}

export function createCommentMarkers(id: string, payload: CommentPayload): { open: string; close: string } {
  if (!id || /["<>\s]/.test(id)) throw new CommentFormatError("Comment IDs cannot contain whitespace or marker syntax");
  const data = encodeBase64Url(JSON.stringify(payload));
  return {
    open: `<!-- geode-comment:v1 id="${id}" data="${data}" -->`,
    close: `<!-- geode-comment-end:${id} -->`,
  };
}

export function parseCommentThreads(source: string): { threads: ParsedCommentThread[]; errors: CommentParseError[] } {
  const threads: ParsedCommentThread[] = [];
  const errors: CommentParseError[] = [];
  const seen = new Set<string>();
  let active: { id: string; data: string; from: number; to: number; invalid: boolean } | null = null;
  for (const candidate of source.matchAll(CANDIDATE_RE)) {
    const value = candidate[0];
    const from = candidate.index!;
    const to = from + value.length;
    const open = value.match(OPEN_EXACT);
    const end = value.match(END_EXACT);
    if (open) {
      if (active) {
        errors.push({ from, to, message: `Comment ${open[1]} is nested inside ${active.id}` });
        active.invalid = true;
        continue;
      }
      const duplicate = seen.has(open[1]);
      if (duplicate) errors.push({ from, to, message: `Duplicate comment id ${open[1]}` });
      seen.add(open[1]);
      active = { id: open[1], data: open[2], from, to, invalid: duplicate };
      continue;
    }
    if (end) {
      if (!active) {
        errors.push({ from, to, message: `Stray closing marker for ${end[1]}` });
        continue;
      }
      if (end[1] !== active.id) {
        errors.push({ from, to, message: `Crossed comment markers: expected ${active.id}, found ${end[1]}` });
        active = null;
        continue;
      }
      if (!active.invalid) {
        try {
          const payload = decodePayload(active.data);
          threads.push({
            id: active.id, ...payload,
            from: active.to, to: from,
            markerFrom: active.from, markerTo: to,
            openFrom: active.from, openTo: active.to,
            closeFrom: from, closeTo: to,
            anchorText: source.slice(active.to, from),
            detached: active.to === from,
          });
        } catch (error) {
          errors.push({ from: active.from, to: active.to, message: `Comment ${active.id} is malformed: ${String(error)}` });
        }
      }
      active = null;
      continue;
    }
    errors.push({ from, to, message: "Malformed or truncated Geode comment marker" });
    if (active) active.invalid = true;
  }
  if (active) errors.push({ from: active.from, to: active.to, message: `Comment ${active.id} has no closing marker` });
  return { threads, errors };
}

export function stripCommentMetadata(source: string): string {
  const parsed = parseCommentThreads(source);
  if (parsed.errors.length) return source;
  if (!parsed.threads.length) return source;
  let result = source;
  for (const thread of [...parsed.threads].sort((a, b) => b.markerFrom - a.markerFrom)) {
    result = result.slice(0, thread.closeFrom) + result.slice(thread.closeTo);
    result = result.slice(0, thread.openFrom) + result.slice(thread.openTo);
  }
  return result;
}

/**
 * Every syntactically well-formed marker token, matched independently of its
 * partner. Both alternatives forbid newlines inside the quoted fields so a
 * crafted `data="..."` can never span lines — `stripCommentMarkerSyntax`'s
 * line-count guarantee depends on that.
 */
const MARKER_TOKEN_RE =
  /<!-- geode-comment:v1 id="[^"\r\n]+" data="[^"\r\n]*" -->|<!-- geode-comment-end:[^\s<>]+ -->/g;

/**
 * Remove marker tokens from `text` without requiring them to pair up.
 *
 * The document-level helpers (`stripCommentMetadata`, `maskCommentMetadata`,
 * `commentMarkerRanges`) all refuse to touch a source whose markers do not
 * parse, so an author can see and repair the damage. That contract is wrong for
 * the consumers that match or display a *single line* — a line holding one half
 * of a valid pair is not a broken document, it is just a slice of one — and it
 * is wrong for read-only presentation, where showing raw marker bytes helps
 * nobody. Those callers use this instead.
 *
 * Markers never contain a line break, so line numbers and line count survive;
 * only offsets within a line shift. Callers that need offsets preserved want
 * `maskCommentMetadata`, and callers that need to map back to raw offsets want
 * `stripCommentMetadataWithMap`.
 */
export function stripCommentMarkerSyntax(text: string): string {
  return text.replace(MARKER_TOKEN_RE, "");
}

export interface StrippedCommentMetadata {
  text: string;
  /** Map an offset in marker-stripped text back to the original Markdown. */
  toSourceOffset(offset: number): number;
}

/**
 * Strip valid comment markers while retaining a compact mapping back to raw
 * source offsets. Search operates on contiguous prose, but navigation must
 * address the marker-bearing editor document.
 */
export function stripCommentMetadataWithMap(source: string): StrippedCommentMetadata {
  const parsed = parseCommentThreads(source);
  if (parsed.errors.length || !parsed.threads.length) {
    return { text: source, toSourceOffset: (offset) => offset };
  }
  const removals = parsed.threads
    .flatMap((thread) => [
      { from: thread.openFrom, to: thread.openTo },
      { from: thread.closeFrom, to: thread.closeTo },
    ])
    .sort((a, b) => a.from - b.from);
  const segments: Array<{ strippedFrom: number; sourceFrom: number; length: number }> = [];
  const chunks: string[] = [];
  let sourceFrom = 0;
  let strippedFrom = 0;
  for (const removal of removals) {
    if (removal.from > sourceFrom) {
      const chunk = source.slice(sourceFrom, removal.from);
      chunks.push(chunk);
      segments.push({ strippedFrom, sourceFrom, length: chunk.length });
      strippedFrom += chunk.length;
    }
    sourceFrom = removal.to;
  }
  if (sourceFrom < source.length) {
    const chunk = source.slice(sourceFrom);
    chunks.push(chunk);
    segments.push({ strippedFrom, sourceFrom, length: chunk.length });
  }
  const text = chunks.join("");
  return {
    text,
    toSourceOffset(offset: number): number {
      if (offset <= 0) return segments[0]?.sourceFrom ?? 0;
      if (offset >= text.length) return source.length;
      let low = 0;
      let high = segments.length - 1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const segment = segments[mid];
        if (offset < segment.strippedFrom) high = mid - 1;
        else if (offset >= segment.strippedFrom + segment.length) low = mid + 1;
        else return segment.sourceFrom + offset - segment.strippedFrom;
      }
      return source.length;
    },
  };
}

/** Hide valid marker bytes while preserving UTF-16 offsets and line endings for metadata positions. */
export function maskCommentMetadata(source: string): string {
  const parsed = parseCommentThreads(source);
  if (parsed.errors.length) return source;
  let result = source;
  const blank = (value: string) => value.replace(/[^\r\n]/g, " ");
  for (const thread of [...parsed.threads].sort((a, b) => b.markerFrom - a.markerFrom)) {
    result = result.slice(0, thread.closeFrom) + blank(result.slice(thread.closeFrom, thread.closeTo)) + result.slice(thread.closeTo);
    result = result.slice(0, thread.openFrom) + blank(result.slice(thread.openFrom, thread.openTo)) + result.slice(thread.openTo);
  }
  return result;
}

function maskCommentSyntax(source: string): string {
  const parsed = parseCommentThreads(source);
  if (parsed.errors.length) return source;
  let result = source;
  const neutral = (value: string) => {
    let started = false;
    return value.replace(/[^\r\n]/g, () => {
      if (started) return " ";
      started = true;
      return "x";
    });
  };
  for (const thread of [...parsed.threads].sort((a, b) => b.markerFrom - a.markerFrom)) {
    result = result.slice(0, thread.closeFrom) + neutral(result.slice(thread.closeFrom, thread.closeTo)) + result.slice(thread.closeTo);
    result = result.slice(0, thread.openFrom) + neutral(result.slice(thread.openFrom, thread.openTo)) + result.slice(thread.openTo);
  }
  return result;
}

function delimitedBlockParser(name: string, node: string, delimiter: string): BlockParser {
  const isDelimiterLine = (text: string, from: number) => text.slice(from).trim() === delimiter;
  return {
    name,
    before: "FencedCode",
    parse(cx, line) {
      if (!isDelimiterLine(line.text, line.pos)) return false;
      const from = cx.lineStart + line.pos;
      let to = cx.lineStart + line.text.length;
      while (cx.nextLine()) {
        to = cx.lineStart + line.text.length;
        if (isDelimiterLine(line.text, line.pos)) {
          cx.nextLine();
          break;
        }
      }
      cx.addElement(cx.elt(node, from, to));
      return true;
    },
  };
}

const geodeMarkdownSyntax: MarkdownConfig = {
  defineNodes: [
    "WikiLink", "ObsidianTag", "Highlight", "TablePipe", "BlockID", "InlineMath", "ObsidianComment",
    { name: "MathBlock", block: true },
    { name: "ObsidianCommentBlock", block: true },
  ],
  parseBlock: [
    delimitedBlockParser("MathBlock", "MathBlock", "$$"),
    delimitedBlockParser("ObsidianCommentBlock", "ObsidianCommentBlock", "%%"),
  ],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== 91 || cx.char(pos + 1) !== 91) return -1;
        const close = cx.slice(pos + 2, cx.end).indexOf("]]");
        if (close < 0) return -1;
        return cx.addElement(cx.elt("WikiLink", pos, pos + close + 4));
      },
    },
    {
      name: "ObsidianTag",
      parse(cx, next, pos) {
        if (next !== 35) return -1;
        const previous = pos === cx.offset ? "" : cx.slice(pos - 1, pos);
        if (previous && !/[\s(]/u.test(previous)) return -1;
        const match = /^[\p{L}\p{N}_\/-]*[\p{L}_\/-][\p{L}\p{N}_\/-]*/u.exec(cx.slice(pos + 1, cx.end));
        if (!match) return -1;
        return cx.addElement(cx.elt("ObsidianTag", pos, pos + 1 + match[0].length));
      },
    },
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== 61 || cx.char(pos + 1) !== 61) return -1;
        const close = cx.slice(pos + 2, cx.end).indexOf("==");
        if (close < 0) return -1;
        return cx.addElement(cx.elt("Highlight", pos, pos + close + 4));
      },
    },
    {
      name: "TablePipe",
      parse(cx, next, pos) {
        return next === 124 ? cx.addElement(cx.elt("TablePipe", pos, pos + 1)) : -1;
      },
    },
    {
      name: "BlockID",
      parse(cx, next, pos) {
        if (next !== 94) return -1;
        const previous = pos === cx.offset ? "" : cx.slice(pos - 1, pos);
        if (pos !== cx.offset && !/[ \t\r\n]/u.test(previous)) return -1;
        const match = /^\^[A-Za-z0-9-]+(?=[ \t]*(?:\r?\n|$))/u.exec(cx.slice(pos, cx.end));
        return match ? cx.addElement(cx.elt("BlockID", pos, pos + match[0].length)) : -1;
      },
    },
    {
      name: "InlineMath",
      parse(cx, next, pos) {
        if (next !== 36) return -1;
        const delimiter = cx.char(pos + 1) === 36 ? "$$" : "$";
        const close = cx.slice(pos + delimiter.length, cx.end).indexOf(delimiter);
        if (close < 0) return -1;
        return cx.addElement(cx.elt("InlineMath", pos, pos + delimiter.length * 2 + close));
      },
    },
    {
      name: "ObsidianComment",
      parse(cx, next, pos) {
        if (next !== 37 || cx.char(pos + 1) !== 37) return -1;
        const close = cx.slice(pos + 2, cx.end).indexOf("%%");
        if (close < 0) return -1;
        return cx.addElement(cx.elt("ObsidianComment", pos, pos + close + 4));
      },
    },
  ],
};

const commentMarkdownParser = parser.configure([GFM, geodeMarkdownSyntax]);

function maskNonPlainDelimiterContexts(source: string, delimiter: "$$" | "%%"): string {
  const masked = source.split("");
  const delimiterNodes = delimiter === "$$"
    ? new Set(["InlineMath", "MathBlock"])
    : new Set(["ObsidianComment", "ObsidianCommentBlock"]);
  const mask = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
    }
  };
  const frontmatter = getFrontMatterInfo(source);
  if (frontmatter.exists) mask(0, frontmatter.contentStart);
  commentMarkdownParser.parse(source).iterate({
    enter(node) {
      if (TRANSPARENT_NODES.has(node.name) || delimiterNodes.has(node.name)) return;
      mask(node.from, node.to);
    },
  });
  return masked.join("");
}

function delimitedSyntaxRanges(
  source: string,
  delimiter: "$$" | "%%",
  kind: "display math" | "Obsidian comment",
): Array<{ from: number; to: number; kind: string }> {
  const ranges: Array<{ from: number; to: number; kind: string }> = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const from = source.indexOf(delimiter, searchFrom);
    if (from < 0) break;
    const closeFrom = source.indexOf(delimiter, from + delimiter.length);
    if (closeFrom < 0) {
      ranges.push({ from, to: source.length, kind });
      break;
    }
    const to = closeFrom + delimiter.length;
    ranges.push({ from, to, kind });
    searchFrom = to;
  }
  return ranges;
}

/**
 * Container nodes that carry no syntax of their own. `protectedRanges` recurses
 * through these and protects only their structural children, so ordinary prose
 * inside a heading, list item, or table cell stays commentable.
 *
 * Everything not listed here is opaque and protects its whole span — the safe
 * default. The structural children (`HeaderMark`, `ListMark`, `TaskMarker`,
 * `TableDelimiter`, `QuoteMark`) are deliberately absent so they stay protected;
 * a marker spliced into one of those would change how the block parses.
 *
 * `Task` wraps a task list item's `[x]` plus its text, and `TableDelimiter`
 * covers both the `|` separators and the whole `| --- | :-: |` row — both
 * verified against the real GFM tree rather than assumed.
 */
const TRANSPARENT_NODES = new Set([
  "Document",
  "Paragraph",
  "ATXHeading1", "ATXHeading2", "ATXHeading3", "ATXHeading4", "ATXHeading5", "ATXHeading6",
  "SetextHeading1", "SetextHeading2",
  "BulletList", "OrderedList", "ListItem", "Task",
  "Table", "TableHeader", "TableRow", "TableCell",
]);

/** Human-readable names for the rejection message; falls back to the node name. */
const PROTECTED_KIND_LABELS: Record<string, string> = {
  HeaderMark: "the heading marker",
  ListMark: "the list marker",
  TaskMarker: "the task checkbox",
  TableDelimiter: "table syntax",
  QuoteMark: "the blockquote marker",
  Blockquote: "a blockquote",
  FencedCode: "fenced code",
  CodeBlock: "indented code",
  InlineCode: "inline code",
  CodeMark: "inline code",
  Link: "a link",
  LinkMark: "a link",
  URL: "a link",
  Image: "an image",
  HTMLTag: "raw HTML",
  HTMLBlock: "raw HTML",
  Comment: "an HTML comment",
  CommentBlock: "an HTML comment",
  Emphasis: "emphasis syntax",
  StrongEmphasis: "emphasis syntax",
  EmphasisMark: "emphasis syntax",
  Strikethrough: "strikethrough syntax",
  HorizontalRule: "a horizontal rule",
  BlockID: "a block reference",
};

function protectedKind(nodeName: string): string {
  return PROTECTED_KIND_LABELS[nodeName] ?? nodeName;
}

function protectedRanges(source: string): Array<{ from: number; to: number; kind: string }> {
  const ranges: Array<{ from: number; to: number; kind: string }> = [];
  const frontmatter = getFrontMatterInfo(source);
  if (frontmatter.exists) ranges.push({ from: 0, to: frontmatter.contentStart, kind: "frontmatter" });
  // Lezer's inline parser intentionally ends a paragraph at a blank line.
  // Geode's math and comment delimiters do not, so pair them across the raw
  // document and conservatively treat an unclosed opener as extending to EOF.
  // Mask other parsed Markdown and Geode syntax separately for each delimiter
  // so literal delimiters cannot become false openers while keeping every
  // source offset unchanged.
  ranges.push(...delimitedSyntaxRanges(maskNonPlainDelimiterContexts(source, "$$"), "$$", "display math"));
  ranges.push(...delimitedSyntaxRanges(maskNonPlainDelimiterContexts(source, "%%"), "%%", "Obsidian comment"));
  commentMarkdownParser.parse(source).iterate({
    enter(node) {
      if (TRANSPARENT_NODES.has(node.name)) return;
      ranges.push({ from: node.from, to: node.to, kind: protectedKind(node.name) });
      // Inline HTML's tags are sibling nodes around their content. Treat the
      // containing paragraph conservatively, since text between paired tags
      // is still part of the raw HTML construct.
      if (node.name === "HTMLTag") {
        let parent = node.node.parent;
        while (parent && parent.name !== "Paragraph") parent = parent.parent;
        if (parent) ranges.push({ from: parent.from, to: parent.to, kind: "raw HTML" });
      }
    },
  });
  return ranges;
}

export function validateCommentRange(source: string, range: { from: number; to: number }): { from: number; to: number } {
  const { from, to } = range;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > source.length || from >= to) {
    throw new CommentFormatError("A comment requires a valid non-empty selection");
  }
  const parsed = parseCommentThreads(source);
  if (parsed.errors.length) throw new CommentFormatError("Repair malformed comment markers before adding another comment");
  for (const thread of parsed.threads) {
    if (from < thread.markerTo && to > thread.markerFrom) throw new CommentFormatError("Comment ranges cannot overlap existing comments");
  }
  // Valid Geode markers are storage metadata, not Markdown syntax. Mask them
  // before parsing so a marker at line start cannot turn the whole line into
  // a Lezer CommentBlock; masking preserves every source offset.
  for (const protectedRange of protectedRanges(maskCommentSyntax(source))) {
    if (from < protectedRange.to && to > protectedRange.from) {
      throw new CommentFormatError(`Comments are not supported inside ${protectedRange.kind}`);
    }
  }
  if (source.slice(from, to).includes("<!-- geode-comment")) throw new CommentFormatError("Selections cannot contain comment markers");
  const selected = source.slice(from, to);
  if (/\r?\n[ \t]*\r?\n/.test(selected)) throw new CommentFormatError("Comments must stay within one text block");
  // Block-level syntax (headings, list marks, table pipes) is the node walk's
  // job — it protects the exact marker spans instead of the whole construct, so
  // prose inside those blocks stays commentable. This regex only guards inline
  // delimiters, which the walk reports as spans but which can also be typed
  // unbalanced inside otherwise-plain text.
  if (/(?:\*\*|__|~~|`|\[|\]|!\[)/.test(selected)) {
    throw new CommentFormatError("Selections cannot contain structural Markdown syntax");
  }
  return { from, to };
}

/**
 * Best commentable sub-range of `range`, or `null` when nothing survives.
 *
 * A selection dragged across a heading's `#`, a list item's bullet, or a table
 * pipe is trimmed to the prose it overlaps instead of being rejected outright.
 * `validateCommentRange` stays the single authority on what is legal — every
 * candidate produced here is confirmed by it — so the two can never disagree.
 */
export function narrowCommentRange(
  source: string,
  range: { from: number; to: number },
): { from: number; to: number } | null {
  const from = Math.max(0, Math.min(source.length, Math.trunc(range.from)));
  const to = Math.max(0, Math.min(source.length, Math.trunc(range.to)));
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return null;

  // The whole selection is usually already legal; skip the subtraction work.
  try { return validateCommentRange(source, { from, to }); } catch { /* fall through */ }

  const parsed = parseCommentThreads(source);
  if (parsed.errors.length) return null;
  const blocked = [
    ...parsed.threads.map((thread) => ({ from: thread.markerFrom, to: thread.markerTo })),
    ...protectedRanges(maskCommentSyntax(source)),
  ]
    .filter((blockedRange) => blockedRange.from < to && blockedRange.to > from)
    .sort((a, b) => a.from - b.from);

  // Walk the gaps between blocked spans inside the selection.
  const candidates: Array<{ from: number; to: number }> = [];
  let cursor = from;
  for (const span of blocked) {
    if (span.from > cursor) candidates.push({ from: cursor, to: Math.min(span.from, to) });
    cursor = Math.max(cursor, span.to);
    if (cursor >= to) break;
  }
  if (cursor < to) candidates.push({ from: cursor, to });

  let best: { from: number; to: number } | null = null;
  for (const candidate of candidates) {
    // Trim whitespace the subtraction left behind (e.g. the space after `# `).
    let start = candidate.from;
    let end = Math.min(candidate.to, to);
    while (start < end && /\s/.test(source[start])) start += 1;
    while (end > start && /\s/.test(source[end - 1])) end -= 1;
    if (start >= end) continue;
    let confirmed: { from: number; to: number };
    try { confirmed = validateCommentRange(source, { from: start, to: end }); } catch { continue; }
    if (!best || confirmed.to - confirmed.from > best.to - best.from) best = confirmed;
  }
  return best;
}
