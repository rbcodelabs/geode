import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ICLOUD_EVICTED, ICLOUD_NOT_DOWNLOADED } from "./node-scan";

/**
 * Opt-in iCloud hydration (`hydrateIcloud`). By default the host NEVER downloads
 * anything: a dataless file is reported as blocked and left alone, because pulling
 * a multi-GB vault out of iCloud as a side effect of a sync is not something to do
 * unasked. When enabled, `brctl download <path>` (macOS) is run for each blocked
 * iCloud path with bounded parallelism and a timeout, then the file is polled
 * until it is materialised or the deadline passes. A path that does not hydrate in
 * time simply stays blocked; hydration never fails a run.
 */
export type CommandRunner = (command: string, args: string[], options: { timeoutMs: number }) => Promise<{ code: number | null; stderr: string }>;

export const execRunner: CommandRunner = (command, args, { timeoutMs }) => new Promise(resolve => {
  execFile(command, args, { timeout: timeoutMs }, (error, _stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null) : 0;
    resolve({ code, stderr: String(stderr ?? "") + (error && code === null ? String(error.message) : "") });
  });
});

export interface HydrateOptions {
  runner?: CommandRunner;
  /** Parallel `brctl` invocations. Default 4. */
  concurrency?: number;
  /** Per path: how long to wait for the download to complete. Default 60 000 ms. */
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}
export interface HydrateReport { requested: number; hydrated: string[]; failed: Array<{ path: string; reason: string }>; }

/** A path is materialised when the real file exists, has no stub beside it, and has data blocks (or is genuinely empty). */
async function isMaterialised(absolute: string): Promise<boolean> {
  const stub = path.join(path.dirname(absolute), `.${path.basename(absolute)}.icloud`);
  if (await fs.lstat(stub).then(() => true, () => false)) return false;
  const stat = await fs.lstat(absolute).catch(() => null);
  return !!stat && stat.isFile() && !(stat.blocks === 0 && stat.size > 0);
}

export async function hydrateIcloudPaths(root: string, issues: ReadonlyArray<{ path: string; reason: string }>, options: HydrateOptions = {}): Promise<HydrateReport> {
  const runner = options.runner ?? execRunner, timeoutMs = options.timeoutMs ?? 60_000, pollMs = options.pollMs ?? 500;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const targets = issues.filter(item => item.reason === ICLOUD_NOT_DOWNLOADED || item.reason === ICLOUD_EVICTED);
  const report: HydrateReport = { requested: targets.length, hydrated: [], failed: [] };
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++; if (index >= targets.length || options.signal?.aborted) return;
      const { path: rel, reason } = targets[index];
      const real = path.join(root, rel);
      // A legacy placeholder is addressed by its stub; an evicted file keeps its own name.
      const argument = reason === ICLOUD_NOT_DOWNLOADED ? path.join(path.dirname(real), `.${path.basename(real)}.icloud`) : real;
      const started = Date.now();
      const result = await runner("brctl", ["download", argument], { timeoutMs }).catch(error => ({ code: null as number | null, stderr: String(error) }));
      if (result.code !== 0) { report.failed.push({ path: rel, reason: `brctl-exit-${result.code ?? "error"}` }); continue; }
      let done = await isMaterialised(real);
      while (!done && Date.now() - started < timeoutMs && !options.signal?.aborted) { await sleep(pollMs); done = await isMaterialised(real); }
      if (done) report.hydrated.push(rel); else report.failed.push({ path: rel, reason: "hydrate-timeout" });
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, options.concurrency ?? 4), targets.length) }, worker));
  report.hydrated.sort(); report.failed.sort((a, b) => (a.path < b.path ? -1 : 1));
  return report;
}
