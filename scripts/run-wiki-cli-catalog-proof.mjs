import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { buildCli } from "./build-cli.mjs";

/**
 * `geode-wiki catalog-publish` and `catalog-restore`, end to end, against a
 * real PostgreSQL schema — each step its own OS process.
 *
 * The round trip here is deliberately made out of *separate invocations*, the
 * same way `scripts/run-catalog-restore-proof.mjs` is made out of separate VMs.
 * The publish process is gone before the restore process starts, and a third
 * process then opens the restored folder as an ordinary vault and asks it the
 * same questions the source vault was asked. Nothing is handed between them but
 * the schema name and the bytes on disk.
 *
 * That third step is what makes the claim worth anything. "Restore wrote some
 * files" is weak; "a `geode-wiki list`, `search`, `resolve`, `outgoing` and
 * `backlinks` against the restored folder return byte-identical payloads to the
 * same five commands against the source" is the claim a caller actually cares
 * about, and it is made through the command surface rather than behind it.
 *
 * Requires libpq `PG*` variables pointing at a disposable server. It installs
 * one randomly-named schema and drops it in `finally`.
 */

const directory = await mkdtemp(join(tmpdir(), "geode-wiki-cli-catalog-"));
const binary = join(directory, "geode-wiki.mjs");
const admin = join(directory, "admin.mjs");
const source = join(directory, "source");
const restored = join(directory, "restored");
const schema = `geode_cli_${randomUUID().replaceAll("-", "")}`;

function run(command, args, env) {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [command, ...args], {
      env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", fail);
    child.on("close", (code) => {
      // The OS has to agree the process is gone before the next one starts —
      // the same check the two-VM restore harness makes, for the same reason.
      let alive = true;
      try { process.kill(child.pid, 0); } catch { alive = false; }
      if (alive) fail(new Error(`${command} still has a live PID ${child.pid} after close`));
      else settle({ code, stdout, stderr, pid: child.pid });
    });
  });
}

/** One `geode-wiki --json` invocation, parsed, with its PID. */
async function cli(args) {
  const result = await run(binary, [...args, "--json"], { GEODE_CATALOG_SCHEMA: schema });
  const line = result.stdout.trim().split("\n").at(-1);
  const payload = JSON.parse(line);
  assert.equal(payload.exit.code, result.code, `envelope exit code must match the process exit for ${args.join(" ")}`);
  return { ...result, payload };
}

