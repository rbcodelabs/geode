import { Events } from "../events";
import type { HostServices, VaultFileEntry } from "../host/contracts";
import { DEFAULT_SYNC_SCOPE, isPathInSyncScope, validateSyncPath, type SyncScope } from "./scope";
import type { SyncApi, SyncPreview, SyncProvider, SyncRemoteEntry, SyncRunResult, SyncSession, SyncStatus } from "./types";

interface BaselineEntry { path: string; localFingerprint: string; remoteId: string; remoteRevision: string; kind: "file" | "folder"; }
interface SyncState { providerId?: string; cursor?: string; approved: boolean; paused: boolean; previewSignature?: string; baseline: Record<string, BaselineEntry>; scope: SyncScope; journal: JournalOperation[]; }
interface JournalOperation { id: string; type: "upload" | "download" | "local-trash" | "remote-trash"; path: string; remote?: SyncRemoteEntry; phase: "prepared" | "applied"; }
interface Plan { uploads: VaultFileEntry[]; downloads: SyncRemoteEntry[]; localTrash: SyncRemoteEntry[]; remoteTrash: BaselineEntry[]; conflicts: Array<{ local: VaultFileEntry; remote: SyncRemoteEntry }>; skipped: number; remoteEntries: SyncRemoteEntry[]; cursor?: string; }

const EMPTY_STATUS: SyncStatus = { state: "disconnected", conflicts: 0 };

export class SyncCoordinator extends Events implements SyncApi {
  private providers = new Map<string, { owner: string; provider: SyncProvider }>();
  private status: SyncStatus = EMPTY_STATUS;
  private activeAbort?: AbortController;
  private activeSession?: SyncSession;
  private running?: Promise<unknown>;
  constructor(private readonly host: HostServices, private readonly vaultId: () => string, private readonly now: () => number = Date.now) { super(); }

  register(owner: string, provider: SyncProvider): () => void {
    if (!provider.id || this.providers.has(provider.id)) throw new Error(`Sync provider already registered: ${provider.id}`);
    this.validateCapabilities(provider);
    this.providers.set(provider.id, { owner, provider });
    return () => { void this.unregister(provider.id, owner); };
  }
  listProviders() { return [...this.providers.values()].map(({ provider }) => ({ id: provider.id, name: provider.name })); }
  getActiveProvider() { const found = this.status.providerId ? this.providers.get(this.status.providerId)?.provider : undefined; return found ? { id: found.id, name: found.name } : null; }
  getStatus() { return { ...this.status }; }
  override on(event: "status", callback: (status: SyncStatus) => void) { return super.on(event, callback); }

  async activate(providerId: string): Promise<void> {
    const registration = this.providers.get(providerId);
    if (!registration) throw new Error(`Unknown sync provider: ${providerId}`);
    const state = await this.loadState();
    if (state.providerId && state.providerId !== providerId) throw new Error("Disconnect the active sync provider before selecting another");
    state.providerId = providerId;
    await this.saveState(state);
    this.setStatus({ state: state.paused ? "paused" : "idle", providerId, conflicts: 0 });
  }

  async disconnect(): Promise<void> { await this.cancel(); const state = await this.loadState(); delete state.providerId; state.approved = false; state.cursor = undefined; state.baseline = {}; state.journal = []; await this.saveState(state); this.setStatus(EMPTY_STATUS); }
  async pause(): Promise<void> { await this.cancel(); const state = await this.loadState(); state.paused = true; await this.saveState(state); this.setStatus({ ...this.status, state: "paused" }); }
  async resume(): Promise<void> { const state = await this.loadState(); state.paused = false; await this.saveState(state); this.setStatus({ ...this.status, state: state.providerId ? "idle" : "disconnected" }); }
  async cancel(): Promise<void> { this.activeAbort?.abort(); await this.running?.catch(() => undefined); await this.activeSession?.close().catch(() => undefined); this.activeAbort = undefined; this.activeSession = undefined; }

  async preview(): Promise<SyncPreview> {
    const plan = await this.withSession(async (session, state, signal) => { const next = await this.plan(session, state, signal); state.previewSignature = this.planSignature(next); await this.saveState(state); return next; });
    const preview = this.toPreview(plan);
    this.setStatus({ state: "preview", providerId: this.status.providerId, conflicts: preview.conflicts });
    return preview;
  }

