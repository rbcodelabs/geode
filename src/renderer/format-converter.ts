/**
 * Pure conversion logic for the "Format converter" core plugin. Free of DOM and
 * vault globals so every rule can be unit-tested; the plugin supplies file IO.
 *
 * Conversions follow docs/spec/02-core-plugins.md "Format converter". Text in
 * fenced code blocks, inline code and (for body conversions) frontmatter is
 * never rewritten.
 */

export type ZettelkastenLinkStyle = "full" | "pretty";

export interface FormatConverterOptions {
  roamTags: boolean;
  roamHighlights: boolean;
  roamTodos: boolean;
  bearHighlights: boolean;
  /** Rewrite `[[UID]]` links; `null` leaves them alone. */
  zettelkasten: ZettelkastenLinkStyle | null;
  /** `alias`/`tag`/`cssclass` -> `aliases`/`tags`/`cssclasses`. */
  properties: boolean;
}

/**
 * The spec does not say how a UID is recognised. Geode treats a note as
 * UID-prefixed when its name starts with 12-14 digits followed by a space
 * (the common `YYYYMMDDHHmm[ss]` Zettelkasten id).
 */
export const DEFAULT_ZETTEL_UID_PATTERN = "\\d{12,14}";

export const DEFAULT_CONVERTER_OPTIONS: FormatConverterOptions = {
  roamTags: false,
  roamHighlights: false,
  roamTodos: false,
  bearHighlights: false,
  zettelkasten: null,
  properties: false,
};

/** Maps a Zettelkasten UID to its note's full basename (`UID File Name`). */
export type ZettelIndex = Map<string, string>;

interface Segment {
  text: string;
  /** Protected segments (code) are emitted untouched. */
  protected: boolean;
}

export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { frontmatter: "", body: text };
  return { frontmatter: match[0], body: text.slice(match[0].length) };
}

/** Split a body into code (fenced / inline, protected) and prose segments. */
function segmentBody(body: string): Segment[] {
  const segments: Segment[] = [];
  const lines = body.split(/(?<=\n)/);
  let prose = "";
  let fence: { char: string; len: number } | null = null;
  let fenced = "";
  const flushProse = () => {
    if (prose) segments.push(...splitInlineCode(prose));
    prose = "";
  };
  for (const line of lines) {
    if (fence) {
      fenced += line;
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        segments.push({ text: fenced, protected: true });
        fenced = "";
        fence = null;
      }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      flushProse();
      fence = { char: open[1][0], len: open[1].length };
      fenced = line;
      continue;
    }
    prose += line;
  }
  if (fence) segments.push({ text: fenced, protected: true });
  flushProse();
  return segments;
}

function splitInlineCode(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), protected: false });
    out.push({ text: m[0], protected: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), protected: false });
  return out;
}

