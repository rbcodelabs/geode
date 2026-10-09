/**
 * `geode-wiki sync ...` — argument parsing and formatting for the headless sync workflow.
 *
 * Like the rest of `src/cli/`, this file decides nothing. The workflow, the safety rails and the
 * exit-status vocabulary come from `../sync-node/index` (`wiki-sync.ts`), which is the third and
 * last entry point the CLI is permitted to import (the audit in `scripts/run-wiki-cli-proof.mjs`
 * enforces that per edge). If a subcommand needs something that module does not export, the
 * module is missing it, not this file.
 *
 * Statuses and exits (see ADR 0025): `ok` 0; named refusals 1 (`approval-required`,
 * `approval-stale`, `delete-limit-exceeded`, `scan-shrunk`, `not-initialised`, ...); usage 2;
 * `store-unavailable` / `vault-unavailable` 3; `conflicts` 4; `locked` 5.
 */

import { parseArgs } from "node:util";
import {
  classifySyncError, describeTarget, serveStore, syncConflicts, syncGc, syncInit, syncPreview, syncResolve,
  syncRun, syncStatus,
  type PreviewSummary, type SyncOverrides, type SyncTarget, type WikiSyncContext,
} from "../sync-node/index";
import { emit, usageOutcome, type CliOutcome, type Streams } from "./output";

export interface SyncCliContext {
  readonly streams: Streams;
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: NodeJS.ReadableStream;
  /** The raw stdout stream. Only `sync serve` needs it: it speaks binary frames and must not go through text `out()`. */
  readonly rawOut?: NodeJS.WritableStream;
}

type Values = Record<string, string | boolean | string[] | undefined>;
type OptionSpec = Record<string, { type: "string" | "boolean"; multiple?: boolean }>;

const SHARED: OptionSpec = { json: { type: "boolean" }, help: { type: "boolean" } };
const VAULT: OptionSpec = { root: { type: "string" }, "state-dir": { type: "string" }, "settle-ms": { type: "string" } };
const OVERRIDES: OptionSpec = {
  "override-delete-limit": { type: "string" },
  "override-shrunk-scan": { type: "boolean" },
  "hydrate-icloud": { type: "boolean" },
};

const SUBCOMMANDS: Record<string, { positionals: readonly string[]; options: OptionSpec }> = {
  init: { positionals: [], options: { ...SHARED, ...VAULT, store: { type: "string" }, ssh: { type: "string" }, create: { type: "boolean" }, name: { type: "string" }, exclude: { type: "string", multiple: true } } },
  preview: { positionals: [], options: { ...SHARED, ...VAULT, ...OVERRIDES, approve: { type: "boolean" } } },
  run: { positionals: [], options: { ...SHARED, ...VAULT, ...OVERRIDES } },
  status: { positionals: [], options: { ...SHARED, ...VAULT } },
  conflicts: { positionals: [], options: { ...SHARED, ...VAULT } },
  resolve: { positionals: ["path"], options: { ...SHARED, ...VAULT, ...OVERRIDES, keep: { type: "string" }, version: { type: "string" } } },
  serve: { positionals: [], options: { ...SHARED, store: { type: "string" } } },
  gc: { positionals: [], options: { ...SHARED, ...VAULT, "trash-days": { type: "string" } } },
};

export const SYNC_USAGE = `geode-wiki sync — keep a folder in step with a hub store, headlessly

Usage:
  geode-wiki sync <command> --root <dir> [options]

Commands:
  init      bind this folder to a hub store         --store <path> [--ssh <host>] [--create] [--name <n>] [--exclude <folder>]...
  preview   show what a run would do                [--approve] [overrides]
  run       sync now (first run needs an approved preview) [overrides]
  status    state of the binding; never touches the store or waits for the lock
  conflicts list unresolved conflicts               (exit 4 when there are any)
  resolve   settle one conflict                     <path> (--keep local|remote | --version <recordId>)
  serve     serve a store over stdio (what ssh runs on the hub)   --store <path>   (no --root)
  gc        reclaim sync-private storage            [--trash-days <n>]

Options:
  --json                        structured output; named statuses preserved verbatim
  --state-dir <dir>             device state directory (default ~/.geode/sync/root-<hash>; must be outside the vault)
  --settle-ms <n>               defer files modified within n ms (default 5000)

Safety rails (all checked before anything is changed):
  first run                     needs 'sync preview --approve' on the exact plan; otherwise approval-required / approval-stale
  deletions                     refuses more than max(20, 1% of the vault); --override-delete-limit <n> allows up to n
  shrunk scan                   refuses a scan finding under 50% of previously known files; --override-shrunk-scan
  iCloud placeholders           never downloaded; --hydrate-icloud opts in. Blocked files are never deleted
  Every override prints a WARNING on stderr and is listed in the JSON result.

Exit codes (in addition to 0-3 documented at the top level):
  4  conflicts   unresolved conflicts remain
  5  locked      another sync run holds this vault's lock; nothing was done`;

