import { SYNC_CONFLICT_COMPARE_MAX_BYTES, SYNC_MAX_FILE_BYTES, type AppendOnlySession, type HistoryRecord } from './history-types';
import { mergeHistory, deriveHistory, type HistoryStore } from './history-reducer';
import { validateSyncPath } from './scope';
export type HistoryNamespace = HistoryRecord['namespace'];
export interface HistoryLocalResource {
    namespace: HistoryNamespace;
    path: string;
    kind: 'file' | 'folder';
    sha256?: string;
    size?: number;
    entityId?: string;
    renamedFrom?: string;
    /** Host-projected portable category with no locally authored fields. */
    initialDefault?: true;
}
export interface HistoryPathIssue {
    namespace: HistoryNamespace;
    path: string;
    reason: string;
}
export interface HistoryLocalSnapshot {
    authoritative: boolean;
    scopeKey: string;
    entries: HistoryLocalResource[];
    excluded: HistoryPathIssue[];
    blocked: HistoryPathIssue[];
}
export interface HistoryBaseline {
    namespace: HistoryNamespace;
    path: string;
    kind: 'file' | 'folder';
    sha256?: string;
    present: boolean;
    heads: string[];
}
export interface HistoryApply {
    operationId: string;
    namespace: HistoryNamespace;
    path: string;
    kind: 'file' | 'folder';
    deleted: boolean;
    expectedHash: string | null;
    data?: ArrayBuffer;
}
export interface HistoryConflict {
    entityId: string;
    namespace: HistoryNamespace;
    path: string;
    heads: string[];
    reason: string;
}
export interface HistoryOperation {
    id: string;
    type: 'publish' | 'apply';
    phase: 'prepared' | 'committed' | 'abandoned';
    record: HistoryRecord;
    baseline?: HistoryBaseline;
    entityId: string;
    path: string;
    payload?: {
        key: string;
        sha256: string;
        size: number;
    };
    apply?: Omit<HistoryApply, 'data'>;
}
export interface HistoryControllerState {
    schema: 1;
    bindingKey: string;
    vaultId: string;
    deviceId: string;
    history: HistoryStore;
    cursor?: string;
    baseline: Record<string, HistoryBaseline>;
    reservedEntities: Record<string, string>;
    approved: boolean;
    scopeKey?: string;
    previewSignature?: string;
    conflicts: HistoryConflict[];
    blocked: HistoryPathIssue[];
    completedOperations: string[];
    pendingBatch?: string[];
    abandonRequested?: boolean;
    recoveryIssues?: HistoryPathIssue[];
    blobAvailability?: Record<string, 'pending' | 'corrupt'>;
}
export interface HistoryControllerPorts {
    load(): Promise<unknown | null>;
    save(state: HistoryControllerState): Promise<void>;
    loadOperations(): Promise<HistoryOperation[]>;
    saveOperation(operation: HistoryOperation): Promise<void>;
    snapshot(): Promise<HistoryLocalSnapshot>;
    read(resource: HistoryLocalResource): Promise<ArrayBuffer>;
    stage(operationId: string, bytes: ArrayBuffer): Promise<string>;
    readStage(key: string): Promise<ArrayBuffer>;
    /** Idempotent by operationId; preserve durable preimages and validate expectedHash before mutation. Folder trash MUST refuse nonempty directories. */
    apply(input: HistoryApply): Promise<void>;
    isIncluded(namespace: HistoryNamespace, path: string): boolean;
    exclude?(resource: HistoryLocalResource, bytes?: ArrayBuffer): Promise<string | null>;
    assertContext(): void;
    newId(): string;
}
export interface HistoryPreview {
    signature: string;
    requiresApproval: boolean;
    uploads: number;
    downloads: number;
    deletions: number;
    conflicts: HistoryConflict[];
    blocked: HistoryPathIssue[];
    excluded: HistoryPathIssue[];
    pending: number;
    upToDate: boolean;
}
export interface HistoryResolution {
    entityId: string;
    heads: string[];
    choice: {
        kind: 'current';
    } | {
        kind: 'version';
        recordId: string;
    };
    /**
     * Transient, in-memory only: the local content hash the user actually
     * reviewed in a comparison. Never persisted in a record or on disk. When
     * supplied, resolution refuses to publish if the local file has moved on.
     */
    reviewedLocalSha256?: string;
}
/** Which side of a comparison to load; mirrors HistoryResolution['choice']. */
export type HistoryComparisonChoice = {
    kind: 'current';
} | {
    kind: 'version';
    recordId: string;
};
/** Machine-readable reason a conflict cannot be compared as same-path Markdown text. */
export type HistoryComparisonBlocker = 'portable-config' | 'folder' | 'deleted-version' | 'rename-or-move' | 'non-markdown' | 'missing-content' | 'oversize';
export interface HistoryComparisonVersion {
    recordId: string;
    deviceId: string;
    kind: 'file' | 'folder';
    deleted: boolean;
    name: string;
    parentId: string | null;
    size?: number;
    sha256?: string;
}
export interface HistoryComparisonLocal {
    path: string;
    present: boolean;
    sha256?: string;
    size?: number;
}
export interface HistoryConflictComparison {
    entityId: string;
    namespace: HistoryNamespace;
    path: string;
    /** The planner's conflict reason, carried through unchanged. */
    reason: string;
    heads: HistoryComparisonVersion[];
    local: HistoryComparisonLocal;
    comparable: boolean;
    notComparable?: HistoryComparisonBlocker;
}
export interface HistoryControllerOptions {
    vaultId: string;
    deviceId: string;
    bindingKey: string;
    session: AppendOnlySession;
    ports: HistoryControllerPorts;
}
interface PublishAction {
    type: 'publish';
    entityId: string;
    namespace: HistoryNamespace;
    path: string;
    kind: 'file' | 'folder';
    parents: string[];
    location: HistoryRecord['location'];
    deleted: boolean;
    resource?: HistoryLocalResource;
}
interface ApplyAction {
    type: 'apply';
    record: HistoryRecord;
    path: string;
    expected: string | null;
    deleted: boolean;
    baseline?: HistoryBaseline;
}
type Action = PublishAction | ApplyAction;
interface Plan {
    actions: Action[];
    adoptions: Record<string, HistoryBaseline>;
    preview: HistoryPreview;
    snapshot: HistoryLocalSnapshot;
    resources: Map<string, HistoryLocalResource>;
    locations: Map<string, HistoryRecord['location']>;
}
const key = (namespace: HistoryNamespace, path: string) => `${namespace}:${path}`;
const parentPath = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const sameHeads = (a: string[], b: string[]) => { const left = [...a].sort(), right = [...b].sort(); return left.length === right.length && left.every((v, i) => v === right[i]); };
const fingerprint = (resource: HistoryLocalResource | undefined): string | null => resource ? (resource.kind === 'folder' ? 'folder' : resource.sha256 ?? null) : null;
const matches = (resource: HistoryLocalResource | undefined, base: HistoryBaseline) => base.present
    ? Boolean(resource && resource.kind === base.kind && resource.path === base.path && (base.kind === 'folder' || resource.sha256 === base.sha256)) : !resource;
