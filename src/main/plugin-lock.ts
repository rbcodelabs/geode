/**
 * `.geode/plugins.lock.json`: the resolved version and per-file sha256 of every
 * GitHub plugin that was installed under a semver range (ADR 0050, "Pinned
 * GitHub plugins"). Written by Geode only; vault packs can never carry one
 * (`.geode/` is allowlisted, and this file is not on the list).
 *
 * The lock does two jobs on later installs of the same plugin: a result outside
 * the recorded range is refused, and a re-download of the locked version must
 * match the recorded bytes. Kept free of Electron imports.
 */
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { isValidRange } from "../shared/semver-range";

export const PLUGIN_LOCK_FILE = "plugins.lock.json";
const SHA256_RE = /^[0-9a-f]{64}$/;
const PLUGIN_FILES = new Set(["manifest.json", "main.js", "styles.css"]);

export interface PluginLockEntry {
  /** `owner/repo`, as installed. */
  repo: string;
  range: string;
  /** Release-age floor in force when the entry was locked; updates reuse it. */
  minReleaseAgeDays: number;
  /** manifest.json `version` that was installed. */
  version: string;
  /** Release tag. */
  ref: string;
  /** sha256 hex per installed file (`manifest.json`, `main.js`, optional `styles.css`). */
  files: Record<string, string>;
  lockedAt: string;
}

export interface PluginLock {
  lockVersion: 1;
  /** Keyed by plugin id. */
  plugins: Record<string, PluginLockEntry>;
}

export class PluginLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginLockError";
  }
}

export const pluginLockPath = (root: string): string => path.join(root, ".geode", PLUGIN_LOCK_FILE);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Strict validation. A lock that cannot be trusted is an error, never silently ignored: ignoring it would disable the check it exists for. */
export function validatePluginLock(raw: unknown): PluginLock {
  if (!isRecord(raw) || raw.lockVersion !== 1 || !isRecord(raw.plugins)) {
    throw new PluginLockError(`.geode/${PLUGIN_LOCK_FILE} is not a valid lock file`);
  }
  const plugins: Record<string, PluginLockEntry> = {};
  for (const [id, value] of Object.entries(raw.plugins)) {
    const bad = (why: string) => new PluginLockError(`.geode/${PLUGIN_LOCK_FILE}: entry "${id}" ${why}`);
    if (!isRecord(value)) throw bad("is not an object");
    const { repo, range, minReleaseAgeDays, version, ref, files, lockedAt } = value;
    if (typeof repo !== "string" || !repo.includes("/")) throw bad('needs a "repo"');
    if (!isValidRange(range)) throw bad('has an invalid "range"');
    if (typeof minReleaseAgeDays !== "number" || !Number.isFinite(minReleaseAgeDays) || minReleaseAgeDays < 0) throw bad('has an invalid "minReleaseAgeDays"');
    if (typeof version !== "string" || typeof ref !== "string") throw bad('needs "version" and "ref"');
    if (!isRecord(files) || !files["manifest.json"] || !files["main.js"]) throw bad('needs hashes for "manifest.json" and "main.js"');
    const hashes: Record<string, string> = {};
    for (const [name, hash] of Object.entries(files)) {
      if (!PLUGIN_FILES.has(name) || typeof hash !== "string" || !SHA256_RE.test(hash)) throw bad(`has an invalid hash for "${name}"`);
      hashes[name] = hash;
    }
    plugins[id] = { repo, range, minReleaseAgeDays, version, ref, files: hashes, lockedAt: typeof lockedAt === "string" ? lockedAt : "" };
  }
  return { lockVersion: 1, plugins };
}

/** Reads the lock; a missing file is an empty lock, a corrupt one throws `PluginLockError`. */
export async function readPluginLock(root: string): Promise<PluginLock> {
  let text: string;
  try {
    text = await fsp.readFile(pluginLockPath(root), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { lockVersion: 1, plugins: {} };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PluginLockError(`.geode/${PLUGIN_LOCK_FILE} is not valid JSON`);
  }
  return validatePluginLock(parsed);
}

async function writePluginLock(root: string, lock: PluginLock): Promise<void> {
  const target = pluginLockPath(root);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(lock, null, 2) + "\n", "utf8");
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Read-modify-write must not interleave for one vault (parallel installs, update sweep).
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(root);
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
  queues.set(key, run);
  void run.finally(() => {
    if (queues.get(key) === run) queues.delete(key);
  }).catch(() => {});
  return run;
}

/** Inserts or replaces the entry for plugin `id`. */
export function recordPluginLock(root: string, id: string, entry: PluginLockEntry): Promise<void> {
  return serialized(root, async () => {
    const lock = await readPluginLock(root);
    lock.plugins[id] = entry;
    await writePluginLock(root, lock);
  });
}

/**
 * The lock entry that governs an install of `repo` into `root`, if any. An entry
 * only applies while the plugin is still installed: uninstalling a plugin
 * releases its lock, and the next ranged install overwrites the stale entry.
 */
export async function activeLockEntry(root: string, repo: string): Promise<{ id: string; entry: PluginLockEntry } | null> {
  const lock = await readPluginLock(root);
  const wanted = repo.toLowerCase();
  for (const [id, entry] of Object.entries(lock.plugins)) {
    if (entry.repo.toLowerCase() !== wanted) continue;
    const installed = await fsp.stat(path.join(root, ".geode", "plugins", id)).then((s) => s.isDirectory(), () => false);
    return installed ? { id, entry } : null;
  }
  return null;
}
