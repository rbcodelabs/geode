import { maskMarkdownCode } from "../wiki/code-mask";
import { selectLinkCandidates } from "../wiki/link-candidates";
import { decodeMarkdownDestination } from "../wiki/markdown-destination";
import { metadataMarkdownParser } from "../wiki/markdown-references";
import { isExternalReference } from "../wiki/metadata";
import { pathName, splitExt } from "./types";

/**
 * Pure planning for "move/rename a file or folder and keep links valid".
 * No I/O: callers (`App.moveVaultPath`) supply the vault's file list, the
 * move map and the candidate notes' text, and apply the returned rewrites.
 *
 * Principle: a link is rewritten only if it resolved to a file before the
 * move and its authored text no longer resolves to that same (possibly moved)
 * file afterwards. Anything that still resolves is left byte-identical,
 * preserving the author's link style.
 */

// ---------------------------------------------------------------- validation

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

/** Throws unless `path` is a plain vault-relative path (no absolute, `..`, hidden, empty or odd segments). */
export function assertVaultRelativePath(path: unknown, label: string): asserts path is string {
  if (typeof path !== "string" || !path) throw new Error(`${label} path must be a non-empty string`);
  if (path.startsWith("/")) throw new Error(`${label} path must be vault-relative, not absolute: "${path}"`);
  if (WINDOWS_DRIVE_RE.test(path)) throw new Error(`${label} path must be vault-relative, not a drive path: "${path}"`);
  if (path.includes("\\")) throw new Error(`${label} path must use "/" separators, not backslashes: "${path}"`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(path)) throw new Error(`${label} path contains control characters`);
  if (path.endsWith("/")) throw new Error(`${label} path must not end with "/": "${path}"`);
  for (const segment of path.split("/")) {
    if (!segment) throw new Error(`${label} path must not contain empty segments: "${path}"`);
    if (segment === "..") throw new Error(`${label} path must not contain "..": "${path}"`);
    if (segment === ".") throw new Error(`${label} path must not contain ".": "${path}"`);
    if (segment.startsWith(".")) throw new Error(`${label} path must not use hidden (dot-prefixed) names: "${path}"`);
  }
}

/** Pure checks on a requested move; existence checks against the vault live in the caller. */
export function assertValidMove(from: unknown, to: unknown): void {
  assertVaultRelativePath(from, "Source");
  assertVaultRelativePath(to, "Target");
  if (from === to) throw new Error(`Source and target are the same path: "${from}"`);
  if (to.startsWith(`${from}/`)) throw new Error(`Cannot move "${from}" into itself ("${to}")`);
}

/**
 * Old-path to new-path map for every FILE affected by moving `from` to `to`.
 * `files` is every vault file path; `isFolder` says whether `from` is a folder.
 */
export function collectMoves(files: readonly string[], from: string, to: string, isFolder: boolean): Map<string, string> {
  const moves = new Map<string, string>();
  if (!isFolder) {
    moves.set(from, to);
    return moves;
  }
  const prefix = `${from}/`;
  for (const file of files) if (file.startsWith(prefix)) moves.set(file, to + file.slice(from.length));
  return moves;
}

// ---------------------------------------------------------------- resolution

interface PathIndex {
  files: ReadonlySet<string>;
  byBasename: Map<string, string[]>;
  byAlias: Map<string, string[]>;
}

function buildIndex(paths: Iterable<string>): PathIndex {
  const files = new Set(paths);
  const byBasename = new Map<string, string[]>();
  const push = (key: string, path: string) => {
    const list = byBasename.get(key) ?? [];
    if (!list.includes(path)) list.push(path);
    byBasename.set(key, list);
  };
  for (const path of [...files].sort()) {
    const name = pathName(path);
    push(splitExt(name).basename.toLowerCase(), path);
    push(name.toLowerCase(), path);
  }
  return { files, byBasename, byAlias: new Map() };
}

