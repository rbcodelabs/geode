#!/usr/bin/env node
/**
 * `npm run e2e:kill` — reap orphaned Electron e2e processes and temp dirs.
 *
 * The escape hatch for when a run has been interrupted and the machine is left
 * with stray app processes. Having this as one documented command is the point:
 * the alternative is improvising `pkill -f electron`, which also kills the
 * developer's real editor/Slack/Geode.
 *
 * Usage:
 *   npm run e2e:kill                 reap orphaned processes + app temp dirs
 *   npm run e2e:kill -- --dry-run    list what would be reaped, change nothing
 *   npm run e2e:kill -- --all        also remove geode-* dirs with no app
 *                                    marker (vitest fixture leftovers)
 *
 * `--all` skips the safety gate that requires a directory to contain app
 * artifacts, so run it with --dry-run first and read the list.
 */
import { reapE2EArtifacts } from "./e2e-reap.mts";

const dryRun = process.argv.includes("--dry-run") || process.argv.includes("-n");
const all = process.argv.includes("--all");

const { killedPids, removedDirs, failed } = await reapE2EArtifacts({
  dryRun,
  all,
  log: (message) => console.log(`  ${message}`),
});

const verb = dryRun ? "would reap" : "reaped";
console.log(
  `${dryRun ? "[dry run] " : ""}${verb} ${killedPids.length} process(es) and ` +
    `${removedDirs.length} temp dir(s)`,
);
for (const failure of failed) console.warn(`failed: ${failure}`);
process.exit(failed.length > 0 ? 1 : 0);
