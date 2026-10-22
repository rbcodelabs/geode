import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/geode-wiki";
import type { ScheduleRunner } from "../../src/cli/sync-schedule";
import { put, rmrf, tmp } from "../helpers/node-host-harness";

/**
 * `geode-wiki sync` under managed policy (docs/adr/0055-cli-policy.md), through the same `run()` the
 * binary calls. Every policy file is a temp file reached through GEODE_POLICY_PATH in the context env;
 * the real machine path is never read or written.
 */
vi.setConfig({ testTimeout: 90_000 });

const cleanups: string[] = [];
const dir = (prefix: string) => { const d = tmp(prefix); cleanups.push(d); return d; };
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); for (const d of cleanups.splice(0)) rmrf(d); });

interface Result { code: number; out: string; err: string; json: any }
interface Extra { scheduleRunner?: ScheduleRunner; stopSignal?: AbortSignal }
async function cli(args: string[], env: NodeJS.ProcessEnv, extra: Extra = {}): Promise<Result> {
  const out: string[] = [], err: string[] = [];
  const code = await run(args, { streams: { out: t => { out.push(t); }, err: t => { err.push(t); } }, env, stdin: Readable.from([]), ...extra });
  const text = out.join("");
  let json: any = null;
  if (args.includes("--json")) { json = JSON.parse(text.trim()); expect(json.exit.code, "envelope exit must equal the returned code").toBe(code); }
  return { code, out: text, err: err.join(""), json };
}

/** A device bound to a hub, with its own machine policy file. */
function setup() {
  const root = dir("vault"), home = dir("home"), hub = dir("hub"), policyDir = dir("policy"), targetDir = dir("units");
  const policyFile = join(policyDir, "managed-policy.json");
  // HOME is a temp dir so the schedule's log directory never lands in the real ~/Library/Logs.
  const userHome = dir("user-home");
  const env: NodeJS.ProcessEnv = { GEODE_SYNC_HOME: home, GEODE_POLICY_PATH: policyFile, HOME: userHome };
  const machine = (doc: unknown) => writeFileSync(policyFile, typeof doc === "string" ? doc : JSON.stringify({ policyVersion: 1, ...(doc as object) }));
  const vault = (doc: unknown) => { mkdirSync(join(root, ".geode"), { recursive: true }); writeFileSync(join(root, ".geode", "policy.json"), JSON.stringify({ policyVersion: 1, ...(doc as object) })); };
  const call = (sub: string, rest: string[] = [], over: NodeJS.ProcessEnv = {}, extra: Extra = {}) =>
    cli(["sync", sub, "--root", root, "--settle-ms", "0", "--json", ...rest], { ...env, ...over }, extra);
  const calls: string[][] = [];
  const scheduleRunner: ScheduleRunner = async (argv) => { calls.push([...argv]); return { code: 0, stdout: "", stderr: "" }; };
  const schedule = (action: string, rest: string[] = [], over: NodeJS.ProcessEnv = {}) =>
    cli(["sync", "schedule", action, "--root", root, "--platform", "launchd", "--target-dir", targetDir, "--node-path", "/usr/bin/node", "--cli-path", "/opt/geode-wiki.mjs", "--json", ...rest], { ...env, ...over }, { scheduleRunner });
  /** The documented first-run ritual, run before any policy exists. */
  const bootstrap = async () => {
    put(root, "a.md", "alpha");
    expect((await call("init", ["--store", hub, "--create"])).code).toBe(0);
    await call("preview");
    expect((await call("preview", ["--approve"])).code).toBe(0);
    expect((await call("run")).code).toBe(0);
  };
  return { root, home, hub, targetDir, policyFile, env, machine, vault, call, schedule, calls, bootstrap };
}

const BLOCKED = (r: Result, feature: "sync" | "daemons") => {
  expect(r.code, r.out + r.err).toBe(6);
  expect(r.json.status).toBe("blocked-by-policy");
  expect(r.json.exit).toEqual({ code: 6, name: "policy" });
  expect(r.json.result.policy).toBe(feature);
  expect(r.json.result.message).toContain(`blocked by administrator policy: ${feature}`);
};