/** Wikilink resolution; mirrors `MetadataCache.getFirstLinkpathDest` (minus aliases, which moves never affect). */
function resolveWiki(index: PathIndex, target: string, sourcePath: string): string | null {
  const { candidates } = selectLinkCandidates(
    target,
    sourcePath,
    { getFileByPath: (p) => (index.files.has(p) ? p : null), byBasename: index.byBasename, byAlias: index.byAlias },
    "desktop-compatibility",
  );
  return candidates[0] ?? null;
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Collapse `.`/`..`; null if it escapes the vault root or is empty. */
function normalizeJoin(dir: string, rel: string): string | null {
  const out: string[] = dir ? dir.split("/") : [];
  for (const segment of rel.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") { if (!out.length) return null; out.pop(); }
    else out.push(segment);
  }
  return out.length ? out.join("/") : null;
}

type MdMode = "relative" | "root";

/** Markdown link resolution: relative to the source's folder first, then vault-root-relative; `.md` optional. */
function resolveMarkdown(index: PathIndex, decoded: string, sourcePath: string): { dest: string; mode: MdMode } | null {
  const tries: [string | null, MdMode][] = [
    [normalizeJoin(dirOf(sourcePath), decoded), "relative"],
    [normalizeJoin("", decoded), "root"],
  ];
  for (const [candidate, mode] of tries) {
    if (!candidate) continue;
    if (index.files.has(candidate)) return { dest: candidate, mode };
    if (index.files.has(`${candidate}.md`)) return { dest: `${candidate}.md`, mode };
  }
  return null;
}

function relativePath(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split("/") : [];
  const b = to.split("/");
  let common = 0;
  while (common < a.length && common < b.length - 1 && a[common] === b[common]) common++;
  return [...a.slice(common).map(() => ".."), ...b.slice(common)].join("/");
}

// ------------------------------------------------------------------- rewrite

export interface PlanInput {
  /** Every vault file path BEFORE the move. */
  files: readonly string[];
  /** old path -> new path for every moved file. */
  moves: ReadonlyMap<string, string>;
  /** Notes to scan (old paths, current text). Notes not listed are assumed to need no change. */
  sources: readonly { path: string; text: string }[];
}

interface Edit { from: number; to: number; text: string }

const WIKILINK_RE = /(!)?\[\[([^\[\]\n]+)\]\]/g;

function isEscaped(text: string, position: number): boolean {
  let slashes = 0;
  for (let i = position - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

interface Ctx {
  oldIndex: PathIndex;
  newIndex: PathIndex;
  moved: (path: string) => string;
}

/** Returns old source path -> rewritten text, only for notes whose text changes. */
export function planLinkRewrites(input: PlanInput): Map<string, string> {
  const { moves } = input;
  const ctx: Ctx = {
    oldIndex: buildIndex(input.files),
    newIndex: buildIndex(input.files.map((p) => moves.get(p) ?? p)),
    moved: (p) => moves.get(p) ?? p,
  };
  const result = new Map<string, string>();

  for (const source of input.sources) {
    const oldPath = source.path;
    const newPath = ctx.moved(oldPath);
    const edits: Edit[] = [
      ...wikilinkEdits(source.text, oldPath, newPath, ctx),
      ...markdownEdits(source.text, oldPath, newPath, ctx),
    ].sort((a, b) => a.from - b.from);
    const kept: Edit[] = [];
    for (const edit of edits) if (!kept.length || edit.from >= kept[kept.length - 1].to) kept.push(edit);
    if (!kept.length) continue;
    let text = source.text;
    for (let i = kept.length - 1; i >= 0; i--) text = text.slice(0, kept[i].from) + kept[i].text + text.slice(kept[i].to);
    if (text !== source.text) result.set(oldPath, text);
  }
  return result;
}

function wikilinkEdits(text: string, oldPath: string, newPath: string, ctx: Ctx): Edit[] {
  const masked = maskMarkdownCode(text);
  const edits: Edit[] = [];
  for (const match of masked.matchAll(WIKILINK_RE)) {
    const start = match.index!;
    if (isEscaped(masked, start)) continue;
    const inner = match[2];
    const innerStart = start + match[0].indexOf("[[") + 2;
    const pipe = inner.indexOf("|");
    const left = pipe < 0 ? inner : inner.slice(0, pipe);
    const sub = left.search(/[#^]/);
    const rawTarget = sub < 0 ? left : left.slice(0, sub);
    const target = rawTarget.trim();
    if (!target || isExternalReference(target)) continue;
    const dest = resolveWiki(ctx.oldIndex, target, oldPath);
    if (!dest) continue;
    const newDest = ctx.moved(dest);
    if (resolveWiki(ctx.newIndex, target, newPath) === newDest) continue;
    const lead = rawTarget.length - rawTarget.trimStart().length;
    edits.push({ from: innerStart + lead, to: innerStart + lead + target.length, text: newWikiTarget(target, newDest, newPath, ctx.newIndex) });
  }
  return edits;
}

function newWikiTarget(oldTarget: string, newDest: string, sourcePath: string, newIndex: PathIndex): string {
  const keepExt = !newDest.endsWith(".md") || oldTarget.toLowerCase().endsWith(".md");
  const shape = (p: string) => (keepExt ? p : p.slice(0, -3));
  if (!oldTarget.includes("/")) {
    const byName = shape(pathName(newDest));
    if (resolveWiki(newIndex, byName, sourcePath) === newDest) return byName;
  }
  return shape(newDest);
}

function markdownEdits(text: string, oldPath: string, newPath: string, ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  const tree = metadataMarkdownParser.parse(text);
  tree.iterate({
    enter(node) {
      if (node.name !== "Link" && node.name !== "Image" && node.name !== "LinkReference") return;
      const url = node.node.getChild("URL");
      if (!url) return;
      const raw = text.slice(url.from, url.to);
      const replacement = rewriteMarkdownDestination(raw, oldPath, newPath, ctx);
      if (replacement !== null && replacement !== raw) edits.push({ from: url.from, to: url.to, text: replacement });
    },
  });
  return edits;
}

function rewriteMarkdownDestination(raw: string, oldPath: string, newPath: string, ctx: Ctx): string | null {
  const angle = raw.length >= 2 && raw.startsWith("<") && raw.endsWith(">");
  const body = angle ? raw.slice(1, -1) : raw;
  const hash = body.indexOf("#");
  const pathPart = hash < 0 ? body : body.slice(0, hash);
  const suffix = hash < 0 ? "" : body.slice(hash);
  if (!pathPart) return null;
  const decoded = decodeMarkdownDestination(pathPart);
  if (!decoded || isExternalReference(decoded)) return null;
  const old = resolveMarkdown(ctx.oldIndex, decoded, oldPath);
  if (!old) return null;
  const newDest = ctx.moved(old.dest);
  if (resolveMarkdown(ctx.newIndex, decoded, newPath)?.dest === newDest) return null;

  const hadLeadingSlash = decoded.startsWith("/");
  const hadDotSlash = decoded.startsWith("./");
  const keepExt = !newDest.endsWith(".md") || decoded.toLowerCase().endsWith(".md");
  const shape = (p: string) => (keepExt ? p : p.slice(0, -3));
  const relative = () => {
    const rel = relativePath(dirOf(newPath), newDest);
    return shape(hadDotSlash && !rel.startsWith("../") ? `./${rel}` : rel);
  };
  const root = () => shape(hadLeadingSlash ? `/${newDest}` : newDest);
  const order = old.mode === "relative" ? [relative, root] : [root, relative];
  let chosen = order[0]();
  for (const make of order) {
    const candidate = make();
    if (resolveMarkdown(ctx.newIndex, decodeMarkdownDestination(candidate), newPath)?.dest === newDest) { chosen = candidate; break; }
  }

  const wasEncoded = /%[0-9A-Fa-f]{2}/.test(pathPart);
  const encoded = wasEncoded ? chosen.split("/").map((s) => (s === ".." || s === "." ? s : encodeURIComponent(s))).join("/") : chosen;
  const needsAngle = !wasEncoded && /[\s()<>]/.test(encoded);
  return angle || needsAngle ? `<${encoded}${suffix}>` : `${encoded}${suffix}`;
}
