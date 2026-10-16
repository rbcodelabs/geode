import { scanFootnotes } from "../wiki/footnote-scan";
import { maskMarkdownCode } from "../wiki/code-mask";

// The shared scanner still checks definition membership per reference. Keep its
// synchronous workload small rather than adding a second footnote parser here.
const SOURCE_LIMIT = 8192;
const ROW_LIMIT = 200;
export interface FootnotePaneItem {
  key: string; label: string; text: string; references: number; missing: boolean;
  from: number; to: number; editFrom: number; editTo: number; editable: boolean;
}
export interface FootnotePaneProjection { items: FootnotePaneItem[]; limited: boolean; scannedCharacters: number }

export async function projectFootnotes(text: string, options: { signal?: AbortSignal; yieldControl?: () => Promise<void> } = {}): Promise<FootnotePaneProjection> {
  const check = () => { if (options.signal?.aborted) { const error = new Error("Footnotes scan cancelled"); error.name = "AbortError"; throw error; } };
  const yieldControl = options.yieldControl ?? (() => new Promise<void>(resolve => setTimeout(resolve, 0)));
  check(); await yieldControl(); check();
  const source = text.slice(0, SOURCE_LIMIT);
  let limited = source.length < text.length;
  const frontmatter = /^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?---(?:\r?\n|$)/.exec(source);
  if (!frontmatter && /^\uFEFF?---\r?\n/.test(source)) return { items: [], limited, scannedCharacters: source.length };
  const start = frontmatter?.[0].length ?? 0;
  const scan = scanFootnotes(source, start);
  const items: (FootnotePaneItem & { order: number })[] = [];
  const counts = new Map<string, number>();
  for (const reference of scan.references) if (reference.kind === "ref") counts.set(reference.id, (counts.get(reference.id) ?? 0) + 1);
  for (const definition of scan.definitions) {
    let editFrom = definition.labelTo, editTo = definition.to;
    while (/[ \t]/.test(source[editFrom] ?? "") && editFrom < editTo) editFrom++;
    if (source[editTo - 1] === "\r") editTo--;
    items.push({ key: `definition:${definition.id}`, label: String(definition.number ?? definition.id), text: definition.text,
      references: counts.get(definition.id) ?? 0, missing: false, from: definition.from, to: definition.to,
      editFrom, editTo, editable: !(limited && !source.slice(definition.to).trim()), order: definition.number ?? Number.MAX_SAFE_INTEGER });
  }
  for (const reference of scan.references) if (reference.kind === "inline") items.push({
    key: `inline:${reference.from}`, label: String(reference.number), text: reference.text, references: 1, missing: false,
    from: reference.from, to: reference.to, editFrom: reference.from + 2, editTo: reference.to - 1, editable: true, order: reference.number,
  });
  items.sort((a, b) => a.order - b.order || a.from - b.from);

  const defined = new Set(scan.definitions.map(definition => definition.id));
  const missing = new Map<string, FootnotePaneItem>();
  const masked = maskMarkdownCode(source);
  let definitionIndex = 0;
  // Undefined references remain literal in the shared rendering scanner. Expose
  // their state without pretending that an absent definition has editable text.
  for (const match of masked.matchAll(/\[\^([^\[\]\s]+)\](?!:)/g)) {
    const from = match.index;
    if (from < start || source[from - 1] === "\\" || defined.has(match[1])) continue;
    while (definitionIndex < scan.definitions.length && scan.definitions[definitionIndex].to <= from) definitionIndex++;
    const definition = scan.definitions[definitionIndex];
    if (definition && from >= definition.from && from < definition.to) continue;
    const existing = missing.get(match[1]);
    if (existing) { existing.references++; continue; }
    missing.set(match[1], { key: `missing:${match[1]}`, label: match[1], text: limited ? "Definition not found in scanned text." : "Definition not found.",
      references: 1, missing: true, from, to: from + match[0].length, editFrom: from, editTo: from, editable: false });
  }
  await yieldControl(); check();
  const all: FootnotePaneItem[] = [...items, ...missing.values()];
  if (all.length > ROW_LIMIT) limited = true;
  return { items: all.slice(0, ROW_LIMIT), limited, scannedCharacters: source.length };
}
