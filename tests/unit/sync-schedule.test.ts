import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/geode-wiki";
import { renderSchedule, scheduleHash, scheduledCommand, parseInterval, type ScheduleRunner, type ScheduleSpec } from "../../src/cli/sync-schedule";
import { put, rmrf, tmp } from "../helpers/node-host-harness";

/**
 * `geode-wiki sync schedule`. Everything here writes to temp --target-dir directories and goes through a
 * recording stub in place of launchctl/systemctl; no real LaunchAgents directory or service manager is touched.
 */
vi.setConfig({ testTimeout: 90_000 });

const cleanups: string[] = [];
const dir = (prefix: string) => { const d = tmp(prefix); cleanups.push(d); return d; };
afterEach(() => { for (const d of cleanups.splice(0)) rmrf(d); });

const spec = (over: Partial<ScheduleSpec> = {}): ScheduleSpec => ({
  platform: "launchd", root: "/Users/me/Vault", intervalSeconds: 300, nodePath: "/opt/node/bin/node", cliPath: "/opt/geode/dist/cli/geode-wiki.mjs",
  home: "/Users/me", uid: 501, ...over,
});

describe("renderSchedule (pure)", () => {
  it("launchd: label from a short root hash, interval, absolute argv, log paths, RunAtLoad false, throttle", () => {
    const u = renderSchedule(spec());
    const hash = scheduleHash("/Users/me/Vault");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(u.label).toBe(`com.geode.wiki-sync.${hash}`);
    expect(u.files.map(f => f.path)).toEqual([`/Users/me/Library/LaunchAgents/com.geode.wiki-sync.${hash}.plist`]);
    const plist = u.files[0].content;
    expect(plist).toContain(`<string>com.geode.wiki-sync.${hash}</string>`);
    expect(plist).toMatch(/<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/);
    expect(plist).toContain("<string>/opt/node/bin/node</string>\n    <string>/opt/geode/dist/cli/geode-wiki.mjs</string>\n    <string>sync</string>\n    <string>run</string>\n    <string>--root</string>\n    <string>/Users/me/Vault</string>\n    <string>--json</string>");
    expect(u.logs.out).toBe(`/Users/me/Library/Logs/geode-wiki-sync/com.geode.wiki-sync.${hash}.out.log`);
    expect(plist).toContain(`<key>StandardOutPath</key>\n  <string>${u.logs.out}</string>`);
    expect(u.activate).toEqual([["launchctl", "bootstrap", "gui/501", u.files[0].path]]);
    expect(u.deactivate).toEqual([["launchctl", "bootout", `gui/501/${u.label}`]]);
  });

  it("systemd: service + timer, SuccessExitStatus 4 5, XDG log dir, enable --now", () => {
    const u = renderSchedule(spec({ platform: "systemd", intervalSeconds: 900, xdgStateHome: "/state", xdgConfigHome: "/cfg" }));
    const [service, timer] = u.files;
    expect(service.path).toBe(`/cfg/systemd/user/geode-wiki-sync-${scheduleHash("/Users/me/Vault")}.service`);
    expect(service.content).toContain("Type=oneshot");
    expect(service.content).toContain("ExecStart=/opt/node/bin/node /opt/geode/dist/cli/geode-wiki.mjs sync run --root /Users/me/Vault --json");
    expect(service.content).toContain("SuccessExitStatus=4 5");
    expect(service.content).toContain(`StandardOutput=append:/state/geode-wiki-sync/${u.label}.out.log`);
    expect(timer.content).toContain("OnUnitInactiveSec=900");
    expect(timer.content).toContain("WantedBy=timers.target");
    expect(u.activate).toEqual([["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", `${u.label}.timer`]]);
  });

  it("is deterministic and quotes awkward paths", () => {
    expect(renderSchedule(spec())).toEqual(renderSchedule(spec()));
    const odd = renderSchedule(spec({ root: "/Users/me/My <Vault> & \"Notes\"" }));
    expect(odd.files[0].content).toContain("My &lt;Vault&gt; &amp; &quot;Notes&quot;");
    const sd = renderSchedule(spec({ platform: "systemd", root: "/v/My Vault 100%$x" }));
    expect(sd.files[0].content).toContain('"/v/My Vault 100%%$$x"');
  });

  it("the scheduled command never carries an override or hydrate flag, whatever the spec", () => {
    for (const platform of ["launchd", "systemd"] as const) {
      const u = renderSchedule(spec({ platform, stateDir: "/s" }));
      for (const f of u.files) expect(f.content).not.toMatch(/--override-|--hydrate-icloud/);
      expect(u.command.filter(w => w.startsWith("--"))).toEqual(["--root", "--state-dir", "--json"]);
    }
    expect(scheduledCommand(spec()).slice(2, 4)).toEqual(["sync", "run"]);
  });

  it("interval: default 300, minimum 60", () => {
    expect(parseInterval(undefined)).toBe(300);
    expect(parseInterval("60")).toBe(60);
    expect(parseInterval("59")).toMatchObject({ error: expect.stringContaining("at least 60") });
    expect(parseInterval("soon")).toMatchObject({ error: expect.any(String) });
  });
});

