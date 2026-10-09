/**
 * `geode-wiki sync schedule ...` — unit files and (optional) activation for an unattended `sync run`.
 *
 * Like the rest of `src/cli/`, this decides nothing about syncing. It renders a launchd plist or a
 * systemd user service+timer around ONE fixed command line, `<node> <cli> sync run --root <root> --json`,
 * and writes, removes and inspects those files. It imports nothing from `src/` (so the import audit
 * needs no new exception): the one engine fact it needs, "has this root got an approved first run",
 * is handed in by `sync.ts` as `SchedulePreflight`.
 *
 * Invariants (ADR 0025, "Scheduling"):
 *  - The scheduled command line is built here and nowhere else. It never contains `--override-*`
 *    or `--hydrate-icloud`: a schedule cannot lift a safety rail, only a person at a terminal can.
 *  - `install` refuses a root whose first run has not been approved, so a schedule cannot bypass the
 *    first-run rail.
 *  - Nothing is activated without `--activate`. `status` only ever reads.
 *  - Exit 4 (conflicts) and 5 (locked) are normal outcomes of a scheduled run. systemd is told so with
 *    `SuccessExitStatus=4 5`; launchd has no such notion (it just records the last exit status and
 *    never restarts an interval job), so `status` reads the run's own JSON envelope from the log and
 *    classifies it.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type SchedulePlatform = "launchd" | "systemd";

export const MIN_INTERVAL_SECONDS = 60;
export const DEFAULT_INTERVAL_SECONDS = 300;
/** Exit statuses of `sync run` that are outcomes, not failures. */
export const NORMAL_EXIT_CODES: readonly number[] = [0, 4, 5];

export interface ScheduleSpec {
  readonly platform: SchedulePlatform;
  /** Absolute vault root. */
  readonly root: string;
  readonly intervalSeconds: number;
  /** Absolute path of the node binary and of the built `geode-wiki.mjs`. */
  readonly nodePath: string;
  readonly cliPath: string;
  readonly home: string;
  readonly uid: number;
  /** Passed to `sync run` as `--state-dir` when set. */
  readonly stateDir?: string;
  readonly targetDir?: string;
  /** `$XDG_STATE_HOME` / `$XDG_CONFIG_HOME` for systemd; ignored on launchd. */
  readonly xdgStateHome?: string;
  readonly xdgConfigHome?: string;
}

export interface ScheduleFile { readonly path: string; readonly content: string }

export interface ScheduleUnits {
  readonly platform: SchedulePlatform;
  readonly label: string;
  readonly intervalSeconds: number;
  readonly files: readonly ScheduleFile[];
  readonly targetDir: string;
  readonly logDir: string;
  readonly logs: { readonly out: string; readonly err: string };
  /** The command the unit runs. */
  readonly command: readonly string[];
  /** Argv arrays, in order. */
  readonly activate: readonly (readonly string[])[];
  readonly deactivate: readonly (readonly string[])[];
  /** The read-only probe that says whether the job is loaded/enabled. */
  readonly probe: readonly string[];
}

/* ------------------------------------------------------------------ pure */

export function scheduleHash(root: string): string {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 8);
}

