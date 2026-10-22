/**
 * Proof for `geode-wiki` under managed policy (docs/adr/0055-cli-policy.md): the REAL built binary in real
 * subprocesses, with GEODE_POLICY_PATH pointing at a temp file. Nothing is called in-process; every claim
 * is an exit status or a one-line `--json` envelope, which is all a launchd/systemd job ever sees.
 *
 *   npm run proof:wiki-policy      (builds dist-less into a temp dir, audits the import graph, runs the scenarios)
 *
 * HONESTY: this proves the shipped binary refuses. It does not, and cannot, prove policy is a security
 * boundary: the CLI is a user-runnable build artifact.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain .mjs build/audit scripts shared with the other CLI proofs
import { buildCli } from "./build-cli.mjs";
// @ts-expect-error see above
import { auditCliImports } from "./cli-import-audit.mjs";

const directory = await mkdtemp(join(tmpdir(), "geode-wiki-policy-proof-"));
const binary = join(directory, "geode-wiki.mjs");
const policyFile = join(directory, "managed-policy.json");
const root = join(directory, "vault");
const hub = join(directory, "hub");
const home = join(directory, "home");
const userHome = join(directory, "user-home");
const units = join(directory, "units");

interface Run { code: number | null; stdout: string; stderr: string; json: any }

function exec(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GEODE_SYNC_HOME: home, GEODE_POLICY_PATH: policyFile, HOME: userHome, INVOCATION_ID: "", XPC_SERVICE_NAME: "", ...env },
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => {
      let json: any = null;
      if (args.includes("--json") && stdout.trim()) {
        const lines = stdout.trim().split("\n");
        assert.equal(lines.length, 1, `--json must print exactly one line, got: ${stdout}`);
        json = JSON.parse(lines[0]);
        assert.equal(json.exit.code, code, "envelope exit code must equal the process exit status");
      }
      resolve({ code, stdout, stderr, json });
    });
  });
}

const sync = (sub: string, extra: string[] = [], env: Record<string, string> = {}) =>
  exec(["sync", sub, "--root", root, "--settle-ms", "0", "--json", ...extra], env);
const schedule = (action: string, extra: string[] = []) =>
  exec(["sync", "schedule", action, "--root", root, "--platform", "launchd", "--target-dir", units, "--node-path", process.execPath, "--cli-path", binary, "--json", ...extra]);
const setMachine = (doc: object | null) => doc === null ? rm(policyFile, { force: true }) : writeFile(policyFile, JSON.stringify({ policyVersion: 1, ...doc }));
const setVault = async (doc: object) => { await mkdir(join(root, ".geode"), { recursive: true }); await writeFile(join(root, ".geode", "policy.json"), JSON.stringify({ policyVersion: 1, ...doc })); };
const assertPolicyRefusal = (r: Run, feature: "sync" | "daemons", what: string) => {
  assert.equal(r.code, 6, `${what}: expected exit 6, got ${r.code}\n${r.stdout}${r.stderr}`);
  assert.equal(r.json.status, "blocked-by-policy", what);
  assert.deepEqual(r.json.exit, { code: 6, name: "policy" }, what);
  assert.equal(r.json.result.policy, feature, what);
  assert.ok(String(r.json.result.message).includes(`blocked by administrator policy: ${feature}`), `${what}: ${r.json.result.message}`);
};
const step = (name: string) => console.log(`ok  ${name}`);

try {
  const built = await buildCli({ outfile: binary });
  const violations = auditCliImports(built.metafile.inputs);
  assert.deepEqual(violations, [], `import-rule violations:\n  ${violations.join("\n  ")}`);
  const sources = Object.keys(built.metafile.inputs).filter((p) => p.startsWith("src/"));
  for (const required of ["src/cli/policy.ts", "src/cli/policy-decisions.ts", "src/policy-node/policy-files.ts", "src/renderer/policy-layering.ts"]) assert.ok(sources.includes(required), `the bundle must contain ${required}`);
  step("built geode-wiki.mjs; import audit passes with the policy exception");

  await mkdir(root, { recursive: true }); await mkdir(userHome, { recursive: true });
  const old = (Date.now() - 120_000) / 1000;
  await writeFile(join(root, "a.md"), "alpha"); await utimes(join(root, "a.md"), old, old);

  // 1. No policy file: everything works (fail open).
  assert.equal((await sync("init", ["--store", hub, "--create"])).code, 0);
  assert.equal((await sync("preview")).code, 0);
  assert.equal((await sync("preview", ["--approve"])).code, 0);
  const first = await sync("run");
  assert.equal(first.code, 0, first.stdout + first.stderr);
  step("no policy file: init, approve, first run all exit 0 (fail open)");

  await writeFile(policyFile, "{ not json");
  assert.equal((await sync("run")).code, 0);
  await setMachine({ policyVersion: 7 as never, sync: { enabled: false } });
  assert.equal((await sync("run")).code, 0);
  step("malformed and wrong-version policy files are ignored (fail open)");

  // 2. sync.enabled=false
  await setMachine({ sync: { enabled: false } });
  await writeFile(join(root, "b.md"), "beta"); await utimes(join(root, "b.md"), old, old);
  assertPolicyRefusal(await sync("run"), "sync", "sync run");
  assertPolicyRefusal(await sync("preview"), "sync", "sync preview");
  assertPolicyRefusal(await exec(["sync", "serve", "--store", hub, "--json"]), "sync", "sync serve (stdio)");
  const human = await exec(["sync", "run", "--root", root]);
  assert.equal(human.code, 6); assert.ok(human.stdout.includes("blocked by administrator policy: sync"), human.stdout);
  assert.equal((await sync("status")).code, 0);
  assert.equal((await sync("conflicts")).code, 0);
  assert.equal(await readFile(join(root, "b.md"), "utf8"), "beta");
  step("sync.enabled=false: run/preview/serve exit 6 naming the policy; status/conflicts still exit 0; vault content untouched");

  await setMachine(null);
  assert.equal((await sync("run")).code, 0);
  step("removing the file re-enables sync on the very next invocation (no cache)");

  // 3. layering
  await setVault({ sync: { enabled: false } });
  assertPolicyRefusal(await sync("run"), "sync", "vault narrows");
  await setMachine({ sync: { enabled: false } }); await setVault({ sync: { enabled: true } });
  assertPolicyRefusal(await sync("run"), "sync", "vault cannot widen");
  await setMachine({ vaultPolicy: "ignore" }); await setVault({ sync: { enabled: false } });
  assert.equal((await sync("run")).code, 0);
  await rm(join(root, ".geode"), { recursive: true, force: true }); await setMachine(null);
  step("layering: vault file narrows, cannot widen, and is ignored under vaultPolicy:ignore");

  // 4. daemons.allowSchedule, including an ALREADY-INSTALLED unit
  const installed = await schedule("install");
  assert.equal(installed.code, 0, installed.stdout + installed.stderr);
  const unitFiles: string[] = installed.json.result.files;
  assert.ok(unitFiles.length > 0 && unitFiles.every((f) => existsSync(f)));
  const label: string = installed.json.result.label;
  await setMachine({ daemons: { allowSchedule: false } });
  assertPolicyRefusal(await schedule("install"), "daemons", "schedule install");
  assertPolicyRefusal(await schedule("install", ["--activate"]), "daemons", "schedule install --activate");
  // The command line the installed unit runs, verbatim: `<node> <cli> sync run --root <root> --json`.
  const unitCommand: string[] = installed.json.result.command;
  assert.deepEqual(unitCommand.slice(-5), ["sync", "run", "--root", root, "--json"], "the scheduled command line is unchanged (ADR 0025)");
  await writeFile(join(root, "c.md"), "gamma"); await utimes(join(root, "c.md"), old, old);
  assertPolicyRefusal(await exec(unitCommand.slice(2), { XPC_SERVICE_NAME: label }), "daemons", "installed launchd unit's run");
  assertPolicyRefusal(await exec(unitCommand.slice(2), { INVOCATION_ID: "0123456789abcdef" }), "daemons", "installed systemd unit's run");
  assert.ok(unitFiles.every((f) => existsSync(f)), "unit files must not be deleted by policy");
  assert.equal((await schedule("status")).code, 0);
  assert.equal((await schedule("print")).code, 0);
  assert.equal((await sync("run")).code, 0, "a hand-run is not a daemon and stays allowed");
  const removed = await schedule("uninstall");
  assert.equal(removed.code, 0);
  assert.ok(unitFiles.every((f) => !existsSync(f)));
  step("allowSchedule=false: install/--activate exit 6; an ALREADY-INSTALLED unit's run exits 6 without syncing; uninstall/status/print still work");

  // 5. daemons.allowServe / allowedListenAddresses
  const token = join(directory, "token"); await writeFile(token, "t".repeat(40), { mode: 0o600 });
  const serve = (listen: string) => exec(["sync", "serve", "--store", hub, "--http", "--token-file", token, "--listen", listen, "--json"]);
  await setMachine({ daemons: { allowServe: false } });
  assertPolicyRefusal(await serve("127.0.0.1:0"), "daemons", "allowServe=false");
  await setMachine({ daemons: { allowedListenAddresses: ["127.0.0.1"] } });
  for (const listen of ["0.0.0.0:0", "[::]:0", "10.1.2.3:0", "corp.example:0"]) assertPolicyRefusal(await serve(listen), "daemons", `listen ${listen}`);
  // An allowed loopback bind really serves; stop it with SIGTERM like a supervisor would.
  const child = spawn(process.execPath, [binary, "sync", "serve", "--store", hub, "--http", "--token-file", token, "--listen", "localhost:0"], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GEODE_POLICY_PATH: policyFile, GEODE_SYNC_HOME: home },
  });
  let logs = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", (c) => { logs += c; });
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  for (let i = 0; i < 100 && !/serving /.test(logs); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(logs, /serving /, `allowed loopback bind must serve: ${logs}`);
  child.kill("SIGTERM");
  assert.equal(await exited, 0, logs);
  step("allowServe=false and non-listed/wildcard binds exit 6 before binding; a listed loopback bind serves");

  console.log("\nPASS  geode-wiki policy proof");
} finally {
  await rm(directory, { recursive: true, force: true });
}