  async run(options: { approvePreview?: boolean } = {}): Promise<SyncRunResult> {
    return this.withSession(async (session, state, signal) => {
      if (state.paused) throw new Error("Sync is paused");
      const plan = await this.plan(session, state, signal);
      if (!state.approved && (!options.approvePreview || state.previewSignature !== this.planSignature(plan))) throw new Error("Preview this exact first sync before approving it");
      state.approved = true;
      state.previewSignature = undefined;
      this.setStatus({ state: "syncing", providerId: state.providerId, conflicts: 0 });
      await this.execute(session, state, plan, signal);
      state.cursor = plan.cursor;
      await this.saveState(state);
      const result = { ...this.toPreview(plan), cursor: state.cursor };
      delete (result as Partial<SyncPreview>).requiresApproval;
      this.setStatus({ state: plan.conflicts.length ? "conflict" : "idle", providerId: state.providerId, conflicts: plan.conflicts.length });
      return result as SyncRunResult;
    });
  }

  private async unregister(id: string, owner: string) { const registered = this.providers.get(id); if (!registered || registered.owner !== owner) return; this.providers.delete(id); if (this.status.providerId === id) { await this.cancel(); this.setStatus({ state: "error", providerId: id, conflicts: 0, message: "Sync provider unloaded" }); } }
  private async withSession<T>(fn: (session: SyncSession, state: SyncState, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.running) throw new Error("A sync operation is already running");
    const state = await this.loadState(); const provider = state.providerId ? this.providers.get(state.providerId)?.provider : undefined;
    if (!provider) throw new Error("No sync provider is active");
    const controller = new AbortController(); this.activeAbort = controller;
    const work = (async () => { const session = await provider.open({ vaultId: this.vaultId() }); this.activeSession = session; try { return await fn(session, state, controller.signal); } finally { await session.close(); } })();
    this.running = work;
    try { return await work; } catch (error) { if (!controller.signal.aborted) this.setStatus({ state: "error", providerId: state.providerId, conflicts: 0, message: error instanceof Error ? error.message : String(error) }); throw error; }
    finally { if (this.running === work) this.running = undefined; this.activeAbort = undefined; this.activeSession = undefined; }
  }

  private async plan(session: SyncSession, state: SyncState, signal: AbortSignal): Promise<Plan> {
    const localScan = await this.host.vaultFiles.reconcileScan();
    if (localScan.status !== "complete") throw new Error(`A complete local scan is required (${localScan.status})`);
    const remoteScan = await session.scan(state.cursor, signal);
    if (signal.aborted) throw new DOMException("Sync cancelled", "AbortError");
    if (remoteScan.status !== "complete") throw new Error(`A complete remote scan is required (${remoteScan.status})`);
    await this.recoverJournal(state, localScan.entries, remoteScan.entries, remoteScan.mode);
    const local = localScan.entries.filter(e => !e.isFolder && isPathInSyncScope(e.path, state.scope));
    const remote = remoteScan.entries.filter(e => e.kind === "tombstone" || isPathInSyncScope(e.path, state.scope));
    this.rejectCollisions(remote);
    const byPath = new Map(remote.filter(e => e.kind !== "tombstone").map(e => [e.path, e]));
    const localByPath = new Map(local.map(e => [e.path, e]));
    const plan: Plan = { uploads: [], downloads: [], localTrash: [], remoteTrash: [], conflicts: [], skipped: 0, remoteEntries: remote, cursor: remoteScan.cursor };
    for (const entry of local) {
      const remoteEntry = byPath.get(entry.path); const baseline = state.baseline[entry.path];
      if (!remoteEntry) {
        if (!baseline) {
          if (this.isWithinLimit(entry.size)) plan.uploads.push(entry); else plan.skipped++;
        } else if (remoteScan.mode === "snapshot") {
          const tombstone: SyncRemoteEntry = { id: baseline.remoteId, path: entry.path, kind: "tombstone", revision: baseline.remoteRevision, deletedPath: entry.path };
          if (this.fingerprint(entry) === baseline.localFingerprint) plan.localTrash.push(tombstone); else plan.conflicts.push({ local: entry, remote: tombstone });
        }
        continue;
      }
      if (!baseline) { plan.conflicts.push({ local: entry, remote: remoteEntry }); continue; }
      const localChanged = this.fingerprint(entry) !== baseline.localFingerprint; const remoteChanged = remoteEntry.revision !== baseline.remoteRevision;
      if (localChanged && remoteChanged) plan.conflicts.push({ local: entry, remote: remoteEntry });
      else if (localChanged) { if (this.isWithinLimit(entry.size)) plan.uploads.push(entry); else plan.skipped++; }
      else if (remoteChanged) { if (this.isWithinLimit(remoteEntry.size)) plan.downloads.push(remoteEntry); else plan.skipped++; }
    }
    for (const entry of remote) {
      if (entry.kind === "tombstone") { const path = entry.deletedPath ?? entry.path; const localEntry = localByPath.get(path); const baseline = state.baseline[path]; if (localEntry && baseline) { if (this.fingerprint(localEntry) === baseline.localFingerprint) plan.localTrash.push(entry); else plan.conflicts.push({ local: localEntry, remote: entry }); } continue; }
      if (!localByPath.has(entry.path)) { const baseline = state.baseline[entry.path]; if (baseline) plan.remoteTrash.push(baseline); else if (this.isWithinLimit(entry.size)) plan.downloads.push(entry); else plan.skipped++; }
    }
    return plan;
  }