/** The whole scheduled command line. Fixed shape on purpose; see the module comment. */
export function scheduledCommand(spec: Pick<ScheduleSpec, "nodePath" | "cliPath" | "root" | "stateDir">): string[] {
  return [
    spec.nodePath, spec.cliPath, "sync", "run", "--root", path.resolve(spec.root),
    ...(spec.stateDir ? ["--state-dir", path.resolve(spec.stateDir)] : []),
    "--json",
  ];
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The PATH a unit runs with: node's directory first, then the places `ssh` and a remote shim usually live. */
export function unitPath(nodePath: string): string {
  return [...new Set([path.dirname(nodePath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])].join(":");
}

/** systemd ExecStart word quoting: `%` and `$` are specifiers/expansions even inside quotes. */
function systemdWord(word: string): string {
  const escaped = word.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_@%:,./=+-]+$/.test(word) ? escaped : `"${escaped}"`;
}

function renderLaunchd(spec: ScheduleSpec): ScheduleUnits {
  const hash = scheduleHash(spec.root);
  const label = `com.geode.wiki-sync.${hash}`;
  const targetDir = spec.targetDir ? path.resolve(spec.targetDir) : path.join(spec.home, "Library", "LaunchAgents");
  const logDir = path.join(spec.home, "Library", "Logs", "geode-wiki-sync");
  const logs = { out: path.join(logDir, `${label}.out.log`), err: path.join(logDir, `${label}.err.log`) };
  const command = scheduledCommand(spec);
  const plistPath = path.join(targetDir, `${label}.plist`);
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!--
  geode-wiki sync, unattended, for ${xmlEscape(path.resolve(spec.root))}
  Generated by \`geode-wiki sync schedule\`. Regenerate rather than hand-edit.

  Exit status 4 (unresolved conflicts) and 5 (another run holds the lock) are NORMAL outcomes of a
  scheduled run, not failures: launchd records them as "last exit code" and does nothing else (this is
  an interval job, there is no KeepAlive). Each run's one-line JSON result, with its status and exit
  name, is appended to the stdout log below. \`geode-wiki sync schedule status\` reads it back.

  This job never passes an override flag. Lifting a safety rail needs a person at a terminal.
-->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((word) => `    <string>${xmlEscape(word)}</string>`).join("\n")}
  </array>
  <key>StartInterval</key>
  <integer>${spec.intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>ThrottleInterval</key>
  <integer>${MIN_INTERVAL_SECONDS}</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(spec.home)}</string>
    <key>PATH</key>
    <string>${xmlEscape(unitPath(spec.nodePath))}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logs.out)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logs.err)}</string>
</dict>
</plist>
`;
  const domain = `gui/${spec.uid}`;
  return {
    platform: "launchd", label, intervalSeconds: spec.intervalSeconds, files: [{ path: plistPath, content }], targetDir, logDir, logs, command,
    activate: [["launchctl", "bootstrap", domain, plistPath]],
    deactivate: [["launchctl", "bootout", `${domain}/${label}`]],
    probe: ["launchctl", "print", `${domain}/${label}`],
  };
}

function renderSystemd(spec: ScheduleSpec): ScheduleUnits {
  const hash = scheduleHash(spec.root);
  const label = `geode-wiki-sync-${hash}`;
  const config = spec.xdgConfigHome ?? path.join(spec.home, ".config");
  const targetDir = spec.targetDir ? path.resolve(spec.targetDir) : path.join(config, "systemd", "user");
  const logDir = path.join(spec.xdgStateHome ?? path.join(spec.home, ".local", "state"), "geode-wiki-sync");
  const logs = { out: path.join(logDir, `${label}.out.log`), err: path.join(logDir, `${label}.err.log`) };
  const command = scheduledCommand(spec);
  const servicePath = path.join(targetDir, `${label}.service`);
  const timerPath = path.join(targetDir, `${label}.timer`);
  const service = `# geode-wiki sync, unattended, for ${path.resolve(spec.root).replace(/\n/g, " ")}
# Generated by \`geode-wiki sync schedule\`. Regenerate rather than hand-edit.
#
# Exit status 4 (unresolved conflicts) and 5 (another run holds the lock) are NORMAL outcomes of a
# scheduled run, so they are listed in SuccessExitStatus and do not mark the unit failed. Each run's
# one-line JSON result is appended to the stdout log; \`geode-wiki sync schedule status\` reads it.
# This unit never passes an override flag.
[Unit]
Description=geode-wiki sync run (${hash})

[Service]
Type=oneshot
ExecStart=${command.map(systemdWord).join(" ")}
SuccessExitStatus=4 5
Environment="HOME=${spec.home.replace(/"/g, '\\"').replace(/%/g, "%%")}"
Environment="PATH=${unitPath(spec.nodePath)}"
StandardOutput=append:${logs.out}
StandardError=append:${logs.err}
Nice=10
`;
  const timer = `# Generated by \`geode-wiki sync schedule\`. Runs ${label}.service every ${spec.intervalSeconds}s.
[Unit]
Description=geode-wiki sync timer (${hash})

[Timer]
OnBootSec=${spec.intervalSeconds}
OnUnitInactiveSec=${spec.intervalSeconds}
AccuracySec=15s

[Install]
WantedBy=timers.target
`;
  return {
    platform: "systemd", label, intervalSeconds: spec.intervalSeconds,
    files: [{ path: servicePath, content: service }, { path: timerPath, content: timer }], targetDir, logDir, logs, command,
    activate: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", `${label}.timer`]],
    deactivate: [["systemctl", "--user", "disable", "--now", `${label}.timer`]],
    probe: ["systemctl", "--user", "is-enabled", `${label}.timer`],
  };
}

/** Pure and deterministic: the same spec always yields byte-identical files. */
export function renderSchedule(spec: ScheduleSpec): ScheduleUnits {
  return spec.platform === "launchd" ? renderLaunchd(spec) : renderSystemd(spec);
}

/** `launchd` on macOS, `systemd` elsewhere. */
export const defaultPlatform = (): SchedulePlatform => (process.platform === "darwin" ? "launchd" : "systemd");

export function parseInterval(raw: string | undefined): number | { error: string } {
  if (raw === undefined) return DEFAULT_INTERVAL_SECONDS;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) return { error: `--interval must be a whole number of seconds, got ${JSON.stringify(raw)}` };
  const n = Number(raw);
  if (n < MIN_INTERVAL_SECONDS) return { error: `--interval must be at least ${MIN_INTERVAL_SECONDS} seconds, got ${n}` };
  return n;
}

