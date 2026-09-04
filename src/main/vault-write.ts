import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { Stats } from "node:fs";
import type { DataWriteOptions } from "../renderer/vault";
import { birthtimeOf } from "./fs-utils";

export interface VaultWriteResult {
  mtime: number;
  ctime: number;
  size: number;
}

/** The subset of `node:fs/promises` `writeVaultFile()` needs, injectable for tests. */
export interface VaultWriteDeps {
  mkdir: (path: string, options: { recursive: true }) => Promise<string | undefined>;
  writeFile: (path: string, data: string, encoding: "utf8") => Promise<void>;
  utimes: (path: string, atime: number, mtime: number) => Promise<void>;
  stat: (path: string) => Promise<Stats>;
}

/**
 * Validate a caller-supplied `DataWriteOptions.mtime` and convert it to the
 * seconds-since-epoch unit `fs.utimes` expects. Returns `undefined` when no
 * `mtime` was requested (the write proceeds without touching timestamps).
 *
 * Must be called — and must throw — before any filesystem mutation runs, so
 * an invalid value never leaves a half-written file on disk while the
 * in-memory Vault index (which only updates after the IPC call resolves)
 * falls out of sync with it.
 */
export function validateMtime(mtime: number | undefined): number | undefined {
  if (mtime === undefined) return undefined;
  if (typeof mtime !== "number" || !Number.isFinite(mtime)) {
    throw new Error(`Invalid DataWriteOptions.mtime: ${String(mtime)}`);
  }
  return mtime / 1000;
}

/**
 * Write `data` to `abs`, honoring `DataWriteOptions.mtime` (applied via
 * `fs.utimes` after the write). `options.ctime` is accepted for API shape
 * compatibility with Obsidian's `DataWriteOptions` but is intentionally NOT
 * applied: Node/Electron's `fs.utimes` can only set atime/mtime, not
 * birthtime, so there is no way to honor a caller-requested ctime on any
 * platform this app ships on. This is a deliberate, documented gap — not a
 * bug to "fix" later.
 */
export async function writeVaultFile(
  abs: string,
  data: string,
  options?: DataWriteOptions,
  deps: VaultWriteDeps = fsp,
): Promise<VaultWriteResult> {
  const mtimeSeconds = validateMtime(options?.mtime);
  await deps.mkdir(path.dirname(abs), { recursive: true });
  await deps.writeFile(abs, data, "utf8");
  if (mtimeSeconds !== undefined) {
    await deps.utimes(abs, mtimeSeconds, mtimeSeconds);
  }
  const st = await deps.stat(abs);
  return { mtime: st.mtimeMs, ctime: birthtimeOf(st), size: st.size };
}
