import { Events } from "../events";
import type { HostServices } from "../host/contracts";
import { SyncCoordinator } from "./coordinator";
import type { SyncApi, SyncConflict, SyncPreview, SyncProgress, SyncProgressPhase, SyncProvider, SyncRunResult, SyncStatus } from "./types";
import { SYNC_PROGRESS_THROTTLE_MS } from "./progress";
import { APPEND_ONLY_PROTOCOL, SYNC_MAX_FILE_BYTES, type AppendOnlySyncProvider, type AppendOnlySession, type VaultDescriptor } from "./history-types";
import { HistoryController, type HistoryComparisonChoice, type HistoryConflictComparison, type HistoryControllerState, type HistoryLocalResource, type HistoryLocalSnapshot, type HistoryOperation, type HistoryPreview, type HistoryResolution } from "./history-controller";
import { DEFAULT_SYNC_SCOPE, isPathInSyncScope, validateSyncPath, type SyncScope } from "./scope";
import { projectPortableConfig, serializePortableConfig } from "./portable-config";
import { buildHistoryPorts, type SyncHostLite } from "../../sync-core/ports";

type Provider = SyncProvider | AppendOnlySyncProvider;
interface BindingState { schema: 1; localRoot: string; providerId?: string; binding?: VaultDescriptor; deviceId: string; scope: SyncScope; paused: boolean; createIntent?: { name: string; operationId: string } }
const hash = async (data: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(value => value.toString(16).padStart(2, "0")).join("");
const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).buffer;
const isHistory = (provider: Provider): provider is AppendOnlySyncProvider => "protocol" in provider && provider.protocol === APPEND_ONLY_PROTOCOL;

