import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCli } from "./build-cli.mjs";
import { auditCliImports } from "./cli-import-audit.mjs";

/**
 * The `geode-wiki sync` proof: the real built binary, in real subprocesses, between two vaults and a
 * hub reached through a stand-in for ssh.
 *
 * Nothing here calls `run()` in-process. Every claim is made against a child process's exit status,
 * stdout and stderr, because that is all a cron job or an agent ever sees.
 *
 * ## The ssh stand-in
 *
 * `spawnSshStore` runs `ssh -o BatchMode=yes ... <host> "geode-wiki sync serve --store '<path>'"`. The
 * stand-in is a real executable named `ssh` placed first on PATH. It skips the `-o x` pairs, records
 * its argv, and runs the remote command through `sh -c` — so the REAL command line the product would
 * send is what executes, and `geode-wiki` on that "remote" PATH is a shim that runs the built binary.
 * Two switches let the proof stage failure deterministically without sleeps or races:
 *   PROOF_SSH_FAIL=1       exit 255 like an unreachable host
 *   PROOF_SSH_GATE=<file>  write <file>.waiting, then block until <file> exists. A sync run takes its
 *                          lock BEFORE it opens the store, so a run parked here is a run provably
 *                          holding the lock — a real second process can then be refused with exit 5.
 */

const directory = await mkdtemp(join(tmpdir(), "geode-wiki-sync-proof-"));
const binary = join(directory, "geode-wiki.mjs");
const bin = join(directory, "bin");
const hub = join(directory, "hub");
const sshLog = join(directory, "ssh.log");
const brctlLog = join(directory, "brctl.log");
const OLD = () => (Date.now() - 120_000) / 1000;

const children = new Set();
function exec(args, { env = {}, devEnv = {} } = {}) {
  let child;
  const done = new Promise((settle, fail) => {
    child = spawn(process.execPath, [binary, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PROOF_SSH_LOG: sshLog, PROOF_BRCTL_LOG: brctlLog, ...devEnv, ...env },
    });
    children.add(child);
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", fail);
    child.on("close", (code) => { children.delete(child); settle({ code, stdout, stderr, pid: child.pid }); });
  });
  return { done, child };
}

class Device {
  constructor(name) {
    this.name = name;
    this.root = join(directory, name);
    this.home = join(directory, `${name}-home`);
    this.env = { GEODE_SYNC_HOME: this.home };
  }
  async write(rel, text) {
    const file = join(this.root, rel);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, text);
    await utimes(file, OLD(), OLD());
  }
  read(rel) { return readFile(join(this.root, rel), "utf8"); }
  has(rel) { return existsSync(join(this.root, rel)); }
  async notes() { return (await readdir(this.root, { recursive: true })).filter((p) => p.endsWith(".md")).sort(); }
  argv(sub, extra) { return ["sync", sub, "--root", this.root, "--settle-ms", "0", ...extra]; }
  /** A `--json` invocation. The envelope's own exit code must equal the OS's, and stdout must be one line. */
  async j(sub, ...extra) {
    const r = await exec(this.argv(sub, [...extra, "--json"]), { devEnv: this.env }).done;
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1, `${this.name} sync ${sub}: --json must print exactly one line, got: ${r.stdout}`);
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.tool, "geode-wiki");
    assert.equal(payload.exit.code, r.code, `${this.name} sync ${sub}: envelope exit code must equal the process exit status`);
    return { ...r, payload, result: payload.result };
  }
  start(sub, extra, env) { return exec(this.argv(sub, extra), { devEnv: this.env, env }); }
  async bootstrap() {
    await this.j("preview");
    const approved = await this.j("preview", "--approve");
    assert.equal(approved.code, 0, approved.stdout);
    const ran = await this.j("run");
    assert.equal(ran.code, 0, `${this.name} first run: ${ran.stdout}${ran.stderr}`);
    return ran;
  }
}

/** A tiny node script made executable: the proof is TypeScript/Node end to end, no shell logic of its own. */
async function installShim(name, source) {
  const file = join(bin, name);
  await writeFile(file, `#!/usr/bin/env node\n${source}`);
  await chmod(file, 0o755);
}

