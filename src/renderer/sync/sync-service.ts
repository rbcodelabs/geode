import { Events } from "../events";
import type { HostServices } from "../host/contracts";
import { SyncCoordinator } from "./coordinator";
import type { SyncApi, SyncConflict, SyncPreview, SyncProvider, SyncRunResult, SyncStatus } from "./types";
import { APPEND_ONLY_PROTOCOL, SYNC_MAX_FILE_BYTES, type AppendOnlySyncProvider, type AppendOnlySession, type VaultDescriptor } from "./history-types";
import { HistoryController, type HistoryControllerState, type HistoryLocalResource, type HistoryLocalSnapshot, type HistoryOperation, type HistoryPreview, type HistoryResolution } from "./history-controller";
import { DEFAULT_SYNC_SCOPE, isPathInSyncScope, validateSyncPath, type SyncScope } from "./scope";
import { projectPortableConfig, serializePortableConfig } from "./portable-config";
import { isPortableAssetPath } from "../../shared/portable-assets";

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
  private lease?: string;
  private generation = 0;
  private debounce?: ReturnType<typeof setTimeout>;
  private polling?: ReturnType<typeof setInterval>;
  private retryDelay = 2000;
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
    if (isHistory(provider)) {
      const root = this.vaultId(), generation = this.generation;
      void this.restore(provider).catch(error => {
        if (this.providers.get(provider.id) !== provider || root !== this.vaultId() || generation !== this.generation) return;
        this.setStatus({ state: "error", providerId: provider.id, conflicts: 0, message: error instanceof Error ? error.message : "Reconnect required" }); this.schedule(this.retryDelay);
      });
    }
    return async () => { if (this.providers.get(provider.id) !== provider) return; if (this.selected === provider || this.setupTarget === provider) { await this.cancel(); if (this.selected === provider) this.selected = undefined; this.setStatus({ state: "error", conflicts: 0, providerId: provider.id, message: "Sync provider unloaded; reconnect explicitly" }); } this.providers.delete(provider.id); await unregister?.(); };
  }
  listProviders() { return [...this.providers.values()].map(provider => ({ id: provider.id, name: provider.name, ...(isHistory(provider) ? { protocol: provider.protocol } : {}) })); }
  getActiveProvider() { return this.selected ? { id: this.selected.id, name: this.selected.name } : this.conditional.getActiveProvider(); }
  getStatus() { return this.selected || this.status.state === "error" && this.status.providerId && !this.conditional.getActiveProvider() ? { ...this.status } : this.conditional.getStatus(); }
  getHistoryDetails() { return this.details; }
  isAppendOnly() { return Boolean(this.selected); }
  private setStatus(status: SyncStatus) { this.status = status; this.trigger("status", status); }
  private key(root = this.vaultId()) { return `sync-history-binding/${root}`; }
  private async load(): Promise<BindingState> {
    const root = this.vaultId(); const value = await this.host.deviceState.read<BindingState>(this.key(root));
    if (this.vaultId() !== root) throw new Error("Vault changed");
    if (value && (value.schema !== 1 || value.localRoot !== root)) throw new Error("Experimental sync state requires reconnect and preview");
    return value ?? { schema: 1, localRoot: root, deviceId: crypto.randomUUID(), scope: { ...DEFAULT_SYNC_SCOPE, excludedFolders: [] }, paused: false };
  }
  private async save(value: BindingState) { const root = value.localRoot; if (this.vaultId() !== root) throw new Error("Vault changed"); await this.host.deviceState.write(this.key(root), value); if (this.vaultId() !== root) throw new Error("Vault changed"); }
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
  private included(scope: SyncScope, namespace: string, path: string): boolean {
    if (namespace === "portable-config") {
      if (isPortableAssetPath(path)) return scope.themesAndSnippets;
      return path === "editor.json" ? scope.mainSettings : path === "appearance.json" ? scope.appearance : path === "hotkeys.json" ? scope.hotkeys : path === "daily-notes.json" && scope.corePlugins;
    }
    return !path.split("/").some(part => part.startsWith(".")) && isPathInSyncScope(path, scope);
  }
  private async stableId(vaultId: string, path: string): Promise<string> {
    const namespace = Uint8Array.from(vaultId.replace(/-/g, "").match(/../g)!, part => parseInt(part, 16));
    const name = new TextEncoder().encode("portable-config:" + path); const bytes = new Uint8Array(namespace.length + name.length); bytes.set(namespace); bytes.set(name, namespace.length);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)); digest[6] = (digest[6] & 15) | 80; digest[8] = (digest[8] & 63) | 128;
    const hex = [...digest.slice(0, 16)].map(value => value.toString(16).padStart(2, "0")).join(""); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  private async withController<T>(operation: (controller: HistoryController, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.running || this.closing || this.cancellations) throw new Error("Sync already running or disconnecting");
    const provider = this.selected; if (!provider) throw new Error("Select a provider");
    const root = this.vaultId(); const generation = this.generation; const abort = new AbortController(); this.abort = abort;
    const assertContext = () => { if (abort.signal.aborted || this.vaultId() !== root || generation !== this.generation || this.selected !== provider || this.providers.get(provider.id) !== provider) throw new DOMException("Sync context changed", "AbortError"); };
    const work = (async () => {
      const state = await this.load(); assertContext(); if (!state.binding) throw new Error("Create or join a shared vault before preview"); if (state.paused) throw new Error("Sync is paused");
      this.lease ??= await this.host.syncSafety!.claimOwner() ?? undefined; assertContext(); if (!this.lease) throw new Error("Another window owns sync for this vault");
      const lease = this.lease; const bindingKey = await hash(encoded([provider.id, state.binding])); assertContext();
      const stateKey = `sync-history/${root}/${bindingKey}`;
      const storage = async (request: Parameters<NonNullable<HostServices["syncSafety"]>["storage"]>[2]) => { assertContext(); const value = await this.host.syncSafety!.storage(lease, bindingKey, request); assertContext(); return value; };
      const read = async (resource: HistoryLocalResource): Promise<ArrayBuffer> => {
        assertContext();
        if (resource.namespace === "portable-config" && !isPortableAssetPath(resource.path)) {
          const documents = await projectPortableConfig(this.host.config, state.scope); assertContext(); const document = documents.find(item => item.name === resource.path); if (!document) throw new Error("Portable category left scope"); return serializePortableConfig(document);
        }
        const data = await this.host.vaultFiles.readBinary(resource.namespace === "portable-config" ? ".geode/" + resource.path : resource.path); assertContext(); return data;
      };
      let includedAncestors = new Set<string>();
      const snapshot = async (): Promise<HistoryLocalSnapshot> => {
        const scan = await this.host.vaultFiles.reconcileScan(); assertContext();
        const result: HistoryLocalSnapshot = { authoritative: scan.status === "complete", scopeKey: JSON.stringify(state.scope), entries: [], excluded: [], blocked: [] };
        const folders = new Map<string, HistoryLocalResource>();
        for (const entry of scan.entries) {
          const namespace = entry.path.startsWith(".geode/") ? "portable-config" : "content";
          const path = namespace === "portable-config" ? entry.path.slice(7) : entry.path;
          if (entry.isFolder) { if (!entry.path.split("/").some(part => part.startsWith(".")) || namespace === "portable-config" && isPortableAssetPath(path)) folders.set(`${namespace}:${path}`, { namespace, path, kind: "folder" }); continue; }
          if (!this.included(state.scope, namespace, path) || namespace === "portable-config" && !isPortableAssetPath(path)) continue;
          const resource: HistoryLocalResource = { namespace, path, kind: "file", size: entry.size };
          if (entry.size > SYNC_MAX_FILE_BYTES) { result.blocked.push({ namespace, path, reason: "File exceeds 100 MiB limit" }); continue; }
          const reason = namespace === "content" ? await provider.excludePath?.(path) : null; assertContext();
          if (reason) { result.excluded.push({ namespace, path, reason }); continue; }
          const data = await read(resource); const contentReason = namespace === "content" ? await provider.excludePath?.(path, data) : null; assertContext();
          if (contentReason) { result.excluded.push({ namespace, path, reason: contentReason }); continue; }
          resource.sha256 = await hash(data); resource.size = data.byteLength;
          if (namespace === "portable-config") resource.entityId = await this.stableId(state.binding!.vaultId, path);
          result.entries.push(resource);
        }
        for (const document of await projectPortableConfig(this.host.config, state.scope)) {
          const data = serializePortableConfig(document);
          const source = document.name === "hotkeys.json" ? "hotkeys" : document.name === "daily-notes.json" ? "daily-notes" : "app";
          const raw = await this.host.config.read(source); assertContext();
          const initialDefault = !raw || typeof raw !== "object" || !Object.keys(document.value).some(field => Object.prototype.hasOwnProperty.call(raw, field));
          result.entries.push({ namespace: "portable-config", path: document.name, kind: "file", sha256: await hash(data), size: data.byteLength, entityId: await this.stableId(state.binding!.vaultId, document.name), ...(initialDefault ? { initialDefault: true as const } : {}) });
        }
        const ancestors = new Set<string>();
        for (const resource of result.entries) { const parts = resource.path.split("/"); while (parts.pop() && parts.length) ancestors.add(`${resource.namespace}:${parts.join("/")}`); }
        for (const [key, folder] of folders) {
          if (ancestors.has(key) || this.included(state.scope, folder.namespace, folder.path)) {
            if (folder.namespace === "portable-config") folder.entityId = await this.stableId(state.binding!.vaultId, folder.path);
            result.entries.push(folder);
          }
        }
        includedAncestors = ancestors;
        for (const resource of result.entries) if (resource.namespace === "content") {
          for (const [destination, source] of this.renameHints) if (resource.path === destination || resource.path.startsWith(destination + "/")) {
            resource.renamedFrom = source + resource.path.slice(destination.length);
            if (!state.scope.excludedFolders.some(folder => source === folder || source.startsWith(folder + "/"))) {
              const parents = resource.renamedFrom.split("/"); if (resource.kind !== "folder") parents.pop();
              while (parents.length) { ancestors.add(`content:${parents.join("/")}`); parents.pop(); }
            }
            break;
          }
        }
        assertContext(); return result;
      };
      this.session = await provider.open({ binding: state.binding, deviceId: state.deviceId }, abort.signal); assertContext();
      const controller = new HistoryController({ vaultId: state.binding.vaultId, deviceId: state.deviceId, bindingKey, session: this.session, ports: {
        load: async () => { const value = await this.host.deviceState.read(stateKey); assertContext(); return value; },
        save: async (value: HistoryControllerState) => { assertContext(); await this.host.deviceState.write(stateKey, value); assertContext(); },
        loadOperations: async () => await storage({ action: "load-operations" }) as HistoryOperation[],
        saveOperation: async value => { await storage({ action: "save-operation", key: value.id, value }); },
        stage: async (key, data) => await storage({ action: "stage", key, data }) as string,
        readStage: async key => await storage({ action: "read-stage", key }) as ArrayBuffer,
        snapshot, read, isIncluded: (namespace, path) => includedAncestors.has(`${namespace}:${path}`) || this.included(state.scope, namespace, path),
        exclude: async (resource, data) => { const reason = resource.namespace === "content" ? await provider.excludePath?.(resource.path, data) : null; assertContext(); return reason ?? null; },
        apply: async input => { assertContext(); await this.host.syncSafety!.apply(lease, { namespace: input.namespace, operationId: input.operationId, path: input.path, expectedHash: input.expectedHash, kind: input.deleted ? "trash" : input.kind === "folder" ? "mkdir" : "write", data: input.data }); assertContext(); if (input.namespace === "portable-config") await this.portableChanged(); assertContext(); },
        assertContext, newId: () => crypto.randomUUID(),
      } });
      return operation(controller, abort.signal);
    })();
    this.running = work;
    let completed = false;
    try { const result = await work; completed = true; return result; }
    catch (error) { if (!abort.signal.aborted && root === this.vaultId() && generation === this.generation && this.selected === provider && this.status.state !== "paused") this.setStatus({ state: "error", providerId: provider.id, conflicts: this.details?.conflicts.length ?? 0, message: error instanceof Error ? error.message : "Sync unavailable" }); throw error; }
    finally { try { await this.session?.close(); } finally { this.session = undefined; if (this.running === work) this.running = undefined; if (this.abort === abort) this.abort = undefined; } if (completed) assertContext(); }
  }
  private summarize(value: HistoryPreview): SyncPreview {
    this.details = value;
    const outstanding = value.uploads + value.downloads + value.deletions;
    const integrityBlocked = !value.upToDate && !outstanding && !value.requiresApproval && !value.conflicts.length;
    this.setStatus({ state: value.blocked.length || value.pending || integrityBlocked ? "error" : value.conflicts.length ? "conflict" : value.requiresApproval ? "preview" : outstanding ? "pending" : "idle", providerId: this.selected?.id, conflicts: value.conflicts.length, message: value.blocked.length ? value.blocked.map(item => `${item.path}: ${item.reason}`).join("; ") : value.pending ? `${value.pending} pending history dependencies` : integrityBlocked ? "Remote integrity or pending history blocks an up-to-date result" : outstanding ? `${outstanding} changes await synchronization` : value.excluded.length ? `${value.excluded.length} managed or excluded paths` : undefined });
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
    const result = this.summarize(await this.withController((controller, signal) => controller.run(options, signal))); this.retryDelay = 2000; this.renameHints.clear(); this.observe();
    this.polling ??= setInterval(() => this.schedule(0), 30_000); if (this.status.state === "pending") this.schedule(0); return result;
  }
  async listConflicts(): Promise<SyncConflict[]> {
    if (!this.selected) return this.conditional.listConflicts();
    return (this.details?.conflicts ?? []).map(conflict => ({ id: JSON.stringify([conflict.entityId, conflict.heads]), path: conflict.path, conflictPath: "", remoteRevision: conflict.heads.join(",") }));
  }
  async resolveHistoryConflict(resolution: HistoryResolution) { return this.summarize(await this.withController((controller, signal) => controller.resolve(resolution, signal))); }
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
      void this.run().catch(error => { if (!current() || error instanceof DOMException && error.name === "AbortError") return; this.setStatus({ state: "error", providerId: provider.id, conflicts: this.details?.conflicts.length ?? 0, message: error instanceof Error ? error.message : "Sync unavailable" }); this.retryDelay = Math.min(this.retryDelay * 2, 60_000); this.schedule(this.retryDelay); });
    }, delay);
  }
  async cancel() { this.cancellations++; try { this.generation++; this.stopObserving?.(); this.stopObserving = undefined; clearTimeout(this.debounce); clearInterval(this.polling); this.polling = undefined; this.abort?.abort(); await this.conditional.cancel(); await this.running?.catch(() => {}); if (this.lease) await this.host.syncSafety?.releaseOwner(this.lease); this.lease = undefined; } finally { this.cancellations--; } }
  async disconnect() {
    if (this.closing) throw new Error("Sync is already disconnecting");
    this.closing = true;
    try { const root = this.vaultId(); const key = this.key(root); await this.cancel(); if (root !== this.vaultId()) throw new Error("Vault changed"); await this.host.deviceState.remove(key); if (root !== this.vaultId()) throw new Error("Vault changed"); await this.conditional.disconnect(); if (root !== this.vaultId()) throw new Error("Vault changed"); this.selected = undefined; this.details = undefined; this.setStatus({ state: "disconnected", conflicts: 0 }); }
    finally { this.closing = false; }
  }
  async pause() { if (!this.selected) return this.withConditional(() => this.conditional.pause()); const root = this.vaultId(); await this.cancel(); if (root !== this.vaultId()) throw new Error("Vault changed"); return this.setup(async (_signal, assert) => { const state = await this.load(); assert(); state.paused = true; await this.save(state); assert(); this.setStatus({ ...this.status, state: "paused" }); }); }
  async resume() { if (!this.selected) return this.withConditional(() => this.conditional.resume()); return this.setup(async (_signal, assert) => { const state = await this.load(); assert(); state.paused = false; await this.save(state); assert(); this.observe(); this.setStatus({ ...this.status, state: "preview", message: "Preview before resuming" }); }); }
}
