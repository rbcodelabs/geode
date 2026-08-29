import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/mobile",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  projects: [
    { name: "iPhone 13", grep: /@phone/, use: { ...devices["iPhone 13"], browserName: "chromium" } },
    { name: "iPad Pro 11", grep: /@tablet/, use: { ...devices["iPad Pro 11"], browserName: "chromium" } },
  ],
});