/* ----------------------------------------------------------------- helpers */

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function nonNegative(raw: string | undefined, flag: string): number | { error: string } {
  if (raw === undefined) return { error: `${flag} is required` };
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) return { error: `${flag} must be a non-negative integer, got ${JSON.stringify(raw)}` };
  return Number(raw);
}
const isError = (value: unknown): value is { error: string } => typeof value === "object" && value !== null && "error" in value;

function overridesFrom(values: Values, name: string): SyncOverrides | CliOutcome {
  const overrides: SyncOverrides = {};
  if (values["override-delete-limit"] !== undefined) {
    const n = nonNegative(values["override-delete-limit"] as string, "--override-delete-limit");
    if (isError(n)) return usageOutcome(n.error, name);
    overrides.deleteLimit = n;
  }
  if (values["override-shrunk-scan"] === true) overrides.shrunkScan = true;
  if (values["hydrate-icloud"] === true) overrides.hydrateIcloud = true;
  return overrides;
}

/** Loud, always on stderr, even under --json. */
function overrideWarnings(overrides: SyncOverrides): string[] {
  const out: string[] = [];
  if (overrides.deleteLimit !== undefined) out.push(`WARNING: --override-delete-limit ${overrides.deleteLimit} is active: the default deletion limit is replaced by ${overrides.deleteLimit}`);
  if (overrides.shrunkScan) out.push("WARNING: --override-shrunk-scan is active: a scan that finds under half of the known files will NOT be refused. If a volume is unmounted this deletes the remote copy of everything missing");
  if (overrides.hydrateIcloud) out.push("WARNING: --hydrate-icloud is active: iCloud placeholder files will be downloaded (brctl download)");
  return out;
}

function failure(command: string, error: unknown, extraWarnings: readonly string[] = []): CliOutcome {
  const f = classifySyncError(error);
  const lines = [`${f.status}  ${f.message}`];
  if (f.override) lines.push(`  to override, pass: ${f.override}`);
  return {
    command, status: f.status, result: { message: f.message, ...f.detail, ...(f.override ? { override: f.override } : {}) },
    lines, warnings: [...extraWarnings],
  };
}

function previewLines(summary: PreviewSummary): string[] {
  const lines = [`upload ${summary.uploads}   download ${summary.downloads}   delete ${summary.deletions}   conflicts ${summary.conflicts.length}   blocked ${summary.blocked.length}   excluded ${summary.excluded}`];
  for (const c of summary.conflicts) lines.push(`  conflict  ${c.path}  (${c.reason})`);
  for (const b of summary.blocked) lines.push(`  blocked   ${b.path}  (${b.reason})`);
  return lines;
}

function contextFrom(values: Values, ctx: SyncCliContext): WikiSyncContext | CliOutcome {
  const settle = values["settle-ms"] === undefined ? undefined : nonNegative(values["settle-ms"] as string, "--settle-ms");
  if (isError(settle)) return usageOutcome(settle.error);
  return {
    root: values.root as string, env: ctx.env,
    ...(typeof values["state-dir"] === "string" ? { stateDir: values["state-dir"] } : {}),
    ...(settle !== undefined ? { settleMs: settle } : {}),
    onStderr: line => ctx.streams.err(line + "\n"),
  };
}

const isOutcome = (value: unknown): value is CliOutcome => typeof value === "object" && value !== null && "status" in value && "command" in value;

/* ------------------------------------------------------------------- entry */

