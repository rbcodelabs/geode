import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "./build-cli.mjs";

/**
 * The `geode-wiki` proof: a real binary, in real subprocesses.
 *
 * Nothing here calls `run()` in-process. Every assertion below is made against
 * a child process's actual stdout, stderr and exit status, because the claim
 * being made is about a *command* — a caller that shells out never sees a
 * return value, only those three things.
 *
 * Two properties are worth naming up front, because they are the reasons this
 * increment is a CLI and not a long-lived server:
 *
 * 1. **Cross-process consistency.** A note created by one invocation is read
 *    back by a second, separate invocation with a different PID. A long-lived
 *    session would satisfy this from its own heap and prove nothing; a short
 *    process can only satisfy it by having actually written to disk and then
 *    actually re-captured. Asserted with the PIDs, so "two processes" is
 *    observed rather than assumed.
 *
 * 2. **The layering is enforced, not asserted.** The audit below reads
 *    esbuild's per-file import records and fails on the *edge*, naming which
 *    module reached past which boundary — not merely on the resulting set. A
 *    module under `src/cli/` may import `src/wiki/index.ts`,
 *    `src/catalog/index.ts` and its own siblings. Nothing else in `src/`.
 */

/* ------------------------------------------------------------------ setup */

const directory = await mkdtemp(join(tmpdir(), "geode-wiki-cli-"));
const binary = join(directory, "geode-wiki.mjs");
const root = join(directory, "vault");

