import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { HistoryController, type HistoryConflict, type HistoryControllerState, type HistoryPathIssue, type HistoryPreview } from "../sync-core/history-controller";
import type { AppendOnlySyncProvider, VaultDescriptor } from "../sync-core/history-types";
import { buildHistoryPorts } from "../sync-core/ports";
import type { SyncStorageRequest } from "../shared/sync-safety";
import { DEFAULT_SYNC_SCOPE, type SyncScope } from "../sync-core/scope";
import { FsStoreProvider } from "./fs-store";
import { NodeHost, SyncLockedError, SyncStateDirError, defaultStateDir, type NodeHostOptions } from "./node-host";
import { spawnSshStore } from "./rpc-store";
import { isStoreError } from "./store-errors";
import { readLockHolder } from "./store-lock";
import { durableWrite, ensureDurableDirectory } from "./sync-apply";

/**
 * The headless sync workflow behind `geode-wiki sync ...`: init, preview, run, status, conflicts,
 * resolve, gc. Everything that decides anything lives here (the CLI only parses argv and formats),
 * so it is unit-testable without a subprocess and the CLI's import audit stays small.
 *
 * Division of labour:
 *   - HistoryController owns the algorithm (plan, approve, apply, conflicts). Not touched here.
 *   - NodeHost owns the device: scan, hash cache, durable state, the cross-process lock.
 *   - This module owns the *safety rails* around an unattended run and the per-vault config.
 *
 * Safety rails (ADR 0025), all evaluated BEFORE any file is changed:
 *   a. approval-required / approval-stale: the first run on a vault must be preceded by
 *      `sync preview --approve`, recorded against the exact preview signature.
 *   b. delete-limit-exceeded: more than max(20, 1% of the vault) deletions in one run.
 *   c. scan-shrunk: the scan saw under half the files this device already knew about (an unmounted
 *      volume or a wrong --root looks exactly like "the user deleted everything").
 *   d. iCloud placeholders are never downloaded unless `hydrateIcloud`; blocked paths are never
 *      deleted (the controller treats a blocked path and everything under it as untouchable).
 * Each of (a)-(c) has an explicit override carried in `SyncOverrides`.
 */

/* ------------------------------------------------------------------ config */

export type SyncTarget = { kind: "fs"; path: string } | { kind: "ssh"; host: string; path: string };

export interface WikiSyncConfig {
  schema: 1;
  target: SyncTarget;
  descriptor: VaultDescriptor;
  deviceId: string;
  /** Vault-relative folders left out of sync. Part of the scope key: changing them re-requires approval. */
  excludeFolders: string[];
  createdAt: string;
}

export interface SyncOverrides {
  /** Allow up to this many deletions in one run (replaces the default limit; does not disable it). */
  deleteLimit?: number;
  /** Proceed although the scan found under half of the previously known files. */
  shrunkScan?: boolean;
  /** Let `brctl download` fetch blocked iCloud placeholders. Off by default. */
  hydrateIcloud?: boolean;
}

export interface WikiSyncContext {
  root: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Receives ssh/server stderr lines. */
  onStderr?: (line: string) => void;
  /** Defer files modified within this window. Default (NodeHost) 5000. */
  settleMs?: number;
  /** Test seams. */
  provider?: AppendOnlySyncProvider & { close?(): Promise<void> };
  hostOptions?: Partial<NodeHostOptions>;
  now?: () => number;
}

export const MIN_DELETE_LIMIT = 20;
export const DELETE_LIMIT_FRACTION = 0.01;
export const MIN_SCAN_RATIO = 0.5;
export const deleteLimitFor = (vaultFiles: number): number => Math.max(MIN_DELETE_LIMIT, Math.floor(vaultFiles * DELETE_LIMIT_FRACTION));

const CONFIG_FILE = "cli-config.json";
const APPROVAL_KEY = "cli/approval";
const LAST_RUN_KEY = "cli/last-run";
const never = new AbortController().signal;

/* ------------------------------------------------------------------ errors */

export type SyncRailStatus = "approval-required" | "approval-stale" | "delete-limit-exceeded" | "scan-shrunk";

/** A safety rail refused the run. Nothing was changed. `override` names the explicit flag that lifts it. */
export class SyncRailError extends Error {
  constructor(readonly status: SyncRailStatus, message: string, readonly detail: Record<string, unknown>, readonly override: string | null) {
    super(message); this.name = "SyncRailError";
  }
}