let installed = false;
try {
  await buildCli({ outfile: binary });
  await build({
    entryPoints: [resolve("scripts/catalog-schema-admin.mts")], outfile: admin,
    bundle: true, platform: "node", format: "esm", target: "node22",
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  });

  /* ------------------------------------------------------------ the vault */

  // Small but not trivial: an alias, an ambiguous basename, a resolving link,
  // an unresolvable link and a binary attachment — each something a round trip
  // can lose.
  await mkdir(join(source, "a"), { recursive: true });
  await mkdir(join(source, "b"), { recursive: true });
  await mkdir(join(source, "assets"), { recursive: true });
  await writeFile(join(source, "Target.md"), "# Target\n\nThe target note, mentioning plesiosaur.\n", "utf8");
  await writeFile(join(source, "a/Dup.md"), "# Dup A\n", "utf8");
  await writeFile(join(source, "b/Dup.md"), "# Dup B\n", "utf8");
  await writeFile(
    join(source, "Index.md"),
    "---\naliases: [Pointer]\n---\n\n# Index\n\nPoints at [[Target]], at [[Dup]], at [[Nothing Here]] and "
    + "embeds ![[assets/diagram.png]].\n",
    "utf8",
  );
  // A real PNG header, so the content type is not a lie and the bytes are not text.
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
  await writeFile(join(source, "assets/diagram.png"), png);

  const install = await run(admin, [], { GEODE_CATALOG_SCHEMA: schema, GEODE_ADMIN_ACTION: "install" });
  assert.equal(install.code, 0, `schema install must succeed: ${install.stderr}`);
  installed = true;

  /* ------------------------------------------- 1. publish, as one process */

  const vaultId = "cli-round-trip";
  const published = await cli([
    "catalog-publish", "--root", source, "--vault-id", vaultId,
    "--mutation-id", "publish-1", "--base-sequence", "0",
  ]);
  assert.equal(published.payload.status, "ok", `publish must commit: ${published.stdout}${published.stderr}`);
  assert.equal(published.code, 0);
  assert.equal(published.payload.result.receipt.sequence, 1);
  assert.equal(published.payload.result.receipt.noteCount, 4);
  assert.equal(published.payload.result.receipt.assetCount, 1);
  // A publication of an incompletely-walked vault is still a publication, so
  // the receipt has to carry the walk's own account of itself.
  assert.equal(published.payload.coverage.discoveryComplete, true);

  /* ------------------------ 2. an identical replay is free, same receipt */

  const replay = await cli([
    "catalog-publish", "--root", source, "--vault-id", vaultId,
    "--mutation-id", "publish-1", "--base-sequence", "0",
  ]);
  assert.equal(replay.payload.status, "ok", "an identical replay must succeed");
  assert.deepEqual(replay.payload.result.receipt, published.payload.result.receipt,
    "an identical replay must return the original receipt, not a new one");
  assert.notEqual(replay.pid, published.pid);

  /* ------------------------------ 3. named catalog refusals, through argv */

  const conflict = await cli([
    "catalog-publish", "--root", source, "--vault-id", vaultId,
    "--mutation-id", "stale-1", "--base-sequence", "0",
  ]);
  assert.equal(conflict.payload.status, "conflict", "a stale base must be refused by name");
  assert.equal(conflict.code, 1);

  await writeFile(join(source, "Target.md"), "# Target\n\nSomething else entirely.\n", "utf8");
  const reused = await cli([
    "catalog-publish", "--root", source, "--vault-id", vaultId,
    "--mutation-id", "publish-1", "--base-sequence", "0",
  ]);
  assert.equal(reused.payload.status, "mutation-id-reused",
    "a reused mutation id with a changed payload must be refused by name");
  assert.equal(reused.code, 1);
  // Put the source back, so the equality comparison below is about the round
  // trip and not about an edit made halfway through it.
  await writeFile(join(source, "Target.md"), "# Target\n\nThe target note, mentioning plesiosaur.\n", "utf8");

  const absent = await cli(["catalog-restore", "--into", join(directory, "nothing"), "--vault-id", "never-published"]);
  assert.equal(absent.payload.status, "absent", "restoring a vault that was never published must be `absent`");
  assert.equal(absent.code, 1);

  const unavailableRoot = await cli([
    "catalog-publish", "--root", join(directory, "no-such-vault"), "--vault-id", "cli-missing",
    "--mutation-id", "m1", "--base-sequence", "0",
  ]);
  assert.equal(unavailableRoot.payload.status, "vault-unavailable",
    "publishing a folder that is not there must be unreachable, not a catalog refusal");
  assert.equal(unavailableRoot.code, 3, "and it must exit 3, not 1");

  /* ----------------------- 4. restore, as a different process entirely */

  const restoredResult = await cli(["catalog-restore", "--into", restored, "--vault-id", vaultId]);
  assert.equal(restoredResult.payload.status, "ok", `restore must succeed: ${restoredResult.stdout}${restoredResult.stderr}`);
  assert.equal(restoredResult.code, 0);
  assert.equal(restoredResult.payload.result.sequence, 1);
  assert.equal(restoredResult.payload.result.noteCount, 4);
  assert.equal(restoredResult.payload.result.assetCount, 1);
  assert.notEqual(restoredResult.pid, published.pid, "publish and restore must be different processes");

  /* ------- 5. the restored folder is a vault, and answers the same questions */

  const QUESTIONS = [
    ["list"],
    ["search", "plesiosaur"],
    ["resolve", "Index.md", "Target"],
    ["resolve", "Index.md", "Dup"],
    ["resolve", "Index.md", "Nothing Here"],
    ["resolve", "Target.md", "Pointer"],
    ["outgoing", "Index.md"],
    ["backlinks", "Target.md"],
    ["read", "Index.md"],
  ];
  const answers = [];
  for (const question of QUESTIONS) {
    const [command, ...rest] = question;
    const before = await cli([command, "--root", source, ...rest]);
    const after = await cli([command, "--root", restored, ...rest]);
    assert.notEqual(before.pid, after.pid);
    assert.deepEqual(
      after.payload.result, before.payload.result,
      `\`geode-wiki ${question.join(" ")}\` must answer identically against the restored vault`,
    );
    assert.equal(after.payload.status, before.payload.status);
    assert.equal(after.code, before.code);
    answers.push({ question: question.join(" "), status: after.payload.status });
  }

  // The claim above is only worth something if these questions have answers
  // that could have differed. Spot-checked rather than assumed.
  const byQuestion = Object.fromEntries(answers.map((answer) => [answer.question, answer.status]));
  assert.equal(byQuestion["resolve Index.md Dup"], "ambiguous", "the ambiguous pair must survive the round trip");
  assert.equal(byQuestion["resolve Index.md Nothing Here"], "missing", "the unresolvable link must stay unresolvable");
  assert.equal(byQuestion["resolve Target.md Pointer"], "resolved", "the alias must still resolve");
  assert.equal(byQuestion["search plesiosaur"], "ok");

  console.log(JSON.stringify({
    postgresRoundTripThroughArgv: true,
    schemaOwnedByThisHarness: true,
    publishPid: published.pid,
    restorePid: restoredResult.pid,
    receipt: published.payload.result.receipt,
    idempotentReplayReturnedOriginalReceipt: true,
    catalogRefusalsByName: {
      conflict: conflict.payload.status,
      mutationIdReused: reused.payload.status,
      absentRestore: absent.payload.status,
      unavailableRoot: unavailableRoot.payload.status,
    },
    restoredNotes: restoredResult.payload.result.noteCount,
    restoredAssets: restoredResult.payload.result.assetCount,
    restoredBytes: restoredResult.payload.result.totalBytes,
    questionsComparedAcrossTheRoundTrip: answers.length,
    everyAnswerIdentical: true,
  }));
} finally {
  if (installed) {
    const dropped = await run(admin, [], { GEODE_CATALOG_SCHEMA: schema, GEODE_ADMIN_ACTION: "drop" })
      .catch((error) => ({ code: 1, stderr: error.message }));
    if (dropped.code !== 0) process.stderr.write(`schema drop failed: ${dropped.stderr}\n`);
  }
  await rm(directory, { recursive: true, force: true });
}
