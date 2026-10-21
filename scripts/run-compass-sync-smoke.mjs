import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

// Bundle the TypeScript smoke script (it imports renderer code with extensionless paths) and run it with this
// process's environment. See the header of scripts/compass-sync-smoke.mts for the variables.
const directory = await mkdtemp(join(tmpdir(), "compass-sync-smoke-"));
const outfile = join(directory, "smoke.mjs");
try {
  await build({ entryPoints: ["scripts/compass-sync-smoke.mts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile, logLevel: "error" });
  const result = spawnSync(process.execPath, [outfile], { stdio: "inherit", env: process.env });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
