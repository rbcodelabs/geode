import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RestoredVault } from "./catalog-contract";

/**
 * Write a verified `RestoredVault` onto a local folder.
 *
 * This is the bridge between the catalog and the engine: once a restored vault
 * is on disk, `openLocalWikiProvider` reads it exactly as it reads any other
 * folder, so the restored snapshot is produced by the *real* capture and
 * indexing path rather than by a second, restore-only code path that might
 * agree with the original for the wrong reasons.
 *
 * It lives in `src/wiki/` alongside `local-filesystem.ts`, which is the
 * existing precedent for an engine module that touches `node:fs`. It imports
 * no adapter and knows nothing about any store — it takes the verified value
 * type and nothing else, so it is equally usable by a restore from a different
 * catalog implementation.
 *
 * The target folder is expected to be fresh and owned by the caller (a
 * `mkdtemp` directory in every current caller). This is not an unpacker for
 * hostile archives: it re-checks containment because a path that escapes its
 * root must never be written, but the same boundary `folder-provider.ts`
 * states applies here — portable Node pathname APIs are not an OS sandbox
 * against an adversary racing the filesystem with equal privilege.
 */

export type MaterializeStatus =
  /** Every note and asset was written. */
  | "ok"
  /** A restored path resolved outside the target root. Nothing further was written. */
  | "escaping-path"
  /** The filesystem refused an operation. */
  | "write-failed";

export interface MaterializeResult {
  readonly status: MaterializeStatus;
  /** The resolved root actually written to. */
  readonly root: string;
  readonly noteCount: number;
  readonly assetCount: number;
  /** The entry a refusal is about, when it is about one. */
  readonly path?: string;
}

function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== "" && !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep);
}

export async function materializeRestoredVault(
  rootPath: string,
  vault: RestoredVault,
): Promise<MaterializeResult> {
  const root = resolve(rootPath);
  let noteCount = 0;
  let assetCount = 0;

  const entries: { path: string; write: (absolute: string) => Promise<void> }[] = [
    ...vault.notes.map((note) => ({
      path: note.path,
      // UTF-8 with no BOM and no newline normalization: the capture side reads
      // bytes and decodes them fatally, so anything added here would come back
      // as a difference in the restored note text.
      write: (absolute: string) => writeFile(absolute, note.text, { encoding: "utf8", flag: "wx" }),
    })),
    ...vault.assets.map((asset) => ({
      path: asset.path,
      write: (absolute: string) => writeFile(absolute, asset.bytes, { flag: "wx" }),
    })),
  ];

  for (const entry of entries) {
    const absolute = join(root, entry.path);
    // The paths were already verified portable by `verifyRestoredVault`. This
    // is the second check, at the point where a mistake would actually write
    // outside the root — cheap, and the only one that is positionally correct.
    if (!contained(root, absolute)) return { status: "escaping-path", root, noteCount, assetCount, path: entry.path };
    try {
      const parent = absolute.slice(0, absolute.lastIndexOf(sep));
      if (contained(root, parent) || parent === root) await mkdir(parent, { recursive: true });
      await entry.write(absolute);
    } catch {
      return { status: "write-failed", root, noteCount, assetCount, path: entry.path };
    }
    if (entry.path.toLowerCase().endsWith(".md")) noteCount += 1;
    else assetCount += 1;
  }

  return { status: "ok", root, noteCount, assetCount };
}
