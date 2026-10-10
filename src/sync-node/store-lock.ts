import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { abortError, SyncStoreError } from "./store-errors";

/**
 * Cross-process single-writer lock for a hub store: an `mkdir` of `<store>/.lock`
 * (atomic on every local filesystem) holding `owner.json` = { pid, bootId, token }.
 *
 * Staleness: the holder is dead (`kill(pid, 0)` says ESRCH) or the machine has
 * rebooted since (boot id differs, which also defeats pid reuse across reboots).
 * A lock directory with no readable owner file is only stale after a grace period,
 * covering the window between `mkdir` and the owner write.
 *
 * Breaking a stale lock is itself serialised through `<store>/.lock.break`, and
 * re-validates the owner token under it, so two breakers cannot both succeed and
 * a breaker can never delete a lock that was re-acquired after it judged staleness.
 *
 * Not defended: a live-but-wedged holder (its pid is alive) is never broken; the
 * waiter gets a retryable `lock-timeout` instead. A shared network filesystem
 * is out of scope (pid/boot id are host-local).
 */
export interface LockOwner { pid: number; bootId: string; token: string; startedAt: number }

const LOCK_DIR = ".lock";
const BREAK_DIR = ".lock.break";
const OWNERLESS_GRACE_MS = 5_000;
const BREAK_LOCK_MAX_AGE_MS = 30_000;

let cachedBootId: string | undefined;
export function currentBootId(): string {
  if (cachedBootId !== undefined) return cachedBootId;
  let id = "unknown";
  try {
    if (process.platform === "linux") id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    else if (process.platform === "darwin" || process.platform.endsWith("bsd")) id = execFileSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", timeout: 2000 }).trim();
  } catch { /* fall through to "unknown": staleness then relies on pid liveness alone */ }
  return cachedBootId = id;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(abortError(signal));
  const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
  signal.addEventListener("abort", onAbort, { once: true });
});

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function readOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    return typeof parsed?.pid === "number" && typeof parsed.bootId === "string" && typeof parsed.token === "string" ? parsed : null;
  } catch { return null; }
}

async function isStale(lockPath: string, owner: LockOwner | null): Promise<boolean> {
  if (!owner) {
    try { return Date.now() - (await stat(lockPath)).mtimeMs > OWNERLESS_GRACE_MS; } catch { return false; }
  }
  const boot = currentBootId();
  if (owner.bootId !== boot && owner.bootId !== "unknown" && boot !== "unknown") return true;
  return !pidAlive(owner.pid);
}

async function breakStale(root: string, seen: LockOwner | null, name: string): Promise<void> {
  const breakPath = join(root, name === LOCK_DIR ? BREAK_DIR : `${name}.break`), lockPath = join(root, name);
  try { await mkdir(breakPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try { if (Date.now() - (await stat(breakPath)).mtimeMs > BREAK_LOCK_MAX_AGE_MS) await rm(breakPath, { recursive: true, force: true }); } catch { /* raced */ }
    return;
  }
  try {
    const now = await readOwner(lockPath);
    if ((now?.token ?? null) === (seen?.token ?? null) && await isStale(lockPath, now)) await rm(lockPath, { recursive: true, force: true });
  } finally { await rmdir(breakPath).catch(() => {}); }
}

const inProcess = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` while holding the store's single-writer lock (in-process queue + cross-process mkdir lock).
 * `lockName` selects a different lock directory under `root` (the device-side sync lock uses `lock`).
 */
export async function withStoreLock<T>(root: string, signal: AbortSignal, fn: () => Promise<T>, timeoutMs = 30_000, lockName: string = LOCK_DIR): Promise<T> {
  const queueKey = lockName === LOCK_DIR ? root : join(root, lockName);
  const prior = inProcess.get(queueKey) ?? Promise.resolve();
  const run = prior.catch(() => {}).then(async () => {
    const release = await acquire(root, signal, timeoutMs, lockName);
    try { return await fn(); } finally { await release(); }
  });
  inProcess.set(queueKey, run);
  try { return await run; } finally { if (inProcess.get(queueKey) === run) inProcess.delete(queueKey); }
}

async function acquire(root: string, signal: AbortSignal, timeoutMs: number, lockName: string): Promise<() => Promise<void>> {
  const lockPath = join(root, lockName), deadline = Date.now() + timeoutMs;
  const owner: LockOwner = { pid: process.pid, bootId: currentBootId(), token: randomBytes(12).toString("hex"), startedAt: Date.now() };
  for (;;) {
    if (signal.aborted) throw abortError(signal);
    try {
      await mkdir(lockPath);
      try { await writeFile(join(lockPath, "owner.json"), JSON.stringify(owner)); } catch (error) { await rm(lockPath, { recursive: true, force: true }).catch(() => {}); throw error; }
      return async () => {
        const held = await readOwner(lockPath);
        if (held?.token === owner.token) await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const seen = await readOwner(lockPath);
    if (await isStale(lockPath, seen)) { await breakStale(root, seen, lockName); continue; }
    if (Date.now() >= deadline) throw new SyncStoreError("lock-timeout", "Timed out waiting for the store writer lock");
    await sleep(5 + Math.random() * 20, signal);
  }
}

/**
 * Read-only: who holds the named lock under `root` right now, or null when it is free or stale.
 * Never acquires, never breaks. Used by `geode-wiki sync status` so a status call neither
 * blocks behind nor interferes with a running sync.
 */
export async function readLockHolder(root: string, lockName: string = LOCK_DIR): Promise<{ pid: number; startedAt: number } | null> {
  const lockPath = join(root, lockName);
  try { await stat(lockPath); } catch { return null; }
  const owner = await readOwner(lockPath);
  if (!owner) return null;
  return await isStale(lockPath, owner) ? null : { pid: owner.pid, startedAt: owner.startedAt };
}