describe("sync.enabled=false", () => {
  it("refuses every subcommand that touches a root with exit 6, in the usual JSON envelope, naming the policy", async () => {
    const d = setup();
    d.machine({ sync: { enabled: false } });
    for (const [sub, rest] of [["init", ["--store", d.hub]], ["preview", []], ["run", []], ["gc", []], ["resolve", ["a.md", "--keep", "local"]]] as const) {
      BLOCKED(await d.call(sub, [...rest]), "sync");
    }
    // Human output names the policy too, and the exit code is the same.
    const human = await cli(["sync", "run", "--root", d.root], d.env);
    expect(human.code).toBe(6);
    expect(human.out).toContain("blocked by administrator policy: sync");
  });

  it("is non-destructive: a bound vault keeps its history and content, and re-enabling resumes", async () => {
    const d = setup();
    await d.bootstrap();
    d.machine({ sync: { enabled: false } });
    put(d.root, "b.md", "beta");
    BLOCKED(await d.call("run"), "sync");
    expect(readFileSync(join(d.root, "a.md"), "utf8")).toBe("alpha");
    expect(readFileSync(join(d.root, "b.md"), "utf8")).toBe("beta");
    // Read-only inspection still works, and still sees the binding.
    const status = await d.call("status");
    expect(status.code).toBe(0);
    expect(status.json.result.approved).toBe(true);
    expect((await d.call("conflicts")).code).toBe(0);
    // Evaluated fresh on each invocation: remove the file and the very next call syncs.
    rmrf(d.policyFile);
    const resumed = await d.call("run");
    expect(resumed.code, resumed.out).toBe(0);
  });

  it("refuses `sync serve` (stdio and http) before reading or binding anything, without needing --root", async () => {
    const d = setup();
    d.machine({ sync: { enabled: false } });
    const store = dir("served");
    const stdio = await cli(["sync", "serve", "--store", store, "--json"], d.env);
    BLOCKED(stdio, "sync");
    const http = await cli(["sync", "serve", "--store", store, "--http", "--token-file", join(store, "no-such-token"), "--json"], d.env);
    BLOCKED(http, "sync");
  });

  it("refuses schedule install, but print, status and uninstall keep working so a job can be removed", async () => {
    const d = setup();
    await d.bootstrap();
    expect((await d.schedule("install")).code).toBe(0);
    const unit = d.calls.length;
    d.machine({ sync: { enabled: false } });
    BLOCKED(await d.schedule("install", ["--activate"]), "sync");
    expect(d.calls.length, "no launchctl call on a refused install").toBe(unit);
    expect((await d.schedule("print")).code).toBe(0);
    expect((await d.schedule("status")).code).toBe(0);
    const removed = await d.schedule("uninstall", ["--activate"]);
    expect(removed.code).toBe(0);
    expect(removed.json.result.removed.length).toBe(1);
  });
});

describe("layering with the vault file", () => {
  it("a vault policy can narrow: sync.enabled=false in <root>/.geode/policy.json refuses that root", async () => {
    const d = setup();
    d.vault({ sync: { enabled: false } });
    BLOCKED(await d.call("run"), "sync");
    expect(JSON.stringify((await d.call("run")).json.result.layers)).toBe('["vault"]');
  });

  it("a vault policy cannot widen what the machine file forbids", async () => {
    const d = setup();
    d.machine({ sync: { enabled: false } });
    d.vault({ sync: { enabled: true } });
    BLOCKED(await d.call("run"), "sync");
  });

  it("machine vaultPolicy:ignore makes the vault file inert", async () => {
    const d = setup();
    d.machine({ vaultPolicy: "ignore" });
    d.vault({ sync: { enabled: false } });
    const r = await d.call("init", ["--store", d.hub, "--create"]);
    expect(r.code, r.out).toBe(0);
  });

  it("the vault layer applies per root: another root is not affected", async () => {
    const d = setup();
    d.vault({ sync: { enabled: false } });
    const other = dir("other-vault");
    const r = await cli(["sync", "init", "--root", other, "--store", d.hub, "--create", "--json"], d.env);
    expect(r.code, r.out).toBe(0);
  });
});

describe("fail open (ADR 0002)", () => {
  it("a missing, malformed or wrong-version policy imposes nothing", async () => {
    const d = setup();
    // no file at all
    expect((await d.call("init", ["--store", d.hub, "--create"])).code).toBe(0);
    d.machine("{ this is not json");
    expect((await d.call("preview")).code).toBe(0);
    d.machine(JSON.stringify({ policyVersion: 99, sync: { enabled: false } }));
    expect((await d.call("preview")).code).toBe(0);
    d.machine(JSON.stringify({ policyVersion: 1, sync: { enabled: "no" } }));
    expect((await d.call("preview")).code).toBe(0);
  });
});

