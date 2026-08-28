/**
 * Playwright globalTeardown for the Electron e2e suite.
 *
 * Specs that finish normally close their own app handle, but a spec that times
 * out, throws past its cleanup, or is interrupted leaves an Electron process
 * holding a temp user-data dir. This is the backstop that keeps a failed run
 * from costing the developer a stray window and a leaked directory.
 *
 * Teardown does not run when the process is hard-killed (SIGKILL), which is
 * exactly why globalSetup reaps as well.
 *
 * Scoped to this checkout, and to directories nothing has touched recently, so
 * a suite running concurrently in a sibling worktree is never disturbed — see
 * scripts/e2e-global-setup.mts.
 *
 * Note this means our *own* just-created dirs are too fresh to remove here. The
 * next run's globalSetup collects them; the point of this pass is killing live
 * strays before they linger, which it does immediately.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AUTO_REAP_MIN_AGE_MS, reapE2EArtifacts } from "./e2e-reap.mts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default async function globalTeardown(): Promise<void> {
  const { killedPids, removedDirs, failed } = await reapE2EArtifacts({
    repoRoot,
    minAgeMs: AUTO_REAP_MIN_AGE_MS,
  });
  if (killedPids.length || removedDirs.length) {
    console.log(
      `[e2e] post-run cleanup: killed ${killedPids.length} leftover process(es), ` +
        `removed ${removedDirs.length} temp dir(s)`,
    );
  }
  for (const failure of failed) console.warn(`[e2e] cleanup failed for ${failure}`);
}
