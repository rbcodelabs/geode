import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { TFile } from "./types";
import type { DataWriteOptions } from "./vault";

/** Same frontmatter delimiter pattern as `markdown/live-preview.ts`'s `FM_RE`. */
const FM_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(\r?\n|$)/;

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

/**
 * Pure text transform: parse `text`'s frontmatter block (if any) into a
 * plain object, run `mutate` on it, and splice the re-stringified result
 * back in. Mirrors `writeFrontmatter()` in `markdown/live-preview.ts` (same
 * delimiter regex, same "no properties left -> remove the block and its
 * trailing newline" behavior) but works on plain text instead of a live
 * CodeMirror `EditorView`, so it doesn't need an open editor.
 */
export function patchFrontmatterText(text: string, mutate: (fm: Record<string, unknown>) => void): string {
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

  mutate(fm);

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

/** Read `file`, apply `mutate` to its frontmatter, and write the result back if it changed. */
export async function patchFrontmatter(
  vault: VaultWriter,
  file: TFile,
  mutate: (fm: Record<string, unknown>) => void,
  options?: DataWriteOptions,
  beforeMutate?: () => void,
): Promise<void> {
  const text = await vault.read(file);
  beforeMutate?.();
  const updated = patchFrontmatterText(text, mutate);
  if (updated !== text) await vault.modify(file, updated, options);
}
