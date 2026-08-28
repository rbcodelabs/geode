/**
 * Playwright globalSetup for the Electron e2e suite.
 *
 * Reaping *before* the run is the zero-risk moment to do it: nothing this run
 * owns exists yet, so every `geode-*` temp dir and orphaned app process found
 * here is detritus from an earlier interrupted run. Cleaning up front also
 * means a developer who kills a run mid-way gets a tidy machine on their next
 * `npm run test:e2e` without having to remember `npm run e2e:kill`.
 *
 * The suite assumes one run at a time (`workers: 1`, `fullyParallel: false`);
 * a second concurrent run would have its processes reaped by this one.
 */
import { reapE2EArtifacts } from "./e2e-reap.mts";

export default async function globalSetup(): Promise<void> {
  const { killedPids, removedDirs } = await reapE2EArtifacts();
  if (killedPids.length || removedDirs.length) {
    console.log(
      `[e2e] pre-run cleanup: killed ${killedPids.length} orphaned process(es), ` +
        `removed ${removedDirs.length} leftover temp dir(s)`,
    );
  }
}
