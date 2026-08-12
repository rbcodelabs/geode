import { defineConfig } from "@playwright/test";

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
