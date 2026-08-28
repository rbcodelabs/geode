/**
 * Cleanup for the Electron e2e suite.
 *
 * `_electron.launch()` has no headless mode in the Playwright sense — it boots
 * the real app. Each spec creates a throwaway `--user-data-dir` under the OS
 * temp dir via `mkdtempSync("geode-*")`. When a run is interrupted (Ctrl-C, a
 * timeout that outlives the reporter, an editor stopping the task) those
 * Electron processes are orphaned and those directories are never removed. They
 * accumulate silently: a single machine had 502 leaked dirs before this existed.
 *
 * Everything here keys off one narrow signal: an Electron process whose
 * `--user-data-dir` points *inside the OS temp dir* at a path beginning
 * `geode-`. A real Geode install always uses Electron's default userData
 * location (`~/Library/Application Support/Geode`), never a temp dir, so it can
 * never match. That property is what makes an automated killer safe to run, and
 * it is covered by tests/unit/e2e-reap.test.ts.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Prefix every e2e temp dir shares (`geode-e2e-`, `geode-deferred-ud-`, …). */
export const E2E_TMP_PREFIX = "geode-";

/**
 * Files and folders only the app or a spec fixture creates. Deletion requires
 * one of these to be present inside the candidate directory.
 *
 * The name alone is not sufficient evidence. `mkdtempSync` appends six random
 * characters, but a directory a human named (`/tmp/geode-scratch`,
 * `/tmp/geode-backup`) is indistinguishable from that by shape — an early
 * version of this file tried a suffix regex and matched both. Since the cost of
 * a false positive is deleting something a developer cared about, the reaper
 * instead looks *inside* and only removes directories that demonstrably contain
 * Electron user-data or seeded-vault artifacts.
 */
const APP_ARTIFACTS = [
  "geode.json", // seeded by specs to auto-open a vault
  "workspace.json",
  "crash-journal.json",
  "diagnostic.log",
  ".geode", // vault-local plugin/config dir
  "Local Storage", // Electron userData
  "Session Storage",
  "Code Cache",
  "Network",
  "Preferences",
];

export interface ProcessRow {
  pid: number;
  command: string;
}

/** Parses `ps -axo pid=,command=` output. Tolerates leading pad whitespace. */
export function parsePsOutput(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const command = match[2].trim();
    if (command) rows.push({ pid: Number(match[1]), command });
  }
  return rows;
}

/**
 * True when `command` is an app process launched against a throwaway e2e
 * user-data dir *by this checkout*. Matching on the temp-dir path — not on the
 * word "electron", not on "geode" anywhere in the line — is what keeps a
 * developer's real Geode (and an unrelated Electron app) out of the blast
 * radius.
 *
 * `repoRoot` narrows it further, and is not optional in practice. Temp dir
 * names carry no hint of which checkout created them, so a reaper keyed only on
 * the temp path will happily kill a *live* run belonging to a sibling git
 * worktree. That is not hypothetical: this machine routinely has half a dozen
 * worktrees of this repo with agents running the suite in parallel, and the
 * first version of this file killed one of their in-flight tests. Electron's
 * command line always contains the app path it was launched with, so requiring
 * `repoRoot` scopes every kill to the checkout doing the reaping.
 */
