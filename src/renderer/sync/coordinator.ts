import { Events } from "../events";
import type { HostServices, VaultFileEntry } from "../host/contracts";
import { DEFAULT_SYNC_SCOPE, isPathInSyncScope, validateSyncPath, type SyncScope } from "./scope";
import type { SyncApi, SyncConflict, SyncPreview, SyncProvider, SyncRemoteEntry, SyncRunResult, SyncSession, SyncStatus } from "./types";

interface BaselineEntry { path: string; localFingerprint: string; remoteId: string; remoteRevision: string; kind: "file" | "folder"; }
interface SyncState { stateKey: string; vaultId: string; providerId?: string; cursor?: string; approved: boolean; paused: boolean; previewSignature?: string; baseline: Record<string, BaselineEntry>; remoteIndex: Record<string, SyncRemoteEntry>; conflicts: Record<string, { remote: SyncRemoteEntry; conflictPath: string }>; scope: SyncScope; journal: JournalOperation[]; }
interface JournalOperation { id: string; type: "upload" | "download" | "local-trash" | "remote-trash"; path: string; remote?: SyncRemoteEntry; localFingerprint?: string; phase: "prepared" | "applied"; }
interface Plan { uploads: VaultFileEntry[]; downloads: SyncRemoteEntry[]; localTrash: SyncRemoteEntry[]; remoteTrash: BaselineEntry[]; conflicts: Array<{ local?: VaultFileEntry; remote: SyncRemoteEntry }>; skipped: number; remoteEntries: SyncRemoteEntry[]; nextRemoteIndex: Record<string, SyncRemoteEntry>; expectedLocal: Record<string, string | undefined>; cursor?: string; }

const EMPTY_STATUS: SyncStatus = { state: "disconnected", conflicts: 0 };

export class SyncCoordinator extends Events implements SyncApi {
  private providers = new Map<string, { owner: string; provider: SyncProvider }>();
  private status: SyncStatus = EMPTY_STATUS;
  private activeAbort?: AbortController;
  private activeSession?: SyncSession;
  private running?: Promise<unknown>;
  private operationClaimed = false;
  private activeRegistration?: { owner: string; provider: SyncProvider };
  private hydration: Promise<void> = Promise.resolve();
  constructor(private readonly host: HostServices, private readonly vaultId: () => string, private readonly now: () => number = Date.now) { super(); }

