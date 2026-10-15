import { parser } from "@lezer/markdown";
import { parseMetadata } from "../wiki/metadata";
import { FRONTMATTER_BLOCK_RE } from "../wiki/constants";

export interface OutgoingTarget { path: string; basename: string; aliases: readonly string[] }
export interface OutgoingMention { targetPath: string; from: number; to: number; text: string; snippet: string }
export interface OutgoingReference { link: string; displayText: string; count: number }

/** Uses the existing metadata parser; Markdown-link graph support is tracked separately. */
export function outgoingReferences(text: string): OutgoingReference[] {
  const metadata = parseMetadata(text);
  const entries = new Map<string, OutgoingReference>();
  for (const ref of [...metadata.links, ...metadata.embeds].sort((a, b) => a.position.start.offset - b.position.start.offset)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref.link) || ref.link.startsWith("//")) continue;
    const existing = entries.get(ref.link);
    if (existing) existing.count++;
    else entries.set(ref.link, { link: ref.link, displayText: ref.displayText || ref.link, count: 1 });
  }
  return [...entries.values()];
}

/** Exclude authored links/frontmatter while deliberately leaving code mentions eligible. */
function maskLinkedSpans(text: string): string {
  const spans: [number, number][] = [];
  const frontmatter = FRONTMATTER_BLOCK_RE.exec(text);
  if (frontmatter) spans.push([0, frontmatter[0].length]);
  for (const match of text.matchAll(/!?\[\[[^\[\]\n]+\]\]/g)) spans.push([match.index, match.index + match[0].length]);
  parser.parse(text).iterate({ enter(node) {
    if (["Link", "Image", "LinkReference", "LinkReferenceDefinition", "Autolink"].includes(node.name)) {
      spans.push([node.from, node.to]); return false;
    }
  } });
  // Markdown inside a code block has no Link nodes. Mask that authored syntax too,
  // so a second click can never nest links inside a converted code mention.
  for (const match of text.matchAll(/!?\[[^\]\n]*\](?:\([^\n]*?\)|\[[^\]\n]*\])/g)) spans.push([match.index, match.index + match[0].length]);
  const chars = text.split("");
  for (const [from, to] of spans) for (let i = from; i < to; i++) if (chars[i] !== "\n") chars[i] = " ";
  return chars.join("");
}

const word = /[\p{L}\p{N}\p{M}_]/u;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) { const error = new Error("Outgoing links scan cancelled"); error.name = "AbortError"; throw error; }
}

export async function findOutgoingMentions(
  text: string, sourcePath: string, targets: Iterable<OutgoingTarget>,
  options: { signal?: AbortSignal; excluded?: (path: string) => boolean; yieldControl?: () => Promise<void> } = {},
): Promise<OutgoingMention[]> {
  abortIfNeeded(options.signal);
  const available = maskLinkedSpans(text);
  const matches: OutgoingMention[] = [];
  let visited = 0;
  const yieldControl = options.yieldControl ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  for (const target of targets) {
    if (++visited % 128 === 0) { await yieldControl(); abortIfNeeded(options.signal); }
    if (target.path === sourcePath || options.excluded?.(target.path)) continue;
    const seen = new Set<string>();
    for (const name of new Set([target.basename, ...target.aliases])) {
      if (!name || name.includes("\n")) continue;
      // RegExp case folding preserves UTF-16 source offsets even for Unicode.
      const expression = new RegExp(escape(name), "giu");
      for (const match of available.matchAll(expression)) {
        const from = match.index, to = from + match[0].length;
        const before = Array.from(available.slice(Math.max(0, from - 2), from)).at(-1) ?? "";
        const after = Array.from(available.slice(to, to + 2))[0] ?? "";
        if ((word.test(Array.from(name)[0]) && word.test(before)) || (word.test(Array.from(name).at(-1)!) && word.test(after))) continue;
        const key = `${from}:${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({ targetPath: target.path, from, to, text: text.slice(from, to),
          snippet: text.slice(Math.max(text.lastIndexOf("\n", from - 1) + 1, from - 60), Math.min(text.indexOf("\n", to) < 0 ? text.length : text.indexOf("\n", to), to + 80)) });
      }
    }
  }
  abortIfNeeded(options.signal);
  matches.sort((a, b) => a.from - b.from || b.to - a.to || a.targetPath.localeCompare(b.targetPath));
  // Longest overlapping name wins; identical spans retain all ambiguous targets.
  const result: OutgoingMention[] = [];
  let coveredTo = -1, lastFrom = -1, lastTo = -1;
  for (const match of matches) {
    if (match.from < coveredTo && (match.from !== lastFrom || match.to !== lastTo)) continue;
    result.push(match); coveredTo = match.to; lastFrom = match.from; lastTo = match.to;
  }
  return result;
}

export function mentionStillCurrent(snapshot: string, current: string, mention: Pick<OutgoingMention, "from" | "to" | "text">): boolean {
  return snapshot === current && mention.from >= 0 && mention.to <= current.length && mention.to > mention.from && current.slice(mention.from, mention.to) === mention.text;
}