export function shouldReapProcess(command: string, tmpRoot: string, repoRoot?: string): boolean {
  const flag = "--user-data-dir=";
  const at = command.indexOf(flag);
  if (at === -1) return false;
  const rest = command.slice(at + flag.length).trim();
  // The value runs to the next argument boundary; test dirs never contain spaces.
  const value = rest.split(/\s+/, 1)[0]?.replace(/^["']|["']$/g, "") ?? "";
  if (!value) return false;
  if (!isE2ETempDir(value, tmpRoot)) return false;
  if (repoRoot && !command.includes(repoRoot)) return false;
  return true;
}

/**
 * True when `candidate` is a temp directory this suite created. `candidate` may
 * be an absolute path or a bare entry name (resolved against `tmpRoot`).
 */
export function isE2ETempDir(candidate: string, tmpRoot: string): boolean {
  const absolute = path.isAbsolute(candidate) ? candidate : path.join(tmpRoot, candidate);
  const resolvedRoot = path.resolve(tmpRoot);
  const resolved = path.resolve(absolute);
  // Must be an immediate child of the temp root: the suite never nests, and
  // allowing deeper paths would widen recursive deletion to arbitrary subtrees.
  if (path.dirname(resolved) !== resolvedRoot) return false;
  const name = path.basename(resolved);
  return name.startsWith(E2E_TMP_PREFIX) && name.length > E2E_TMP_PREFIX.length;
}

/**
 * Second gate before deletion: does this directory actually contain app or
 * fixture artifacts? Name matching is necessary but not sufficient (see
 * APP_ARTIFACTS). Erring conservative here means the worst case is a leftover
 * directory rather than lost work — a vault fixture holding only a `.md` file
 * and no `.geode/`, for instance, is deliberately left behind.
 */
export function hasAppArtifacts(dir: string): boolean {
  return APP_ARTIFACTS.some((entry) => fs.existsSync(path.join(dir, entry)));
}

export interface ReapOptions {
  /** Where the suite's temp dirs live. Defaults to the OS temp dir. */
  tmpRoot?: string;
  /** Report what would happen without killing or deleting anything. */
  dryRun?: boolean;
  /**
   * Skip the artifact gate and remove every `geode-*` dir in the temp root.
   *
   * Opt-in only, never used by the automated setup/teardown hooks. Vitest
   * fixtures (`geode-parity-ledger-*`, `geode-crash-journal-*`, …) leave dirs
   * whose contents carry no app marker, so the default gate cannot claim them;
   * this is the documented way to reclaim that backlog. Pair with `dryRun`
   * first.
   */
  all?: boolean;
  /**
   * Only remove directories untouched for at least this many milliseconds.
   *
   * The companion to `repoRoot` on the process side. Directory names record
   * nothing about which checkout created them, so there is no way to tell a
   * sibling worktree's *live* temp dir from our own abandoned one — except by
   * age. Anything a concurrent run is actively using was written to seconds
   * ago; an orphan from an interrupted run was not.
   *
   * Defaults to 0 (remove regardless of age) so an explicit CLI invocation
   * still cleans everything. The automated hooks pass a real threshold.
   */
  minAgeMs?: number;
  /** Scope process kills to launches from this checkout. See shouldReapProcess. */
  repoRoot?: string;
  /** Called with a human-readable line per action. */
  log?: (message: string) => void;
}

/**
 * How stale a directory must be before the automated hooks will remove it.
 * Long enough to clear any plausible single spec (the slowest in this suite
 * takes ~15s), short enough that leftovers do not survive to the next session.
 */
export const AUTO_REAP_MIN_AGE_MS = 30 * 60 * 1000;

export interface ReapResult {
  killedPids: number[];
  removedDirs: string[];
  failed: string[];
}

function listE2EProcesses(tmpRoot: string, repoRoot?: string): ProcessRow[] {
  // `ps` is present on macOS and Linux; on an unexpected platform we simply
  // find nothing rather than throwing and failing an otherwise-green run.
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (ps.status !== 0 || typeof ps.stdout !== "string") return [];
  return parsePsOutput(ps.stdout).filter(
    (row) => row.pid !== process.pid && shouldReapProcess(row.command, tmpRoot, repoRoot),
  );
}

/** True when nothing in `dir` has been modified for at least `minAgeMs`. */
export function isStaleDir(dir: string, minAgeMs: number, now: number): boolean {
  if (minAgeMs <= 0) return true;
  try {
    // The directory mtime only tracks entry add/remove, so a run writing *into*
    // an existing file would look stale. Take the newest mtime of the dir and
    // its immediate children instead.
    let newest = fs.statSync(dir).mtimeMs;
    for (const entry of fs.readdirSync(dir)) {
      try {
        newest = Math.max(newest, fs.statSync(path.join(dir, entry)).mtimeMs);
      } catch {
        // Vanished mid-scan: ignore this entry rather than abort the sweep.
      }
    }
    return now - newest >= minAgeMs;
  } catch {
    // Unreadable: leave it alone rather than guess.
    return false;
  }
}

function listE2EDirs(
  tmpRoot: string,
  includeAll: boolean,
  minAgeMs: number,
  now: number,
): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpRoot);
  } catch {
    return [];
  }
  const named = entries
    .filter((name) => isE2ETempDir(name, tmpRoot))
    .map((name) => path.join(tmpRoot, name));
  const gated = includeAll ? named : named.filter((dir) => hasAppArtifacts(dir));
  return gated.filter((dir) => isStaleDir(dir, minAgeMs, now));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Kills orphaned e2e app processes, then removes the suite's temp dirs.
 *
 * Processes are terminated before directories are removed: deleting a live
 * Electron's user-data dir out from under it provokes noisy crash dialogs.
 */
export async function reapE2EArtifacts(options: ReapOptions = {}): Promise<ReapResult> {
  const tmpRoot = options.tmpRoot ?? os.tmpdir();
  const log = options.log ?? (() => {});
  const result: ReapResult = { killedPids: [], removedDirs: [], failed: [] };

  const processes = listE2EProcesses(tmpRoot, options.repoRoot);
  for (const { pid, command } of processes) {
    if (options.dryRun) {
      log(`would kill pid ${pid}: ${command.slice(0, 120)}`);
      result.killedPids.push(pid);
      continue;
    }
    try {
      process.kill(pid, "SIGTERM");
      result.killedPids.push(pid);
    } catch {
      // Already gone between listing and killing — not a failure.
    }
  }

  if (!options.dryRun && result.killedPids.length > 0) {
    // Give SIGTERM a moment to land so Electron can tear down its helper
    // processes itself, then escalate for anything still standing.
    await delay(500);
    for (const pid of result.killedPids) {
      try {
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // Exited on SIGTERM, which is the good path.
      }
    }
    log(`killed ${result.killedPids.length} orphaned e2e app process(es)`);
  }

  const now = Date.now();
  for (const dir of listE2EDirs(tmpRoot, options.all === true, options.minAgeMs ?? 0, now)) {
    if (options.dryRun) {
      log(`would remove ${dir}`);
      result.removedDirs.push(dir);
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      result.removedDirs.push(dir);
    } catch (error) {
      result.failed.push(`${dir}: ${String(error)}`);
    }
  }
  if (!options.dryRun && result.removedDirs.length > 0) {
    log(`removed ${result.removedDirs.length} e2e temp dir(s)`);
  }
  return result;
}