  register(owner: string, provider: SyncProvider): () => Promise<void> {
    if (!provider.id || this.providers.has(provider.id)) throw new Error(`Sync provider already registered: ${provider.id}`);
    this.validateCapabilities(provider);
    this.providers.set(provider.id, { owner, provider });
    this.hydration = this.hydration.then(() => this.hydrate());
    return () => this.unregister(provider.id, owner);
  }
  listProviders() { return [...this.providers.values()].map(({ provider }) => ({ id: provider.id, name: provider.name })); }
  getActiveProvider() { const found = this.status.providerId ? this.providers.get(this.status.providerId)?.provider : undefined; return found ? { id: found.id, name: found.name } : null; }
  getStatus() { return { ...this.status }; }
  async getScope(): Promise<SyncScope> { const state = await this.loadState(); return { ...state.scope, excludedFolders: [...state.scope.excludedFolders] }; }
  async updateScope(patch: Partial<SyncScope>): Promise<void> {
    const state = await this.loadState();
    const excludedFolders = patch.excludedFolders?.map(folder => folder.trim().replace(/\/$/, ""));
    if (excludedFolders) for (const folder of excludedFolders) validateSyncPath(folder);
    state.scope = { ...state.scope, ...patch, ...(excludedFolders ? { excludedFolders } : {}) };
    state.approved = false;
    state.previewSignature = undefined;
    await this.saveState(state);
  }
  async listConflicts(): Promise<SyncConflict[]> { const state = await this.loadState(); return Object.entries(state.conflicts).map(([id, conflict]) => ({ id, path: conflict.remote.path, conflictPath: conflict.conflictPath, remoteRevision: conflict.remote.revision })); }
  async resolveConflict(id: string, resolution: "keep-local" | "accept-remote"): Promise<void> {
    return this.withSession(async (session, state, signal, vaultId) => {
      const conflict = state.conflicts[id]; if (!conflict) throw new Error("Unknown sync conflict");
      const opId = this.operationId(); let remote = conflict.remote;
      const before = await this.currentFingerprint(remote.path); this.assertContext(signal, vaultId);
      const scan = await session.scan(undefined, signal); this.assertContext(signal, vaultId);
      if (scan.status !== "complete" || scan.mode !== "snapshot") throw new Error("Conflict resolution requires a complete current snapshot");
      const current = scan.entries.find(entry => entry.id === remote.id && entry.kind !== "tombstone");
      if (remote.kind === "tombstone" ? Boolean(current) : !current || current.revision !== remote.revision) throw new Error("Remote conflict changed; sync again before resolving");
      if (remote.kind === "tombstone") {
        if (resolution === "keep-local") {
          const bytes = await this.host.vaultFiles.readBinary(remote.path); const fingerprint = await this.hash(bytes); this.assertContext(signal, vaultId);
          remote = await session.create({ path: remote.path, data: bytes, operationKey: opId, signal }); this.assertContext(signal, vaultId);
          state.baseline[remote.path] = { path: remote.path, localFingerprint: fingerprint, remoteId: remote.id, remoteRevision: remote.revision, kind: "file" };
          state.remoteIndex[remote.id] = remote;
        } else {
          if (await this.currentFingerprint(remote.path) !== before) throw new Error("Local conflict changed; try resolving again");
          this.assertContext(signal, vaultId); if (before !== undefined) await this.host.vaultFiles.trash(remote.path, opId); this.assertContext(signal, vaultId);
          delete state.baseline[remote.path]; delete state.remoteIndex[remote.id];
        }
        delete state.conflicts[id]; await this.saveState(state);
        this.setStatus({ state: Object.keys(state.conflicts).length ? "conflict" : "idle", providerId: state.providerId, conflicts: Object.keys(state.conflicts).length });
        return;
      }
      let fingerprint: string;
      if (resolution === "accept-remote") {
        const bytes = await session.read(remote, signal); fingerprint = await this.hash(bytes); this.assertContext(signal, vaultId);
        if (await this.currentFingerprint(remote.path) !== before) throw new Error("Local conflict changed; try resolving again");
        this.assertContext(signal, vaultId);
        await this.host.vaultFiles.writeBinary(remote.path, bytes, undefined, opId); this.assertContext(signal, vaultId);
      } else {
        if (before === undefined) {
          await session.trash({ id: remote.id, expectedRevision: remote.revision, signal }); this.assertContext(signal, vaultId);
          delete state.baseline[remote.path]; delete state.remoteIndex[remote.id]; delete state.conflicts[id]; await this.saveState(state);
          this.setStatus({ state: Object.keys(state.conflicts).length ? "conflict" : "idle", providerId: state.providerId, conflicts: Object.keys(state.conflicts).length }); return;
        }
        const bytes = await this.host.vaultFiles.readBinary(remote.path); fingerprint = await this.hash(bytes); this.assertContext(signal, vaultId);
        remote = await session.update({ id: remote.id, path: remote.path, data: bytes, expectedRevision: remote.revision, operationKey: opId, signal }); this.assertContext(signal, vaultId);
      }
      const canonical = (await this.host.vaultFiles.list()).find(entry => entry.path === remote.path);
      if (!canonical) throw new Error("Canonical conflict file is missing");
      state.baseline[remote.path] = { path: remote.path, localFingerprint: fingerprint, remoteId: remote.id, remoteRevision: remote.revision, kind: "file" };
      state.remoteIndex[remote.id] = remote;
      // Preserve the conflict copy: it may have been edited manually while resolving.
      delete state.conflicts[id]; await this.saveState(state);
      this.setStatus({ state: Object.keys(state.conflicts).length ? "conflict" : "idle", providerId: state.providerId, conflicts: Object.keys(state.conflicts).length });
    });
  }
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

  async disconnect(): Promise<void> { await this.cancel(); const state = await this.loadState(); delete state.providerId; state.approved = false; state.cursor = undefined; state.baseline = {}; state.remoteIndex = {}; state.conflicts = {}; state.journal = []; await this.saveState(state); this.setStatus(EMPTY_STATUS); }
  async pause(): Promise<void> { await this.cancel(); const state = await this.loadState(); state.paused = true; await this.saveState(state); this.setStatus({ ...this.status, state: "paused" }); }
  async resume(): Promise<void> { const state = await this.loadState(); state.paused = false; await this.saveState(state); this.setStatus({ ...this.status, state: state.providerId ? "idle" : "disconnected" }); }
  async cancel(): Promise<void> { this.activeAbort?.abort(); await this.running?.catch(() => undefined); await this.activeSession?.close().catch(() => undefined); this.activeAbort = undefined; this.activeSession = undefined; }