export async function runSync(argv: readonly string[], ctx: SyncCliContext): Promise<number> {
  const { streams } = ctx;
  if (argv.length === 0) return emit(usageOutcome("sync needs a command: " + Object.keys(SUBCOMMANDS).join(", "), "sync"), false, streams);
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") { streams.out(SYNC_USAGE + "\n"); return 0; }
  const sub = argv[0];
  const spec = SUBCOMMANDS[sub];
  const name = `sync ${sub}`;
  if (!spec) return emit(usageOutcome(`unknown sync command ${JSON.stringify(sub)}; known commands are ${Object.keys(SUBCOMMANDS).join(", ")}`, "sync"), false, streams);

  let values: Values; let positionals: string[];
  try {
    const parsed = parseArgs({ args: [...argv.slice(1)], options: spec.options, allowPositionals: true, strict: true });
    values = parsed.values as Values; positionals = parsed.positionals;
  } catch (error) { return emit(usageOutcome(error instanceof Error ? error.message : String(error), name), argv.includes("--json"), streams); }

  const json = values.json === true;
  if (values.help === true) { streams.out(SYNC_USAGE + "\n"); return 0; }
  if (positionals.length !== spec.positionals.length) {
    return emit(usageOutcome(`${name} takes ${spec.positionals.length} positional argument(s) (${spec.positionals.map(p => `<${p}>`).join(" ") || "none"}), got ${positionals.length}`, name), json, streams);
  }

  if (sub === "serve") return serve(values, ctx, json);
  if (typeof values.root !== "string" || values.root === "") return emit(usageOutcome("--root <dir> is required", name), json, streams);
  const context = contextFrom(values, ctx);
  if (isOutcome(context)) return emit({ ...context, command: name }, json, streams);

  // Everything decidable from argv alone is decided before the vault or the store is touched.
  let outcome: CliOutcome;
  switch (sub) {
    case "init": outcome = await init(values, context); break;
    case "preview": outcome = await preview(values, context); break;
    case "run": outcome = await runCommand(values, context); break;
    case "status": outcome = await status(context); break;
    case "conflicts": outcome = await conflicts(context); break;
    case "resolve": outcome = await resolve(values, positionals[0], context); break;
    case "gc": outcome = await gc(values, context); break;
    default: outcome = usageOutcome(`unhandled sync command ${sub}`, name);
  }
  return emit(outcome, json, streams);
}

/* ---------------------------------------------------------------- commands */

async function serve(values: Values, ctx: SyncCliContext, json: boolean): Promise<number> {
  if (typeof values.store !== "string" || values.store === "") return emit(usageOutcome("--store <path> is required", "sync serve"), json, ctx.streams);
  if (!ctx.rawOut) return emit(usageOutcome("sync serve needs a raw stdout stream and is only available from the binary", "sync serve"), json, ctx.streams);
  // stdout carries protocol frames only. Everything diagnostic goes to stderr.
  await serveStore({
    store: values.store, input: ctx.stdin as unknown as AsyncIterable<Uint8Array>,
    output: ctx.rawOut as unknown as Parameters<typeof serveStore>[0]["output"],
    log: message => ctx.streams.err(`geode-wiki sync serve: ${message}\n`),
  });
  return 0;
}

async function init(values: Values, context: WikiSyncContext): Promise<CliOutcome> {
  const name = "sync init";
  if (typeof values.store !== "string" || values.store === "") return usageOutcome("--store <path> is required", name);
  const target: SyncTarget = typeof values.ssh === "string" ? { kind: "ssh", host: values.ssh, path: values.store } : { kind: "fs", path: values.store };
  try {
    const result = await syncInit(context, { target, create: values.create === true, ...(typeof values.name === "string" ? { name: values.name } : {}), exclude: (values.exclude as string[] | undefined) ?? [] });
    return {
      command: name, status: "ok", result,
      lines: [`ok  vault=${result.vaultId} store=${describeTarget(result.target)}${result.created ? " (created)" : ""}`, `state=${result.stateDir}`, "next: geode-wiki sync preview, then sync preview --approve, then sync run"],
    };
  } catch (error) { return failure(name, error); }
}

async function preview(values: Values, context: WikiSyncContext): Promise<CliOutcome> {
  const name = "sync preview";
  const overrides = overridesFrom(values, name);
  if (isOutcome(overrides)) return overrides;
  const warnings = overrideWarnings(overrides);
  try {
    const result = await syncPreview(context, { approve: values.approve === true, overrides });
    const lines = previewLines(result.preview);
    if (result.approvalRecorded) lines.push(`approved  signature=${result.preview.signature.slice(0, 12)}  (a first \`sync run\` now matches this exact plan)`);
    else if (result.firstRun) lines.push("first run: review the above, then re-run with --approve to record approval");
    return { command: name, status: result.preview.conflicts.length ? "conflicts" : "ok", result, warnings, lines };
  } catch (error) { return failure(name, error, warnings); }
}