interface Result { code: number; out: string; err: string; json: any }
function harness() {
  const calls: string[][] = [];
  const results = new Map<string, number>();
  const scheduleRunner: ScheduleRunner = async (argv) => { calls.push([...argv]); return { code: results.get(argv[1]) ?? results.get(argv[0]) ?? 0, stdout: "", stderr: "" }; };
  const cli = async (args: string[], env: NodeJS.ProcessEnv = {}): Promise<Result> => {
    const out: string[] = [], err: string[] = [];
    const code = await run(args, { streams: { out: t => { out.push(t); }, err: t => { err.push(t); } }, env, stdin: Readable.from([]), scheduleRunner });
    const text = out.join("");
    const json = args.includes("--json") ? JSON.parse(text.trim()) : null;
    if (json) expect(json.exit.code).toBe(code);
    return { code, out: text, err: err.join(""), json };
  };
  return { calls, results, cli };
}

describe("sync schedule via the CLI", () => {
  function vault() {
    const root = dir("sched-vault"), home = dir("sched-home"), hub = dir("sched-hub"), target = dir("sched-target"), userHome = dir("sched-user");
    const env = { GEODE_SYNC_HOME: home, HOME: userHome };
    const flags = ["--node-path", "/opt/node/bin/node", "--cli-path", "/opt/geode/geode-wiki.mjs"];
    return { root, home, hub, target, userHome, env, flags };
  }
  const sync = (v: ReturnType<typeof vault>, sub: string, ...rest: string[]) => ["sync", sub, "--root", v.root, "--settle-ms", "0", "--json", ...rest];
  const schedule = (v: ReturnType<typeof vault>, action: string, ...rest: string[]) =>
    ["sync", "schedule", action, "--root", v.root, "--target-dir", v.target, "--platform", "launchd", ...v.flags, "--json", ...rest];

  it("print writes nothing and emits the plist", async () => {
    const { cli, calls } = harness(); const v = vault();
    const r = await cli(schedule(v, "print"), v.env);
    expect(r.code).toBe(0);
    expect(r.json.result.files[0].content).toContain("<key>StartInterval</key>");
    expect(readdirSync(v.target)).toEqual([]);
    expect(calls).toEqual([]);
    const human = await cli(["sync", "schedule", "print", "--root", v.root, "--platform", "systemd", ...v.flags], v.env);
    expect(human.out).toContain("SuccessExitStatus=4 5");
  });

  it("usage errors exit 2: bad action, interval under 60, bad platform, relative paths, and override flags are not accepted", async () => {
    const { cli } = harness(); const v = vault();
    expect((await cli(["sync", "schedule", "--root", v.root], v.env)).code).toBe(2);
    expect((await cli(schedule(v, "frobnicate"), v.env)).code).toBe(2);
    expect((await cli(schedule(v, "print", "--interval", "59"), v.env)).code).toBe(2);
    expect((await cli(schedule(v, "print", "--interval", "x"), v.env)).code).toBe(2);
    expect((await cli(["sync", "schedule", "print", "--root", v.root, "--platform", "cron", "--json"], v.env)).code).toBe(2);
    expect((await cli(["sync", "schedule", "print", "--root", v.root, "--node-path", "node", "--json"], v.env)).code).toBe(2);
    for (const flag of [["--override-delete-limit", "99"], ["--override-shrunk-scan"], ["--hydrate-icloud"]]) {
      expect((await cli(schedule(v, "install", ...flag), v.env)).code, flag.join(" ")).toBe(2);
    }
  });

  it("install refuses an unbound vault and a vault whose first run is not approved, writing nothing", async () => {
    const { cli, calls } = harness(); const v = vault();
    put(v.root, "a.md", "a");
    const unbound = await cli(schedule(v, "install"), v.env);
    expect([unbound.json.status, unbound.code]).toEqual(["not-initialised", 1]);
    expect((await cli(sync(v, "init", "--store", v.hub, "--create"), v.env)).code).toBe(0);
    const unapproved = await cli(schedule(v, "install", "--activate"), v.env);
    expect([unapproved.json.status, unapproved.code]).toEqual(["schedule-not-approved", 1]);
    await cli(sync(v, "preview", "--approve"), v.env); // approved but never run: still not enough to be trusted unattended
    expect(readdirSync(v.target)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("install -> status -> uninstall on an approved vault; nothing activates without --activate", async () => {
    const { cli, calls, results } = harness(); const v = vault();
    put(v.root, "a.md", "a");
    await cli(sync(v, "init", "--store", v.hub, "--create"), v.env);
    await cli(sync(v, "preview", "--approve"), v.env);
    expect((await cli(sync(v, "run"), v.env)).code).toBe(0);

    const installed = await cli(schedule(v, "install", "--interval", "120"), v.env);
    expect([installed.json.status, installed.code]).toEqual(["ok", 0]);
    expect(installed.json.result.activated).toBe(false);
    const [plistPath] = installed.json.result.files as string[];
    expect(plistPath.startsWith(v.target)).toBe(true);
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toMatch(/<integer>120<\/integer>/);
    expect(plist).toContain(`<string>${v.root.replace(/\/$/, "")}</string>`);
    expect(plist).toContain("<string>--state-dir</string>");
    expect(plist).not.toMatch(/--override-|--hydrate-icloud/);
    expect(installed.json.result.activateCommands[0]).toMatch(/^launchctl bootstrap gui\/\d+ /);
    expect(existsSync(installed.json.result.logs.out.replace(/[^/]+$/, ""))).toBe(true);
    expect(calls).toEqual([]); // no launchctl at all

    // status: files present, probe says not loaded, no log yet
    results.set("print", 113);
    const s1 = await cli(schedule(v, "status"), v.env);
    expect(s1.json.result).toMatchObject({ installed: true, activated: false, lastRun: null });
    expect(calls.map(c => c.slice(0, 2))).toEqual([["launchctl", "print"]]); // read-only probe only

    // a lock-held run (exit 5) and a conflicts run (4) are normal; an unavailable run (3) is not
    const log = installed.json.result.logs.out as string;
    const envelope = (status: string, code: number, name: string) => JSON.stringify({ tool: "geode-wiki", schemaVersion: 1, command: "sync run", status, exit: { code, name }, result: {} }) + "\n";
    writeFileSync(log, envelope("ok", 0, "ok") + envelope("locked", 5, "locked"));
    results.set("print", 0);
    const s2 = await cli(schedule(v, "status"), v.env);
    expect(s2.json.result.activated).toBe(true);
    expect(s2.json.result.lastRun).toMatchObject({ status: "locked", exitCode: 5, normal: true });
    const human = await cli(["sync", "schedule", "status", "--root", v.root, "--target-dir", v.target, "--platform", "launchd", ...v.flags], v.env);
    expect(human.out).toContain("normal outcome, not a launchd failure");
    writeFileSync(log, envelope("conflicts", 4, "conflicts"));
    expect((await cli(schedule(v, "status"), v.env)).json.result.lastRun).toMatchObject({ exitCode: 4, normal: true });
    writeFileSync(log, envelope("store-unavailable", 3, "unavailable") + "garbage line\n");
    expect((await cli(schedule(v, "status"), v.env)).json.result.lastRun).toMatchObject({ exitCode: 3, normal: false });

    // uninstall without --activate removes files and prints, but does not run, the bootout
    calls.length = 0;
    const gone = await cli(schedule(v, "uninstall"), v.env);
    expect(gone.json.result.removed).toEqual([plistPath]);
    expect(existsSync(plistPath)).toBe(false);
    expect(calls).toEqual([]);
    expect(gone.json.result.deactivateCommands[0]).toMatch(/^launchctl bootout gui\/\d+\/com\.geode\.wiki-sync\./);
    expect((await cli(schedule(v, "uninstall"), v.env)).json.result.removed).toEqual([]); // idempotent
  });

  it("--activate runs launchctl bootstrap (stubbed); a failing activation is reported with the files kept; uninstall --activate boots out", async () => {
    const { cli, calls, results } = harness(); const v = vault();
    put(v.root, "a.md", "a");
    await cli(sync(v, "init", "--store", v.hub, "--create"), v.env);
    await cli(sync(v, "preview", "--approve"), v.env);
    await cli(sync(v, "run"), v.env);

    results.set("bootstrap", 5);
    const failed = await cli(schedule(v, "install", "--activate"), v.env);
    expect([failed.json.status, failed.code]).toEqual(["schedule-activation-failed", 1]);
    expect(readdirSync(v.target)).toHaveLength(1);

    results.set("bootstrap", 0); calls.length = 0;
    const ok = await cli(schedule(v, "install", "--activate"), v.env);
    expect([ok.json.status, ok.json.result.activated]).toEqual(["ok", true]);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(["launchctl", "bootstrap"]);
    expect(calls[0][2]).toMatch(/^gui\/\d+$/);
    expect(calls[0][3].startsWith(v.target)).toBe(true);

    calls.length = 0;
    const out = await cli(schedule(v, "uninstall", "--activate"), v.env);
    expect(out.json.result.deactivated).toBe(true);
    expect(calls[0].slice(0, 2)).toEqual(["launchctl", "bootout"]);
    expect(readdirSync(v.target)).toEqual([]);
  });

  it("systemd install writes service+timer and --activate runs daemon-reload then enable --now", async () => {
    const { cli, calls } = harness(); const v = vault();
    put(v.root, "a.md", "a");
    await cli(sync(v, "init", "--store", v.hub, "--create"), v.env);
    await cli(sync(v, "preview", "--approve"), v.env);
    await cli(sync(v, "run"), v.env);
    const r = await cli(["sync", "schedule", "install", "--root", v.root, "--target-dir", v.target, "--platform", "systemd", "--activate", ...v.flags, "--json"], { ...v.env, XDG_STATE_HOME: join(v.userHome, "state") });
    expect(r.code).toBe(0);
    expect(readdirSync(v.target).sort().map(f => f.replace(/[0-9a-f]{8}/, "H"))).toEqual(["geode-wiki-sync-H.service", "geode-wiki-sync-H.timer"]);
    expect(calls.map(c => c.slice(0, 4).join(" "))).toEqual(["systemctl --user daemon-reload", "systemctl --user enable --now"]);
  });
});