  async preview(): Promise<SyncPreview> {
    const plan = await this.withSession(async (session, state, signal, vaultId) => { const next = await this.plan(session, state, signal, vaultId); state.previewSignature = this.planSignature(next); await this.saveState(state); return next; });
    const preview = this.toPreview(plan);
    this.setStatus({ state: "preview", providerId: this.status.providerId, conflicts: preview.conflicts });
    return preview;
  }

  async run(options: { approvePreview?: boolean } = {}): Promise<SyncRunResult> {
    return this.withSession(async (session, state, signal, vaultId) => {
      if (state.paused) throw new Error("Sync is paused");
      const plan = await this.plan(session, state, signal, vaultId);
      if (!state.approved && (!options.approvePreview || state.previewSignature !== this.planSignature(plan))) throw new Error("Preview this exact first sync before approving it");
      state.approved = true;
      state.previewSignature = undefined;
      this.setStatus({ state: "syncing", providerId: state.providerId, conflicts: 0 });
      await this.execute(session, state, plan, signal, vaultId);
      state.cursor = plan.cursor;
      state.remoteIndex = plan.nextRemoteIndex;
      await this.saveState(state);
      const result = { ...this.toPreview(plan), cursor: state.cursor };
      delete (result as Partial<SyncPreview>).requiresApproval;
      const unresolved = Object.keys(state.conflicts).length;
      this.setStatus({ state: unresolved ? "conflict" : "idle", providerId: state.providerId, conflicts: unresolved });
      return result as SyncRunResult;
    });
  }

  private async unregister(id: string, owner: string) { const registered = this.providers.get(id); if (!registered || registered.owner !== owner) return; this.providers.delete(id); const state = await this.loadState(); if (state.providerId === id) { await this.cancel(); this.setStatus({ state: "error", providerId: id, conflicts: 0, message: "Sync provider unloaded" }); } }
  private async withSession<T>(fn: (session: SyncSession, state: SyncState, signal: AbortSignal, vaultId: string) => Promise<T>): Promise<T> {
    if (this.operationClaimed) throw new Error("A sync operation is already running");
    this.operationClaimed = true;
    let work: Promise<T> | undefined;
    try {
      await this.hydration;
      const vaultId = this.vaultId();
      const state = await this.loadState(vaultId); this.assertVault(vaultId); const registration = state.providerId ? this.providers.get(state.providerId) : undefined;
      if (!registration) throw new Error("No sync provider is active");
      const provider = registration.provider;
      const controller = new AbortController(); this.activeAbort = controller;
      this.activeRegistration = registration;
      work = (async () => { const session = await provider.open({ vaultId }); this.assertContext(controller.signal, vaultId); this.activeSession = session; try { return await fn(session, state, controller.signal, vaultId); } finally { await session.close(); } })();
      this.running = work;
      try { return await work; } catch (error) { if (!controller.signal.aborted) this.setStatus({ state: "error", providerId: state.providerId, conflicts: Object.keys(state.conflicts).length, message: error instanceof Error ? error.message : String(error) }); throw error; }
      finally { if (this.running === work) this.running = undefined; this.activeAbort = undefined; this.activeSession = undefined; this.activeRegistration = undefined; }
    } finally {
      this.operationClaimed = false;
    }
  }