const COMPARE_OVERSIZE = 'Conflict comparison is limited to 1 MiB of text';
/** Strict decode: invalid UTF-8 surfaces an error rather than replacement garbage. */
const decodeText = (bytes: ArrayBuffer): string => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('Conflict content is not valid UTF-8 text'); }
};
const recordBaseline = (r: HistoryRecord, path: string): HistoryBaseline => ({ namespace: r.namespace, path, kind: r.kind, present: !r.deleted, heads: [r.recordId], ...(r.blob ? { sha256: r.blob.sha256 } : {}) });
function folderSignatures(resources: HistoryLocalResource[]): Map<string, string> {
    const parts = new Map<string, string[]>();
    for (const r of resources)
        if (r.kind === 'folder')
            parts.set(key(r.namespace, r.path), []);
    for (const r of resources)
        for (let parent = parentPath(r.path); parent; parent = parentPath(parent))
            parts.get(key(r.namespace, parent))?.push(`${r.path.slice(parent.length + 1)}:${r.kind}:${r.sha256 ?? ''}`);
    return new Map([...parts].map(([path, entries]) => [path, JSON.stringify(entries.sort())]));
}
export class HistoryController {
    private active = false;
    constructor(private readonly options: HistoryControllerOptions) { }
    private get ports() { return this.options.ports; }
    private assert(signal: AbortSignal) { signal.throwIfAborted(); this.ports.assertContext(); }
    private async checked<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> { this.assert(signal); const result = await operation(); this.assert(signal); return result; }
    private async exclusive<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> { if (this.active)
        throw new Error('Sync operation already running'); this.active = true; try {
        this.assert(signal);
        return await operation();
    }
    finally {
        this.active = false;
    } }
    private async hash(bytes: ArrayBuffer, signal: AbortSignal): Promise<string> { const digest = await this.checked(signal, () => crypto.subtle.digest('SHA-256', bytes)); return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join(''); }
    private async load(signal: AbortSignal): Promise<HistoryControllerState> {
        const raw = await this.checked(signal, () => this.ports.load());
        if (raw === null || raw === undefined)
            return { schema: 1, bindingKey: this.options.bindingKey, vaultId: this.options.vaultId, deviceId: this.options.deviceId, history: { records: {}, quarantined: {} }, baseline: {}, reservedEntities: {}, approved: false, conflicts: [], blocked: [], completedOperations: [] };
        const state = raw as HistoryControllerState;
        if (state.schema !== 1 || state.bindingKey !== this.options.bindingKey || state.vaultId !== this.options.vaultId || state.deviceId !== this.options.deviceId || !state.history?.records || !state.history.quarantined || !state.baseline || !state.reservedEntities || !Array.isArray(state.completedOperations) || !Array.isArray(state.conflicts))
            throw new Error('Unsupported sync state; reconnect with a fresh preview');
        return state;
    }
    private save(state: HistoryControllerState, signal: AbortSignal) { return this.checked(signal, () => this.ports.save(state)); }
    async getState(signal: AbortSignal): Promise<HistoryControllerState> { return this.exclusive(signal, () => this.load(signal)); }
    async abandonPending(signal: AbortSignal): Promise<HistoryPreview> {
        return this.exclusive(signal, async () => {
            const state = await this.load(signal);
            state.abandonRequested = true;
            state.approved = false;
            delete state.previewSignature;
            await this.save(state, signal);
            await this.abandon(state, signal);
            const plan = await this.plan(state, signal);
            await this.save(state, signal);
            return plan.preview;
        });
    }
    async preview(signal: AbortSignal): Promise<HistoryPreview> { return this.exclusive(signal, async () => { const state = await this.load(signal); if (state.pendingBatch?.length)
        throw new Error('Resume pending sync before preview'); const plan = await this.plan(state, signal); state.previewSignature = plan.preview.signature; await this.save(state, signal); return plan.preview; }); }
    async run(options: {
        approvePreview?: boolean;
    }, signal: AbortSignal): Promise<HistoryPreview> {
        return this.exclusive(signal, async () => {
            const state = await this.load(signal);
            if (state.pendingBatch?.length)
                await this.recover(state, signal);
            const plan = await this.plan(state, signal);
            if (!state.approved && (!options.approvePreview || state.previewSignature !== plan.preview.signature))
                throw new Error('Preview this exact sync before approving it');
            state.approved = true;
            delete state.previewSignature;
            await this.execute(state, plan, signal);
            const after = await this.plan(state, signal);
            await this.save(state, signal);
            return after.preview;
        });
    }
    private included(snapshot: HistoryLocalSnapshot, namespace: HistoryNamespace, path: string): boolean {
        return this.ports.isIncluded(namespace, path) && ![...snapshot.excluded, ...snapshot.blocked].some(item => item.namespace === namespace && (path === item.path || path.startsWith(`${item.path}/`)));
    }
    private async snapshot(signal: AbortSignal): Promise<HistoryLocalSnapshot> {
        const snapshot = await this.checked(signal, () => this.ports.snapshot());
        if (!snapshot.authoritative)
            throw new Error('Authoritative local snapshot unavailable');
        const entries: HistoryLocalResource[] = [];
        const blocked = [...snapshot.blocked], excluded = [...snapshot.excluded];
        for (const resource of snapshot.entries) {
            if (!this.included(snapshot, resource.namespace, resource.path))
                continue;
            if (resource.kind === 'file' && (!Number.isSafeInteger(resource.size) || resource.size! < 0 || resource.size! > SYNC_MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(resource.sha256 ?? ''))) {
                blocked.push({ namespace: resource.namespace, path: resource.path, reason: 'invalid-or-oversized-resource' });
                continue;
            }
            const reason = this.ports.exclude ? await this.checked(signal, () => this.ports.exclude!(resource)) : null;
            if (reason) {
                excluded.push({ namespace: resource.namespace, path: resource.path, reason });
                continue;
            }
            entries.push(resource);
        }
        return { ...snapshot, entries, blocked, excluded };
    }
    private async plan(state: HistoryControllerState, signal: AbortSignal): Promise<Plan> {
        const scan = await this.checked(signal, () => this.options.session.scan(state.cursor, signal));
        const availability: Record<string, 'pending' | 'corrupt'> = Object.assign(Object.create(null), state.blobAvailability ?? {});
        if (scan.blobAvailability !== undefined && !Array.isArray(scan.blobAvailability)) throw new Error('Invalid blob availability evidence');
        const evidenceIds = new Set<string>();
        for (const item of scan.blobAvailability ?? []) {
            if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 4096 || !['available', 'pending', 'corrupt'].includes(item.status) || evidenceIds.has(item.id)) throw new Error('Invalid blob availability evidence');
            evidenceIds.add(item.id);
            if (availability[item.id] === 'corrupt') continue;
            if (item.status === 'available') delete availability[item.id]; else availability[item.id] = item.status;
        }
        state.blobAvailability = availability;
        state.history = mergeHistory(state.history, scan.records, this.options.vaultId);
        if (scan.status !== 'complete') {
            await this.save(state, signal);
            throw new Error('Complete remote history scan unavailable');
        }
        state.cursor = scan.cursor;
        const snapshot = await this.snapshot(signal);
        if (state.scopeKey !== snapshot.scopeKey) {
            state.approved = false;
            state.scopeKey = snapshot.scopeKey;
        }
        const derived = deriveHistory(state.history), blocked = [...snapshot.blocked], conflicts: HistoryConflict[] = [], actions: Action[] = [], adoptions: Record<string, HistoryBaseline> = {};
        for (const [entityId, entity] of Object.entries(derived.entities)) {
            const statuses = entity.heads.map(id => state.history.records[id]?.blob?.id).filter((id): id is string => Boolean(id)).map(id => availability[id]);
            const status = statuses.includes('corrupt') ? 'corrupt' : statuses.includes('pending') ? 'pending' : undefined;
            if (status) blocked.push({ namespace: entity.namespace, path: entity.path ?? state.baseline[entityId]?.path ?? state.history.records[entity.heads[0]]?.location.name ?? entityId, reason: `${status}-blob` });
        }
        if (Object.keys(derived.quarantined).length)
            blocked.push({ namespace: 'content', path: '(remote history)', reason: 'quarantined-remote-history' });
        const localByPath = new Map(snapshot.entries.map(r => [key(r.namespace, r.path), r]));
        if (localByPath.size !== snapshot.entries.length)
            throw new Error('Duplicate local resource path');
        state.recoveryIssues = state.recoveryIssues?.filter(issue => localByPath.has(key(issue.namespace, issue.path)));
        blocked.push(...state.recoveryIssues ?? []);
        const remoteFolders = new Map(Object.entries(derived.entities).filter(([, e]) => e.path && e.record?.kind === 'folder').map(([id, e]) => [key(e.namespace, e.path!), id]));
        const localId = new Map<string, string>(), byEntity = new Map<string, HistoryLocalResource>();
        const assign = (id: string, r: HistoryLocalResource) => { const old = byEntity.get(id), oldId = localId.get(key(r.namespace, r.path)); if (old && (old.path !== r.path || old.namespace !== r.namespace) || oldId && oldId !== id)
            throw new Error('Duplicate local resource identity'); localId.set(key(r.namespace, r.path), id); byEntity.set(id, r); };
        for (const r of snapshot.entries)
            if (r.entityId)
                assign(r.entityId, r);
        for (const [id, base] of Object.entries(state.baseline)) {
            const local = localByPath.get(key(base.namespace, base.path));
            if (local && !localId.has(key(local.namespace, local.path)))
                assign(id, local);
        }
        for (const [id, entity] of Object.entries(derived.entities))
            if (entity.record && entity.path && !entity.record.deleted) {
                const local = localByPath.get(key(entity.namespace, entity.path));
                if (local && !localId.has(key(local.namespace, local.path)))
                    assign(id, local);
            }
        const baselineResources = Object.values(state.baseline).filter(b => b.present).map(b => ({ namespace: b.namespace, path: b.path, kind: b.kind, sha256: b.sha256 }));
        const oldSignatures = folderSignatures(baselineResources), newSignatures = folderSignatures(snapshot.entries), oldFolders = new Map<string, string[]>(), newFolders = new Map<string, HistoryLocalResource[]>();
        for (const [id, b] of Object.entries(state.baseline))
            if (b.present && b.kind === 'folder' && !byEntity.has(id) && this.included(snapshot, b.namespace, b.path)) {
                const signature = key(b.namespace, oldSignatures.get(key(b.namespace, b.path))!);
                oldFolders.set(signature, [...oldFolders.get(signature) ?? [], id]);
            }
        for (const r of snapshot.entries)
            if (r.kind === 'folder' && !localId.has(key(r.namespace, r.path))) {
                const signature = key(r.namespace, newSignatures.get(key(r.namespace, r.path))!);
                newFolders.set(signature, [...newFolders.get(signature) ?? [], r]);
            }
        for (const [signature, ids] of oldFolders) {
            const candidates = newFolders.get(signature) ?? [];
            if (ids.length === 1 && candidates.length === 1)
                assign(ids[0], candidates[0]);
            else if (candidates.length) {
                for (const id of ids) {
                    const b = state.baseline[id];
                    blocked.push({ namespace: b.namespace, path: b.path, reason: 'ambiguous-rename' });
                }
                for (const r of candidates)
                    blocked.push({ namespace: r.namespace, path: r.path, reason: 'ambiguous-rename' });
            }
        }
        const baselinePathId = new Map(Object.entries(state.baseline).map(([id, b]) => [key(b.namespace, b.path), id]));
        for (const [id, b] of Object.entries(state.baseline))
            if (b.present && !byEntity.has(id))
                for (let parent = parentPath(b.path); parent; parent = parentPath(parent)) {
                    const folderId = baselinePathId.get(key(b.namespace, parent)), folder = folderId ? byEntity.get(folderId) : undefined;
                    if (!folder || folder.path === parent)
                        continue;
                    const moved = localByPath.get(key(b.namespace, `${folder.path}/${b.path.slice(parent.length + 1)}`));
                    if (moved && !localId.has(key(moved.namespace, moved.path)) && moved.kind === b.kind && (b.kind === 'folder' || moved.sha256 === b.sha256))
                        assign(id, moved);
                    break;
                }
        // Content equality is rename evidence only when both missing and new sides are unique.
        const missingByHash = new Map<string, string[]>(), newByHash = new Map<string, HistoryLocalResource[]>();
        for (const [id, base] of Object.entries(state.baseline))
            if (base.present && !byEntity.has(id) && base.kind === 'file' && this.included(snapshot, base.namespace, base.path)) {
                const k = key(base.namespace, base.sha256 ?? '');
                missingByHash.set(k, [...(missingByHash.get(k) ?? []), id]);
            }
        for (const r of snapshot.entries)
            if (!localId.has(key(r.namespace, r.path)) && r.kind === 'file') {
                const k = key(r.namespace, r.sha256 ?? '');
                newByHash.set(k, [...(newByHash.get(k) ?? []), r]);
            }
        for (const [k, ids] of missingByHash) {
            const candidates = newByHash.get(k) ?? [];
            if (ids.length === 1 && candidates.length === 1)
                assign(ids[0], candidates[0]);
            else if (candidates.length) {
                for (const id of ids) {
                    const b = state.baseline[id];
                    blocked.push({ namespace: b.namespace, path: b.path, reason: 'ambiguous-rename' });
                }
                for (const r of candidates)
                    blocked.push({ namespace: r.namespace, path: r.path, reason: 'ambiguous-rename' });
            }
        }
        for (const r of snapshot.entries)
            if (r.renamedFrom && !localId.has(key(r.namespace, r.path))) {
                const prior = Object.entries(state.baseline).find(([, b]) => b.namespace === r.namespace && b.path === r.renamedFrom && b.kind === r.kind);
                if (prior && !byEntity.has(prior[0]))
                    assign(prior[0], r);
            }
        // Reservations stabilize unpublished previews, not permanent path ownership.
        // A committed identity is located by its baseline/history above; retaining
        // its creation path would alias a later unrelated file after a rename.
        for (const [path, id] of Object.entries(state.reservedEntities))
            if (state.baseline[id] || derived.entities[id])
                delete state.reservedEntities[path];
        for (const r of snapshot.entries)
            if (!localId.has(key(r.namespace, r.path))) {
                const k = key(r.namespace, r.path);
                const id = state.reservedEntities[k] ?? (state.reservedEntities[k] = this.ports.newId());
                assign(id, r);
            }
        snapshot.blocked = blocked;
        const location = (namespace: HistoryNamespace, path: string): HistoryRecord['location'] | undefined => {
            const parent = parentPath(path);
            if (!parent)
                return { parentId: null, name: nameOf(path) };
            const parentId = localId.get(key(namespace, parent)) ?? remoteFolders.get(key(namespace, parent));
            if (!parentId)
                return undefined;
            return { parentId, name: nameOf(path) };
        };
        const publish = (id: string, local: HistoryLocalResource | undefined, base: HistoryBaseline | undefined, parents: string[], fallback?: HistoryRecord) => {
            const namespace = local?.namespace ?? base?.namespace ?? fallback!.namespace, path = local?.path ?? base?.path ?? nameOf(fallback!.location.name);
            if (!this.included(snapshot, namespace, path))
                return;
            const desiredLocation = local ? location(namespace, path) : fallback?.location ?? location(namespace, path);
            if (!desiredLocation) {
                blocked.push({ namespace, path, reason: 'missing-parent-folder-identity' });
                return;
            }
            actions.push({ type: 'publish', entityId: id, namespace, path, kind: local?.kind ?? base?.kind ?? fallback!.kind, parents: [...parents].sort(), location: desiredLocation, deleted: !local, resource: local });
        };
        for (const [id, entity] of Object.entries(derived.entities)) {
            const base = state.baseline[id], local = byEntity.get(id), r = entity.record;
            const path = entity.path ?? base?.path ?? local?.path ?? state.history.records[entity.heads[0]]?.location.name ?? id;
            if (!this.included(snapshot, entity.namespace, path) || base && !this.included(snapshot, base.namespace, base.path))
                continue;
            if (entity.blocked) {
                conflicts.push({ entityId: id, namespace: entity.namespace, path, heads: entity.heads, reason: entity.blocked });
                if (entity.blocked === 'concurrent-heads' && base && !matches(local, base) && (!local || local.kind === base.kind))
                    publish(id, local, base, base.heads, state.history.records[entity.heads[0]]);
                continue;
            }
            if (!r)
                continue;
            const remoteBase = recordBaseline(r, path);
            const same = matches(local, remoteBase);
            if (!base) {
                if (local?.initialDefault && local.namespace === 'portable-config' && local.kind === 'file' && r.kind === 'file' && !r.deleted) {
                    actions.push({ type: 'apply', record: r, path, expected: local.sha256!, deleted: false, baseline: remoteBase });
                    continue;
                }
                if (same || r.deleted && !local) {
                    adoptions[id] = remoteBase;
                    continue;
                }
                if (local) {
                    if (local.kind !== r.kind) {
                        conflicts.push({ entityId: id, namespace: r.namespace, path, heads: entity.heads, reason: 'kind-collision' });
                        continue;
                    }
                    publish(id, local, undefined, [], r);
                    conflicts.push({ entityId: id, namespace: r.namespace, path, heads: entity.heads, reason: 'first-join-divergence' });
                }
                else
                    actions.push({ type: 'apply', record: r, path, expected: null, deleted: r.deleted, baseline: remoteBase });
                continue;
            }
            const localChanged = !matches(local, base), remoteChanged = !sameHeads(base.heads, entity.heads) || base.path !== path;
            if (same) {
                adoptions[id] = remoteBase;
                continue;
            }
            if (local && local.kind !== r.kind) {
                conflicts.push({ entityId: id, namespace: r.namespace, path: local.path, heads: entity.heads, reason: 'kind-collision' });
                continue;
            }
            if (localChanged) {
                publish(id, local, base, base.heads, r);
                continue;
            }
            if (remoteChanged) {
                if (r.deleted && [...byEntity].some(([otherId, other]) => otherId !== id && other.namespace === r.namespace && other.path === path)) {
                    blocked.push({ namespace: r.namespace, path, reason: 'tombstone-path-owned-by-another-entity' });
                    continue;
                }
                const target = localByPath.get(key(r.namespace, path));
                if (target && local && target.path !== local.path) {
                    conflicts.push({ entityId: id, namespace: r.namespace, path, heads: entity.heads, reason: 'rename-destination-occupied' });
                    continue;
                }
                actions.push({ type: 'apply', record: r, path, expected: fingerprint(target), deleted: r.deleted, baseline: remoteBase });
                if (local && local.path !== path)
                    actions.push({ type: 'apply', record: r, path: local.path, expected: fingerprint(local), deleted: true });
            }
        }
        for (const [id, local] of byEntity) {
            if (derived.entities[id])
                continue;
            const base = state.baseline[id];
            if (base) {
                blocked.push({ namespace: local.namespace, path: local.path, reason: 'baseline-history-missing' });
                continue;
            }
            publish(id, local, undefined, []);
        }
        for (const [id, base] of Object.entries(state.baseline))
            if (!derived.entities[id] && !byEntity.has(id) && base.present && this.included(snapshot, base.namespace, base.path))
                blocked.push({ namespace: base.namespace, path: base.path, reason: 'baseline-history-missing' });
        // A complete remote tombstone set can still race with a new local descendant.
        const deletingPaths = new Set(actions.filter((a): a is ApplyAction => a.type === 'apply' && a.deleted).map(a => key(a.record.namespace, a.path)));
        const retainedAncestors = new Set<string>();
        for (const r of snapshot.entries)
            if (!deletingPaths.has(key(r.namespace, r.path)))
                for (let parent = parentPath(r.path); parent; parent = parentPath(parent))
                    retainedAncestors.add(key(r.namespace, parent));
        for (let index = actions.length - 1; index >= 0; index--) {
            const a = actions[index];
            if (a.type === 'apply' && a.deleted && a.record.kind === 'folder' && retainedAncestors.has(key(a.record.namespace, a.path))) {
                actions.splice(index, 1);
                conflicts.push({ entityId: a.record.entityId, namespace: a.record.namespace, path: a.path, heads: [a.record.recordId], reason: 'live-local-descendants' });
            }
        }
        const priority = (action: Action) => action.type === 'publish' ? (action.deleted ? (action.kind === 'folder' ? 5 : 3) : (action.kind === 'folder' ? 0 : 2)) : (action.deleted ? (action.record.kind === 'folder' ? 6 : 4) : (action.record.kind === 'folder' ? 1 : 2));
        actions.sort((a, b) => priority(a) - priority(b) || (a.deleted ? -1 : 1) * (a.path.split('/').length - b.path.split('/').length) || a.path.localeCompare(b.path));
        state.conflicts = conflicts;
        state.blocked = blocked;
        const signature = await this.hash(new TextEncoder().encode(JSON.stringify({ scope: snapshot.scopeKey, actions, conflicts, blocked, excluded: snapshot.excluded, records: Object.keys(state.history.records).sort(), quarantined: Object.keys(state.history.quarantined).sort() })).buffer, signal);
        const preview: HistoryPreview = { signature, requiresApproval: !state.approved, uploads: actions.filter(a => a.type === 'publish' && !a.deleted).length, downloads: actions.filter(a => a.type === 'apply' && !a.deleted).length, deletions: actions.filter(a => a.deleted).length, conflicts, blocked, excluded: snapshot.excluded, pending: derived.pending.length, upToDate: state.approved && !actions.length && !conflicts.length && !blocked.length && !derived.pending.length && !Object.keys(derived.quarantined).length };
        const locations = new Map<string, HistoryRecord['location']>();
        for (const [id, r] of byEntity) {
            const found = location(r.namespace, r.path);
            if (found)
                locations.set(id, found);
        }
        return { actions, adoptions, preview, snapshot, resources: byEntity, locations };
    }
    private async verified(bytes: ArrayBuffer, sha256: string, size: number, signal: AbortSignal): Promise<ArrayBuffer> { if (bytes.byteLength !== size || size > SYNC_MAX_FILE_BYTES || await this.hash(bytes, signal) !== sha256)
        throw new Error('Sync content integrity mismatch'); return bytes; }
    private async prepare(action: Action, signal: AbortSignal): Promise<HistoryOperation> {
        const id = this.ports.newId();
        let record: HistoryRecord;
        let data: ArrayBuffer | undefined;
        if (action.type === 'publish') {
            record = { schema: 1, vaultId: this.options.vaultId, deviceId: this.options.deviceId, operationId: id, recordId: this.ports.newId(), entityId: action.entityId, namespace: action.namespace, parents: action.parents, kind: action.kind, deleted: action.deleted, location: action.location };
            if (action.resource?.kind === 'file')
                data = await this.verified(await this.checked(signal, () => this.ports.read(action.resource!)), action.resource.sha256!, action.resource.size!, signal);
        }
        else {
            record = action.record;
            if (!action.deleted && record.kind === 'file') {
                if (!record.blob)
                    throw new Error('Missing content reference');
                data = await this.verified(await this.checked(signal, () => this.options.session.readBlob(record.blob!, signal)), record.blob.sha256, record.blob.size, signal);
            }
        }
        const payload = data ? { key: await this.checked(signal, () => this.ports.stage(id, data!)), sha256: await this.hash(data, signal), size: data.byteLength } : undefined;
        const candidate = { ...record, ...(payload && !record.blob ? { blob: { id: 'pending', sha256: payload.sha256, size: payload.size } } : {}) };
        if (mergeHistory({ records: {}, quarantined: {} }, [candidate], this.options.vaultId).quarantined[record.recordId])
            throw new Error('Invalid local history record');
        if (this.ports.exclude && data) {
            const resource: HistoryLocalResource = { namespace: record.namespace, path: action.path, kind: record.kind, sha256: payload!.sha256, size: payload!.size };
            const reason = await this.checked(signal, () => this.ports.exclude!(resource, data));
            if (reason)
                throw new Error('Resource ownership changed; preview sync again');
        }
        const operation: HistoryOperation = { id, type: action.type, phase: 'prepared', record, entityId: record.entityId, path: action.path, ...(payload ? { payload } : {}),
            ...(action.type === 'publish' ? { baseline: { namespace: record.namespace, path: action.path, kind: record.kind, present: !record.deleted, heads: [record.recordId], ...(payload ? { sha256: payload.sha256 } : {}) } } : { ...(action.baseline ? { baseline: action.baseline } : {}), apply: { operationId: id, namespace: record.namespace, path: action.path, kind: record.kind, deleted: action.deleted, expectedHash: action.expected } }) };
        await this.checked(signal, () => this.ports.saveOperation(operation));
        return operation;
    }
    private async execute(state: HistoryControllerState, plan: Plan, signal: AbortSignal): Promise<void> {
        const operations: HistoryOperation[] = [];
        // No mutation before the whole ordered batch is durably ready; this is what
        // makes destination-write/child-move/empty-folder-cleanup recovery safe.
        for (const action of plan.actions)
            operations.push(await this.prepare(action, signal));
        state.pendingBatch = operations.map(op => op.id);
        await this.save(state, signal);
        for (const operation of operations)
            await this.perform(operation, plan.snapshot, signal);
        this.finish(state, operations);
        Object.assign(state.baseline, plan.adoptions);
        await this.save(state, signal);
    }
    private async perform(operation: HistoryOperation, snapshot: HistoryLocalSnapshot, signal: AbortSignal): Promise<void> {
        this.validateOperation(operation);
        if (operation.phase !== 'prepared')
            return;
        if (!this.included(snapshot, operation.record.namespace, operation.path))
            throw new Error('Pending sync resource is excluded or blocked');
        const data = operation.payload ? await this.verified(await this.checked(signal, () => this.ports.readStage(operation.payload!.key)), operation.payload.sha256, operation.payload.size, signal) : undefined;
        if (operation.type === 'publish') {
            if (data && !operation.record.blob) {
                const ref = await this.checked(signal, () => this.options.session.putBlob({ operationId: operation.id, sha256: operation.payload!.sha256, size: operation.payload!.size, data }, signal));
                if (ref.sha256 !== operation.payload!.sha256 || ref.size !== operation.payload!.size)
                    throw new Error('Invalid upload receipt');
                await this.verified(await this.checked(signal, () => this.options.session.readBlob(ref, signal)), ref.sha256, ref.size, signal);
                operation.record = { ...operation.record, blob: ref };
                await this.checked(signal, () => this.ports.saveOperation(operation));
            }
            await this.checked(signal, () => this.options.session.appendRecord(operation.record, signal));
        }
        else {
            const apply = operation.apply;
            if (!apply)
                throw new Error('Missing guarded operation');
            await this.checked(signal, () => this.ports.apply({ ...apply, ...(data ? { data } : {}) }));
        }
        operation.phase = 'committed';
        await this.checked(signal, () => this.ports.saveOperation(operation));
    }
    private finish(state: HistoryControllerState, operations: HistoryOperation[]) {
        state.history = mergeHistory(state.history, operations.filter(o => o.type === 'publish' && o.phase === 'committed').map(o => o.record), this.options.vaultId);
        for (const operation of operations)
            if (operation.phase === 'committed' && operation.baseline)
                state.baseline[operation.entityId] = operation.baseline;
        state.completedOperations = [...new Set([...state.completedOperations, ...operations.map(o => o.id)])];
        delete state.pendingBatch;
    }
    private async recover(state: HistoryControllerState, signal: AbortSignal) {
        if (state.abandonRequested) {
            await this.abandon(state, signal);
            return;
        }
        const all = new Map((await this.checked(signal, () => this.ports.loadOperations())).map(o => [o.id, o]));
        const operations = state.pendingBatch!.map(id => { const op = all.get(id); if (!op)
            throw new Error('Missing durable sync intent'); return op; });
        const snapshot = await this.snapshot(signal);
        for (const operation of operations)
            await this.perform(operation, snapshot, signal);
        this.finish(state, operations);
        await this.save(state, signal);
    }
    private async abandon(state: HistoryControllerState, signal: AbortSignal) {
        const all = new Map((await this.checked(signal, () => this.ports.loadOperations())).map(o => [o.id, o]));
        const operations = (state.pendingBatch ?? []).map(id => { const op = all.get(id); if (!op)
            throw new Error('Missing durable sync intent'); return op; });
        for (const op of operations) {
            this.validateOperation(op);
            if (op.phase !== 'committed') {
                if (op.type === 'apply' && op.apply?.deleted && !op.baseline)
                    (state.recoveryIssues ??= []).push({ namespace: op.record.namespace, path: op.path, reason: 'recovery-source-retained' });
                op.phase = 'abandoned';
                await this.checked(signal, () => this.ports.saveOperation(op));
            }
        }
        this.finish(state, operations);
        state.approved = false;
        delete state.previewSignature;
        delete state.abandonRequested;
        await this.save(state, signal);
    }
    private async localMove(resource: HistoryLocalResource, entityId: string, destination: string, baseline: HistoryBaseline | undefined, state: HistoryControllerState, signal: AbortSignal): Promise<HistoryOperation> {
        const id = this.ports.newId();
        let payload: HistoryOperation['payload'];
        if (resource.kind === 'file') {
            const bytes = await this.verified(await this.checked(signal, () => this.ports.read(resource)), resource.sha256!, resource.size!, signal);
            payload = { key: await this.checked(signal, () => this.ports.stage(id, bytes)), sha256: resource.sha256!, size: resource.size! };
        }
        const record: HistoryRecord = state.history.records[baseline?.heads[0] ?? ''] ?? { schema: 1, vaultId: this.options.vaultId, recordId: this.ports.newId(), operationId: id, deviceId: this.options.deviceId, entityId, namespace: resource.namespace, parents: [], kind: resource.kind, deleted: false, location: { parentId: null, name: nameOf(destination) }, ...(payload ? { blob: { id: 'local-staged', sha256: payload.sha256, size: payload.size } } : {}) };
        const operation: HistoryOperation = { id, type: 'apply', phase: 'prepared', record, entityId, path: destination, apply: { operationId: id, namespace: resource.namespace, path: destination, kind: resource.kind, deleted: false, expectedHash: null }, ...(payload ? { payload } : {}), ...(baseline ? { baseline: { ...baseline, path: destination } } : {}) };
        await this.checked(signal, () => this.ports.saveOperation(operation));
        return operation;
    }
    private validateOperation(operation: HistoryOperation): void {
        const r = operation.record, payload = operation.payload;
        if (!r || r.vaultId !== this.options.vaultId || operation.entityId !== r.entityId || !['publish', 'apply'].includes(operation.type) || !['prepared', 'committed', 'abandoned'].includes(operation.phase))
            throw new Error('Invalid durable sync intent');
        validateSyncPath(operation.path);
        if (payload && (!payload.key || !Number.isSafeInteger(payload.size) || payload.size < 0 || payload.size > SYNC_MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(payload.sha256)))
            throw new Error('Invalid staged payload intent');
        const candidate = { ...r, ...(payload && !r.blob ? { blob: { id: 'pending', sha256: payload.sha256, size: payload.size } } : {}) };
        if (mergeHistory({ records: {}, quarantined: {} }, [candidate], this.options.vaultId).quarantined[r.recordId])
            throw new Error('Invalid durable history record');
        const apply = operation.apply;
        if (operation.type === 'apply' && (!apply || apply.operationId !== operation.id || apply.path !== operation.path || apply.namespace !== r.namespace || apply.kind !== r.kind || typeof apply.deleted !== 'boolean' || !(apply.expectedHash === null || apply.expectedHash === 'folder' || /^[a-f0-9]{64}$/.test(apply.expectedHash))))
            throw new Error('Invalid durable guarded application');
        if (operation.type === 'publish' && operation.id !== r.operationId)
            throw new Error('Invalid durable publication identity');
    }
    /**
     * Read-only comparison support. These two methods deliberately never touch
     * plan(), which persists state on an incomplete scan, and never reach
     * save/prepare/stage/saveOperation/perform/apply. They read the durable
     * state written by the last preview or run, so the heads a user was shown
     * stay exactly the heads they resolve against; nothing is collapsed,
     * auto-selected, or repaired here.
     */
    private displayedConflict(state: HistoryControllerState, entityId: string): HistoryConflict {
        const conflict = state.conflicts.find(item => item.entityId === entityId);
        if (!conflict || !conflict.heads.length)
            throw new Error('Conflict selection is stale');
        return conflict;
    }
    async describeConflict(entityId: string, signal: AbortSignal): Promise<HistoryConflictComparison> {
        return this.exclusive(signal, async () => {
            const state = await this.load(signal);
            const conflict = this.displayedConflict(state, entityId);
            const records = conflict.heads.map(id => {
                const found = state.history.records[id];
                if (!found || found.entityId !== entityId)
                    throw new Error('Invalid conflict heads');
                return found;
            });
            const heads: HistoryComparisonVersion[] = records.map(r => ({ recordId: r.recordId, deviceId: r.deviceId, kind: r.kind, deleted: r.deleted, name: r.location.name, parentId: r.location.parentId, ...(r.blob ? { size: r.blob.size, sha256: r.blob.sha256 } : {}) }));
            const name = nameOf(conflict.path);
            let blocker: HistoryComparisonBlocker | undefined = conflict.namespace !== 'content' ? 'portable-config'
                : records.some(r => r.kind !== 'file') ? 'folder'
                    : records.some(r => r.deleted) ? 'deleted-version'
                        : records.some(r => r.location.name !== name || r.location.parentId !== records[0].location.parentId) ? 'rename-or-move'
                            : !/\.md$/i.test(conflict.path) ? 'non-markdown'
                                : records.some(r => !r.blob) ? 'missing-content'
                                    : records.some(r => r.blob!.size > SYNC_CONFLICT_COMPARE_MAX_BYTES) ? 'oversize'
                                        : undefined;
            const local: HistoryComparisonLocal = { path: conflict.path, present: false };
            if (blocker !== 'portable-config' && blocker !== 'folder') {
                this.assert(signal);
                let bytes: ArrayBuffer | undefined;
                // Absence is a legitimate comparison outcome, not a failure; a
                // cancelled context is re-raised by the assertion that follows.
                try { bytes = await this.ports.read({ namespace: conflict.namespace, path: conflict.path, kind: 'file' }); }
                catch { bytes = undefined; }
                this.assert(signal);
                if (!bytes)
                    blocker ??= 'missing-content';
                else {
                    local.present = true;
                    local.size = bytes.byteLength;
                    if (bytes.byteLength > SYNC_CONFLICT_COMPARE_MAX_BYTES)
                        blocker ??= 'oversize';
                    else
                        local.sha256 = await this.hash(bytes, signal);
                }
            }
            return { entityId, namespace: conflict.namespace, path: conflict.path, reason: conflict.reason, heads, local, comparable: !blocker, ...(blocker ? { notComparable: blocker } : {}) };
        });
    }
    async readConflictText(entityId: string, choice: HistoryComparisonChoice, signal: AbortSignal): Promise<string> {
        return this.exclusive(signal, async () => {
            const state = await this.load(signal);
            const conflict = this.displayedConflict(state, entityId);
            if (choice.kind === 'current') {
                const bytes = await this.checked(signal, () => this.ports.read({ namespace: conflict.namespace, path: conflict.path, kind: 'file' }));
                if (bytes.byteLength > SYNC_CONFLICT_COMPARE_MAX_BYTES)
                    throw new Error(COMPARE_OVERSIZE);
                return decodeText(bytes);
            }
            const chosen = state.history.records[choice.recordId];
            if (!chosen || chosen.entityId !== entityId || !conflict.heads.includes(choice.recordId))
                throw new Error('Invalid selected conflict version');
            if (chosen.deleted || chosen.kind !== 'file')
                throw new Error('Selected version has no comparable text');
            if (!chosen.blob)
                throw new Error('Missing content reference');
            if (chosen.blob.size > SYNC_CONFLICT_COMPARE_MAX_BYTES)
                throw new Error(COMPARE_OVERSIZE);
            const bytes = await this.verified(await this.checked(signal, () => this.options.session.readBlob(chosen.blob!, signal)), chosen.blob.sha256, chosen.blob.size, signal);
            return decodeText(bytes);
        });
    }
    async resolve(resolution: HistoryResolution, signal: AbortSignal): Promise<HistoryPreview> {
        return this.exclusive(signal, async () => {
            const state = await this.load(signal);
            if (state.pendingBatch?.length)
                throw new Error('Resume pending sync before conflict resolution');
            const displayed = state.conflicts.find(c => c.entityId === resolution.entityId);
            if (!displayed || !sameHeads(displayed.heads, resolution.heads) || !resolution.heads.length)
                throw new Error('Conflict selection is stale');
            const plan = await this.plan(state, signal);
            const parents = resolution.heads.map(id => state.history.records[id]);
            if (parents.some(r => !r || r.entityId !== resolution.entityId))
                throw new Error('Invalid conflict heads');
            const local = plan.resources.get(resolution.entityId);
            const chosen = resolution.choice.kind === 'version' ? state.history.records[resolution.choice.recordId] : undefined;
            if (resolution.choice.kind === 'version' && (!chosen || chosen.entityId !== resolution.entityId || !resolution.heads.includes(chosen.recordId)))
                throw new Error('Invalid selected conflict version');
            const template = chosen ?? parents[0];
            let resource = local;
            let selectedData: ArrayBuffer | undefined;
            const selectedParent = chosen?.location.parentId ? deriveHistory(state.history).entities[chosen.location.parentId] : undefined;
            if (chosen?.location.parentId && !selectedParent?.path)
                throw new Error('Resolve the parent folder conflict first');
            const selectedPath = chosen ? `${selectedParent?.path ? `${selectedParent.path}/` : ''}${chosen.location.name}` : local?.path ?? displayed.path;
            const destination = plan.snapshot.entries.find(r => r.namespace === displayed.namespace && r.path === selectedPath);
            if (chosen && destination && destination.path !== local?.path)
                throw new Error('Selected version destination is occupied');
            if (chosen && !chosen.deleted && chosen.kind === 'file') {
                selectedData = await this.verified(await this.checked(signal, () => this.options.session.readBlob(chosen.blob!, signal)), chosen.blob!.sha256, chosen.blob!.size, signal);
                resource = { namespace: chosen.namespace, path: selectedPath, kind: 'file', sha256: chosen.blob!.sha256, size: chosen.blob!.size };
            }
            if (chosen && !chosen.deleted && chosen.kind === 'folder')
                resource = { namespace: chosen.namespace, path: selectedPath, kind: 'folder' };
            if (chosen?.deleted)
                resource = undefined;
            if (chosen?.deleted && chosen.kind === 'folder' && local && plan.snapshot.entries.some(r => r.namespace === local.namespace && r.path.startsWith(`${local.path}/`)))
                throw new Error('Resolve or move descendants before deleting their folder');
            if (local && local.kind !== template.kind)
                throw new Error('Resolve kind replacement by moving the local resource to a different path');
            const actualLocation = chosen?.location ?? plan.locations.get(resolution.entityId) ?? state.history.records[state.baseline[resolution.entityId]?.heads[0]]?.location;
            if (!actualLocation)
                throw new Error('Current conflict location is unavailable');
            // Last guard, after every pre-existing one and before any write: a
            // caller that reviewed a specific local snapshot must not publish
            // on behalf of bytes nobody looked at. Absent-vs-supplied (either
            // direction) is stale. Omitting the field preserves prior behavior.
            if (resolution.reviewedLocalSha256 !== undefined && (local?.kind === 'file' ? local.sha256 : undefined) !== resolution.reviewedLocalSha256)
                throw new Error('This device\'s file changed since it was reviewed; compare again');
            const publish: PublishAction = { type: 'publish', entityId: resolution.entityId, namespace: displayed.namespace, path: selectedPath, kind: template.kind, parents: [...resolution.heads].sort(), location: actualLocation, deleted: !resource, resource };
            let operation: HistoryOperation;
            if (selectedData) {
                const id = this.ports.newId(), record: HistoryRecord = { ...template, recordId: this.ports.newId(), operationId: id, deviceId: this.options.deviceId, parents: publish.parents };
                delete record.blob;
                const payload = { key: await this.checked(signal, () => this.ports.stage(id, selectedData!)), sha256: resource!.sha256!, size: resource!.size! };
                operation = { id, type: 'publish', phase: 'prepared', record, entityId: record.entityId, path: selectedPath, payload, baseline: { namespace: record.namespace, path: selectedPath, kind: record.kind, present: true, heads: [record.recordId], sha256: payload.sha256 } };
                await this.checked(signal, () => this.ports.saveOperation(operation));
            }
            else
                operation = await this.prepare(publish, signal);
            const operations = [operation];
            if (chosen) {
                operations.push(await this.prepare({ type: 'apply', record: chosen, path: selectedPath, expected: fingerprint(destination), deleted: chosen.deleted }, signal));
                const cleanup: ApplyAction[] = [];
                if (local && local.path !== selectedPath) {
                    if (local.kind === 'folder') {
                        const descendants = [...plan.resources].filter(([, r]) => r.namespace === local.namespace && r.path.startsWith(`${local.path}/`)).sort(([, a], [, b]) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
                        for (const [id, child] of descendants) {
                            const target = `${selectedPath}/${child.path.slice(local.path.length + 1)}`;
                            if (plan.snapshot.entries.some(r => r.namespace === child.namespace && r.path === target))
                                throw new Error('Selected subtree destination is occupied');
                            const moved = await this.localMove(child, id, target, state.baseline[id], state, signal);
                            operations.push(moved);
                            cleanup.push({ type: 'apply', record: moved.record, path: child.path, expected: fingerprint(child), deleted: true });
                        }
                    }
                    cleanup.push({ type: 'apply', record: chosen, path: local.path, expected: fingerprint(local), deleted: true });
                }
                cleanup.sort((a, b) => b.path.split('/').length - a.path.split('/').length);
                for (const action of cleanup)
                    operations.push(await this.prepare(action, signal));
            }
            state.pendingBatch = operations.map(op => op.id);
            await this.save(state, signal);
            for (const op of operations)
                await this.perform(op, plan.snapshot, signal);
            this.finish(state, operations);
            const after = await this.plan(state, signal);
            await this.save(state, signal);
            return after.preview;
        });
    }
}