  private async execute(session: SyncSession, state: SyncState, plan: Plan, signal: AbortSignal) {
    for (const entry of plan.uploads) {
      this.assertActive(signal); const op = await this.prepare(state, "upload", entry.path); const data = await this.host.vaultFiles.readBinary(entry.path); const prior = state.baseline[entry.path];
      try {
        const remote = prior ? await session.update({ id: prior.remoteId, path: entry.path, data, expectedRevision: prior.remoteRevision, signal, operationKey: op.id }) : await session.create({ path: entry.path, data, signal, operationKey: op.id });
        state.baseline[entry.path] = { path: entry.path, localFingerprint: this.fingerprint(entry), remoteId: remote.id, remoteRevision: remote.revision, kind: "file" }; await this.ack(state, op);
      } catch (error) {
        if (!prior || !(error instanceof Error) || error.name !== "SyncPreconditionError") throw error;
        const current = plan.remoteEntries.find(remote => remote.id === prior.remoteId && remote.kind === "file");
        if (!current) throw error;
        state.baseline[entry.path] = { path: entry.path, localFingerprint: this.fingerprint(entry), remoteId: current.id, remoteRevision: current.revision, kind: "file" };
        plan.conflicts.push({ local: entry, remote: current }); await this.ack(state, op);
      }
    }
    for (const entry of plan.downloads) { this.assertActive(signal); validateSyncPath(entry.path); const op = await this.prepare(state, "download", entry.path, entry); const data = await session.read(entry, signal); await this.host.vaultFiles.writeBinary(entry.path, data, undefined, op.id); const stat = (await this.host.vaultFiles.list()).find(e => e.path === entry.path); if (stat) state.baseline[entry.path] = { path: entry.path, localFingerprint: this.fingerprint(stat), remoteId: entry.id, remoteRevision: entry.revision, kind: "file" }; await this.ack(state, op); }
    for (const entry of plan.localTrash) { const path = entry.deletedPath ?? entry.path; const op = await this.prepare(state, "local-trash", path, entry); await this.host.vaultFiles.trash(path, op.id); delete state.baseline[path]; await this.ack(state, op); }
    for (const entry of plan.remoteTrash) { const op = await this.prepare(state, "remote-trash", entry.path, { id: entry.remoteId, path: entry.path, kind: "file", revision: entry.remoteRevision }); await session.trash({ id: entry.remoteId, expectedRevision: entry.remoteRevision, signal }); delete state.baseline[entry.path]; await this.ack(state, op); }
    for (const conflict of plan.conflicts) { if (conflict.remote.kind === "tombstone") continue; const bytes = await session.read(conflict.remote, signal); const path = this.conflictPath(conflict.remote.path); await this.host.vaultFiles.writeBinary(path, bytes, undefined, this.operationId()); }
  }

