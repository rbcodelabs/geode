import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "*.spec.ts", workers: 1, retries: 0, timeout: 90_000, reporter: [["list"]] });
