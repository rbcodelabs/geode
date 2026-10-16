import { buildLineStarts, parseMetadata } from "../wiki/metadata";
import { FRONTMATTER_BLOCK_RE } from "../wiki/constants";

export interface OutgoingTarget { path: string; basename: string; aliases: readonly string[] }
export interface OutgoingMention { targetPath: string; from: number; to: number; text: string; snippet: string }
export interface OutgoingMentionResult { mentions: OutgoingMention[]; limited: boolean; scannedCharacters: number }
const MAX_SOURCE_CHARACTERS = 128 * 1024;
const MAX_VISIBLE_MENTIONS = 500;

export interface OutgoingReference { link: string; displayText: string; count: number }

/** Uses the shared metadata parser for authored wiki and Markdown references. */
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
function maskLinkedSpans(text: string, truncated: boolean): string {
  const spans: [number, number][] = [];
  const frontmatter = FRONTMATTER_BLOCK_RE.exec(text);
  if (frontmatter) spans.push([0, frontmatter[0].length]);
  // A closing YAML delimiter may be outside the bounded prefix. Its values
  // must never become editable suggestions merely because their context was cut.
  else if (truncated && /^---\r?\n/.test(text)) spans.push([0, text.length]);
  for (const match of text.matchAll(/!?\[\[[^\[\]\n]+\]\]/g)) spans.push([match.index, match.index + match[0].length]);
  // One forward pass for Markdown syntax. Incomplete destinations consume their
  // tail once rather than rescanning it from every unmatched opening bracket.
  // This masks spans only; the shared metadata parser still owns parsed Links.
  const labels: number[] = [];
  const shortcutCandidates: { from: number; to: number }[] = [];
  const definitions = new Set<string>();
  const normalizeLabel = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "[") { labels.push(i); continue; }
    if (text[i] === "]" && labels.length) {
      const from = labels.pop()!;
      if (text[i + 1] === "(") {
        let end = i + 2, depth = 1;
        for (; end < text.length; end++) {
          if (text[end] === "\\") { end++; continue; }
          if (text[end] === "(") depth++;
          else if (text[end] === ")" && --depth === 0) break;
        }
        spans.push([from, Math.min(end + 1, text.length)]);
        i = end;
      } else if (text[i + 1] === "[") {
        let end = i + 2;
        while (end < text.length && !"[]\n".includes(text[end])) end++;
        if (text[end] === "]") spans.push([from, end + 1]);
        i = text[end] === "]" ? end : end - 1;
      } else if (text[i + 1] === ":") {
        if (i - from <= 1000) definitions.add(normalizeLabel(text.slice(from + 1, i)));
        let end = i + 2;
        while (end < text.length && text[end] !== "\n") end++;
        spans.push([from, end]); i = end;
      } else shortcutCandidates.push({ from, to: i + 1 });
    } else if (text[i] === "<") {
      let end = i + 1;
      while (end < text.length && !"<>\n".includes(text[end])) end++;
      if (text[end] === ">") spans.push([i, end + 1]);
      i = text[end] === ">" ? end : end - 1;
    }
  }
  for (const candidate of shortcutCandidates) {
    // Reference labels are at most 999 characters. Retain only offsets while
    // scanning so nested bracket runs cannot allocate quadratic substrings.
    if (truncated || (definitions.size && candidate.to - candidate.from <= 1001 &&
        definitions.has(normalizeLabel(text.slice(candidate.from + 1, candidate.to - 1))))) {
      spans.push([candidate.from, candidate.to]);
    }
  }
  // The omitted suffix may close an authored wikilink/Markdown label. Never
  // convert a candidate whose label context extends beyond the inspected text.
  if (truncated && labels.length) spans.push([labels[0], text.length]);
  const chars = text.split("");
  spans.sort((a, b) => a[0] - b[0]);
  let maskedTo = 0;
  for (const [from, to] of spans) {
    for (let i = Math.max(from, maskedTo); i < to; i++) if (chars[i] !== "\n") chars[i] = " ";
    maskedTo = Math.max(maskedTo, to);
  }
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
): Promise<OutgoingMentionResult> {
  abortIfNeeded(options.signal);
  const source = text.slice(0, MAX_SOURCE_CHARACTERS);
  let limited = source.length < text.length;
  const yieldControl = options.yieldControl ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  const cooperate = async () => { await yieldControl(); abortIfNeeded(options.signal); };
  // Bound the synchronous parser/masking phase, with cancellation checkpoints on
  // both sides. Candidate scans have an independent byte/match work budget below.
  if (source.length >= 8192) await cooperate();
  const available = maskLinkedSpans(source, limited);
  if (source.length >= 8192) await cooperate();
  const lineStarts = buildLineStarts(source);
  const lineAt = (offset: number) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >>> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const matches: OutgoingMention[] = [];
  let visited = 0, work = 0;
  targetScan: for (const target of targets) {
    if (++visited % 128 === 0) await cooperate();
    if (target.path === sourcePath || options.excluded?.(target.path)) continue;
    const seen = new Set<string>();
    for (const name of new Set([target.basename, ...target.aliases])) {
      if (!name.trim() || name.includes("\n") || name.length > available.length) continue;
      work += available.length;
      if (work >= 32768) { work = 0; await cooperate(); }
      const first = Array.from(name)[0], last = Array.from(name).at(-1)!;
      // RegExp case folding preserves UTF-16 source offsets even for Unicode.
      const expression = new RegExp(escape(name), "giu");
      for (const match of available.matchAll(expression)) {
        work += 1024;
        if (work >= 32768) { work = 0; await cooperate(); }
        const from = match.index, to = from + match[0].length;
        if (source.slice(from, to) !== match[0]) continue;
        const before = Array.from(text.slice(Math.max(0, from - 2), from)).at(-1) ?? "";
        const after = Array.from(text.slice(to, to + 2))[0] ?? "";
        if ((word.test(first) && word.test(before)) || (word.test(last) && word.test(after))) continue;
        const key = `${from}:${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const line = lineAt(from);
        matches.push({ targetPath: target.path, from, to, text: source.slice(from, to),
          snippet: source.slice(Math.max(lineStarts[line], from - 60), Math.min(lineStarts[line + 1] === undefined ? source.length : lineStarts[line + 1] - 1, to + 80)) });
        if (matches.length === MAX_VISIBLE_MENTIONS) { limited = true; break targetScan; }
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
  return { mentions: result, limited, scannedCharacters: source.length };
}

export function mentionStillCurrent(snapshot: string, current: string, mention: Pick<OutgoingMention, "from" | "to" | "text">): boolean {
  return snapshot === current && mention.from >= 0 && mention.to <= current.length && mention.to > mention.from && current.slice(mention.from, mention.to) === mention.text;
}
