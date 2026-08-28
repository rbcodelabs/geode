/**
 * Playwright globalSetup for the Electron e2e suite.
 *
 * Reaping before the run means a developer who kills a run mid-way gets a tidy
 * machine on their next `npm run test:e2e` without having to remember
 * `npm run e2e:kill`.
 *
 * "Before our own run" is *not* the same as "nothing is running". Sibling git
 * worktrees of this repo may have their own suites in flight, and their temp
 * dirs and processes are indistinguishable from ours by name. Both guards below
 * exist to avoid sabotaging them:
 *
 * - `repoRoot` scopes process kills to launches from this checkout.
 * - `minAgeMs` limits directory removal to things nothing has touched in half an
 *   hour, which a live run never is.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTO_REAP_MIN_AGE_MS, reapE2EArtifacts } from "./e2e-reap.mts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default async function globalSetup(): Promise<void> {
  const { killedPids, removedDirs } = await reapE2EArtifacts({
    repoRoot,
    minAgeMs: AUTO_REAP_MIN_AGE_MS,
  });
  if (killedPids.length || removedDirs.length) {
    console.log(
      `[e2e] pre-run cleanup: killed ${killedPids.length} orphaned process(es), ` +
        `removed ${removedDirs.length} leftover temp dir(s)`,
    );
  }
}
