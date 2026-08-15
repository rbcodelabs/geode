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
  // Each test cold-launches a real Electron app; back-to-back launches under
  // load occasionally miss a timing window. One retry absorbs that transient
  // flakiness without masking real failures (they fail both attempts).
  retries: 1,
  reporter: [["list"]],
  timeout: 45_000,
});