  private async plan(session: SyncSession, state: SyncState, signal: AbortSignal, vaultId: string): Promise<Plan> {
    const localScan = await this.host.vaultFiles.reconcileScan();
    this.assertContext(signal, vaultId);
    if (localScan.status !== "complete") throw new Error(`A complete local scan is required (${localScan.status})`);
    const remoteScan = await session.scan(state.cursor, signal);
    this.assertContext(signal, vaultId);
    if (remoteScan.status !== "complete") throw new Error(`A complete remote scan is required (${remoteScan.status})`);
    const capabilities = this.activeRegistration!.provider.capabilities;
    if (remoteScan.mode === "delta" && !capabilities.delta) throw new Error("Provider returned an unadvertised delta scan");
    if (remoteScan.mode === "snapshot" && !capabilities.completeSnapshots) throw new Error("Provider returned an unadvertised complete snapshot");
    if (!remoteScan.mode) throw new Error("Provider must declare snapshot or delta scan mode");
    for (const entry of localScan.entries) {
      if (isPathInSyncScope(entry.path, state.scope) && (entry.isFolder || this.isWithinLimit(entry.size))) {
        (entry as VaultFileEntry & { syncFingerprint: string }).syncFingerprint = entry.isFolder ? "folder" : await this.hash(await this.host.vaultFiles.readBinary(entry.path));
        this.assertContext(signal, vaultId);
      }
    }
    await this.recoverJournal(state, localScan.entries, remoteScan.entries, remoteScan.mode);
    const conflictCopies = new Set(Object.values(state.conflicts).map(conflict => conflict.conflictPath).filter(Boolean));
    const localAll = localScan.entries.filter(e => isPathInSyncScope(e.path, state.scope) && !conflictCopies.has(e.path) && !/\.sync-conflict-\d+/.test(e.path));
    const local = localAll.filter(e => !e.isFolder);
    const nextRemoteIndex = remoteScan.mode === "delta" ? { ...state.remoteIndex } : {};
    for (const change of remoteScan.entries) {
      if (change.kind === "tombstone") delete nextRemoteIndex[change.id];
      else nextRemoteIndex[change.id] = change;
    }
    const remote = [
      ...Object.values(nextRemoteIndex),
      ...(remoteScan.mode === "delta" ? remoteScan.entries.filter(entry => entry.kind === "tombstone") : []),
    ].filter(e => e.kind === "tombstone" || isPathInSyncScope(e.path, state.scope));
    this.rejectCollisions(remote);
    const byPath = new Map(remote.filter(e => e.kind !== "tombstone").map(e => [e.path, e]));
    const localByPath = new Map(localAll.map(e => [e.path, e]));
    const plan: Plan = { uploads: [], downloads: [], localTrash: [], remoteTrash: [], conflicts: [], skipped: 0, remoteEntries: remote, nextRemoteIndex, expectedLocal: {}, cursor: remoteScan.cursor };
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
      if (!localByPath.has(entry.path)) { const baseline = state.baseline[entry.path]; if (baseline) { if (entry.revision !== baseline.remoteRevision) plan.conflicts.push({ remote: entry }); else plan.remoteTrash.push(baseline); } else if (this.isWithinLimit(entry.size)) plan.downloads.push(entry); else plan.skipped++; }
    }
    for (const entry of plan.downloads) plan.expectedLocal[entry.path] = localByPath.has(entry.path) ? this.fingerprint(localByPath.get(entry.path)!) : undefined;
    return plan;
  }

  private async execute(session: SyncSession, state: SyncState, plan: Plan, signal: AbortSignal, vaultId: string) {
    for (const entry of plan.uploads) {
      this.assertContext(signal, vaultId); const op = await this.prepare(state, "upload", entry.path); const data = await this.host.vaultFiles.readBinary(entry.path); this.assertContext(signal, vaultId); const prior = state.baseline[entry.path];
      op.localFingerprint = await this.hash(data);
      if (op.localFingerprint !== this.fingerprint(entry)) throw new Error("Local file changed after preview; preview sync again");
      await this.saveState(state); this.assertContext(signal, vaultId);
      try {
        const remote = prior ? await session.update({ id: prior.remoteId, path: entry.path, data, expectedRevision: prior.remoteRevision, signal, operationKey: op.id }) : await session.create({ path: entry.path, data, signal, operationKey: op.id }); this.assertContext(signal, vaultId);
        plan.nextRemoteIndex[remote.id] = remote;
        state.baseline[entry.path] = { path: entry.path, localFingerprint: this.fingerprint(entry), remoteId: remote.id, remoteRevision: remote.revision, kind: "file" }; await this.ack(state, op);
      } catch (error) {
        if (!prior || !(error instanceof Error) || error.name !== "SyncPreconditionError") throw error;
        const refreshed = await session.scan(state.cursor, signal);
        this.assertContext(signal, vaultId);
        if (refreshed.status !== "complete") throw error;
        const current = refreshed.entries.find(remote => remote.id === prior.remoteId && remote.kind === "file");
        if (!current) throw error;
        plan.nextRemoteIndex[current.id] = current;
        plan.conflicts.push({ local: entry, remote: current }); await this.ack(state, op);
      }
    }
    for (const entry of plan.downloads) { this.assertContext(signal, vaultId); validateSyncPath(entry.path); const op = await this.prepare(state, "download", entry.path, entry); if (entry.kind === "folder") { await this.host.vaultFiles.mkdir(entry.path, op.id); this.assertContext(signal, vaultId); state.baseline[entry.path] = { path: entry.path, localFingerprint: "folder", remoteId: entry.id, remoteRevision: entry.revision, kind: "folder" }; await this.ack(state, op); continue; } const data = await session.read(entry, signal); this.assertContext(signal, vaultId); const beforeWrite = (await this.host.vaultFiles.list()).find(e => e.path === entry.path); const actual = await this.currentFingerprint(entry.path); this.assertContext(signal, vaultId); if (actual !== plan.expectedLocal[entry.path]) { plan.conflicts.push({ local: beforeWrite, remote: entry }); await this.ack(state, op); continue; } await this.host.vaultFiles.writeBinary(entry.path, data, undefined, op.id); this.assertContext(signal, vaultId); const stat = (await this.host.vaultFiles.list()).find(e => e.path === entry.path); if (stat) state.baseline[entry.path] = { path: entry.path, localFingerprint: await this.hash(data), remoteId: entry.id, remoteRevision: entry.revision, kind: "file" }; await this.ack(state, op); }
    for (const entry of plan.localTrash) { const path = entry.deletedPath ?? entry.path; const baseline = state.baseline[path]; const current = (await this.host.vaultFiles.list()).find(e => e.path === path); this.assertContext(signal, vaultId); if (!baseline || !current || await this.currentFingerprint(path) !== baseline.localFingerprint) { if (current) plan.conflicts.push({ local: current, remote: entry }); continue; } const op = await this.prepare(state, "local-trash", path, entry); if (await this.currentFingerprint(path) !== baseline.localFingerprint) { plan.conflicts.push({ local: current, remote: entry }); await this.ack(state, op); continue; } this.assertContext(signal, vaultId); await this.host.vaultFiles.trash(path, op.id); this.assertContext(signal, vaultId); delete state.baseline[path]; await this.ack(state, op); }
    for (const entry of plan.remoteTrash) { this.assertContext(signal, vaultId); const op = await this.prepare(state, "remote-trash", entry.path, { id: entry.remoteId, path: entry.path, kind: "file", revision: entry.remoteRevision }); if (await this.host.vaultFiles.exists(entry.path)) { await this.ack(state, op); throw new Error("Local file was restored; sync again"); } this.assertContext(signal, vaultId); await session.trash({ id: entry.remoteId, expectedRevision: entry.remoteRevision, signal }); this.assertContext(signal, vaultId); delete state.baseline[entry.path]; delete plan.nextRemoteIndex[entry.remoteId]; await this.ack(state, op); }
    for (const conflict of plan.conflicts) {
      const conflictId = `${conflict.remote.id}:${conflict.remote.revision}:${conflict.remote.path}`;
      if (state.conflicts[conflictId]) continue;
      if (conflict.remote.kind === "tombstone") {
        state.conflicts[conflictId] = { remote: conflict.remote, conflictPath: "" };
        await this.saveState(state); continue;
      }
      if (conflict.remote.kind !== "file") throw new Error("Cannot reconcile a folder conflict automatically");
      const bytes = await session.read(conflict.remote, signal); this.assertContext(signal, vaultId);
      let conflictPath = this.conflictPath(conflict.remote.path); let suffix = 2;
      while (await this.host.vaultFiles.exists(conflictPath)) conflictPath = this.conflictPath(conflict.remote.path).replace(/(\.[^./]+)?$/, `-${suffix++}$1`);
      await this.host.vaultFiles.writeBinary(conflictPath, bytes, undefined, this.operationId()); this.assertContext(signal, vaultId);
      state.conflicts[conflictId] = { remote: conflict.remote, conflictPath };
      await this.saveState(state);
    }
  }

  private fingerprint(entry: VaultFileEntry) { return (entry as VaultFileEntry & { syncFingerprint?: string }).syncFingerprint ?? (entry.isFolder ? "folder" : "unknown"); }
  private async hash(bytes: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  private async currentFingerprint(path: string): Promise<string | undefined> {
    if (!await this.host.vaultFiles.exists(path)) return undefined;
    const entry = (await this.host.vaultFiles.list()).find(item => item.path === path);
    return entry?.isFolder ? "folder" : await this.hash(await this.host.vaultFiles.readBinary(path));
  }
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
        if (uploaded && localEntry) { state.baseline[op.path] = { path: op.path, localFingerprint: op.localFingerprint ?? "unknown", remoteId: uploaded.id, remoteRevision: uploaded.revision, kind: "file" }; state.journal = state.journal.filter(candidate => candidate.id !== op.id); changed = true; }
      } else if (op.type === "local-trash" && !localByPath.has(op.path)) {
        delete state.baseline[op.path]; state.journal = state.journal.filter(candidate => candidate.id !== op.id); changed = true;
      } else if (op.type === "remote-trash" && mode === "snapshot" && op.remote && !remoteById.has(op.remote.id)) {
        delete state.baseline[op.path]; state.journal = state.journal.filter(candidate => candidate.id !== op.id); changed = true;
      }
    }
    if (changed) await this.saveState(state);
  }
  private planSignature(plan: Plan) { return JSON.stringify({ cursor: plan.cursor, uploads: plan.uploads.map(e => [e.path, this.fingerprint(e)]), downloads: plan.downloads.map(e => [e.id, e.revision, e.path]), localTrash: plan.localTrash.map(e => [e.id, e.revision]), remoteTrash: plan.remoteTrash.map(e => [e.remoteId, e.remoteRevision]), conflicts: plan.conflicts.map(e => [e.local?.path, e.remote.id, e.remote.revision]) }); }
  private assertActive(signal: AbortSignal) { if (signal.aborted) throw new DOMException("Sync cancelled", "AbortError"); }
  private assertContext(signal: AbortSignal, vaultId: string) { this.assertActive(signal); if (this.vaultId() !== vaultId) throw new DOMException("Vault changed during sync", "AbortError"); const registration = this.activeRegistration; if (!registration || this.providers.get(registration.provider.id) !== registration) throw new DOMException("Sync provider changed during sync", "AbortError"); }
  private toPreview(plan: Plan): SyncPreview { return { uploads: plan.uploads.length, downloads: plan.downloads.length, deletes: plan.localTrash.length + plan.remoteTrash.length, conflicts: plan.conflicts.length, skipped: plan.skipped, requiresApproval: true }; }
  private validateCapabilities(provider: SyncProvider) { const c = provider.capabilities; if (!c.binary || !c.conditionalWrites || (!c.delta && !c.completeSnapshots) || !c.atomicMoves || !c.trash) throw new Error(`Sync provider ${provider.id} does not meet Geode's safety contract`); }
  private rejectCollisions(entries: SyncRemoteEntry[]) { const seen = new Map<string, SyncRemoteEntry>(); for (const entry of entries) { if (entry.kind === "tombstone") continue; validateSyncPath(entry.path); const key = entry.path.normalize("NFC").toLocaleLowerCase("en-US"); const prior = seen.get(key); if (prior) throw new Error(`Remote path collision: ${prior.path} (${prior.kind}) and ${entry.path} (${entry.kind})`); seen.set(key, entry); } }
  private stateKey(vaultId: string) { return `sync/${encodeURIComponent(vaultId)}`; }
  private async loadState(vaultId = this.vaultId()): Promise<SyncState> { const stateKey = this.stateKey(vaultId); const stored = await this.host.deviceState.read<Partial<SyncState>>(stateKey); return { approved: false, paused: false, baseline: {}, remoteIndex: {}, conflicts: {}, journal: [], scope: { ...DEFAULT_SYNC_SCOPE, excludedFolders: [] }, ...stored, stateKey, vaultId }; }
  private async saveState(state: SyncState) { this.assertVault(state.vaultId); await this.host.deviceState.write(state.stateKey, state); this.assertVault(state.vaultId); }
  private assertVault(vaultId: string) { if (this.vaultId() !== vaultId) throw new DOMException("Vault changed during sync", "AbortError"); }
  private async hydrate() { const vaultId = this.vaultId(); const state = await this.loadState(vaultId); if (this.vaultId() !== vaultId) return; this.setStatus(state.providerId ? { state: state.paused ? "paused" : "idle", providerId: state.providerId, conflicts: Object.keys(state.conflicts).length } : EMPTY_STATUS); }
  private setStatus(status: SyncStatus) { this.status = status; this.trigger("status", this.getStatus()); }
}
