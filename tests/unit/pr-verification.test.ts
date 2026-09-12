import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { expect, it } from "vitest";

it("runs the complete read-only verification gate for stacked pull requests", () => {
  const path = resolve(".github/workflows/verify.yml");
  expect(existsSync(path), "PR verification workflow must exist").toBe(true);
  const workflow = parse(readFileSync(path, "utf8"));
  expect(workflow.on.pull_request).toEqual({});
  expect(workflow.on.pull_request_target).toBeUndefined();
  expect(workflow.permissions).toEqual({ contents: "read" });
  const job = workflow.jobs.verify;
  expect(job["runs-on"]).toBe("macos-latest");
  expect(job.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"))?.with["persist-credentials"]).toBe(false);
  const commands = job.steps.flatMap((step: { run?: string }) => step.run ? [step.run] : []);
  expect(commands).toEqual(["npm ci", "npm run typecheck", "npm run proof:headless", "npm run proof:local-wiki", "npm test"]);
  expect(job.steps.every((step: Record<string, unknown>) => !step["continue-on-error"])).toBe(true);
});
