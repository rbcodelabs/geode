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

const OPEN_RE = /<!-- geode-comment:v1 id="([^"]+)" data="([A-Za-z0-9_-]+)" -->/g;

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
  OPEN_RE.lastIndex = 0;
  for (let match = OPEN_RE.exec(source); match; match = OPEN_RE.exec(source)) {
    const openFrom = match.index;
    const openTo = openFrom + match[0].length;
    const closeMarker = `<!-- geode-comment-end:${match[1]} -->`;
    const closeFrom = source.indexOf(closeMarker, openTo);
    if (closeFrom < 0) {
      errors.push({ from: openFrom, to: openTo, message: `Comment ${match[1]} has no closing marker` });
      continue;
    }
    try {
      const payload = decodePayload(match[2]);
      const closeTo = closeFrom + closeMarker.length;
      threads.push({
        id: match[1], ...payload,
        from: openTo, to: closeFrom,
        markerFrom: openFrom, markerTo: closeTo,
        openFrom, openTo, closeFrom, closeTo,
        anchorText: source.slice(openTo, closeFrom),
        detached: openTo === closeFrom,
      });
      OPEN_RE.lastIndex = closeTo;
    } catch (error) {
      errors.push({ from: openFrom, to: openTo, message: `Comment ${match[1]} is malformed: ${String(error)}` });
    }
  }
  return { threads, errors };
}

export function stripCommentMetadata(source: string): string {
  const parsed = parseCommentThreads(source);
  if (!parsed.threads.length) return source;
  let result = source;
  for (const thread of [...parsed.threads].sort((a, b) => b.markerFrom - a.markerFrom)) {
    result = result.slice(0, thread.closeFrom) + result.slice(thread.closeTo);
    result = result.slice(0, thread.openFrom) + result.slice(thread.openTo);
  }
  return result;
}

/** Hide valid marker bytes while preserving UTF-16 offsets and line endings for metadata positions. */
export function maskCommentMetadata(source: string): string {
  const parsed = parseCommentThreads(source);
  let result = source;
  const blank = (value: string) => value.replace(/[^\r\n]/g, " ");
  for (const thread of [...parsed.threads].sort((a, b) => b.markerFrom - a.markerFrom)) {
    result = result.slice(0, thread.closeFrom) + blank(result.slice(thread.closeFrom, thread.closeTo)) + result.slice(thread.closeTo);
    result = result.slice(0, thread.openFrom) + blank(result.slice(thread.openFrom, thread.openTo)) + result.slice(thread.openTo);
  }
  return result;
}

function protectedRanges(source: string): Array<{ from: number; to: number; kind: string }> {
  const ranges: Array<{ from: number; to: number; kind: string }> = [];
  const addMatches = (re: RegExp, kind: string, group = 0) => {
    for (const match of source.matchAll(re)) {
      const wholeFrom = match.index!;
      const relative = group ? match[0].indexOf(match[group]) : 0;
      ranges.push({ from: wholeFrom + relative, to: wholeFrom + relative + match[group].length, kind });
    }
  };
  const frontmatter = source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (frontmatter) ranges.push({ from: 0, to: frontmatter[0].length, kind: "frontmatter" });
  addMatches(/```[\s\S]*?(?:```|$)/g, "fenced code");
  addMatches(/`[^`\n]*`/g, "inline code");
  addMatches(/<!--(?! geode-comment:)[\s\S]*?-->/g, "HTML comment");
  addMatches(/\[[^\]\n]*\]\(([^)\n]*)\)/g, "link destination", 1);
  addMatches(/^(?: {0,3}(?:#{1,6}\s+|>|[-+*]\s+|\d+[.)]\s+|```)|\s*\|)/gm, "structural Markdown");
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
  for (const protectedRange of protectedRanges(source)) {
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