try {
  /* ----------------------------------------------------------- build + audit */

  const built = await buildCli({ outfile: binary });
  const inputs = built.metafile.inputs;
  const violations = auditCliImports(inputs);
  assert.deepEqual(violations, [], `import-rule violations:\n  ${violations.join("\n  ")}`);
  const sources = Object.keys(inputs).filter((p) => p.startsWith("src/"));
  for (const required of ["src/cli/sync.ts", "src/sync-node/index.ts", "src/sync-node/wiki-sync.ts", "src/sync-core/history-controller.ts"]) {
    assert.ok(sources.includes(required), `the bundle must contain ${required}`);
  }

  /* ----------------------------------------------------------- stand-ins */

  await mkdir(bin, { recursive: true });
  await installShim("ssh", `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(process.env.PROOF_SSH_LOG, JSON.stringify(args) + "\\n");
if (process.env.PROOF_SSH_FAIL) { process.stderr.write("ssh: connect to host: Connection refused\\n"); process.exit(255); }
let i = 0; while (args[i] === "-o") i += 2;
const command = args.slice(i + 1).join(" ");
const gate = process.env.PROOF_SSH_GATE;
if (gate) { writeFileSync(gate + ".waiting", String(process.pid)); while (!existsSync(gate)) await new Promise((r) => setTimeout(r, 20)); }
const child = spawn("sh", ["-c", command], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
`);
  await installShim("geode-wiki", `
import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(binary)}, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
`);
  // A brctl that only records. If the product ever tried to download an iCloud placeholder it would land here.
  await installShim("brctl", `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.PROOF_BRCTL_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(1);
`);
  await writeFile(sshLog, ""); await writeFile(brctlLog, "");

  const A = new Device("a"), B = new Device("b");
  await mkdir(A.root); await mkdir(B.root);
  const store = ["--ssh", "proof-hub.invalid", "--store", hub];

  /* ------------------------------------------------------------ help / usage */

  const help = await exec(["--help"]).done;
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes("sync init | preview | run | status | conflicts | resolve | serve | gc"), "top-level --help must list sync");
  const syncHelp = await exec(["sync", "--help"]).done;
  for (const word of ["Safety rails", "--override-delete-limit", "--override-shrunk-scan", "--hydrate-icloud", "4  conflicts", "5  locked"]) {
    assert.ok(syncHelp.stdout.includes(word), `sync --help must document ${word}`);
  }
  const usage = {
    noSub: (await exec(["sync"]).done).code,
    unknownSub: (await exec(["sync", "frobnicate"]).done).code,
    noRoot: (await exec(["sync", "run"]).done).code,
    badFlag: (await A.j("run", "--colour")).code,
    badInteger: (await A.j("run", "--override-delete-limit", "lots")).code,
    resolveNoChoice: (await A.j("resolve", "x.md")).code,
    serveNoStore: (await exec(["sync", "serve"]).done).code,
  };
  assert.deepEqual(Object.values(usage), Array(7).fill(2), `usage errors must exit 2: ${JSON.stringify(usage)}`);
  assert.equal((await A.j("status")).payload.status, "not-initialised", "an unbound vault is refused by name");

  /* --------------------------------------------------- init over the ssh stand-in */

  await A.write("base.md", "base\n");
  await A.write("Notes/Plan.md", "plan\n");
  for (let i = 0; i < 60; i++) await A.write(`bulk/n${String(i).padStart(3, "0")}.md`, `note ${i}\n`);
  const aInit = await A.j("init", ...store, "--create");
  assert.equal(aInit.code, 0, aInit.stdout + aInit.stderr);
  assert.equal(aInit.result.created, true);
  const sshCalls = (await readFile(sshLog, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(sshCalls.length >= 1, "init must have gone through the ssh stand-in");
  const last = sshCalls.at(-1);
  assert.deepEqual(last.slice(0, 4), ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=15"], "ssh must be invoked non-interactively");
  assert.ok(last.includes("proof-hub.invalid"), "the host argument must reach ssh");
  assert.equal(last.at(-1), `geode-wiki sync serve --store '${hub}'`, "the remote command is exactly `geode-wiki sync serve --store <path>`");
  assert.equal((await A.j("init", ...store, "--create")).payload.status, "already-initialised");
  const b1 = new Device("b-empty");
  await mkdir(b1.root);
  assert.equal((await b1.j("init", "--store", join(directory, "empty-hub"))).payload.status, "store-empty", "an empty store needs --create");

  /* ------------------------------------------- rail (a): approval before the first run */

  const bare = await A.j("run");
  assert.deepEqual([bare.payload.status, bare.code], ["approval-required", 1]);
  assert.deepEqual(await readdir(join(hub, "records")), [], "a refused run must have published nothing");
  const peek = await A.j("preview");
  assert.equal(peek.code, 0);
  const planned = peek.result.preview.uploads; // 62 notes + the 2 folders holding them
  assert.equal(planned, 64);
  assert.equal(peek.result.preview.requiresApproval, true);
  assert.equal((await A.j("run")).payload.status, "approval-required", "looking at a preview is not approving it");
  assert.equal((await A.j("preview", "--approve")).result.approvalRecorded, true);
  await A.write("extra.md", "added after the human looked\n");
  const stale = await A.j("run");
  assert.deepEqual([stale.payload.status, stale.code], ["approval-stale", 1]);
  assert.equal(stale.result.now.uploads, planned + 1);
  assert.equal(stale.result.approved.uploads, planned);
  await A.j("preview", "--approve");
  const firstRun = await A.j("run");
  assert.equal(firstRun.code, 0, firstRun.stdout + firstRun.stderr);
  assert.equal(firstRun.result.planned.uploads, planned + 1);
  assert.equal(firstRun.result.after.upToDate, true);
  await A.write("later.md", "needs no approval\n");
  assert.equal((await A.j("run")).code, 0, "only the first run needs an approved preview");

  /* ------------------------------------------------ the second device converges */

  assert.equal((await B.j("init", ...store)).result.created, false, "the second device joins, it does not create");
  assert.equal((await B.j("run")).payload.status, "approval-required", "every device approves its own first run");
  await B.bootstrap();
  assert.deepEqual(await B.notes(), await A.notes(), "B must hold exactly A's notes");
  for (const rel of await A.notes()) assert.equal(await B.read(rel), await A.read(rel), `${rel} must be byte-identical`);

  /* ----------------------------------------------- conflicts (exit 4) and resolve */

  await A.write("base.md", "edited on A\n");
  assert.equal((await A.j("run")).code, 0);
  await B.write("base.md", "edited on B\n");
  const clash = await B.j("run");
  assert.deepEqual([clash.payload.status, clash.code], ["conflicts", 4]);
  assert.deepEqual(clash.result.after.conflicts.map((c) => c.path), ["base.md"]);
  assert.equal(await B.read("base.md"), "edited on B\n", "a conflict must never overwrite either side");
  const listed = await B.j("conflicts");
  assert.deepEqual([listed.payload.status, listed.code, listed.result.count], ["conflicts", 4, 1]);
  assert.deepEqual(listed.result.conflicts[0].heads.map((h) => h.device).sort(), ["other", "this"]);
  assert.equal((await B.j("status")).code, 4);
  assert.equal((await B.j("preview")).code, 4);
  assert.equal((await A.j("conflicts")).code, 0, "A has no conflict");
  const resolved = await B.j("resolve", "base.md", "--keep", "remote");
  assert.equal(resolved.code, 0, resolved.stdout + resolved.stderr);
  assert.equal(await B.read("base.md"), "edited on A\n");
  assert.equal((await B.j("conflicts")).code, 0);
  assert.equal((await B.j("resolve", "base.md", "--keep", "remote")).payload.status, "no-such-conflict");

  /* ------------------------------------------------------------------ deletes */

  await unlink(join(A.root, "extra.md"));
  const small = await A.j("run");
  assert.equal(small.result.planned.deletions, 1);
  assert.equal((await B.j("run")).code, 0);
  assert.equal(B.has("extra.md"), false, "an ordinary deletion propagates");
  const trash = await readdir(join(B.home, (await readdir(B.home))[0], "trash"));
  assert.ok(trash.length >= 1, "a deleted file is moved to the device trash, not unlinked");

  /* ------------------------------------------ rail (b): the deletion limit */

  for (let i = 0; i < 25; i++) await unlink(join(A.root, `bulk/n${String(i).padStart(3, "0")}.md`));
  const tooMany = await A.j("run");
  assert.deepEqual([tooMany.payload.status, tooMany.code], ["delete-limit-exceeded", 1]);
  assert.equal(tooMany.result.deletions, 25);
  assert.equal(tooMany.result.limit, 20);
  const untouched = await B.j("preview");
  assert.equal(untouched.result.preview.deletions, 0, "the refused run must not have published its deletions");
  const short = await A.j("run", "--override-delete-limit", "24");
  assert.equal(short.payload.status, "delete-limit-exceeded", "the override is a number, not 'off'");
  assert.ok(short.stderr.includes("WARNING: --override-delete-limit 24 is active"), "overrides are loud on stderr");
  const forced = await A.j("run", "--override-delete-limit", "25");
  assert.equal(forced.code, 0, forced.stdout + forced.stderr);
  assert.ok(forced.stderr.includes("WARNING: --override-delete-limit 25 is active"));
  assert.deepEqual(forced.result.rails.overridesActive, ["--override-delete-limit 25"], "and listed in the payload");
  const recv = await B.j("run");
  assert.equal(recv.payload.status, "delete-limit-exceeded", "the receiving device is protected too");
  assert.equal(B.has("bulk/n000.md"), true);
  assert.equal((await B.j("run", "--override-delete-limit", "25")).code, 0);
  assert.equal(B.has("bulk/n000.md"), false);
  assert.deepEqual(await B.notes(), await A.notes());

  /* ------------------------------------ rail (c): a scan that finds almost nothing */

  // An unmounted volume leaves an empty mount point at the same path. Reproduce it exactly: the same
  // device state, pointed at an empty folder.
  const mountPoint = join(directory, "unmounted");
  await mkdir(mountPoint);
  const aState = join(A.home, (await readdir(A.home))[0]);
  const shrunk = await exec(["sync", "run", "--root", mountPoint, "--state-dir", aState, "--settle-ms", "0", "--json"], { devEnv: A.env }).done;
  const shrunkPayload = JSON.parse(shrunk.stdout);
  assert.deepEqual([shrunkPayload.status, shrunk.code], ["scan-shrunk", 1]);
  assert.equal(shrunkPayload.result.found, 0);
  assert.ok(shrunkPayload.result.known >= 30);
  assert.equal(shrunkPayload.result.override, "--override-shrunk-scan");
  // The rails are independent: lifting this one still meets the deletion limit.
  const stacked = await exec(["sync", "run", "--root", mountPoint, "--state-dir", aState, "--settle-ms", "0", "--override-shrunk-scan", "--json"], { devEnv: A.env }).done;
  assert.equal(JSON.parse(stacked.stdout).status, "delete-limit-exceeded");
  assert.ok(stacked.stderr.includes("WARNING: --override-shrunk-scan is active"));
  assert.equal((await B.j("preview")).result.preview.deletions, 0, "nothing was published as deleted by either refusal");
  assert.deepEqual(await B.notes(), await A.notes());

  /* ------------------------------------- the lock (exit 5), with two real processes */

  await A.write("locked-case.md", "written while another run holds the lock\n");
  const gate = join(directory, "gate");
  const holder = A.start("run", ["--json"], { PROOF_SSH_GATE: gate });
  for (let i = 0; i < 500 && !existsSync(`${gate}.waiting`); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(`${gate}.waiting`), "the first run must have reached the store (holding the lock)");
  const second = await A.j("run");
  assert.deepEqual([second.payload.status, second.code], ["locked", 5]);
  assert.equal((await A.j("preview")).code, 5);
  assert.equal((await A.j("gc")).code, 5);
  assert.equal((await A.j("resolve", "base.md", "--keep", "local")).code, 5);
  const during = await A.j("status");
  assert.equal(during.code, 0, "status never waits for the lock");
  assert.equal(during.result.running.pid, holder.child.pid, "status names the process that holds it");
  await writeFile(gate, "go");
  const finished = await holder.done;
  assert.equal(finished.code, 0, finished.stdout + finished.stderr);
  assert.equal((await B.j("run")).code, 0);
  assert.equal(await B.read("locked-case.md"), "written while another run holds the lock\n", "the held run completed its work");
  assert.equal((await A.j("status")).result.running, null, "the lock is released");

  /* ------------------------------------- rail (d): iCloud placeholders */

  await rm(join(B.root, "Notes/Plan.md"));
  await writeFile(join(B.root, "Notes/.Plan.md.icloud"), "stub");
  await unlink(join(A.root, "Notes/Plan.md"));
  assert.equal((await A.j("run")).code, 0);
  const placeholder = await B.j("run");
  assert.equal(placeholder.code, 0, placeholder.stdout + placeholder.stderr);
  assert.deepEqual(placeholder.result.after.blocked.map((b) => [b.path, b.reason]), [["Notes/Plan.md", "icloud-not-downloaded"]]);
  assert.equal(B.has("Notes/.Plan.md.icloud"), true, "a blocked placeholder is never deleted, even though the remote deleted its file");
  assert.equal((await readFile(brctlLog, "utf8")).trim(), "", "nothing is downloaded without --hydrate-icloud");
  const hydrate = await B.j("run", "--hydrate-icloud");
  assert.ok(hydrate.stderr.includes("WARNING: --hydrate-icloud is active"));
  const brctlCalls = (await readFile(brctlLog, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(brctlCalls.length >= 1 && brctlCalls.every((c) => c[0] === "download" && c[1].endsWith("Notes/.Plan.md.icloud")), `opt-in asks brctl for the placeholder only: ${JSON.stringify(brctlCalls)}`);
  assert.equal(B.has("Notes/.Plan.md.icloud"), true, "a failed download leaves the placeholder alone");

  /* ------------------------------------------------------- hub unreachable */

  const down = await A.j("run");
  assert.equal(down.code, 0, "sanity: the hub is reachable again");
  const unreachable = await exec(A.argv("run", ["--json"]), { devEnv: A.env, env: { PROOF_SSH_FAIL: "1" } }).done;
  const unreachablePayload = JSON.parse(unreachable.stdout);
  assert.deepEqual([unreachablePayload.status, unreachable.code], ["store-unavailable", 3]);

  /* ------------------------------------------------------------------- gc */

  const gc = await A.j("gc", "--trash-days", "0");
  assert.equal(gc.code, 0, gc.stdout + gc.stderr);

  /* ----------------------------------------------------------------- report */

  console.log(JSON.stringify({
    realSubprocesses: true,
    importAuditViolations: violations.length,
    sshCalls: (await readFile(sshLog, "utf8")).trim().split("\n").length,
    remoteCommand: last.at(-1),
    exitCodesObserved: {
      ok: forced.code, refused: bare.code, usage: usage.noSub, unavailable: unreachable.code,
      conflicts: clash.code, locked: second.code,
    },
    refusals: [bare, stale, tooMany, recv].map((r) => r.payload.status).concat(shrunkPayload.status, JSON.parse(stacked.stdout).status),
    lockHolderPid: during.result.running.pid,
    conflictResolvedTo: await B.read("base.md"),
    finalNotesEqual: JSON.stringify(await A.notes()) === JSON.stringify(await B.notes()),
    brctlCallsWithoutOptIn: 0,
    brctlCallsWithOptIn: brctlCalls.length,
  }));
} finally {
  for (const child of children) child.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true });
}