/** A refusal that is not a rail: not initialised, already initialised, no such conflict... Named, exit 1. */
export class SyncRefusal extends Error {
  constructor(readonly status: string, message: string, readonly detail: Record<string, unknown> = {}) { super(message); this.name = "SyncRefusal"; }
}

export interface SyncFailure { status: string; message: string; detail: Record<string, unknown>; override?: string | null }

/** Maps anything thrown by the workflow onto a named status. Unknown errors become `sync-failed`. */
export function classifySyncError(error: unknown): SyncFailure {
  if (error instanceof SyncRailError) return { status: error.status, message: error.message, detail: error.detail, override: error.override };
  if (error instanceof SyncRefusal) return { status: error.status, message: error.message, detail: error.detail };
  if (error instanceof SyncLockedError) return { status: "locked", message: error.message, detail: { stateDir: error.stateDir } };
  if (error instanceof SyncStateDirError) return { status: "state-dir-invalid", message: error.message, detail: {} };
  if (isStoreError(error)) {
    const down = error.code === "unavailable" || error.code === "lock-timeout" || error.code === "protocol";
    return { status: down ? "store-unavailable" : "store-failed", message: error.message, detail: { code: error.code } };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return { status: "vault-unavailable", message, detail: { code } };
  if (message.includes("Authoritative local snapshot unavailable")) return { status: "scan-incomplete", message: "The vault scan was incomplete (an unreadable directory); the engine refuses to plan from a partial view", detail: {} };
  if (message.includes("Complete remote history scan unavailable")) return { status: "store-unavailable", message, detail: {} };
  if (message.includes("Resume pending sync")) return { status: "pending-batch", message: "A previous run was interrupted mid-batch; run `sync run` to resume it before previewing", detail: {} };
  return { status: "sync-failed", message, detail: {} };
}

/* -------------------------------------------------------------- state dir */

function localName(realRoot: string): string { return `root-${createHash("sha256").update(realRoot).digest("hex").slice(0, 16)}`; }

/** One state directory per local directory, outside the vault: `~/.geode/sync/root-<hash of realpath>`. */
export async function resolveStateDir(ctx: Pick<WikiSyncContext, "root" | "stateDir" | "env" | "homeDir">): Promise<string> {
  if (ctx.stateDir) return path.resolve(ctx.stateDir);
  let real: string;
  try { real = await fs.realpath(ctx.root); } catch (error) { throw new SyncRefusal("vault-unavailable", `Vault folder is not reachable: ${ctx.root}`, { root: ctx.root, code: (error as NodeJS.ErrnoException).code ?? null }); }
  return defaultStateDir(localName(real), ctx.env, ctx.homeDir);
}

async function requireDirectory(root: string): Promise<void> {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) throw new SyncRefusal("vault-unavailable", `Vault folder is not reachable: ${root}`, { root });
}