describe("daemons.allowSchedule=false", () => {
  it("refuses schedule install and install --activate with exit 6, naming daemons, without touching the service manager", async () => {
    const d = setup();
    await d.bootstrap();
    d.machine({ daemons: { allowSchedule: false } });
    BLOCKED(await d.schedule("install"), "daemons");
    BLOCKED(await d.schedule("install", ["--activate"]), "daemons");
    expect(d.calls).toEqual([]);
    expect(existsSync(join(d.targetDir, "anything"))).toBe(false);
    // and the others stay available
    expect((await d.schedule("print")).code).toBe(0);
    expect((await d.schedule("status")).code).toBe(0);
    expect((await d.schedule("uninstall")).code).toBe(0);
  });

  it("an ALREADY-INSTALLED schedule stops syncing: the scheduled run exits 6 and changes nothing", async () => {
    const d = setup();
    await d.bootstrap();
    // Installed while policy allowed it (the unit files exist on disk).
    const installed = await d.schedule("install");
    expect(installed.code).toBe(0);
    const files = installed.json.result.files as string[];
    expect(files.every(f => existsSync(f))).toBe(true);
    const label = String(installed.json.result.label);

    d.machine({ daemons: { allowSchedule: false } });
    put(d.root, "new.md", "created after the policy");

    // The scheduled command line is exactly what ADR 0025 fixes: `sync run --root <root> --json`.
    const scheduled = await cli(["sync", "run", "--root", d.root, "--json"], { ...d.env, XPC_SERVICE_NAME: label });
    BLOCKED(scheduled, "daemons");
    const systemd = await cli(["sync", "run", "--root", d.root, "--json"], { ...d.env, INVOCATION_ID: "0123456789abcdef" });
    BLOCKED(systemd, "daemons");

    // Nothing was synced: a second device pulling from the hub sees the first run's note but not the new one.
    const peer = dir("peer"), peerHome = dir("peer-home");
    const peerEnv = { GEODE_SYNC_HOME: peerHome };
    const pj = (sub: string, rest: string[] = []) => cli(["sync", sub, "--root", peer, "--settle-ms", "0", "--json", ...rest], peerEnv);
    expect((await pj("init", ["--store", d.hub])).code).toBe(0);
    await pj("preview"); await pj("preview", ["--approve"]);
    expect((await pj("run")).code).toBe(0);
    expect(existsSync(join(peer, "a.md"))).toBe(true);
    expect(existsSync(join(peer, "new.md"))).toBe(false);

    // Non-destructive: unit files untouched, local file untouched, and a hand-run is still allowed.
    expect(files.every(f => existsSync(f))).toBe(true);
    expect(readFileSync(join(d.root, "new.md"), "utf8")).toBe("created after the policy");
    expect((await d.call("run")).code).toBe(0);
  });

  it("the unit's recorded last-run status treats exit 6 as a normal outcome", async () => {
    const d = setup();
    await d.bootstrap();
    const installed = await d.schedule("install");
    const outLog = (installed.json.result.logs as { out: string }).out;
    mkdirSync(join(outLog, ".."), { recursive: true });
    writeFileSync(outLog, JSON.stringify({ tool: "geode-wiki", schemaVersion: 1, command: "sync run", status: "blocked-by-policy", exit: { code: 6, name: "policy" }, result: {} }) + "\n");
    const status = await d.schedule("status");
    expect(status.json.result.lastRun).toMatchObject({ status: "blocked-by-policy", exitCode: 6, exitName: "policy", normal: true });
  });

  it("the schedule unit still carries the fixed command line and now lists 6 as a success status", async () => {
    const d = setup();
    await d.bootstrap();
    const r = await d.schedule("install", [], {});
    expect(r.json.result.command.slice(-5)).toEqual(["sync", "run", "--root", d.root, "--json"]);
    const sysd = await cli(["sync", "schedule", "print", "--root", d.root, "--platform", "systemd", "--target-dir", d.targetDir, "--node-path", "/usr/bin/node", "--cli-path", "/opt/geode-wiki.mjs"], d.env);
    expect(sysd.out).toContain("SuccessExitStatus=4 5 6");
  });
});

describe("daemons.allowServe and allowedListenAddresses", () => {
  const token = "x".repeat(40);
  const tokenFile = () => { const f = join(dir("tok"), "token"); writeFileSync(f, token, { mode: 0o600 }); return f; };

  it("allowServe=false refuses sync serve before binding", async () => {
    const d = setup();
    d.machine({ daemons: { allowServe: false } });
    const store = dir("served");
    BLOCKED(await cli(["sync", "serve", "--store", store, "--http", "--token-file", tokenFile(), "--listen", "127.0.0.1:0", "--json"], d.env), "daemons");
    BLOCKED(await cli(["sync", "serve", "--store", store, "--json"], d.env), "daemons");
  });

  it("allowedListenAddresses refuses a wildcard or unlisted bind, and admits a listed loopback bind", async () => {
    const d = setup();
    d.machine({ daemons: { allowedListenAddresses: ["127.0.0.1"] } });
    const store = dir("served");
    const serve = (listen: string, extra: Extra = {}) =>
      cli(["sync", "serve", "--store", store, "--http", "--token-file", tokenFile(), "--listen", listen, "--json"], d.env, extra);
    for (const listen of ["0.0.0.0:0", "[::]:0", "10.1.2.3:0", "corp.example:0"]) BLOCKED(await serve(listen), "daemons");
    // Allowed: bind and stop at once through the test seam (an already-aborted signal).
    const stop = new AbortController(); stop.abort();
    const ok = await serve("localhost:0", { stopSignal: stop.signal });
    expect(ok.code, ok.out + ok.err).toBe(0);
  });

  it("a vault policy cannot supply serve settings for serve (no root), and the machine layer alone applies", async () => {
    const d = setup();
    d.vault({ daemons: { allowServe: false } });
    const store = dir("served");
    const stop = new AbortController(); stop.abort();
    const r = await cli(["sync", "serve", "--store", store, "--http", "--token-file", tokenFile(), "--listen", "127.0.0.1:0", "--json"], d.env, { stopSignal: stop.signal });
    expect(r.code, r.out + r.err).toBe(0);
  });
});
