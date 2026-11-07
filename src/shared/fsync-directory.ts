import * as fsp from "node:fs/promises";

/**
 * Durably flush a directory entry (after a rename/create/unlink inside it).
 *
 * POSIX lets you open a directory read-only and `fsync` it. Windows does not: the handle opens but `fsync` fails with
 * `EPERM` (and some versions refuse the open with `EISDIR`/`EINVAL`/`ENOTSUP`). NTFS journals directory metadata itself,
 * so there is nothing further to flush; treating those codes as "already durable" on win32 — and only there, so POSIX
 * platforms keep failing loudly on a genuine error — is what lets the sync engine run on Windows.
 */
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EPERM", "EISDIR", "EINVAL", "ENOTSUP"]);

export interface DirectorySyncDeps {
  /** Injectable for tests and for callers that already carry a filesystem seam. */
  open?: (path: string, flags: string) => Promise<{ sync(): Promise<void>; close(): Promise<void> }>;
  platform?: NodeJS.Platform;
}

export async function fsyncDirectory(directory: string, deps: DirectorySyncDeps = {}): Promise<void> {
  const open = deps.open ?? ((path: string, flags: string) => fsp.open(path, flags));
  const platform = deps.platform ?? process.platform;
  let handle: { sync(): Promise<void>; close(): Promise<void> } | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (platform === "win32" && DIRECTORY_SYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  } finally {
    await handle?.close();
  }
}