async function readConfig(stateDir: string): Promise<WikiSyncConfig | null> {
  let raw: string;
  try { raw = await fs.readFile(path.join(stateDir, CONFIG_FILE), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const parsed = JSON.parse(raw) as WikiSyncConfig;
  if (parsed?.schema !== 1 || !parsed.descriptor?.vaultId || !parsed.deviceId || !parsed.target) throw new SyncRefusal("config-invalid", `${path.join(stateDir, CONFIG_FILE)} is not a valid sync config`);
  return parsed;
}

async function requireConfig(stateDir: string): Promise<WikiSyncConfig> {
  const config = await readConfig(stateDir);
  if (!config) throw new SyncRefusal("not-initialised", "This vault has no sync binding yet; run `geode-wiki sync init` first", { stateDir });
  return config;
}

const bindingKeyFor = (vaultId: string) => createHash("sha256").update(vaultId).digest("hex");
const stateKeyFor = (vaultId: string) => `sync-history/${vaultId}/${bindingKeyFor(vaultId)}`;

function scopeFor(config: WikiSyncConfig): SyncScope {
  // Content only: a headless host has no app configuration to project.
  return { ...DEFAULT_SYNC_SCOPE, mainSettings: false, appearance: false, hotkeys: false, corePlugins: false, themesAndSnippets: false, excludedFolders: [...config.excludeFolders] };
}

export function validateExcludeFolders(folders: readonly string[]): string[] {
  return folders.map(folder => {
    const clean = folder.replace(/\/+$/, "");
    if (!clean || clean.startsWith("/") || clean.includes("\\") || clean.split("/").some(part => !part || part === "." || part === "..")) throw new SyncRefusal("invalid-exclude", `--exclude must be a vault-relative folder, got ${JSON.stringify(folder)}`);
    return clean;
  });
}

function makeProvider(target: SyncTarget, ctx: WikiSyncContext): AppendOnlySyncProvider & { close?(): Promise<void> } {
  if (ctx.provider) return ctx.provider;
  if (target.kind === "fs") return new FsStoreProvider(target.path);
  return spawnSshStore({ host: target.host, storePath: target.path, ...(ctx.onStderr ? { onStderr: ctx.onStderr } : {}) });
}

/* ------------------------------------------------------------- live session */

interface ScanStats { known: number; found: number; files: number }

interface Live {
  host: NodeHost;
  controller: HistoryController;
  config: WikiSyncConfig;
  stateKey: string;
  stats: ScanStats;
  storage(request: SyncStorageRequest): Promise<unknown>;
}

const knownFileCount = (state: HistoryControllerState | null): number =>
  state ? Object.values(state.baseline).filter(entry => entry.present && entry.kind === "file" && entry.namespace === "content").length : 0;

async function openHost(ctx: WikiSyncContext, config: WikiSyncConfig, stateDir: string, overrides: SyncOverrides): Promise<NodeHost> {
  await requireDirectory(ctx.root);
  return NodeHost.open({
    root: ctx.root, stateDir, excludeFolders: config.excludeFolders,
    ...(ctx.settleMs !== undefined ? { settleMs: ctx.settleMs } : {}),
    hydrateIcloud: overrides.hydrateIcloud === true,
    ...(ctx.now ? { now: ctx.now } : {}),
    ...ctx.hostOptions,
  });
}

/** Holds the cross-process lock, opens the store, and hands over a controller whose scan is guarded by rail (c). */
async function withLive<T>(ctx: WikiSyncContext, overrides: SyncOverrides, fn: (live: Live) => Promise<T>): Promise<T> {
  const stateDir = await resolveStateDir(ctx);
  const config = await requireConfig(stateDir);
  const host = await openHost(ctx, config, stateDir, overrides);
  const provider = makeProvider(config.target, ctx);
  try {
    return await host.run(async lease => {
      const bindingKey = bindingKeyFor(config.descriptor.vaultId), stateKey = stateKeyFor(config.descriptor.vaultId);
      const stats: ScanStats = { known: 0, found: 0, files: 0 };
      const built = buildHistoryPorts(host, {
        provider: { id: provider.id }, scope: scopeFor(config), bindingVaultId: config.descriptor.vaultId, bindingKey, stateKey, lease,
        assertContext: () => {}, renameHints: new Map(), portableChanged: async () => {},
      });
      const innerSnapshot = built.ports.snapshot;
      built.ports.snapshot = async onProgress => {
        const snapshot = await innerSnapshot(onProgress);
        stats.known = knownFileCount(await host.deviceState.read<HistoryControllerState>(stateKey));
        stats.files = snapshot.entries.filter(entry => entry.namespace === "content" && entry.kind === "file").length;
        stats.found = stats.files + snapshot.blocked.filter(item => item.namespace === "content").length + snapshot.excluded.filter(item => item.namespace === "content").length;
        // Rail (c). Blocked and excluded paths still exist on disk, so they count as "seen".
        if (stats.known > 0 && stats.found < stats.known * MIN_SCAN_RATIO && !overrides.shrunkScan) {
          throw new SyncRailError("scan-shrunk", `The scan found ${stats.found} files but this device previously knew ${stats.known} (under ${MIN_SCAN_RATIO * 100}%). Is the volume mounted and --root correct?`,
            { found: stats.found, known: stats.known, ratio: Number((stats.found / stats.known).toFixed(3)), minimumRatio: MIN_SCAN_RATIO }, "--override-shrunk-scan");
        }
        return snapshot;
      };
      const session = await provider.open({ binding: config.descriptor, deviceId: config.deviceId }, never);
      try {
        const controller = new HistoryController({ vaultId: config.descriptor.vaultId, deviceId: config.deviceId, bindingKey, session, ports: built.ports });
        return await fn({ host, controller, config, stateKey, stats, storage: built.storage });
      } finally { await session.close(); }
    });
  } finally { await provider.close?.().catch(() => {}); }
}

/* --------------------------------------------------------------- summaries */

export interface PreviewSummary {
  signature: string; uploads: number; downloads: number; deletions: number;
  conflicts: Array<{ path: string; reason: string; entityId: string }>;
  blocked: HistoryPathIssue[]; excluded: number; pending: number; upToDate: boolean; requiresApproval: boolean;
}

const summarise = (preview: HistoryPreview): PreviewSummary => ({
  signature: preview.signature, uploads: preview.uploads, downloads: preview.downloads, deletions: preview.deletions,
  conflicts: preview.conflicts.map(c => ({ path: c.path, reason: c.reason, entityId: c.entityId })),
  blocked: preview.blocked, excluded: preview.excluded.length, pending: preview.pending, upToDate: preview.upToDate, requiresApproval: preview.requiresApproval,
});

export interface RailReport { scan: { known: number; found: number }; deletes: { planned: number; limit: number; vaultFiles: number }; overridesActive: string[] }

function activeOverrides(overrides: SyncOverrides): string[] {
  return [
    ...(overrides.deleteLimit !== undefined ? [`--override-delete-limit ${overrides.deleteLimit}`] : []),
    ...(overrides.shrunkScan ? ["--override-shrunk-scan"] : []),
    ...(overrides.hydrateIcloud ? ["--hydrate-icloud"] : []),
  ];
}

/** Preview, then rail (b). Throws SyncRailError carrying the counts when the plan is too destructive. */
async function previewWithRails(live: Live, overrides: SyncOverrides): Promise<{ summary: PreviewSummary; rails: RailReport }> {
  const preview = await live.controller.preview(never);
  const summary = summarise(preview);
  const limit = overrides.deleteLimit ?? deleteLimitFor(live.stats.found);
  const rails: RailReport = { scan: { known: live.stats.known, found: live.stats.found }, deletes: { planned: preview.deletions, limit, vaultFiles: live.stats.found }, overridesActive: activeOverrides(overrides) };
  if (preview.deletions > limit) {
    throw new SyncRailError("delete-limit-exceeded", `This run would delete ${preview.deletions} items, over the limit of ${limit} (max(${MIN_DELETE_LIMIT}, ${DELETE_LIMIT_FRACTION * 100}% of ${live.stats.found} files)). Review with \`sync preview\`.`,
      { deletions: preview.deletions, limit, vaultFiles: live.stats.found, uploads: preview.uploads, downloads: preview.downloads, signature: preview.signature }, "--override-delete-limit <n>");
  }
  return { summary, rails };
}

interface ApprovalRecord { signature: string; approvedAt: string; uploads: number; downloads: number; deletions: number }

/* -------------------------------------------------------------------- init */

export interface InitInput { target: SyncTarget; name?: string; create?: boolean; exclude?: readonly string[] }

export async function syncInit(ctx: WikiSyncContext, input: InitInput) {
  await requireDirectory(ctx.root);
  const stateDir = await resolveStateDir(ctx);
  const existing = await readConfig(stateDir);
  if (existing) throw new SyncRefusal("already-initialised", `This vault is already bound to a store (${describeTarget(existing.target)}); remove ${stateDir} to rebind`, { stateDir, target: existing.target, vaultId: existing.descriptor.vaultId });
  const exclude = validateExcludeFolders(input.exclude ?? []);
  const target: SyncTarget = input.target.kind === "fs" ? { kind: "fs", path: path.resolve(input.target.path) } : input.target;
  const provider = makeProvider(target, ctx);
  try {
    let vaults = await provider.discover(never);
    let created = false;
    if (vaults.length === 0) {
      if (!input.create) throw new SyncRefusal("store-empty", "The store holds no vault yet. Pass --create to start one from this folder", { target });
      vaults = [await provider.createVault({ name: input.name ?? (path.basename(path.resolve(ctx.root)) || "vault"), operationId: randomUUID() }, never)];
      created = true;
    }
    const config: WikiSyncConfig = { schema: 1, target, descriptor: vaults[0], deviceId: randomUUID(), excludeFolders: exclude, createdAt: new Date((ctx.now ?? Date.now)()).toISOString() };
    // Fail on an unusable state dir (inside the vault) before writing anything into it.
    await openHost(ctx, config, stateDir, {});
    await ensureDurableDirectory(stateDir);
    await durableWrite(path.join(stateDir, CONFIG_FILE), Buffer.from(JSON.stringify(config, null, 2) + "\n"));
    return { stateDir, created, vaultId: config.descriptor.vaultId, name: config.descriptor.name, deviceId: config.deviceId, target, excludeFolders: exclude };
  } finally { await provider.close?.().catch(() => {}); }
}

export const describeTarget = (target: SyncTarget): string => target.kind === "fs" ? target.path : `ssh://${target.host}${target.path.startsWith("/") ? "" : "/"}${target.path}`;

/* ----------------------------------------------------------------- preview */

export async function syncPreview(ctx: WikiSyncContext, input: { approve?: boolean; overrides?: SyncOverrides } = {}) {
  const overrides = input.overrides ?? {};
  return withLive(ctx, overrides, async live => {
    const { summary, rails } = await previewWithRails(live, overrides);
    let approved = false;
    if (input.approve) {
      const record: ApprovalRecord = { signature: summary.signature, approvedAt: new Date((ctx.now ?? Date.now)()).toISOString(), uploads: summary.uploads, downloads: summary.downloads, deletions: summary.deletions };
      await live.host.deviceState.write(APPROVAL_KEY, record);
      approved = true;
    }
    return { preview: summary, rails, approvalRecorded: approved, firstRun: summary.requiresApproval };
  });
}

/* --------------------------------------------------------------------- run */

export async function syncRun(ctx: WikiSyncContext, input: { overrides?: SyncOverrides } = {}) {
  const overrides = input.overrides ?? {};
  return withLive(ctx, overrides, async live => {
    const before = await live.controller.getState(never);
    const resuming = (before.pendingBatch?.length ?? 0) > 0;
    let planned: PreviewSummary | null = null;
    let rails: RailReport | null = null;
    if (!resuming) {
      ({ summary: planned, rails } = await previewWithRails(live, overrides));
      if (!before.approved) {
        // Rail (a). The controller would also refuse an unapproved first run, but only by comparing against
        // whatever preview happened last. The recorded approval is what a human actually signed off on.
        const approval = await live.host.deviceState.read<ApprovalRecord>(APPROVAL_KEY);
        if (!approval) throw new SyncRailError("approval-required", "The first run on a vault must follow a reviewed preview. Run `geode-wiki sync preview`, read it, then `geode-wiki sync preview --approve`.", { uploads: planned.uploads, downloads: planned.downloads, deletions: planned.deletions }, null);
        if (approval.signature !== planned.signature) throw new SyncRailError("approval-stale", "The approved preview no longer matches what a run would do (the vault or the store changed since). Preview again and re-approve.", { approvedAt: approval.approvedAt, approved: { uploads: approval.uploads, downloads: approval.downloads, deletions: approval.deletions }, now: { uploads: planned.uploads, downloads: planned.downloads, deletions: planned.deletions } }, null);
      }
    }
    const after = await live.controller.run({ approvePreview: true }, never);
    const finished = summarise(after);
    await live.host.deviceState.write(APPROVAL_KEY, null);
    await live.host.deviceState.write(LAST_RUN_KEY, { at: new Date((ctx.now ?? Date.now)()).toISOString(), planned: planned && { uploads: planned.uploads, downloads: planned.downloads, deletions: planned.deletions }, conflicts: finished.conflicts.length, blocked: finished.blocked.length, resumed: resuming });
    return {
      resumed: resuming, planned: planned && { uploads: planned.uploads, downloads: planned.downloads, deletions: planned.deletions },
      rails: rails ?? { scan: { known: live.stats.known, found: live.stats.found }, deletes: { planned: 0, limit: deleteLimitFor(live.stats.found), vaultFiles: live.stats.found }, overridesActive: activeOverrides(overrides) },
      after: finished,
    };
  });
}

/* ------------------------------------------------- offline state reads */

async function readOffline(ctx: WikiSyncContext) {
  const stateDir = await resolveStateDir(ctx);
  const config = await requireConfig(stateDir);
  const host = await openHost(ctx, config, stateDir, {});
  const state = await host.deviceState.read<HistoryControllerState>(stateKeyFor(config.descriptor.vaultId));
  return { stateDir, config, host, state };
}

export async function syncStatus(ctx: WikiSyncContext) {
  const { stateDir, config, host, state } = await readOffline(ctx);
  const approval = await host.deviceState.read<ApprovalRecord>(APPROVAL_KEY);
  const lastRun = await host.deviceState.read<Record<string, unknown>>(LAST_RUN_KEY);
  const holder = await readLockHolder(stateDir, "lock");
  return {
    initialised: true, stateDir, store: describeTarget(config.target), vaultId: config.descriptor.vaultId, deviceId: config.deviceId,
    excludeFolders: config.excludeFolders,
    running: holder, ran: state !== null, approved: state?.approved ?? false,
    approvalRecorded: approval ? { approvedAt: approval.approvedAt, signature: approval.signature } : null,
    knownFiles: knownFileCount(state), conflicts: state?.conflicts.length ?? 0, blocked: state?.blocked ?? [], pendingBatch: state?.pendingBatch?.length ?? 0, lastRun,
  };
}

export async function syncConflicts(ctx: WikiSyncContext) {
  const { config, state } = await readOffline(ctx);
  const conflicts = (state?.conflicts ?? []).map((conflict: HistoryConflict) => ({
    path: conflict.path, entityId: conflict.entityId, reason: conflict.reason,
    heads: conflict.heads.map(id => {
      const record = state!.history.records[id];
      return { recordId: id, device: record ? (record.deviceId === config.deviceId ? "this" : "other") : "unknown", deviceId: record?.deviceId ?? null, deleted: record?.deleted ?? null, size: record?.blob?.size ?? null, sha256: record?.blob?.sha256 ?? null };
    }),
  }));
  return { conflicts, count: conflicts.length };
}

/* ----------------------------------------------------------------- resolve */

export type ResolveChoice = { keep: "local" } | { keep: "remote" } | { version: string };

export async function syncResolve(ctx: WikiSyncContext, input: { path: string; choice: ResolveChoice; overrides?: SyncOverrides }) {
  return withLive(ctx, input.overrides ?? {}, async live => {
    await live.controller.preview(never); // refresh state.conflicts from live evidence
    const state = await live.controller.getState(never);
    const conflict = state.conflicts.find(item => item.path === input.path && item.namespace === "content");
    if (!conflict) throw new SyncRefusal("no-such-conflict", `No unresolved conflict at ${input.path}`, { path: input.path, conflicts: state.conflicts.map(c => c.path) });
    let choice: { kind: "current" } | { kind: "version"; recordId: string };
    if ("version" in input.choice) {
      if (!conflict.heads.includes(input.choice.version)) throw new SyncRefusal("invalid-version", `${input.choice.version} is not one of this conflict's versions`, { heads: conflict.heads });
      choice = { kind: "version", recordId: input.choice.version };
    } else if (input.choice.keep === "local") choice = { kind: "current" };
    else {
      const others = conflict.heads.filter(id => state.history.records[id]?.deviceId !== live.config.deviceId);
      if (others.length !== 1) throw new SyncRefusal("ambiguous-remote", others.length ? "Several other-device versions exist; pick one with --version <recordId>" : "No other-device version exists; use --keep local", { remoteVersions: others });
      choice = { kind: "version", recordId: others[0] };
    }
    const after = await live.controller.resolve({ entityId: conflict.entityId, heads: conflict.heads, choice }, never);
    return { path: input.path, choice, after: summarise(after) };
  });
}

/* ---------------------------------------------------------------------- gc */

export async function syncGc(ctx: WikiSyncContext, input: { trashDays?: number } = {}) {
  return withLive(ctx, {}, async live => {
    const state = await live.controller.getState(never);
    const operations = await live.storage({ action: "gc", retain: state.pendingBatch ?? [] });
    const bindings = await live.storage({ action: "sweep", keep: [bindingKeyFor(live.config.descriptor.vaultId)], force: false });
    const trashed: string[] = [];
    if (input.trashDays !== undefined) {
      const trashRoot = path.join(live.host.stateDir, "trash"), cutoff = (ctx.now ?? Date.now)() - input.trashDays * 86_400_000;
      for (const name of await fs.readdir(trashRoot).catch(() => [] as string[])) {
        const full = path.join(trashRoot, name), stat = await fs.stat(full).catch(() => null);
        if (stat && stat.mtimeMs < cutoff) { await fs.rm(full, { recursive: true, force: true }); trashed.push(name); }
      }
    }
    return { operations, bindings, trashRemoved: trashed, trashDays: input.trashDays ?? null };
  });
}
