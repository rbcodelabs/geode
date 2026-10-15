import { test, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { runChild, OwnedProcessGroups, collectProcessGroupRss } from "../../scripts/large-vault-runner-lib.mjs";
test.describe.configure({ retries: 0 });
test("records nine raw native decode teardown observations without settlement claims", async ({}, info) => {
  test.setTimeout(150_000); await mkdir(info.outputDir, { recursive: true });
  const terminal = info.outputPath("diagnostic-terminal.json");
  const result = await runChild({ script: resolve("scripts/run-image-native-diagnostics.cjs"), args: [terminal], cwd: process.cwd(),
    resultFile: terminal, logFile: info.outputPath("native.log"), timeoutMs: 120_000 });
  expect(result.code).toBe(0); expect(result.status).toBe("ok"); expect(result.result.diagnosticComplete).toBe(true); expect(result.result.settlementAccepted).toBe(false);
  const validation = result.result, bytes = await readFile(resolve(validation.report)), report = JSON.parse(bytes.toString());
  expect(validation.commit).toBe(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
  expect(report.commit).toBe(validation.commit); expect(report.runId).toBe(validation.runId);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(validation.reportSha256);
  const guard = JSON.parse(await readFile(terminal + ".guard.json", "utf8")); expect(guard.cleanupUncertainty).toBe(false);
  const tracker = new OwnedProcessGroups(0); tracker.started = true;
  for (const sample of guard.samples) for (const process of sample.processes) tracker.identities.set(process.pid, process.started);
  await expect.poll(async () => (await collectProcessGroupRss(0, tracker)).processes.length).toBe(0);
});
