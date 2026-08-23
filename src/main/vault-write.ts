import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { Stats } from "node:fs";

/**
 * Obsidian's `DataWriteOptions` — plugins pass this to `Vault.create` /
 * `Vault.modify` (and the adapter write methods) to pin a file's timestamps,
 * e.g. sync/import tooling preserving a source file's original modification
 * time.
 */
export interface DataWriteOptions {
  /**
   * Desired creation time (epoch ms). Accepted for API compatibility, but
   * Node's `fs` cannot set a file's birthtime independently, so this value is
   * not honored on disk — see `writeVaultFile`.
   */
  ctime?: number;
  /** Desired modification time (epoch ms). Applied exactly via `utimes`. */
  mtime?: number;
}

export interface VaultWriteResult {
  mtime: number;
  ctime: number;
  size: number;
}

/**
 * `stats.birthtimeMs` is unreliable on some filesystems (e.g. some Linux ext
 * filesystems report it as 0, meaning "unavailable") — fall back to mtime in
 * that case so `file.ctime` never reports an epoch-zero date.
 */
export function birthtimeOf(st: Stats | null): number {
  if (!st) return 0;
  return st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
}

/** The subset of `fs/promises` `writeVaultFile` needs; injectable for tests. */
export type VaultWriteDeps = Pick<typeof fsp, "mkdir" | "writeFile" | "stat" | "utimes">;

/**
 * Write a UTF-8 file to `abs`, creating parent directories, and honor
 * `DataWriteOptions` where the platform allows.
 *
 * `options.mtime` is applied exactly through `fs.utimes` (atime is pinned to
 * the same instant so the timestamp pair stays coherent). `options.ctime`
 * maps to the file's birthtime, which Node's `fs` cannot set independently of
 * the real creation instant — it is accepted for parity with Obsidian's API
 * but intentionally not applied. Callers relying on a pinned creation time
 * should treat that as unsupported on this IPC path.
 */
export async function writeVaultFile(
  abs: string,
  data: string,
  options?: DataWriteOptions,
  deps: VaultWriteDeps = fsp,
): Promise<VaultWriteResult> {
  await deps.mkdir(path.dirname(abs), { recursive: true });
  await deps.writeFile(abs, data, "utf8");
  if (options?.mtime !== undefined) {
    const mtimeSeconds = options.mtime / 1000;
    await deps.utimes(abs, mtimeSeconds, mtimeSeconds);
  }
  const st = await deps.stat(abs);
  return { mtime: st.mtimeMs, ctime: birthtimeOf(st), size: st.size };
}
