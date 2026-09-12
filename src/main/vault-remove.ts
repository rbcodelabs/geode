import * as fsp from "node:fs/promises";
import { resolveVaultPath } from "./vault-path";

/**
 * Resolve the target of `adapter.rmdir(normalizedPath, recursive)`, refusing
 * anything that escapes the vault (`resolveVaultPath`) and the vault root
 * itself. Split from the removal so the caller can take the path lock on the
 * resolved path first, the way `vault-delete` and `vault-rename` do.
 */
export function resolveVaultFolderPath(root: string, rel: string): string {
  const abs = resolveVaultPath(root, rel);
  if (abs === root) throw new Error(`Path escapes vault: refusing to remove the vault root (${rel})`);
  return abs;
}

/**
 * Remove an already-resolved vault folder.
 *
 * Unlike the `vault-delete` handler — which routes through the OS trash,
 * matching Obsidian's default for user-initiated deletes — Obsidian's adapter
 * API is a direct filesystem removal, and callers use it for internal
 * bookkeeping rather than for anything the user asked to throw away
 * (obsidian-claude-threads cleans up a thread's attachment folder with it when
 * the thread is hard-deleted).
 *
 * `lstat` rather than `stat` is deliberate: a symlink pointing at a directory
 * outside the vault passes a `stat` check, and following it would delete
 * whatever it points at.
 */
export async function removeVaultFolderAt(abs: string, recursive: boolean): Promise<void> {
  const stat = await fsp.lstat(abs);
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${abs}`);
  if (recursive) await fsp.rm(abs, { recursive: true, force: true });
  else await fsp.rmdir(abs);
}

/** `resolveVaultFolderPath` + `removeVaultFolderAt`, for callers holding no lock. */
export async function removeVaultFolder(
  root: string,
  rel: string,
  recursive: boolean,
): Promise<void> {
  await removeVaultFolderAt(resolveVaultFolderPath(root, rel), recursive);
}
