import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FakeCompassServer } from "../helpers/fake-compass-server";

let server: FakeCompassServer;
beforeEach(async () => { server = new FakeCompassServer(); await server.start(); });
afterEach(() => server.stop());

function runSmoke(extra: Record<string, string> = {}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/run-compass-sync-smoke.mjs"], {
      env: { ...process.env, COMPASS_URL: server.baseUrl, COMPASS_WORKSPACE_ID: server.workspaceId, COMPASS_TOKEN: server.token, ...extra },
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code, output }));
  });
}

it("the real-deployment smoke script passes against the contract stand-in (trash and hard delete)", async () => {
  const trash = await runSmoke();
  expect(trash.output).toContain("All checks passed.");
  expect(trash.code).toBe(0);
  expect(server.paths().some((path) => path.startsWith("Geode Trash/"))).toBe(true);
  const hard = await runSmoke({ COMPASS_SMOKE_HARD_DELETE: "1" });
  expect(hard.code).toBe(0);
}, 60_000);

it("the smoke script fails loudly on bad credentials", async () => {
  const bad = await runSmoke({ COMPASS_TOKEN: "nope" });
  expect(bad.code).toBe(1);
  expect(bad.output).toMatch(/rejected the access token/);
}, 60_000);