export const shellQuote = (word: string) => (/^[A-Za-z0-9_@%:,./=+-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);
export const shellLine = (argv: readonly string[]) => argv.map(shellQuote).join(" ");

/* ------------------------------------------------------------------ I/O */

export interface CommandResult { readonly code: number | null; readonly stdout: string; readonly stderr: string }
/** Runs `argv[0]` found on `env.PATH`. Never rejects: a missing binary is `code: null`. */
export type ScheduleRunner = (argv: readonly string[], env: NodeJS.ProcessEnv) => Promise<CommandResult>;

export const execScheduleRunner: ScheduleRunner = (argv, env) =>
  new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { env, encoding: "utf8", timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : null) : 0;
      resolve({ code, stdout, stderr: stderr || (error && code === null ? error.message : "") });
    });
  });

export interface LastRun {
  readonly status: string;
  readonly exitCode: number;
  readonly exitName: string;
  /** True for 0, 4 and 5: outcomes rather than failures. */
  readonly normal: boolean;
  readonly at: string;
}

/** The last JSON envelope in the stdout log, which is what `sync run --json` prints once per run. */
export async function readLastRun(outLog: string): Promise<LastRun | null> {
  let text: string; let mtime: Date;
  try { [text, mtime] = [await readFile(outLog, "utf8"), (await stat(outLog)).mtime]; } catch { return null; }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]) as { tool?: string; status?: string; exit?: { code?: number; name?: string } };
      if (e.tool !== "geode-wiki" || typeof e.exit?.code !== "number") continue;
      return { status: String(e.status), exitCode: e.exit.code, exitName: String(e.exit.name), normal: NORMAL_EXIT_CODES.includes(e.exit.code), at: mtime.toISOString() };
    } catch { /* not an envelope line */ }
  }
  return null;
}

const exists = (file: string) => stat(file).then(() => true, () => false);

export interface InstallResult {
  readonly platform: SchedulePlatform; readonly label: string; readonly files: readonly string[]; readonly logs: { out: string; err: string };
  readonly intervalSeconds: number; readonly activated: boolean; readonly activateCommands: readonly string[]; readonly command: readonly string[];
}

export async function installSchedule(units: ScheduleUnits, opts: { activate: boolean; env: NodeJS.ProcessEnv; run: ScheduleRunner }): Promise<InstallResult | { failed: string; command: string; stderr: string }> {
  await mkdir(units.targetDir, { recursive: true });
  await mkdir(units.logDir, { recursive: true });
  for (const file of units.files) await writeFile(file.path, file.content, { mode: 0o644 });
  const activateCommands = units.activate.map(shellLine);
  if (opts.activate) {
    for (const argv of units.activate) {
      const r = await opts.run(argv, opts.env);
      if (r.code !== 0) return { failed: `${shellLine(argv)} exited ${r.code ?? "without starting"}`, command: shellLine(argv), stderr: r.stderr.trim() };
    }
  }
  return {
    platform: units.platform, label: units.label, files: units.files.map((f) => f.path), logs: units.logs, intervalSeconds: units.intervalSeconds,
    activated: opts.activate, activateCommands, command: units.command,
  };
}

export async function uninstallSchedule(units: ScheduleUnits, opts: { activate: boolean; env: NodeJS.ProcessEnv; run: ScheduleRunner }) {
  const present = [];
  for (const file of units.files) if (await exists(file.path)) present.push(file.path);
  let deactivated = false; const failures: string[] = [];
  if (opts.activate) {
    for (const argv of units.deactivate) {
      const r = await opts.run(argv, opts.env);
      if (r.code === 0) deactivated = true; else failures.push(`${shellLine(argv)} exited ${r.code ?? "without starting"}${r.stderr.trim() ? `: ${r.stderr.trim()}` : ""}`);
    }
  }
  for (const file of units.files) await rm(file.path, { force: true });
  return { label: units.label, removed: present, deactivated, deactivateCommands: units.deactivate.map(shellLine), failures };
}

export async function scheduleStatus(units: ScheduleUnits, opts: { env: NodeJS.ProcessEnv; run: ScheduleRunner }) {
  const filesPresent = await Promise.all(units.files.map(async (f) => ({ path: f.path, present: await exists(f.path) })));
  const probe = await opts.run(units.probe, opts.env);
  const activated = probe.code === 0;
  const launchdExit = units.platform === "launchd" && activated ? /last exit code = (-?\d+)/.exec(probe.stdout)?.[1] : undefined;
  return {
    platform: units.platform, label: units.label, intervalSeconds: units.intervalSeconds, files: filesPresent,
    installed: filesPresent.every((f) => f.present), activated, probe: shellLine(units.probe),
    ...(launchdExit !== undefined ? { launchdLastExitCode: Number(launchdExit) } : {}),
    lastRun: await readLastRun(units.logs.out), logs: units.logs,
  };
}

export const defaultHome = (env: NodeJS.ProcessEnv) => env.HOME || homedir();