/** Host-owned lifecycle facade; conditional transports retain their original API. */
export class SyncService extends Events implements SyncApi {
  private readonly conditional: SyncCoordinator;
  private readonly providers = new Map<string, Provider>();
  private selected?: AppendOnlySyncProvider;
  private status: SyncStatus = { state: "disconnected", conflicts: 0 };
  private details?: HistoryPreview;
  private abort?: AbortController;
  private running?: Promise<unknown>;
  private session?: AppendOnlySession;
  /** The bound shared vault's own name (VaultDescriptor.name), cached from load()/save() so the renderer can read it synchronously — distinct from getActiveProvider().name, which is the transport/provider name. */
  private boundVaultName?: string;
  private lease?: string;
  private generation = 0;
  private debounce?: ReturnType<typeof setTimeout>;
  private polling?: ReturnType<typeof setInterval>;
  private retryDelay = 2000;
  /**
   * Consecutive runs that ended in failure, sharing `retryDelay`'s exact
   * lifecycle: both grow in the retry catch and both reset once a run completes.
   * It is deliberately *not* progress state — `endProgress()` runs in
   * `withController`'s finally, so anything kept there dies with each attempt,
   * which is precisely how a retry loop came to look like one slow first try.
   */
  private failedRuns = 0;
  private stopObserving?: () => void;
  private renameHints = new Map<string, string>();
  private observedRoot?: string;
  private setupTarget?: Provider;
  // Existing conditional hydration settles first; later registrations cannot
  // select a second protocol while the append binding is being persisted.
  private appendSetupReady = false;
  private closing = false;
  private cancellations = 0;
  constructor(private readonly host: HostServices, private readonly vaultId: () => string, private readonly portableChanged: () => Promise<void> = async () => {}) {
    super(); this.conditional = new SyncCoordinator(host, vaultId, Date.now, () => !this.selected && !this.closing && !this.cancellations && !(this.setupTarget && isHistory(this.setupTarget) && this.appendSetupReady));
    this.conditional.on("status", status => { if (!this.selected) this.trigger("status", status); });
  }
  private observe() {
    if (this.observedRoot !== this.vaultId()) { this.renameHints.clear(); this.observedRoot = this.vaultId(); }
    this.stopObserving ??= this.host.vaultFiles.onChange(event => {
      if (event.renamedFrom) { const original = this.renameHints.get(event.renamedFrom) ?? event.renamedFrom; this.renameHints.delete(event.renamedFrom); this.renameHints.set(event.path, original); }
      if (!event.mutationId) this.schedule();
    });
  }
  register(owner: string, provider: Provider): () => Promise<void> {
    if (!provider.id || this.providers.has(provider.id)) throw new Error("Sync provider already registered");
    if (isHistory(provider)) {
      const c = provider.capabilities;
      if (!c.binary || c.conditionalWrites || !c.appendOnly || !c.delta || c.maxFileSize !== SYNC_MAX_FILE_BYTES || !this.host.syncSafety) throw new Error("Append-only sync requires guarded desktop support and the 100 MiB contract");
    }
    const unregister = isHistory(provider) ? undefined : this.conditional.register(owner, provider);
    this.providers.set(provider.id, provider);
    if (isHistory(provider) && !this.closing && !this.cancellations && !this.running && !this.selected) {
      const root = this.vaultId(), generation = this.generation;
      void this.restore(provider).catch(error => {
        if (this.providers.get(provider.id) !== provider || root !== this.vaultId() || generation !== this.generation) return;
        this.setStatus({ state: "error", providerId: provider.id, conflicts: 0, message: error instanceof Error ? error.message : "Reconnect required" }); this.schedule(this.retryDelay);
      });
    }
    // Clearing details alongside selected matters beyond bookkeeping: getHistoryDetails()
    // is rendered unconditionally in the Sync tab (not gated on isAppendOnly()) so the
    // plain/conditional path can show blocked/excluded issues too — leaving stale details
    // behind here would keep painting this unloaded provider's old blocked-file groups forever.
    return async () => { if (this.providers.get(provider.id) !== provider) return; if (this.selected === provider || this.setupTarget === provider) { await this.cancel(); if (this.selected === provider) { this.selected = undefined; this.details = undefined; } this.setStatus({ state: "error", conflicts: 0, providerId: provider.id, message: "Sync provider unloaded; reconnect explicitly" }); } this.providers.delete(provider.id); await unregister?.(); };
  }
  listProviders() { return [...this.providers.values()].map(provider => ({ id: provider.id, name: provider.name, ...(isHistory(provider) ? { protocol: provider.protocol } : {}) })); }
  getActiveProvider() { return this.selected ? { id: this.selected.id, name: this.selected.name } : this.conditional.getActiveProvider(); }
  getStatus() { return this.selected || this.status.state === "error" && this.status.providerId && !this.conditional.getActiveProvider() ? { ...this.status } : this.conditional.getStatus(); }
  getHistoryDetails() { return this.details; }
  isAppendOnly() { return Boolean(this.selected); }
  getBoundVaultName() { return this.boundVaultName; }
  /**
   * Any state change ends the run being reported, so progress is dropped here
   * rather than at each call site. A stale "47%" surviving a failure is its own
   * bug, and there are eleven setStatus() callers to forget.
   */
  private setStatus(status: SyncStatus) { this.cancelProgress(); this.status = status; this.trigger("status", status); }
  private progressStartedAt = 0;
  private progressEmittedAt = 0;
  private progressPhase?: SyncProgressPhase;
  private progressPending?: SyncProgress;
  private progressTimer?: ReturnType<typeof setTimeout>;
  /** Drops any in-flight throttle without emitting, so a deferred tick cannot land after a run ends. */
  private cancelProgress() {
    if (this.progressTimer) clearTimeout(this.progressTimer);
    this.progressTimer = undefined; this.progressPending = undefined; this.progressPhase = undefined; this.progressStartedAt = 0; this.progressEmittedAt = 0;
  }
  /** Ends a run's progress display, telling subscribers once so nothing is left painted on screen. */
  private endProgress() {
    const had = Boolean(this.status.progress);
    this.cancelProgress();
    if (!had) return;
    this.status = { ...this.status, progress: undefined };
    this.trigger("status", this.status);
  }
  /**
   * Rate-limits the controller's ticks onto the status bus. A phase change is
   * always emitted immediately — it is the cheapest possible signal that the run
   * moved on — and anything held back is emitted by a trailing timer, so the
   * last tick of a batch is never the one that gets swallowed.
   */
  private publishProgress(progress: SyncProgress) {
    const now = Date.now();
    if (!this.progressPhase) this.progressStartedAt = now;
    const elapsed = now - this.progressEmittedAt;
    this.progressPending = progress;
    if (progress.phase !== this.progressPhase || elapsed >= SYNC_PROGRESS_THROTTLE_MS) { this.progressPhase = progress.phase; this.flushProgress(now); return; }
    this.progressPhase = progress.phase;
    this.progressTimer ??= setTimeout(() => { this.progressTimer = undefined; this.flushProgress(Date.now()); }, Math.max(0, SYNC_PROGRESS_THROTTLE_MS - elapsed));
  }
  private flushProgress(now: number) {
    const pending = this.progressPending;
    if (!pending) return;
    this.progressPending = undefined;
    if (this.progressTimer) { clearTimeout(this.progressTimer); this.progressTimer = undefined; }
    this.progressEmittedAt = now;
    this.status = { ...this.status, progress: { ...pending, startedAt: this.progressStartedAt, lastProgressAt: now, attempt: this.failedRuns + 1 } };
    this.trigger("status", this.status);
  }
  private key(root = this.vaultId()) { return `sync-history-binding/${root}`; }
  private async load(): Promise<BindingState> {
    const root = this.vaultId(); const value = await this.host.deviceState.read<BindingState>(this.key(root));
    if (this.vaultId() !== root) throw new Error("Vault changed");
    if (value && (value.schema !== 1 || value.localRoot !== root)) throw new Error("Experimental sync state requires reconnect and preview");
    const state = value ?? { schema: 1, localRoot: root, deviceId: crypto.randomUUID(), scope: { ...DEFAULT_SYNC_SCOPE, excludedFolders: [] }, paused: false };
    this.boundVaultName = state.binding?.name; return state;
  }
  private async save(value: BindingState) { const root = value.localRoot; if (this.vaultId() !== root) throw new Error("Vault changed"); await this.host.deviceState.write(this.key(root), value); if (this.vaultId() !== root) throw new Error("Vault changed"); this.boundVaultName = value.binding?.name; }
  private async restore(provider: AppendOnlySyncProvider): Promise<void> {
    const root = this.vaultId(); const generation = this.generation; const state = await this.load();
    await this.conditional.waitUntilReady();
    if (this.vaultId() !== root || this.generation !== generation || this.selected || this.running || this.closing || this.cancellations || this.conditional.getActiveProvider() || state.providerId !== provider.id || this.providers.get(provider.id) !== provider) return;
    this.selected = provider; this.observe();
    if (state.paused) { this.setStatus({ state: "paused", providerId: provider.id, conflicts: 0 }); return; }
    if (!state.binding) { this.setStatus({ state: "preview", providerId: provider.id, conflicts: 0, message: "Create or join a shared vault" }); return; }
    let resumed = false;
    const preview = await this.withController(async (controller, signal) => {
      const current = await controller.getState(signal);
      if (current.approved) { resumed = true; return controller.run({}, signal); }
      return controller.preview(signal);
    });
    this.summarize(preview);
    if (resumed) { this.polling ??= setInterval(() => this.schedule(0), 30_000); if (this.status.state === "pending") this.schedule(0); }
  }
  async activate(id: string): Promise<void> {
    const provider = this.providers.get(id); if (!provider) throw new Error("Unknown sync provider");
    if (!isHistory(provider)) { if (this.selected) throw new Error("Disconnect before changing providers"); return this.setup(async (_signal, assert) => { await this.conditional.waitUntilReady(); assert(); await this.conditional.activate(id); assert(); }, provider); }
    if (this.conditional.getActiveProvider() || this.selected && this.selected !== provider) throw new Error("Disconnect before changing providers");
    return this.setup(async (_signal, assert) => {
    await this.conditional.waitUntilReady(); assert(); this.appendSetupReady = true; if (this.conditional.getActiveProvider()) throw new Error("Disconnect before changing providers");
    const state = await this.load(); assert();
    if (state.providerId && state.providerId !== id) throw new Error("Disconnect before changing providers");
    state.providerId = id; await this.save(state); assert(); this.selected = provider; this.observe();
    this.setStatus({ state: "preview", providerId: id, conflicts: 0, message: state.binding ? "Review a fresh preview before resuming this experimental binding" : "Create or join a shared vault" });
    }, provider);
  }
  async discoverVaults(): Promise<VaultDescriptor[]> {
    const provider = this.selected; if (!provider) throw new Error("Select an append-only provider");
    return this.setup(async (signal, assert) => { const result = await provider.discover(signal); assert(); return result; });
  }
  private async setup<T>(action: (signal: AbortSignal, assert: () => void) => Promise<T>, target: Provider | undefined = this.selected): Promise<T> {
    if (this.running || this.closing || this.cancellations) throw new Error("Sync already running or disconnecting");
    this.generation++;
    const root = this.vaultId(); const generation = this.generation; const provider = this.selected; const abort = new AbortController(); this.abort = abort;
    const registered = target && this.providers.get(target.id) === target; this.setupTarget = target;
    const assert = () => { if (abort.signal.aborted || root !== this.vaultId() || generation !== this.generation || provider !== this.selected || registered && this.providers.get(target!.id) !== target) throw new Error("Sync context changed"); };
    const work = action(abort.signal, assert); this.running = work;
    try { return await work; } finally { if (this.running === work) { this.running = undefined; this.setupTarget = undefined; this.appendSetupReady = false; } if (this.abort === abort) this.abort = undefined; }
  }
  async createVault(name: string): Promise<void> {
    const provider = this.selected; if (!provider) throw new Error("Select an append-only provider");
    return this.setup(async (signal, assert) => {
    const state = await this.load(); assert(); if (state.binding) throw new Error("Disconnect before creating another shared vault");
    if (!name.trim()) throw new Error("Shared vault name required");
    state.createIntent ??= { name: name.trim(), operationId: crypto.randomUUID() };
    await this.save(state); assert();
    this.lease ??= await this.host.syncSafety!.claimOwner() ?? undefined;
    assert();
    if (!this.lease) throw new Error("Another window owns sync for this vault");
    const binding = await provider.createVault(state.createIntent, signal); assert();
    this.validateBinding(binding); state.binding = binding; delete state.createIntent; await this.save(state);
    this.setStatus({ state: "preview", providerId: provider.id, conflicts: 0, message: "Shared vault created. Preview before approving sync." });
    });
  }
  async joinVault(binding: VaultDescriptor): Promise<void> {
    const provider = this.selected; if (!provider) throw new Error("Select an append-only provider");
    return this.setup(async (signal, assert) => {
    this.validateBinding(binding); const discovered = await provider.discover(signal); assert();
    if (!discovered.some(item => JSON.stringify(item) === JSON.stringify(binding))) throw new Error("Shared vault descriptor changed; discover again");
    const state = await this.load(); assert(); if (state.binding) throw new Error("Disconnect before joining another shared vault");
    state.binding = binding; await this.save(state); assert(); this.setStatus({ state: "preview", providerId: provider.id, conflicts: 0, message: "Joined shared vault. Local absence will not delete remote files; review preview." });
    });
  }
  private validateBinding(binding: VaultDescriptor) {
    if (binding.schema !== 1 || binding.protocol !== APPEND_ONLY_PROTOCOL || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(binding.vaultId) || !binding.rootId || !binding.descriptorId || !binding.name) throw new Error("Invalid shared vault descriptor");
  }
  async getScope() { return this.selected ? (await this.load()).scope : this.conditional.getScope(); }
  async updateScope(patch: Partial<SyncScope>) {
    if (!this.selected) return this.withConditional(() => this.conditional.updateScope(patch));
    if (patch.communityPlugins || patch.communityPluginData) throw new Error("Community plugin configuration is excluded from immutable sync");
    for (const path of patch.excludedFolders ?? []) validateSyncPath(path);
    const root = this.vaultId(); await this.cancel(); if (root !== this.vaultId()) throw new Error("Vault changed");
    return this.setup(async (_signal, assert) => {
      const state = await this.load(); assert(); state.scope = { ...state.scope, ...patch, communityPlugins: false, communityPluginData: false }; await this.save(state); assert(); this.details = undefined; this.observe(); this.setStatus({ state: "preview", providerId: this.selected?.id, conflicts: 0, message: "Scope changed. Preview before syncing." });
    });
  }
  /** Narrow adapter over HostServices for the platform-neutral history engine (src/sync-core). */
  private liteHost(): SyncHostLite {
    const host = this.host;
    return {
      vault: { reconcileScan: () => host.vaultFiles.reconcileScan(), readBinary: path => host.vaultFiles.readBinary(path) },
      hashCache: host.hashCache && { readAll: () => host.hashCache!.readAll(), upsertBatch: entries => host.hashCache!.upsertBatch(entries), prune: keep => host.hashCache!.prune(keep) },
      deviceState: { read: key => host.deviceState.read(key), write: (key, value) => host.deviceState.write(key, value) },
      safety: { storage: (token, binding, request) => host.syncSafety!.storage(token, binding, request), apply: (token, input) => host.syncSafety!.apply(token, input) },
      portableConfig: {
        project: async scope => (await projectPortableConfig(host.config, scope)).map(document => ({
          name: document.name,
          data: serializePortableConfig(document),
          isInitialDefault: async () => {
            const source = document.name === "hotkeys.json" ? "hotkeys" : document.name === "daily-notes.json" ? "daily-notes" : "app";
            const raw = await host.config.read(source);
            return !raw || typeof raw !== "object" || !Object.keys(document.value).some(field => Object.prototype.hasOwnProperty.call(raw, field));
          },
        })),
      },
    };
  }
  /** @param silent read-only work that must not publish its failure as global sync status. */
  private async withController<T>(operation: (controller: HistoryController, signal: AbortSignal) => Promise<T>, silent = false): Promise<T> {
    if (this.running || this.closing || this.cancellations) throw new Error("Sync already running or disconnecting");
    const provider = this.selected; if (!provider) throw new Error("Select a provider");
    const root = this.vaultId(); const generation = this.generation; const abort = new AbortController(); this.abort = abort;
    const assertContext = () => { if (abort.signal.aborted || this.vaultId() !== root || generation !== this.generation || this.selected !== provider || this.providers.get(provider.id) !== provider) throw new DOMException("Sync context changed", "AbortError"); };
    const work = (async () => {
      const state = await this.load(); assertContext(); if (!state.binding) throw new Error("Create or join a shared vault before preview"); if (state.paused) throw new Error("Sync is paused");
      this.lease ??= await this.host.syncSafety!.claimOwner() ?? undefined; assertContext(); if (!this.lease) throw new Error("Another window owns sync for this vault");
      const lease = this.lease; const bindingKey = await hash(encoded([provider.id, state.binding])); assertContext();
      const stateKey = `sync-history/${root}/${bindingKey}`;
      const { ports, storage } = buildHistoryPorts(this.liteHost(), { provider, scope: state.scope, bindingVaultId: state.binding.vaultId, bindingKey, stateKey, lease, assertContext, renameHints: this.renameHints, portableChanged: this.portableChanged });
      // Reclaim staged bytes no live 'prepared' operation or durable pendingBatch can need
      // (crash orphans, pre-release leftovers) and stale sibling bindings. Housekeeping
      // only: a failure here must never block a sync, but a lost context must still abort.
      try {
        const pending = (await this.host.deviceState.read<{ pendingBatch?: string[] }>(stateKey))?.pendingBatch ?? []; assertContext();
        await storage({ action: "gc", retain: Array.isArray(pending) ? pending : [] });
        await storage({ action: "sweep", keep: [bindingKey], force: false });
      } catch { assertContext(); }
      this.session = await provider.open({ binding: state.binding, deviceId: state.deviceId }, abort.signal); assertContext();
      const controller = new HistoryController({ vaultId: state.binding.vaultId, deviceId: state.deviceId, bindingKey, session: this.session, ports,
      // Progress from a run whose vault, provider or generation has moved on is
      // dropped silently rather than asserted: this is the one callback that must
      // never throw into the sync, and a late tick is simply not news any more.
      progress: value => { if (!abort.signal.aborted && this.vaultId() === root && this.generation === generation && this.selected === provider) this.publishProgress(value); } });
      return operation(controller, abort.signal);
    })();
    this.running = work;
    let completed = false;
    try { const result = await work; completed = true; return result; }
    catch (error) { if (!silent && !abort.signal.aborted && root === this.vaultId() && generation === this.generation && this.selected === provider && this.status.state !== "paused") this.setStatus({ state: "error", providerId: provider.id, conflicts: this.details?.conflicts.length ?? 0, message: error instanceof Error ? error.message : "Sync unavailable" }); throw error; }
    // Cancellation reaches neither summarize() nor the error branch above — an
    // aborted run deliberately sets no status — so progress is retired here, on
    // the one path every completion, failure and cancellation passes through.
    finally { this.endProgress(); try { await this.session?.close(); } finally { this.session = undefined; if (this.running === work) this.running = undefined; if (this.abort === abort) this.abort = undefined; } if (completed) assertContext(); }
  }
  private summarize(value: HistoryPreview): SyncPreview {
    this.details = value;
    const outstanding = value.uploads + value.downloads + value.deletions;
    const integrityBlocked = !value.upToDate && !outstanding && !value.requiresApproval && !value.conflicts.length;
    // Per-file detail (path + reason for each blocked item) lives on `details.blocked`,
    // reachable via getHistoryDetails() — the message here stays a short summary so it
    // never turns into an unreadable semicolon-joined sentence for dozens of files.
    this.setStatus({ state: value.blocked.length || value.pending || integrityBlocked ? "error" : value.conflicts.length ? "conflict" : value.requiresApproval ? "preview" : outstanding ? "pending" : "idle", providerId: this.selected?.id, conflicts: value.conflicts.length, message: value.blocked.length ? `${value.blocked.length} file(s) blocked` : value.pending ? `${value.pending} pending history dependencies` : integrityBlocked ? "Remote integrity or pending history blocks an up-to-date result" : outstanding ? `${outstanding} changes await synchronization` : value.excluded.length ? `${value.excluded.length} managed or excluded paths` : undefined });
    return { uploads: value.uploads, downloads: value.downloads, deletes: value.deletions, conflicts: value.conflicts.length, skipped: value.excluded.length + value.blocked.length, requiresApproval: value.requiresApproval };
  }
  private async withConditional<T>(action: () => Promise<T>): Promise<T> {
    const active = this.conditional.getActiveProvider();
    const target = active ? this.providers.get(active.id) : undefined;
    return this.setup(async (_signal, assert) => { await this.conditional.waitUntilReady(); assert(); if (this.selected) throw new Error("Disconnect before changing providers"); const result = await action(); assert(); return result; }, target);
  }
  async preview(): Promise<SyncPreview> { return this.selected ? this.summarize(await this.withController((controller, signal) => controller.preview(signal))) : this.withConditional(() => this.conditional.preview()); }
  async run(options: { approvePreview?: boolean } = {}): Promise<SyncRunResult> {
    if (!this.selected) return this.withConditional(() => this.conditional.run(options));
    const result = this.summarize(await this.withController((controller, signal) => controller.run(options, signal))); this.retryDelay = 2000; this.failedRuns = 0; this.renameHints.clear(); this.observe();
    this.polling ??= setInterval(() => this.schedule(0), 30_000); if (this.status.state === "pending") this.schedule(0); return result;
  }
  async listConflicts(): Promise<SyncConflict[]> {
    if (!this.selected) return this.conditional.listConflicts();
    return (this.details?.conflicts ?? []).map(conflict => ({ id: JSON.stringify([conflict.entityId, conflict.heads]), path: conflict.path, conflictPath: "", remoteRevision: conflict.heads.join(",") }));
  }
  async resolveHistoryConflict(resolution: HistoryResolution) { return this.summarize(await this.withController((controller, signal) => controller.resolve(resolution, signal))); }
  /**
   * Read-only comparison shares withController's single-owner invariants:
   * this.abort, this.session and this.lease are single-slot fields, so a second
   * controller running concurrently would overwrite the in-flight sync's abort
   * handle and close its session underneath it. Rather than weaken that, a
   * comparison lets the current work settle once and then takes the ordinary
   * guarded path (vaultId/generation/provider-identity checks, AbortError
   * semantics, cancellation on unload/vault switch/cancel()). If something else
   * claims the slot first, withController's existing "Sync already running or
   * disconnecting" error surfaces unchanged.
   */
  private async settled() {
    for (let attempt = 0; attempt < 4 && this.running; attempt++) {
      const current = this.running;
      await current.catch(() => {});
      // withController clears this.running inside a finally that first awaits
      // session close, so yield once before deciding the slot is still taken.
      if (this.running === current) await new Promise(resolve => setTimeout(resolve, 0));
      if (this.running === current) break;
    }
  }
  async describeHistoryConflict(entityId: string): Promise<HistoryConflictComparison> {
    if (!this.selected) throw new Error("Select an append-only provider");
    await this.settled();
    return this.withController((controller, signal) => controller.describeConflict(entityId, signal), true);
  }
  async readHistoryConflictText(entityId: string, choice: HistoryComparisonChoice): Promise<string> {
    if (!this.selected) throw new Error("Select an append-only provider");
    await this.settled();
    return this.withController((controller, signal) => controller.readConflictText(entityId, choice, signal), true);
  }
  async resolveConflict(id: string, resolution: "keep-local" | "accept-remote") {
    if (!this.selected) return this.withConditional(() => this.conditional.resolveConflict(id, resolution));
    if (resolution !== "keep-local") throw new Error("Choose an explicit immutable version to accept");
    const [entityId, heads] = JSON.parse(id); await this.resolveHistoryConflict({ entityId, heads, choice: { kind: "current" } });
  }
  async abandonPending() { return this.summarize(await this.withController((controller, signal) => controller.abandonPending(signal))); }
  private schedule(delay = 2000) {
    if (!this.selected || this.closing || this.cancellations || this.status.state === "paused" || this.status.state === "preview") return;
    const provider = this.selected, root = this.vaultId(), generation = this.generation;
    const current = () => this.selected === provider && this.vaultId() === root && this.generation === generation;
    clearTimeout(this.debounce); this.debounce = setTimeout(() => {
      if (!current() || this.closing || this.cancellations) return;
      if (this.running) { this.schedule(); return; }
      void this.run().catch(error => { if (!current() || error instanceof DOMException && error.name === "AbortError") return; this.setStatus({ state: "error", providerId: provider.id, conflicts: this.details?.conflicts.length ?? 0, message: error instanceof Error ? error.message : "Sync unavailable" }); this.failedRuns++; this.retryDelay = Math.min(this.retryDelay * 2, 60_000); this.schedule(this.retryDelay); });
    }, delay);
  }
  async cancel() { this.cancellations++; try { this.generation++; this.stopObserving?.(); this.stopObserving = undefined; clearTimeout(this.debounce); clearInterval(this.polling); this.polling = undefined; this.abort?.abort(); await this.conditional.cancel(); await this.running?.catch(() => {}); if (this.lease) await this.host.syncSafety?.releaseOwner(this.lease); this.lease = undefined; } finally { this.cancellations--; } }
  async disconnect() {
    if (this.closing) throw new Error("Sync is already disconnecting");
    this.closing = true;
    try { const root = this.vaultId(); const key = this.key(root); await this.cancel(); if (root !== this.vaultId()) throw new Error("Vault changed"); await this.host.deviceState.remove(key); if (root !== this.vaultId()) throw new Error("Vault changed"); await this.purgePrivateStorage(root); await this.conditional.disconnect(); if (root !== this.vaultId()) throw new Error("Vault changed"); this.selected = undefined; this.details = undefined; this.boundVaultName = undefined; this.setStatus({ state: "disconnected", conflicts: 0 }); }
    finally { this.closing = false; }
  }
  /** Best-effort: disconnect has already removed the device state that could resume these operations. */
  private async purgePrivateStorage(root: string) {
    const safety = this.host.syncSafety; if (!safety) return;
    try {
      const lease = await safety.claimOwner(); if (!lease) return;
      try { await safety.storage(lease, "0".repeat(64), { action: "sweep", keep: [], force: true }); } finally { await safety.releaseOwner(lease); }
    } catch { /* leftover bytes are reclaimed by the next sync's sweep */ }
    if (root !== this.vaultId()) throw new Error("Vault changed");
  }
  async pause() { if (!this.selected) return this.withConditional(() => this.conditional.pause()); const root = this.vaultId(); await this.cancel(); if (root !== this.vaultId()) throw new Error("Vault changed"); return this.setup(async (_signal, assert) => { const state = await this.load(); assert(); state.paused = true; await this.save(state); assert(); this.setStatus({ ...this.status, state: "paused" }); }); }
  async resume() { if (!this.selected) return this.withConditional(() => this.conditional.resume()); return this.setup(async (_signal, assert) => { const state = await this.load(); assert(); state.paused = false; await this.save(state); assert(); this.observe(); this.setStatus({ ...this.status, state: "preview", message: "Preview before resuming" }); }); }
}
