import { GFM, parser, type MarkdownConfig } from "@lezer/markdown";
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

const geodeMarkdownSyntax: MarkdownConfig = {
  defineNodes: ["WikiLink", "ObsidianTag", "Highlight", "TablePipe", "BlockID", "InlineMath", "ObsidianComment"],
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
        if (!/[ \t]/u.test(previous)) return -1;
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

function protectedRanges(source: string): Array<{ from: number; to: number; kind: string }> {
  const ranges: Array<{ from: number; to: number; kind: string }> = [];
  const frontmatter = getFrontMatterInfo(source);
  if (frontmatter.exists) ranges.push({ from: 0, to: frontmatter.contentStart, kind: "frontmatter" });
  commentMarkdownParser.parse(source).iterate({
    enter(node) {
      if (node.name === "Document" || node.name === "Paragraph") return;
      ranges.push({ from: node.from, to: node.to, kind: node.name });
      // Inline HTML's tags are sibling nodes around their content. Treat the
      // containing paragraph conservatively, since text between paired tags
      // is still part of the raw HTML construct.
      if (node.name === "HTMLTag" || node.name === "TablePipe") {
        let parent = node.node.parent;
        while (parent && parent.name !== "Paragraph") parent = parent.parent;
        if (parent) ranges.push({
          from: parent.from,
          to: parent.to,
          kind: node.name === "HTMLTag" ? "raw HTML" : "table syntax",
        });
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
  if (/(?:\*\*|__|~~|`|\[|\]|!\[)|(?:^|\n)#{1,6}[ \t]|(?:^|\n)[ \t]*(?:>|[-+*][ \t]|\d+[.)][ \t])/.test(selected)) {
    throw new CommentFormatError("Selections cannot contain structural Markdown syntax");
  }
  return { from, to };
}