/** Roam `#tag` and `#[[tag]]` -> `[[tag]]`. Headings (`# x`), mid-word and numeric `#` are untouched. */
export function convertRoamTags(text: string): string {
  return text
    .replace(/(^|[^\w&/#\\[])#\[\[([^\]\n]+)\]\]/g, "$1[[$2]]")
    .replace(/(^|[^\w&/#\\[(])#([\p{L}\p{N}_][\p{L}\p{N}_-]*)/gu, (match, pre: string, tag: string) =>
      /^\d+$/.test(tag) ? match : `${pre}[[${tag}]]`
    );
}

/** Roam `^^highlight^^` -> `==highlight==`. */
export function convertRoamHighlights(text: string): string {
  return text.replace(/\^\^(?=\S)([^\n]*?\S)\^\^/g, "==$1==");
}

/** Roam `{{[[TODO]]}}` -> `[ ]`. */
export function convertRoamTodos(text: string): string {
  return text.replace(/\{\{\[\[TODO\]\]\}\}/g, "[ ]");
}

/** Bear `::highlight::` -> `==highlight==`. */
export function convertBearHighlights(text: string): string {
  return text.replace(/::(?=\S)([^\n:]*?\S)::/g, "==$1==");
}

/** Build the UID -> `UID File Name` index from vault note basenames. */
export function buildZettelIndex(basenames: string[], uidPattern = DEFAULT_ZETTEL_UID_PATTERN): ZettelIndex {
  const re = new RegExp(`^(${uidPattern})\\s+\\S.*$`);
  const index: ZettelIndex = new Map();
  for (const name of basenames) {
    const m = re.exec(name);
    if (m && !index.has(m[1])) index.set(m[1], name);
  }
  return index;
}

/**
 * `[[UID]]` -> `[[UID File Name]]` (full) or `[[UID File Name|File Name]]`
 * (pretty). Links whose UID has no matching note, and links that already carry
 * an alias or subpath, are left alone.
 */
export function convertZettelkastenLinks(
  text: string,
  style: ZettelkastenLinkStyle,
  index: ZettelIndex
): string {
  return text.replace(/\[\[([^\]|#^\n]+)\]\]/g, (match, uid: string) => {
    const full = index.get(uid);
    if (!full) return match;
    if (style === "full") return `[[${full}]]`;
    return `[[${full}|${full.slice(uid.length).trimStart()}]]`;
  });
}

function bodyConvert(text: string, options: FormatConverterOptions, index: ZettelIndex): string {
  const apply = (s: string): string => {
    let out = s;
    // Todos first: `{{[[TODO]]}}` contains `[[TODO]]`, which must not be read as a tag.
    if (options.roamTodos) out = convertRoamTodos(out);
    if (options.roamTags) out = convertRoamTags(out);
    if (options.roamHighlights) out = convertRoamHighlights(out);
    if (options.bearHighlights) out = convertBearHighlights(out);
    if (options.zettelkasten) out = convertZettelkastenLinks(out, options.zettelkasten, index);
    return out;
  };
  return segmentBody(text)
    .map((seg) => (seg.protected ? seg.text : apply(seg.text)))
    .join("");
}

const LIST_PROPERTIES: Array<{ from: string; to: string; split: RegExp | null }> = [
  { from: "alias", to: "aliases", split: null },
  { from: "tag", to: "tags", split: /[,\s]+/ },
  { from: "cssclass", to: "cssclasses", split: /[,\s]+/ },
];

/** Migrate deprecated singular properties to their list forms in a frontmatter block. */
export function migrateProperties(frontmatter: string): string {
  if (!frontmatter) return frontmatter;
  const eol = frontmatter.includes("\r\n") ? "\r\n" : "\n";
  const lines = frontmatter.split(/\r?\n/);
  let close = lines.length - 1;
  while (close > 0 && lines[close].trim() !== "---") close -= 1;
  if (close <= 0) return frontmatter;
  const existing = new Set<string>();
  for (let i = 1; i < close; i += 1) {
    const m = /^([A-Za-z_][\w-]*)\s*:/.exec(lines[i]);
    if (m) existing.add(m[1]);
  }
  const out: string[] = [lines[0]];
  for (let i = 1; i < close; i += 1) {
    const line = lines[i];
    const m = /^([A-Za-z_][\w-]*)\s*:[ \t]*(.*?)[ \t]*$/.exec(line);
    const spec = m ? LIST_PROPERTIES.find((p) => p.from === m[1]) : undefined;
    if (!m || !spec || existing.has(spec.to)) {
      out.push(line);
      continue;
    }
    const value = m[2];
    if (value === "" || value.startsWith("[") || value === "|" || value === ">") {
      // Already a block or flow list: only the key changes.
      out.push(`${spec.to}:${value ? ` ${value}` : ""}`);
      continue;
    }
    const quoted = /^(["']).*\1$/.test(value);
    const parts = spec.split && !quoted ? value.split(spec.split) : [value];
    out.push(`${spec.to}:`);
    for (let part of parts) {
      if (spec.to === "tags") part = part.replace(/^#/, "");
      if (part) out.push(`  - ${part}`);
    }
  }
  out.push(...lines.slice(close));
  return out.join(eol);
}

/** Apply every enabled conversion to one note's text. */
export function convertNote(text: string, options: FormatConverterOptions, index: ZettelIndex = new Map()): string {
  const { frontmatter, body } = splitFrontmatter(text);
  const newFrontmatter = options.properties ? migrateProperties(frontmatter) : frontmatter;
  return newFrontmatter + bodyConvert(body, options, index);
}

export interface ConvertVaultResult {
  scanned: number;
  changed: string[];
  failed: Array<{ path: string; message: string }>;
}

export interface ConvertVaultIO {
  files: Array<{ path: string; basename: string }>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

/** Convert every note once, writing only files whose text changed. */
export async function convertVault(
  io: ConvertVaultIO,
  options: FormatConverterOptions,
  uidPattern = DEFAULT_ZETTEL_UID_PATTERN
): Promise<ConvertVaultResult> {
  const index = options.zettelkasten ? buildZettelIndex(io.files.map((f) => f.basename), uidPattern) : new Map();
  const result: ConvertVaultResult = { scanned: 0, changed: [], failed: [] };
  for (const file of io.files) {
    result.scanned += 1;
    try {
      const before = await io.read(file.path);
      const after = convertNote(before, options, index);
      if (after !== before) {
        await io.write(file.path, after);
        result.changed.push(file.path);
      }
    } catch (error) {
      result.failed.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export function anyConversionEnabled(o: FormatConverterOptions): boolean {
  return o.roamTags || o.roamHighlights || o.roamTodos || o.bearHighlights || o.zettelkasten !== null || o.properties;
}
