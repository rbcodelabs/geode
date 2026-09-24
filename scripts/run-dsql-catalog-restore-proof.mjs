import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

/**
 * The two-process publish/restore harness for the DSQL adapter.
 *
 * Same shape as `run-catalog-restore-proof.mjs`, and deliberately so: one
 * disposable schema, VM A run to completion as its own OS process, that
 * process confirmed gone, VM B run as a second independent process, and the two
 * projections diffed. The schema is dropped in `finally` whatever happens.
 *
 * One thing is different, and it matters. This adapter keeps object bytes
 * outside the database, so the harness owns **two** stores rather than one: the
 * schema and an object-store directory. Both are created here, handed to both
 * children by name only, and torn down here. VM B still receives no snapshot,
 * no vault directory, no stdout and no projection from VM A — it receives two
 * store locations and rebuilds a vault by joining them.
 *
 * Each bundle's complete esbuild input graph is audited before it runs, on the
 * same terms as every other proof: the DSQL adapter and its object store are
 * the only modules in either build that may know about durable storage, and
 * `src/wiki/` must stay free of both.
 */

const PORTABLE_ENGINE = [
  "src/wiki/catalog-contract.ts", "src/wiki/folder-provider.ts", "src/wiki/contracts.ts",
  "src/wiki/local-filesystem.ts", "src/wiki/snapshot.ts", "src/wiki/metadata.ts",
  "src/wiki/link-candidates.ts", "src/wiki/constants.ts", "src/wiki/query-projection.ts",
  "src/renderer/comments/model.ts", "src/renderer/api/frontmatter.ts",
];

/** The adapter layer: the two modules that are allowed to know where bytes live. */
const ADAPTER = ["src/catalog/dsql-catalog-store.ts", "src/catalog/object-store.ts"];

const ALLOWED = {
  vmA: new Set([...ADAPTER, ...PORTABLE_ENGINE]),
  vmB: new Set([...ADAPTER, "src/wiki/catalog-materialize.ts", ...PORTABLE_ENGINE]),
  admin: new Set([...ADAPTER, "src/wiki/catalog-contract.ts", "src/wiki/link-candidates.ts"]),
};

const directory = await mkdtemp(join(tmpdir(), "geode-dsql-two-process-"));

async function bundle(entry, name, allowed) {
  const outfile = join(directory, `${name}.mjs`);
  const result = await build({
    entryPoints: [resolve(entry)], outfile,
    bundle: true, platform: "node", format: "esm", target: "node22", metafile: true,
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });
  const sources = Object.keys(result.metafile.inputs).filter((path) => path.startsWith("src/")).sort();
  for (const path of sources) assert.ok(allowed.has(path), `${name}: unexpected runtime dependency: ${path}`);
  // The PostgreSQL adapter must not be reachable from a DSQL build. The two are
  // independent reference adapters; a shared helper creeping between them is
  // exactly how "two adapters" quietly becomes "one adapter with a flag".
  assert.equal(
    sources.includes("src/catalog/postgres-catalog-store.ts"),
    false,
    `${name}: the PostgreSQL adapter must not appear in a DSQL build`,
  );
  assert.deepEqual(
    sources.filter((path) => path.startsWith("src/catalog/")).sort(),
    [...ADAPTER].sort(),
    `${name}: exactly the DSQL adapter and its object store may know where bytes live`,
  );
  return { outfile, sources };
}

function run(outfile, env, label) {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [outfile], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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

const schema = `geode_dsql_${randomUUID().replaceAll("-", "")}`;
const objectRoot = join(directory, "objects");
const env = { GEODE_CATALOG_SCHEMA: schema, GEODE_OBJECT_ROOT: objectRoot };
const projectionA = join(directory, "vm-a-projection.json");
const projectionB = join(directory, "vm-b-projection.json");

let installed = false;
try {
  const admin = await bundle("scripts/dsql-catalog-schema-admin.mts", "admin", ALLOWED.admin);
  const vmA = await bundle("scripts/dsql-catalog-publish-proof.mts", "vm-a", ALLOWED.vmA);
  const vmB = await bundle("scripts/dsql-catalog-restore-proof.mts", "vm-b", ALLOWED.vmB);

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
    adapter: "dsql",
    vmAPid: a.pid,
    vmBPid: b.pid,
    // Two durable stores, not one. VM B joins them; it is handed neither's
    // contents, only their names.
    sharedStores: ["schema", "objectRoot"],
    projectionBytes: Buffer.byteLength(beforePublish, "utf8"),
    projectionsIdentical: true,
    vmARuntimeSources: vmA.sources,
    vmBRuntimeSources: vmB.sources,
    adapterModulesPerBuild: 2,
    postgresAdapterInDsqlBuild: false,
  }));
} finally {
  if (installed) {
    await run(join(directory, "admin.mjs"), { ...env, GEODE_ADMIN_ACTION: "drop" }, "schema drop")
      .catch((error) => { process.stderr.write(`schema drop failed: ${error.message}\n`); });
  }
  await rm(directory, { recursive: true, force: true });
}
