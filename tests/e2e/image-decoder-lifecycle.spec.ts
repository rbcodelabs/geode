import { test, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runChild, OwnedProcessGroups, collectProcessGroupRss } from "../../scripts/large-vault-runner-lib.mjs";
test.describe.configure({ retries: 0 });
test("observes all six native raster APIs through private settled sessions", async ({}, info) => {
  test.setTimeout(150_000);
  await mkdir(info.outputDir, { recursive: true });
  const terminal = info.outputPath("image-decoder-terminal.json");
  const result = await runChild({ script: resolve("scripts/run-image-decoder-proof.cjs"), args: [terminal], cwd: process.cwd(),
    resultFile: terminal, logFile: info.outputPath("image-decoder-native.log"), timeoutMs: 120_000 });
  expect(result.code).toBe(0); expect(result.status).toBe("ok"); expect(result.result.validated).toBe(true);
  const validation = result.result, reportBytes = await readFile(resolve("test-results/image-decoder-proof", validation.report));
  const report = JSON.parse(reportBytes.toString());
  expect(validation.commit).toBe(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  expect(report.commit).toBe(validation.commit); expect(report.runId).toBe(validation.runId);
  expect(createHash("sha256").update(reportBytes).digest("hex")).toBe(validation.reportSha256);
  expect(report.completed).toBe(true); expect(report.failure).toBeNull();
  expect(report.families.map((row: { family: string }) => row.family)).toEqual(["png", "jpeg", "gif", "webp", "bmp", "avif"]);
  expect(validation).not.toHaveProperty("phaseStartedAt");
  const guard = JSON.parse(await readFile(terminal + ".guard.json", "utf8")); expect(guard.cleanupUncertainty).toBe(false);
  // Observed, identity-verified owned groups only; no universal descendant claim.
  const tracker = new OwnedProcessGroups(0); tracker.started = true;
  for (const sample of guard.samples) for (const process of sample.processes) tracker.identities.set(process.pid, process.started);
  await expect.poll(async () => (await collectProcessGroupRss(0, tracker)).processes.length).toBe(0);
});
