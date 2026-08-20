import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { Stats } from "node:fs";

export interface VaultFileEntry {
  path: string;
  isFolder: boolean;
  mtime: number;
  ctime: number;
  size: number;
}

export interface ListVaultFilesOptions {
  ioDelayMs?: number;
  yieldEveryOperations?: number;
  yieldToEventLoop?: () => Promise<void>;
}

const MAX_CONCURRENT_OPERATIONS = 32;
// A typical file costs one operation and a directory costs two. Yielding at
// this cadence keeps the main-process task queue moving for large vaults while
// adding only a few dozen macrotasks even for a multi-thousand-file walk.
const YIELD_EVERY_OPERATIONS = 64;

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}

/** Use mtime when a filesystem cannot provide a meaningful birthtime. */
function birthtimeOf(st: Stats | null): number {
  if (!st) return 0;
  return st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs;
}

export async function listVaultFiles(
  root: string,
  options: ListVaultFilesOptions = {}
): Promise<VaultFileEntry[]> {
  const injectedDelayMs = options.ioDelayMs
    ?? Number(process.env.GEODE_TEST_VAULT_IO_DELAY_MS ?? 0);
  const injectDelay = () => injectedDelayMs > 0
    ? new Promise<void>((resolve) => setTimeout(resolve, injectedDelayMs))
    : Promise.resolve();
  const yieldEveryOperations = options.yieldEveryOperations ?? YIELD_EVERY_OPERATIONS;
  const yieldToEventLoop = options.yieldToEventLoop ?? immediate;

  // Endpoint security can add material latency to every filesystem operation.
  // Bound concurrency globally across the recursive walk so that latency is
  // hidden without issuing an unbounded burst against a large vault.
  let activeOperations = 0;
  let completedOperations = 0;
  const waiters: Array<() => void> = [];
  async function limited<T>(operation: () => Promise<T>): Promise<T> {
    if (activeOperations >= MAX_CONCURRENT_OPERATIONS) {
      await new Promise<void>((resolve) => waiters.push(resolve));
      // The completing operation transfers its slot to this waiter.
    } else {
      activeOperations += 1;
    }
    try {
      return await operation();
    } finally {
      completedOperations += 1;
      try {
        if (yieldEveryOperations > 0 && completedOperations % yieldEveryOperations === 0) {
          // Keep this operation's slot until the yield completes. That preserves
          // the global cap while giving queued IPC (notably plugin-file-read) a
          // macrotask boundary in which to run.
          await yieldToEventLoop();
        }
      } finally {
        const next = waiters.shift();
        if (next) next();
        else activeOperations -= 1;
      }
    }
  }

  async function walk(dir: string): Promise<VaultFileEntry[]> {
    let entries;
    try {
      entries = await limited(async () => {
        await injectDelay();
        return fsp.readdir(dir, { withFileTypes: true });
      });
    } catch {
      return [];
    }
    const nested = await Promise.all(entries.map(async (entry): Promise<VaultFileEntry[]> => {
      if (entry.name.startsWith(".")) return [];
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const [st, children] = await Promise.all([
          limited(async () => {
            await injectDelay();
            return fsp.stat(abs).catch(() => null);
          }),
          walk(abs),
        ]);
        return [{
          path: toRel(root, abs),
          isFolder: true,
          mtime: st?.mtimeMs ?? 0,
          ctime: birthtimeOf(st),
          size: 0,
        }, ...children];
      }
      if (entry.isFile()) {
        const st = await limited(async () => {
          await injectDelay();
          return fsp.stat(abs).catch(() => null);
        });
        return [{
          path: toRel(root, abs),
          isFolder: false,
          mtime: st?.mtimeMs ?? 0,
          ctime: birthtimeOf(st),
          size: st?.size ?? 0,
        }];
      }
      return [];
    }));
    return nested.flat();
  }

  return walk(root);
}
