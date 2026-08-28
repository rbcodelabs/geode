import { defineConfig } from "@playwright/test";

// Run Electron in headless/hidden mode during e2e tests so test runs don't pop
// up windows, bounce the macOS dock, or steal focus from the user's workspace.
// Pass GEODE_HEADLESS=0 (or HEADED=1) to launch with visible windows for debugging.
if (process.env.HEADED === "1" || process.env.GEODE_HEADLESS === "0") {
  process.env.GEODE_HEADLESS = "0";
} else {
  process.env.GEODE_HEADLESS = "1";
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  // Electron apps launched by specs hold a throwaway --user-data-dir under the
  // OS temp dir. A run that is interrupted (Ctrl-C, an editor stopping the
  // task) orphans those processes and leaks those dirs. Setup reaps leftovers
  // from previous runs; teardown reaps this run's. See scripts/e2e-reap.mts,
  // or run `npm run e2e:kill` by hand.
  globalSetup: "./scripts/e2e-global-setup.mts",
  globalTeardown: "./scripts/e2e-global-teardown.mts",
  // Each test cold-launches a real Electron app; back-to-back launches under
  // load occasionally miss a timing window. One retry absorbs that transient
  // flakiness without masking real failures (they fail both attempts).
  retries: 1,
  reporter: [["list"]],
  timeout: 45_000,
});
