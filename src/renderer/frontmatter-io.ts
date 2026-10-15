import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { FRONTMATTER_BLOCK_OPTIONAL_BODY_RE } from "../wiki/constants";
import type { TFile } from "./types";
import type { DataWriteOptions } from "./vault";

/**
 * The rewrite-side frontmatter pattern, owned by the portable engine. Unlike
 * the read-side pattern it also matches an empty block, so rewriting replaces
 * it instead of prepending a second one.
 */
const FM_RE = FRONTMATTER_BLOCK_OPTIONAL_BODY_RE;

/**
 * Narrow slice of `Vault` (see `src/renderer/vault.ts`) — just enough to
 * read and rewrite one file's contents.
 */
export interface VaultWriter {
  read(file: TFile): Promise<string>;
  modify(file: TFile, data: string, options?: DataWriteOptions): Promise<void>;
}

function newlineStyle(text: string): "\n" | "\r\n" {
  return text.match(/\r?\n/)?.[0] === "\r\n" ? "\r\n" : "\n";
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  return typeof (value as { then?: unknown }).then === "function";
}

/**
 * Pure text transform: parse `text`'s frontmatter block (if any) into a
 * plain object, run `mutate` on it, and splice the re-stringified result
 * back in. Mirrors `writeFrontmatter()` in `markdown/live-preview.ts` (same
 * delimiter regex, same "no properties left -> remove the block and its
 * trailing newline" behavior) but works on plain text instead of a live
 * CodeMirror `EditorView`, so it doesn't need an open editor.
 */
export function patchFrontmatterText(text: string, mutate: (fm: Record<string, unknown>) => unknown): string {
  const match = text.match(FM_RE);

  let fm: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed = parseYaml(match[1] ?? "");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) fm = parsed as Record<string, unknown>;
    } catch {
      // Malformed existing frontmatter YAML: mutate() starts from an empty object.
    }
  }

  const mutationResult = mutate(fm);
  if (isThenable(mutationResult)) {
    // The public callback contract is synchronous. Consume a later rejection
    // so an accidentally async callback cannot also create an unhandled one.
    void Promise.resolve(mutationResult).catch(() => undefined);
    throw new TypeError("FileManager.processFrontMatter requires a synchronous callback; received a thenable");
  }

  const hasProps = Object.keys(fm).length > 0;
  const newline = newlineStyle(text);
  const yaml = hasProps ? stringifyYaml(fm).replace(/\n/g, newline) : "";
  const insert = hasProps ? `---${newline}${yaml}---` : "";

  if (match) {
    const trailingNewlineLen = match[2]?.length ?? 0;
    const blockEnd = match[0].length - trailingNewlineLen; // just after the closing "---", before its newline
    const to = hasProps ? blockEnd : Math.min(text.length, blockEnd + trailingNewlineLen);
    return insert + text.slice(to);
  }
  if (hasProps) {
    return `${insert}${newline}${text}`;
  }
  return text;
}

const frontmatterLanes = new WeakMap<VaultWriter, Map<string, Promise<void>>>();

/**
 * Serialize participating read/transform/write operations for one captured Vault
 * and path. Direct Vault writes and other runtimes remain outside this lane.
 * The optional caller guard runs at dequeue, after read, and before modify.
 */
export async function patchFrontmatter(
  vault: VaultWriter,
  file: TFile,
  mutate: (fm: Record<string, unknown>) => unknown,
  options?: DataWriteOptions,
  beforeMutate?: () => void,
): Promise<void> {
  const path = file.path;
  let lanes = frontmatterLanes.get(vault);
  if (!lanes) {
    lanes = new Map();
    frontmatterLanes.set(vault, lanes);
  }
  const check = () => {
    if (file.path !== path) throw new Error(`Cannot patch frontmatter because the file path changed from ${path}`);
    beforeMutate?.();
  };
  const operation = (lanes.get(path) ?? Promise.resolve()).then(async () => {
    check();
    const text = await vault.read(file);
    check();
    const updated = patchFrontmatterText(text, mutate);
    check();
    if (updated !== text) await vault.modify(file, updated, options);
  });
  // Keep scheduling recovery separate from the rejection returned to the caller.
  const tail = operation.then(() => undefined, () => undefined);
  lanes.set(path, tail);
  void tail.then(() => {
    if (lanes.get(path) === tail) lanes.delete(path);
  });
  return operation;
}
