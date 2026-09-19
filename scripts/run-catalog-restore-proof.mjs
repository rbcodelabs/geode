import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

/**
 * The two-process publish/restore harness.
 *
 * It installs one disposable schema, runs VM A to completion **as its own OS
 * process**, waits for that process to be fully gone, then runs VM B as a
 * second independent process, and diffs the two projections. The schema is
 * dropped in `finally` whatever happens.
 *
 * The separation is the point. VM B cannot be handed VM A's snapshot, its
 * provider, its captured files or its projection, because it does not share a
 * heap with VM A and does not start until VM A's PID is gone. Everything it
 * reconstructs, it reconstructs from durable state. This runner sees both
 * projections — that is what a diff oracle is for — but neither child sees the
 * other's.
 *
 * Each bundle's complete esbuild input graph is audited before it runs, on the
 * same terms as the existing proofs: the PostgreSQL adapter is the only module
 * in either build that may know a database exists.
 */

const PORTABLE_ENGINE = [
  "src/wiki/catalog-contract.ts", "src/wiki/folder-provider.ts", "src/wiki/contracts.ts",
  "src/wiki/local-filesystem.ts", "src/wiki/snapshot.ts", "src/wiki/metadata.ts",
  "src/wiki/link-candidates.ts", "src/wiki/constants.ts", "src/wiki/query-projection.ts",
  "src/renderer/comments/model.ts", "src/renderer/api/frontmatter.ts",
];

/** VM B additionally materializes; the admin bundle touches only the adapter. */
const ALLOWED = {
  vmA: new Set(["src/catalog/postgres-catalog-store.ts", ...PORTABLE_ENGINE]),
  vmB: new Set(["src/catalog/postgres-catalog-store.ts", "src/wiki/catalog-materialize.ts", ...PORTABLE_ENGINE]),
  admin: new Set(["src/catalog/postgres-catalog-store.ts", "src/wiki/catalog-contract.ts", "src/wiki/link-candidates.ts"]),
};

const directory = await mkdtemp(join(tmpdir(), "geode-catalog-two-process-"));

async function bundle(entry, name, allowed) {
  const outfile = join(directory, `${name}.mjs`);
  const result = await build({
    entryPoints: [resolve(entry)], outfile,
    bundle: true, platform: "node", format: "esm", target: "node22", metafile: true,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const sources = Object.keys(result.metafile.inputs).filter((path) => path.startsWith("src/")).sort();
  for (const path of sources) assert.ok(allowed.has(path), `${name}: unexpected runtime dependency: ${path}`);
  assert.deepEqual(
    sources.filter((path) => path.startsWith("src/catalog/")),
    ["src/catalog/postgres-catalog-store.ts"],
    `${name}: exactly one module in the build may know a database exists`,
  );
  return { outfile, sources };
}

/**
 * Run one child to completion and confirm the OS agrees it is gone.
 *
 * `close` fires after the process exited *and* its stdio closed, and
 * `kill(pid, 0)` then has to fail with ESRCH. "Waited for it to exit" is worth
 * asserting rather than assuming: it is the only thing standing between this
 * and two processes racing on one schema.
 */
function run(outfile, env, label) {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [outfile], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    // Decode once, across chunk boundaries — see the same call in
    // `src/catalog/postgres-catalog-store.ts`. Benign here today, because these
    // children print ASCII summaries, but the pattern is the bug and a future
    // summary carrying a vault path would inherit it.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", fail);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        fail(new Error(`${label} exited ${code}${signal ? ` (${signal})` : ""}:\n${stderr.trim()}\n${stdout.trim()}`));
        return;
      }
      let alive = true;
      try { process.kill(child.pid, 0); } catch { alive = false; }
      if (alive) fail(new Error(`${label} still has a live PID ${child.pid} after close`));
      else settle({ stdout: stdout.trim(), stderr: stderr.trim(), pid: child.pid });
    });
  });
}

const schema = `geode_catalog_${randomUUID().replaceAll("-", "")}`;
const env = { GEODE_CATALOG_SCHEMA: schema };
const projectionA = join(directory, "vm-a-projection.json");
const projectionB = join(directory, "vm-b-projection.json");

let installed = false;
try {
  const admin = await bundle("scripts/catalog-schema-admin.mts", "admin", ALLOWED.admin);
  const vmA = await bundle("scripts/catalog-publish-proof.mts", "vm-a", ALLOWED.vmA);
  const vmB = await bundle("scripts/catalog-restore-proof.mts", "vm-b", ALLOWED.vmB);

  await run(admin.outfile, { ...env, GEODE_ADMIN_ACTION: "install" }, "schema install");
  installed = true;

  const a = await run(vmA.outfile, { ...env, GEODE_PROJECTION_OUT: projectionA }, "VM A");
  // VM A is gone before VM B is even spawned. Nothing is handed across.
  const b = await run(vmB.outfile, { ...env, GEODE_PROJECTION_OUT: projectionB }, "VM B");
  assert.notEqual(a.pid, b.pid, "VM A and VM B must be different processes");

  const [beforePublish, afterRestore] = await Promise.all([
    readFile(projectionA, "utf8"), readFile(projectionB, "utf8"),
  ]);
  assert.ok(beforePublish.length > 1000, "VM A's projection must be substantive, not an empty object");
  if (beforePublish !== afterRestore) {
    const left = beforePublish.split("\n");
    const right = afterRestore.split("\n");
    const at = left.findIndex((line, index) => line !== right[index]);
    throw new Error(
      "VM A's pre-publish projection and VM B's restored projection differ.\n" +
      `First difference at line ${at + 1}:\n  VM A: ${left[at]}\n  VM B: ${right[at]}`,
    );
  }

  process.stdout.write(a.stdout + "\n");
  process.stdout.write(b.stdout + "\n");
  console.log(JSON.stringify({
    twoProcess: true,
    vmAPid: a.pid,
    vmBPid: b.pid,
    schemaSharedOnly: true,
    // UTF-8 bytes, so this is the same number each child reports rather than a
    // second, quietly different measure of the same artifact.
    projectionBytes: Buffer.byteLength(beforePublish, "utf8"),
    projectionsIdentical: true,
    vmARuntimeSources: vmA.sources,
    vmBRuntimeSources: vmB.sources,
    // Both VM bundles legitimately contain the adapter — they are the things
    // under test. "The portable core does not reach the adapter" is a
    // different claim, and it is `proof:catalog` that makes it.
    adapterModulesPerBuild: 1,
  }));
} finally {
  if (installed) {
    await run(join(directory, "admin.mjs"), { ...env, GEODE_ADMIN_ACTION: "drop" }, "schema drop")
      .catch((error) => { process.stderr.write(`schema drop failed: ${error.message}\n`); });
  }
  await rm(directory, { recursive: true, force: true });
}
