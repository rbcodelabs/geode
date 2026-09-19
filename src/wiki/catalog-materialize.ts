import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
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
 *
 * Within that boundary it uses the same two mechanisms `folder-provider.ts`
 * uses, because it previously claimed that parity without having it. Lexical
 * `relative()` containment answers "does this path *spell* an escape", which
 * says nothing about symlinks, and `O_EXCL` alone refuses a symlink planted at
 * the final component but not one standing in for a parent directory: a
 * pre-existing `assets` → `/etc` would have `mkdir(parent, { recursive: true })`
 * traverse it and `assets/foo` land in `/etc/foo`. So:
 *
 * - every file is opened `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, and
 * - each parent directory is re-checked *after* creation with `realpath`,
 *   against a `realpath` of the root taken once up front,
 *
 * which is what makes the containment claim about where bytes actually land
 * rather than about how the path was spelled.
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

/** Absent on platforms without it, where `O_EXCL` alone is what the OS offers. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export async function materializeRestoredVault(
  rootPath: string,
  vault: RestoredVault,
): Promise<MaterializeResult> {
  const root = resolve(rootPath);
  let noteCount = 0;
  let assetCount = 0;

  // The anchor every later containment question is asked against. Taken once,
  // from the filesystem rather than from the string the caller passed, so a
  // symlinked target root is resolved here instead of silently making every
  // subsequent `relative()` comparison meaningless.
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return { status: "write-failed", root, noteCount, assetCount };
  }

  // A note's content is a string and an asset's is bytes, which is the only
  // difference between the two at this point. UTF-8 with no BOM and no newline
  // normalization: the capture side reads bytes and decodes them fatally, so
  // anything added here would come back as a difference in restored note text.
  const entries: { path: string; content: Uint8Array | string }[] = [
    ...vault.notes.map((note) => ({ path: note.path, content: note.text })),
    ...vault.assets.map((asset) => ({ path: asset.path, content: asset.bytes })),
  ];

  for (const entry of entries) {
    const absolute = join(root, entry.path);
    // The paths were already verified portable by `verifyRestoredVault`. This
    // is the second check, at the point where a mistake would actually write
    // outside the root — cheap, and the only one that is positionally correct.
    if (!contained(root, absolute)) return { status: "escaping-path", root, noteCount, assetCount, path: entry.path };

    const parent = absolute.slice(0, absolute.lastIndexOf(sep));
    if (!contained(root, parent) && parent !== root) {
      return { status: "escaping-path", root, noteCount, assetCount, path: entry.path };
    }
    try {
      await mkdir(parent, { recursive: true });
    } catch {
      return { status: "write-failed", root, noteCount, assetCount, path: entry.path };
    }
    // Where the parent *spells* containment and where it actually resolves are
    // different questions, and only the second one decides where bytes land.
    // `mkdir(..., { recursive: true })` walks through a pre-existing symlinked
    // directory without complaint, so this is asked after the directory exists.
    let realParent: string;
    try {
      realParent = await realpath(parent);
    } catch {
      return { status: "write-failed", root, noteCount, assetCount, path: entry.path };
    }
    if (!contained(realRoot, realParent) && realParent !== realRoot) {
      return { status: "escaping-path", root, noteCount, assetCount, path: entry.path };
    }

    try {
      // O_EXCL makes "does it already exist?" one atomic question rather than a
      // check followed by a racy write; O_NOFOLLOW means a symlink planted at
      // the final component is an error, never a write through to its target.
      // The same pair `nodeWikiWriteFileSystem.createFile` uses.
      const name = absolute.slice(parent.length + 1);
      const handle = await open(
        join(realParent, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      );
      try {
        if (typeof entry.content === "string") await handle.writeFile(entry.content, "utf8");
        else await handle.writeFile(entry.content);
      } finally {
        await handle.close();
      }
    } catch {
      return { status: "write-failed", root, noteCount, assetCount, path: entry.path };
    }
    if (entry.path.toLowerCase().endsWith(".md")) noteCount += 1;
    else assetCount += 1;
  }

  return { status: "ok", root, noteCount, assetCount };
}