async function runCommand(values: Values, context: WikiSyncContext): Promise<CliOutcome> {
  const name = "sync run";
  const overrides = overridesFrom(values, name);
  if (isOutcome(overrides)) return overrides;
  const warnings = overrideWarnings(overrides);
  try {
    const result = await syncRun(context, { overrides });
    const p = result.planned;
    const lines = [
      p ? `ran  upload ${p.uploads}   download ${p.downloads}   delete ${p.deletions}` : "ran  resumed an interrupted batch",
      ...previewLines(result.after).slice(1),
      result.after.upToDate ? "up to date" : `not yet up to date: ${count(result.after.conflicts.length, "conflict")}, ${count(result.after.blocked.length, "blocked path")}`,
    ];
    return { command: name, status: result.after.conflicts.length ? "conflicts" : "ok", result, warnings, lines };
  } catch (error) { return failure(name, error, warnings); }
}

async function status(context: WikiSyncContext): Promise<CliOutcome> {
  const name = "sync status";
  try {
    const result = await syncStatus(context);
    const lines = [
      `store       ${result.store}`, `vault       ${result.vaultId}`, `state       ${result.stateDir}`,
      `approved    ${result.approved}${result.approvalRecorded ? `   (approval recorded ${result.approvalRecorded.approvedAt})` : ""}`,
      `known files ${result.knownFiles}`, `conflicts   ${result.conflicts}`, `blocked     ${result.blocked.length}`,
      `running     ${result.running ? `yes (pid ${result.running.pid})` : "no"}`,
    ];
    return { command: name, status: result.conflicts ? "conflicts" : "ok", result, lines };
  } catch (error) { return failure(name, error); }
}

async function conflicts(context: WikiSyncContext): Promise<CliOutcome> {
  const name = "sync conflicts";
  try {
    const result = await syncConflicts(context);
    const lines = result.conflicts.length ? result.conflicts.flatMap(c => [`${c.path}  (${c.reason})`, ...c.heads.map(h => `    ${h.recordId}  ${h.device} device${h.deleted ? "  [deleted]" : ""}${h.size === null ? "" : `  ${h.size} bytes`}`)]) : ["no conflicts"];
    return { command: name, status: result.count ? "conflicts" : "ok", result, lines };
  } catch (error) { return failure(name, error); }
}

async function resolve(values: Values, path: string, context: WikiSyncContext): Promise<CliOutcome> {
  const name = "sync resolve";
  const keep = values.keep, version = values.version;
  if ((keep === undefined) === (version === undefined)) return usageOutcome("resolve needs exactly one of --keep local|remote or --version <recordId>", name);
  if (keep !== undefined && keep !== "local" && keep !== "remote") return usageOutcome(`--keep must be local or remote, got ${JSON.stringify(keep)}`, name);
  const overrides = overridesFrom(values, name);
  if (isOutcome(overrides)) return overrides;
  const warnings = overrideWarnings(overrides);
  try {
    const result = await syncResolve(context, { path, choice: typeof version === "string" ? { version } : { keep: keep as "local" | "remote" }, overrides });
    return {
      command: name, status: result.after.conflicts.length ? "conflicts" : "ok", result, warnings,
      lines: [`resolved  ${path}  (${result.choice.kind === "current" ? "kept this device's version" : `took ${result.choice.recordId}`})`, ...previewLines(result.after).slice(1)],
    };
  } catch (error) { return failure(name, error, warnings); }
}

async function gc(values: Values, context: WikiSyncContext): Promise<CliOutcome> {
  const name = "sync gc";
  let trashDays: number | undefined;
  if (values["trash-days"] !== undefined) {
    const n = nonNegative(values["trash-days"] as string, "--trash-days");
    if (isError(n)) return usageOutcome(n.error, name);
    trashDays = n;
  }
  try {
    const result = await syncGc(context, trashDays === undefined ? {} : { trashDays });
    return { command: name, status: "ok", result, lines: [`ok  trash entries removed: ${result.trashRemoved.length}`] };
  } catch (error) { return failure(name, error); }
}