/** One invocation. Returns what a shell would see, plus the PID that produced it. */
function cli(args, { stdin } = {}) {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [binary, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", fail);
    child.on("close", (code) => settle({ code, stdout, stderr, pid: child.pid }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

/** A `--json` invocation, parsed. Every command answers with one envelope on one line. */
async function json(args) {
  const result = await cli([...args, "--json"]);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `--json must print exactly one line, got ${lines.length}: ${result.stdout}`);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.tool, "geode-wiki");
  assert.equal(payload.schemaVersion, 1);
  // The payload's own account of the exit code must match the one the OS saw,
  // or a caller trusting either would be trusting a different thing.
  assert.equal(payload.exit.code, result.code, `envelope exit code must equal the process exit status for ${args.join(" ")}`);
  return { ...result, payload };
}

try {
  /* ------------------------------------------------------------- the audit */

  const built = await buildCli({ outfile: binary });
  const inputs = built.metafile.inputs;
  const sources = Object.keys(inputs).filter((path) => path.startsWith("src/")).sort();

  // The enforcement, per edge. This is the constraint the increment was given —
  // "a thin argument-parsing and formatting layer that does not reach past
  // src/wiki/index.ts" — written as something that fails a build rather than as
  // a sentence in a design doc.
  const ENTRY_POINTS = new Set(["src/wiki/index.ts", "src/catalog/index.ts"]);
  const cliModules = sources.filter((path) => path.startsWith("src/cli/"));
  assert.ok(cliModules.length >= 2, "the CLI must be more than one module for this audit to mean anything");
  for (const module of cliModules) {
    for (const edge of inputs[module].imports) {
      if (!edge.path.startsWith("src/")) continue;
      assert.ok(
        ENTRY_POINTS.has(edge.path) || edge.path.startsWith("src/cli/"),
        `${module} imports ${edge.path} (as ${JSON.stringify(edge.original)}): the CLI may only reach ` +
        `src/wiki/index.ts, src/catalog/index.ts and its own modules`,
      );
    }
  }

  // Named boundaries first, so crossing one reports *which* was crossed.
  // `src/wiki/search.ts` and `src/wiki/link-resolution.ts` carry the same
  // meaning here as in the SDK audit: they are the desktop operator query
  // language and the desktop-compatibility resolver, and either appearing would
  // mean the CLI had quietly shipped a second, contradictory answer for
  // `search` or `resolve`. `query-projection.ts` is the restore-equality test
  // oracle, which is proof machinery and not a product surface.
  const forbidden = {
    "the desktop operator query language": ["src/wiki/search.ts"],
    "the desktop-compatibility link resolver": ["src/wiki/link-resolution.ts"],
    "the restore-equality test oracle": ["src/wiki/query-projection.ts"],
  };
  for (const [description, paths] of Object.entries(forbidden)) {
    for (const path of paths) {
      assert.ok(!sources.includes(path), `${description} must not be in the CLI graph: ${path}`);
    }
  }
  for (const prefix of ["src/indexer/", "src/main/", "src/preload/"]) {
    assert.ok(!sources.some((path) => path.startsWith(prefix)), `nothing under ${prefix} may reach the CLI graph`);
  }
  assert.deepEqual(
    sources.filter((path) => path.startsWith("src/renderer/")),
    ["src/renderer/api/frontmatter.ts", "src/renderer/comments/model.ts"],
    "the CLI must inherit exactly the SDK's two portable renderer helpers and no more",
  );

  // EXACT, not a permitted superset — same discipline as the SDK audit. A
  // module that quietly *disappears* is as much a change to the layering as one
  // that appears.
  assert.deepEqual(sources, [
    "src/catalog/index.ts",
    "src/catalog/postgres-catalog-store.ts",
    "src/cli/geode-wiki.ts",
    "src/cli/main.ts",
    "src/cli/output.ts",
    "src/renderer/api/frontmatter.ts",
    "src/renderer/comments/model.ts",
    "src/wiki/catalog-contract.ts",
    "src/wiki/catalog-materialize.ts",
    "src/wiki/constants.ts",
    "src/wiki/folder-provider.ts",
    "src/wiki/index.ts",
    "src/wiki/link-candidates.ts",
    "src/wiki/local-filesystem.ts",
    "src/wiki/metadata.ts",
    "src/wiki/snapshot.ts",
  ], "the CLI input graph must be exactly the audited set");

  /* ------------------------------------------------------------- a vault */

  await mkdir(join(root, "a"), { recursive: true });
  await mkdir(join(root, "b"), { recursive: true });
  const targetText = "# Target\n\nThe target note.\n";
  await writeFile(join(root, "Target.md"), targetText, "utf8");
  await writeFile(join(root, "a/Dup.md"), "# Dup A\n", "utf8");
  await writeFile(join(root, "b/Dup.md"), "# Dup B\n", "utf8");
  await writeFile(
    join(root, "Referrer.md"),
    "---\naliases: [Pointer]\n---\n\n# Referrer\n\nPoints at [[Target]], at [[Dup]], and mentions plesiosaur.\n",
    "utf8",
  );

  const V = ["--root", root];

  /* --------------------------------------------------------------- help */

  const help = await cli(["--help"]);
  assert.equal(help.code, 0, "--help must succeed");
  for (const command of [
    "info", "list", "read", "search", "resolve", "outgoing", "backlinks",
    "create", "update", "delete", "catalog-publish", "catalog-restore",
  ]) {
    assert.ok(help.stdout.includes(command), `--help must document ${command}`);
  }
  assert.ok(help.stdout.includes("There is no \"refresh\" command"),
    "--help must say why the eleventh session method has no subcommand");

  /* ------------------------------------- usage errors never reach the engine */

  // Exit 2 is reserved for "argv could not be turned into an operation". Each
  // of these must be distinguishable from a refusal *by exit status alone*.
  const usageCases = {
    unknownCommand: await cli(["frobnicate", ...V]),
    missingPositional: await cli(["read", ...V]),
    extraPositional: await cli(["list", ...V, "surplus"]),
    unknownFlag: await cli(["list", ...V, "--colour"]),
    missingRoot: await cli(["list"]),
    bothTextForms: await cli(["create", ...V, "X.md", "--text", "a", "--text-file", "b"]),
    noTextForm: await cli(["create", ...V, "X.md"]),
    badInteger: await cli(["search", ...V, "x", "--limit", "many"]),
    noCommand: await cli([]),
    // Two problems at once: an unreachable root (exit 3) and an unparseable
    // `--limit` (exit 2). The one the caller wrote wins, which is only true
    // because every argv-decidable check runs before the folder is opened.
    // Caught by a unit test that expected 2 and observed 3.
    badIntegerBeatsAnUnreachableRoot: await cli([
      "search", "--root", join(directory, "not-a-vault"), "x", "--limit", "many",
    ]),
  };
  for (const [label, result] of Object.entries(usageCases)) {
    assert.equal(result.code, 2, `${label} must exit 2 (usage), got ${result.code}: ${result.stdout}${result.stderr}`);
  }
  // A usage failure must not have touched the vault.
  assert.equal(
    (await json(["read", ...V, "X.md"])).payload.status, "absent",
    "a refused create must not have created anything",
  );

  /* ------------------------------------------------------------ the reads */

  const info = await json(["info", ...V]);
  assert.equal(info.code, 0);
  assert.equal(info.payload.result.consistency, "scan");
  assert.equal(info.payload.result.referenceSyntax, "wikilinks");
  assert.equal(info.payload.coverage.discoveryComplete, true);

  const list = await json(["list", ...V]);
  assert.deepEqual(
    list.payload.result.files.map((file) => file.path),
    ["Referrer.md", "Target.md", "a/Dup.md", "b/Dup.md"],
    "list must return every note in path order",
  );
  assert.deepEqual(Object.keys(list.payload.result.files[0]).sort(), ["kind", "path"]);

  // Human `read` writes the note's bytes and nothing else, so a redirect
  // round-trips the file.
  const readHuman = await cli(["read", ...V, "Target.md"]);
  assert.equal(readHuman.code, 0);
  assert.equal(readHuman.stdout, targetText, "human `read` must emit the note's exact bytes");

  const readJson = await json(["read", ...V, "Referrer.md"]);
  assert.deepEqual(readJson.payload.result.metadata.links.map((link) => link.link), ["Target", "Dup"]);
  assert.deepEqual(readJson.payload.result.metadata.aliases, ["Pointer"]);
  assert.equal(readJson.payload.result.parserCoverage.referencesCertain, true);

  const search = await json(["search", ...V, "plesiosaur"]);
  assert.deepEqual(search.payload.result.hits.map((hit) => hit.path), ["Referrer.md"]);
  assert.equal(search.payload.result.complete, true);

  /* ---------------------------------- the resolution vocabulary, by name */

  // The four answers a caller has to be able to tell apart. `missing` and
  // `unavailable` are the sharp pair: one means "I looked and it is not there",
  // the other "I could not look" — and they carry different exit codes so a
  // shell can tell them apart without reading stdout.
  const resolved = await json(["resolve", ...V, "Referrer.md", "Target"]);
  assert.equal(resolved.payload.status, "resolved");
  assert.equal(resolved.payload.result.path, "Target.md");
  assert.equal(resolved.code, 0);

  const ambiguous = await json(["resolve", ...V, "Referrer.md", "Dup"]);
  assert.equal(ambiguous.payload.status, "ambiguous");
  assert.deepEqual(ambiguous.payload.result.candidates, ["a/Dup.md", "b/Dup.md"]);
  assert.equal(ambiguous.payload.result.path, undefined, "an ambiguous resolution must not pick a winner");
  assert.equal(ambiguous.code, 1);

  const missing = await json(["resolve", ...V, "Referrer.md", "Nope"]);
  assert.equal(missing.payload.status, "missing");
  assert.equal(missing.code, 1);

  const alias = await json(["resolve", ...V, "Target.md", "Pointer"]);
  assert.equal(alias.payload.status, "resolved");
  assert.equal(alias.payload.result.path, "Referrer.md");

  const outgoing = await json(["outgoing", ...V, "Referrer.md"]);
  assert.deepEqual(
    outgoing.payload.result.references.map((reference) => [reference.link, reference.resolution.status]),
    [["Target", "resolved"], ["Dup", "ambiguous"]],
    "outgoing links must carry their own resolutions, ambiguity included",
  );

  const backlinks = await json(["backlinks", ...V, "Target.md"]);
  assert.deepEqual(backlinks.payload.result.references.map((reference) => reference.sourcePath), ["Referrer.md"]);

  /* ------------------------- honest diagnostics: not found vs. not looked at */

  // A capture cut short by a limit. Every answer derived from it has to say so,
  // in the payload and on stderr, or a caller will read an empty result as
  // evidence of absence.
  const capped = ["--max-entries", "2"];
  const cappedSearch = await json(["search", ...V, ...capped, "plesiosaur"]);
  assert.equal(cappedSearch.payload.status, "ok", "an incomplete search is still a successful call");
  assert.deepEqual(cappedSearch.payload.result.hits, [], "the note holding the term was never walked");
  assert.equal(cappedSearch.payload.result.complete, false, "and the result must admit it");
  assert.equal(cappedSearch.payload.coverage.discoveryComplete, false);
  assert.ok(cappedSearch.payload.coverage.diagnostics.some((d) => d.code === "entry-limit"),
    "the capture must name the limit it hit");
  assert.ok(cappedSearch.stderr.includes("absence is not provable"),
    "an incomplete walk must warn on stderr even when the call succeeded");

  const cappedResolve = await json(["resolve", ...V, ...capped, "Referrer.md", "Target"]);
  assert.equal(cappedResolve.payload.status, "unavailable",
    "resolving from a note that was never walked is `unavailable`, not `missing`");
  assert.equal(cappedResolve.code, 3, "and it exits 3, so a shell can tell it from a real miss");

  // A write against an incomplete capture is refused rather than guessed at.
  const cappedWrite = await json(["create", ...V, ...capped, "Whatever.md", "--text", "x"]);
  assert.equal(cappedWrite.payload.status, "capture-incomplete");
  assert.equal(cappedWrite.code, 1);

  /* ------------------------------- CROSS-PROCESS CONSISTENCY: the whole point */

  const body = "# Fresh\n\nMentions ichthyosaur, points at [[Target]].\n";
  const created = await json(["create", ...V, "notes/Fresh.md", "--text", body]);
  assert.equal(created.payload.status, "ok");
  assert.equal(created.code, 0);

  // A second, separate process. It shares no heap with the first and holds no
  // session — everything it answers, it answers from a fresh capture of disk.
  const readBack = await cli(["read", ...V, "notes/Fresh.md"]);
  assert.equal(readBack.code, 0);
  assert.notEqual(created.pid, readBack.pid, "the create and the read must be different processes");
  assert.equal(readBack.stdout, body, "the second process must read back exactly what the first wrote");

  // And a third, asking a *derived* question — one that requires re-parsing and
  // re-indexing, not merely re-reading bytes.
  const searchBack = await json(["search", ...V, "ichthyosaur"]);
  assert.notEqual(searchBack.pid, created.pid);
  assert.deepEqual(searchBack.payload.result.hits.map((hit) => hit.path), ["notes/Fresh.md"]);
  const backlinksBack = await json(["backlinks", ...V, "Target.md"]);
  assert.deepEqual(
    backlinksBack.payload.result.references.map((reference) => reference.sourcePath).sort(),
    ["Referrer.md", "notes/Fresh.md"],
    "a fourth process must see the new note's backlink",
  );

  // Stdin as a text source, then the delete, then the disappearance — each its
  // own process.
  const updated = await json(["update", ...V, "notes/Fresh.md", "--text-file", "-"]);
  const stdinBody = "# Fresh\n\nNow mentions mosasaur.\n";
  const updatedViaStdin = await cli(["update", ...V, "notes/Fresh.md", "--text-file", "-", "--json"], { stdin: stdinBody });
  assert.equal(updated.payload.status, "ok", "an empty stdin is still a valid note body");
  assert.equal(JSON.parse(updatedViaStdin.stdout.trim()).status, "ok");
  assert.equal(await readFile(join(root, "notes/Fresh.md"), "utf8"), stdinBody,
    "stdin must reach the real filesystem");
  assert.deepEqual((await json(["search", ...V, "ichthyosaur"])).payload.result.hits, [],
    "the replaced text must stop matching in the next process");

  const deleted = await json(["delete", ...V, "notes/Fresh.md"]);
  assert.equal(deleted.payload.status, "ok");
  const afterDelete = await json(["read", ...V, "notes/Fresh.md"]);
  assert.notEqual(deleted.pid, afterDelete.pid);
  assert.equal(afterDelete.payload.status, "absent", "the delete must be visible to the next process");
  assert.equal(afterDelete.code, 1);

  const processIds = new Set([created.pid, readBack.pid, searchBack.pid, deleted.pid, afterDelete.pid]);
  assert.equal(processIds.size, 5, "every step above must have been its own process");

  /* -------------------------------- every refusal keeps its own name and code */

  const refusals = {
    alreadyExists: await json(["create", ...V, "Target.md", "--text", "x"]),
    portabilityCollision: await json(["create", ...V, "TARGET.md", "--text", "x"]),
    notANote: await json(["create", ...V, "asset.png", "--text", "x"]),
    invalidPath: await json(["create", ...V, "../Escape.md", "--text", "x"]),
    absentUpdate: await json(["update", ...V, "Nope.md", "--text", "x"]),
    absentDelete: await json(["delete", ...V, "Nope.md"]),
    absentRead: await json(["read", ...V, "Nope.md"]),
  };
  assert.deepEqual(
    Object.fromEntries(Object.entries(refusals).map(([label, result]) => [label, result.payload.status])),
    {
      alreadyExists: "already-exists",
      portabilityCollision: "portability-collision",
      notANote: "not-a-note",
      invalidPath: "invalid-path",
      absentUpdate: "absent",
      absentDelete: "absent",
      absentRead: "absent",
    },
    "every refusal must survive the CLI with its own distinct name",
  );
  for (const [label, result] of Object.entries(refusals)) {
    assert.equal(result.code, 1, `${label} must exit 1 (refused)`);
  }
  assert.equal(await readFile(join(root, "Target.md"), "utf8"), targetText,
    "refused writes must not touch existing notes");

  /* ------------------------------------------------ the unavailable outcome */

  const noSuchRoot = await json(["list", "--root", join(directory, "not-a-vault")]);
  assert.equal(noSuchRoot.payload.status, "vault-unavailable");
  assert.equal(noSuchRoot.payload.result.code, "root-unavailable");
  assert.equal(noSuchRoot.code, 3);

  /* ------------------- catalog refusals decidable without contacting a store */

  // Both of these are the contract's "decide it before you touch a database"
  // rule reaching the command line: no `PG*` variable is set here and no `psql`
  // is spawned, yet each refusal arrives by name.
  const badSchema = await json(["catalog-publish", ...V, "--schema", "public",
    "--vault-id", "v", "--mutation-id", "m", "--base-sequence", "0"]);
  assert.equal(badSchema.payload.status, "invalid-schema");
  assert.equal(badSchema.code, 1);

  const badVaultId = await json(["catalog-restore", "--into", join(directory, "restored"),
    "--schema", "geode_cli_never_used", "--vault-id", "not a vault id"]);
  assert.equal(badVaultId.payload.status, "invalid-vault-id");
  assert.equal(badVaultId.code, 1);

  const catalogUsage = await cli(["catalog-publish", ...V, "--schema", "geode_cli_never_used", "--vault-id", "v"]);
  assert.equal(catalogUsage.code, 2, "a missing --mutation-id is a usage error, not a refusal");

  /* ------------------------------------------------------------- the report */

  const codes = {
    ok: resolved.code,
    refused: ambiguous.code,
    usage: usageCases.unknownCommand.code,
    unavailable: noSuchRoot.code,
  };
  assert.deepEqual(codes, { ok: 0, refused: 1, usage: 2, unavailable: 3 },
    "all four documented exit codes must have been observed");

  console.log(JSON.stringify({
    realSubprocesses: true,
    exitCodesObserved: codes,
    distinctPidsInConsistencyRun: processIds.size,
    crossProcessReadAfterWrite: readBack.stdout === body,
    resolutionVocabulary: {
      resolved: resolved.payload.status, ambiguous: ambiguous.payload.status,
      ambiguousCandidates: ambiguous.payload.result.candidates.length,
      missing: missing.payload.status, notScanned: cappedResolve.payload.status,
      alias: alias.payload.status,
    },
    writeRefusals: Object.keys(refusals).length,
    distinctWriteRefusalStatuses: new Set(Object.values(refusals).map((r) => r.payload.status)).size,
    usageCases: Object.keys(usageCases).length,
    catalogRefusalsWithoutADatabase: 2,
    incompleteCaptureAdmitted: cappedSearch.payload.result.complete === false
      && cappedSearch.payload.coverage.discoveryComplete === false,
  }));
  console.log(JSON.stringify({ runtimeSources: sources, cliModules }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
