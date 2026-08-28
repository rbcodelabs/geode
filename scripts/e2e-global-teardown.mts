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
 */
import { reapE2EArtifacts } from "./e2e-reap.mts";

export default async function globalTeardown(): Promise<void> {
  const { killedPids, removedDirs, failed } = await reapE2EArtifacts();
  if (killedPids.length || removedDirs.length) {
    console.log(
      `[e2e] post-run cleanup: killed ${killedPids.length} leftover process(es), ` +
        `removed ${removedDirs.length} temp dir(s)`,
    );
  }
  for (const failure of failed) console.warn(`[e2e] cleanup failed for ${failure}`);
}
