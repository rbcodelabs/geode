#!/usr/bin/env node
/**
 * `npm run e2e:kill` — reap orphaned Electron e2e processes and temp dirs.
 *
 * The escape hatch for when a run has been interrupted and the machine is left
 * with stray app processes. Having this as one documented command is the point:
 * the alternative is improvising `pkill -f electron`, which also kills the
 * developer's real editor, Slack, and Geode.
 *
 * Defaults are deliberately conservative because sibling git worktrees of this
 * repo may be running their own suites right now, and their processes and temp
 * dirs look exactly like ours. By default this only kills app processes
 * launched from *this* checkout, and only removes directories nothing has
 * touched for 30 minutes — which a live run never is.
 *
 * Usage:
 *   npm run e2e:kill                 this checkout's strays, stale dirs only
 *   npm run e2e:kill -- --dry-run    list what would happen, change nothing
 *   npm run e2e:kill -- --all        also remove geode-* dirs with no app
 *                                    marker (vitest fixture leftovers)
 *   npm run e2e:kill -- --force      drop the age and checkout guards: reap
 *                                    every matching process and dir on the
 *                                    machine. Only when you are certain no
 *                                    other worktree is running the suite.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTO_REAP_MIN_AGE_MS, reapE2EArtifacts } from "./e2e-reap.mts";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run") || argv.includes("-n");
const all = argv.includes("--all");
const force = argv.includes("--force");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { killedPids, removedDirs, failed } = await reapE2EArtifacts({
  dryRun,
  all,
  repoRoot: force ? undefined : repoRoot,
  minAgeMs: force ? 0 : AUTO_REAP_MIN_AGE_MS,
  log: (message) => console.log(`  ${message}`),
});

const scope = force ? "all worktrees, any age" : "this checkout, stale dirs only";
const verb = dryRun ? "would reap" : "reaped";
console.log(
  `${dryRun ? "[dry run] " : ""}${verb} ${killedPids.length} process(es) and ` +
    `${removedDirs.length} temp dir(s) (${scope})`,
);
if (!force && !dryRun && removedDirs.length === 0 && killedPids.length === 0) {
  console.log("nothing matched — add --force if you know no other worktree is running the suite");
}
for (const failure of failed) console.warn(`failed: ${failure}`);
process.exit(failed.length > 0 ? 1 : 0);