  private fingerprint(entry: VaultFileEntry) { return `${entry.size}:${entry.mtime}`; }
  private isWithinLimit(size: number | undefined) { const provider = this.status.providerId ? this.providers.get(this.status.providerId)?.provider : undefined; return size === undefined || provider?.capabilities.maxFileSize === undefined || size <= provider.capabilities.maxFileSize; }
  private conflictPath(path: string) { const dot = path.lastIndexOf("."); const suffix = `.sync-conflict-${this.now()}`; return dot > path.lastIndexOf("/") ? `${path.slice(0, dot)}${suffix}${path.slice(dot)}` : `${path}${suffix}`; }
  private operationId() { return `sync:${this.now()}:${Math.random().toString(36).slice(2)}`; }
  private async prepare(state: SyncState, type: JournalOperation["type"], path: string, remote?: SyncRemoteEntry) { const existing = state.journal.find(op => op.type === type && op.path === path); if (existing) return existing; const op: JournalOperation = { id: this.operationId(), type, path, remote, phase: "prepared" }; state.journal.push(op); await this.saveState(state); return op; }
  private async ack(state: SyncState, op: JournalOperation) { state.journal = state.journal.filter(candidate => candidate.id !== op.id); await this.saveState(state); }
  private async recoverJournal(state: SyncState, local: VaultFileEntry[], remote: SyncRemoteEntry[], mode: "snapshot" | "delta" | undefined) {
    if (!state.journal.length) return;
    const localByPath = new Map(local.map(entry => [entry.path, entry]));
    const remoteById = new Map(remote.filter(entry => entry.kind !== "tombstone").map(entry => [entry.id, entry]));
    let changed = false;
    for (const op of [...state.journal]) {
      if (op.type === "upload") {
        const uploaded = remote.find(entry => entry.operationKey === op.id && entry.kind !== "tombstone");
        const localEntry = localByPath.get(op.path);
        if (uploaded && localEntry) { state.baseline[op.path] = { path: op.path, localFingerprint: this.fingerprint(localEntry), remoteId: uploaded.id, remoteRevision: uploaded.revision, kind: "file" }; state.journal = state.journal.filter(candidate => candidate.id !== op.id); changed = true; }
      } else if (op.type === "local-trash" && !localByPath.has(op.path)) {
        delete state.baseline[op.path]; state.journal = state.journal.filter(candidate => candidate.id !== op.id); changed = true;
      } else if (op.type === "remote-trash" && mode === "snapshot" && op.remote && !remoteById.has(op.remote.id)) {
        delete state.baseline[op.path]; state.journal = state.journal.filter(candidate => candidate.id !== op.id); changed = true;
      }
    }
    if (changed) await this.saveState(state);
  }
  private planSignature(plan: Plan) { return JSON.stringify({ cursor: plan.cursor, uploads: plan.uploads.map(e => [e.path, this.fingerprint(e)]), downloads: plan.downloads.map(e => [e.id, e.revision, e.path]), localTrash: plan.localTrash.map(e => [e.id, e.revision]), remoteTrash: plan.remoteTrash.map(e => [e.remoteId, e.remoteRevision]), conflicts: plan.conflicts.map(e => [e.local.path, e.remote.id, e.remote.revision]) }); }
  private assertActive(signal: AbortSignal) { if (signal.aborted) throw new DOMException("Sync cancelled", "AbortError"); }
  private toPreview(plan: Plan): SyncPreview { return { uploads: plan.uploads.length, downloads: plan.downloads.length, deletes: plan.localTrash.length + plan.remoteTrash.length, conflicts: plan.conflicts.length, skipped: plan.skipped, requiresApproval: true }; }
  private validateCapabilities(provider: SyncProvider) { const c = provider.capabilities; if (!c.binary || !c.conditionalWrites || (!c.delta && !c.completeSnapshots) || !c.trash) throw new Error(`Sync provider ${provider.id} does not meet Geode's safety contract`); }
  private rejectCollisions(entries: SyncRemoteEntry[]) { const seen = new Map<string, string>(); for (const entry of entries) { if (entry.kind === "tombstone") continue; validateSyncPath(entry.path); const key = entry.path.normalize("NFC").toLocaleLowerCase("en-US"); const prior = seen.get(key); if (prior && prior !== entry.path) throw new Error(`Remote path collision: ${prior} and ${entry.path}`); seen.set(key, entry.path); } }
  private stateKey() { return `sync/${encodeURIComponent(this.vaultId())}`; }
  private async loadState(): Promise<SyncState> { return (await this.host.deviceState.read<SyncState>(this.stateKey())) ?? { approved: false, paused: false, baseline: {}, journal: [], scope: { ...DEFAULT_SYNC_SCOPE, excludedFolders: [] } }; }
  private saveState(state: SyncState) { return this.host.deviceState.write(this.stateKey(), state); }
  private setStatus(status: SyncStatus) { this.status = status; this.trigger("status", this.getStatus()); }
}
