import { SYNC_MAX_FILE_BYTES, type HistoryRecord } from './history-types';
export interface HistoryStore { records: Record<string, HistoryRecord>; quarantined: Record<string, { reason: string; variants?: unknown[] }> }
export interface HistoryEntity { heads: string[]; record?: HistoryRecord; path?: string; namespace: 'content' | 'portable-config'; blocked?: string }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const dictionary = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const onlyKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 255 && new TextEncoder().encode(value).byteLength <= 255 && value === value.normalize('NFC')
    && !/[\x00-\x1f\x7f/\\:*?"<>|]/.test(value) && !/[. ]$/.test(value)
    && !/^(\.|\.\.|\.geode|\.geode-trash|\.obsidian|\.git|\.trash)$/i.test(value)
    && !value.toLowerCase().includes('.sync-conflict-')
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

function validate(value: unknown, vaultId: string): value is HistoryRecord {
  if (!object(value) || value.schema !== 1 || value.vaultId !== vaultId || !isUuid(value.vaultId)
    || !isUuid(value.recordId) || !isUuid(value.operationId) || !isUuid(value.deviceId) || !isUuid(value.entityId)
    || (value.namespace !== 'content' && value.namespace !== 'portable-config') || (value.kind !== 'file' && value.kind !== 'folder')
    || typeof value.deleted !== 'boolean' || !Array.isArray(value.parents) || !value.parents.every(isUuid)
    || new Set(value.parents).size !== value.parents.length || value.parents.includes(value.recordId)
    || !object(value.location) || !validName(value.location.name)
    || !(value.location.parentId === null || isUuid(value.location.parentId)) || value.location.parentId === value.entityId
    || !onlyKeys(value, ['schema','vaultId','recordId','operationId','deviceId','entityId','namespace','parents','kind','deleted','location','blob'])
    || !onlyKeys(value.location, ['parentId','name'])) return false;
  if (value.kind === 'folder' || value.deleted) return value.blob === undefined;
  return object(value.blob) && onlyKeys(value.blob, ['id','sha256','size']) && typeof value.blob.id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value.blob.id)
    && typeof value.blob.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.blob.sha256)
    && typeof value.blob.size === 'number' && Number.isSafeInteger(value.blob.size) && value.blob.size >= 0 && value.blob.size <= SYNC_MAX_FILE_BYTES;
}

function snapshotInvalid(raw: unknown): unknown {
  try { return JSON.parse(JSON.stringify(raw) ?? 'null') as unknown; }
  catch {
    // Non-JSON input cannot come from Drive, but must not poison durable state.
    if (!object(raw)) return null;
    return Object.fromEntries(['recordId','entityId','namespace'].filter(key => typeof raw[key] === 'string').map(key => [key, raw[key]]));
  }
}

/** Canonicalize only validated fields; parent order has no causal significance. */
function cloneRecord(r: HistoryRecord): HistoryRecord {
  return { schema: 1, vaultId: r.vaultId, recordId: r.recordId, operationId: r.operationId, deviceId: r.deviceId,
    entityId: r.entityId, namespace: r.namespace, parents: [...r.parents].sort(), kind: r.kind, deleted: r.deleted,
    location: { parentId: r.location.parentId, name: r.location.name },
    ...(r.blob ? { blob: { id: r.blob.id, sha256: r.blob.sha256, size: r.blob.size } } : {}) };
}

/** Union is monotonic, including quarantine: a replay can never rehabilitate an ambiguous ID. */
export function mergeHistory(store: HistoryStore, batch: unknown[], vaultId: string): HistoryStore {
  const records = Object.assign(dictionary<HistoryRecord>(), store.records);
  const quarantined = Object.assign(dictionary<HistoryStore['quarantined'][string]>(), store.quarantined);
  for (const raw of batch) {
    const id = object(raw) && typeof raw.recordId === 'string' ? raw.recordId : 'invalid-record-without-id';
    const valid = validate(raw, vaultId);
    const incoming = valid ? cloneRecord(raw) : snapshotInvalid(raw);
    const prior = records[id];
    if (!valid || quarantined[id] || (prior && JSON.stringify(cloneRecord(prior)) !== JSON.stringify(incoming))) {
      const variants = [...(quarantined[id]?.variants ?? []), ...(prior ? [prior] : []), incoming];
      // Keep evidence without making delivery order select a canonical winner.
      const unique = new Map<string, unknown>();
      for (const variant of variants) {
        let key: string;
        try { key = JSON.stringify(variant) ?? String(variant); } catch { key = '[unserializable-record]'; }
        unique.set(key, variant);
      }
      quarantined[id] = { reason: 'invalid-or-contradictory-record', variants: [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v) };
      delete records[id];
    } else if (!prior) records[id] = incoming as HistoryRecord;
  }
  return { records, quarantined };
}

export function deriveHistory(store: HistoryStore): { entities: Record<string, HistoryEntity>; pending: string[]; quarantined: Record<string, string> } {
  const entities = dictionary<HistoryEntity>();
  const quarantined = dictionary<string>();
  const records = store.records;
  const ids = Object.keys(records).sort();
  const members = new Map<string, HistoryRecord[]>();
  const pending = new Set<string>();
  const invalid = new Set<string>();
  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const ambiguousLocations: Array<{ entityId: string; namespace: HistoryRecord['namespace']; location: HistoryRecord['location'] }> = [];
  const addMember = (r: HistoryRecord) => { const list = members.get(r.entityId) ?? []; list.push(r); members.set(r.entityId, list); };
  for (const id of ids) addMember(records[id]);
  for (const [id, entry] of Object.entries(store.quarantined)) {
    quarantined[id] = entry.reason;
    for (const v of entry.variants ?? []) {
      if (object(v) && isUuid(v.entityId) && (v.namespace === 'content' || v.namespace === 'portable-config')) {
        const namespace = entities[v.entityId]?.namespace === 'content' ? 'content' : v.namespace;
        entities[v.entityId] = { heads: [], namespace, blocked: 'quarantined-history' };
        if (object(v.location) && validName(v.location.name) && (v.location.parentId === null || isUuid(v.location.parentId))) {
          ambiguousLocations.push({ entityId: v.entityId, namespace: v.namespace, location: { parentId: v.location.parentId, name: v.location.name } });
        }
      }
    }
  }
  const entityKinds = new Map<string, { kind: HistoryRecord['kind']; namespace: HistoryRecord['namespace']; inconsistent: boolean }>();
  for (const [id, list] of members) entityKinds.set(id, {
    kind: list[0].kind, namespace: list[0].namespace,
    inconsistent: list.some(r => r.kind !== list[0].kind || r.namespace !== list[0].namespace),
  });
  for (const id of ids) {
    const r = records[id]; let count = 0;
    if (r.location.parentId) {
      const parent = entityKinds.get(r.location.parentId);
      if (entities[r.location.parentId]?.blocked || parent?.inconsistent || (parent && (parent.kind !== 'folder' || parent.namespace !== r.namespace))) invalid.add(id);
      else if (!parent) pending.add(id);
    }
    for (const parentId of r.parents) {
      const parent = records[parentId];
      if (store.quarantined[parentId]) invalid.add(id);
      else if (!parent) pending.add(id);
      else {
        count++; const list = children.get(parentId) ?? []; list.push(id); children.set(parentId, list);
        if (parent.entityId !== r.entityId || parent.kind !== r.kind || parent.namespace !== r.namespace) invalid.add(id);
      }
    }
    indegree.set(id, count);
  }
  // Iterative topological validation avoids recursion limits on long edit histories.
  const queue = ids.filter(id => indegree.get(id) === 0);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    for (const child of children.get(id) ?? []) {
      if (invalid.has(id)) invalid.add(child);
      if (pending.has(id)) pending.add(child);
      const count = indegree.get(child)! - 1; indegree.set(child, count);
      if (count === 0) queue.push(child);
    }
  }
  for (const id of ids) {
    if (indegree.get(id)! > 0) invalid.add(id);
    if (invalid.has(id)) { quarantined[id] = 'invalid-causal-ancestry'; pending.delete(id); }
  }
  const candidates = new Map<string, HistoryRecord>();
  const headRecords = new Map<string, HistoryRecord[]>();
  for (const [entityId, list] of members) {
    const superseded = new Set(list.flatMap(r => r.parents));
    const heads = list.filter(r => !superseded.has(r.recordId)).sort((a,b) => a.recordId.localeCompare(b.recordId));
    headRecords.set(entityId, heads);
    const entity: HistoryEntity = entities[entityId] ?? { heads: [], namespace: list[0].namespace };
    entity.heads = heads.map(r => r.recordId);
    const changedType = entityKinds.get(entityId)!.inconsistent;
    if (changedType) for (const r of list) quarantined[r.recordId] = 'entity-type-change';
    if (changedType || list.some(r => invalid.has(r.recordId))) entity.blocked = 'quarantined-history';
    else if (!entity.blocked && list.some(r => pending.has(r.recordId))) entity.blocked = 'pending-history';
    else if (!entity.blocked && heads.length !== 1) entity.blocked = 'concurrent-heads';
    if (!entity.blocked) candidates.set(entityId, heads[0]);
    entities[entityId] = entity;
  }
  const dependents = new Map<string, Set<string>>();
  const ancestors = new Map<string, Set<string>>();
  const occupied = new Map<string, Set<string>>();
  const addLocation = (entityId: string, namespace: HistoryRecord['namespace'], location: HistoryRecord['location'], deleted: boolean) => {
    if (location.parentId) {
      const set = dependents.get(location.parentId) ?? new Set<string>(); set.add(entityId); dependents.set(location.parentId, set);
      const parents = ancestors.get(entityId) ?? new Set<string>(); parents.add(location.parentId); ancestors.set(entityId, parents);
    }
    if (!deleted) {
      // Conservatively reserve compatibility/case equivalents across desktop filesystems.
      const foldedName = location.name.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFC');
      const key = `${namespace}:${location.parentId ?? ''}:${foldedName}`;
      const set = occupied.get(key) ?? new Set<string>(); set.add(entityId); occupied.set(key, set);
    }
  };
  for (const [entityId, heads] of headRecords) {
    for (const r of heads) addLocation(entityId, r.namespace, r.location, r.deleted);
  }
  for (const r of ambiguousLocations) addLocation(r.entityId, r.namespace, r.location, false);
  for (const set of occupied.values()) if (set.size > 1) for (const id of set) entities[id].blocked = 'path-collision';

  // A tombstoned folder is safe only if every known descendant is resolved deleted.
  const unsafe = new Set(Object.keys(entities).filter(id => entities[id].blocked || !candidates.get(id)?.deleted));
  const unsafeQueue = [...unsafe];
  for (let index = 0; index < unsafeQueue.length; index++) {
    for (const parentId of ancestors.get(unsafeQueue[index]) ?? []) {
      const parent = candidates.get(parentId);
      if (parent?.deleted) entities[parentId].blocked = 'live-or-unresolved-descendants';
      if (!unsafe.has(parentId)) { unsafe.add(parentId); unsafeQueue.push(parentId); }
    }
  }
  const paths = new Map<string, string>();
  const visited = new Set<string>();
  for (const entityId of Object.keys(entities).sort()) {
    if (visited.has(entityId)) continue;
    const chain: string[] = []; const visiting = new Set<string>(); let current: string | null = entityId;
    while (current && !visited.has(current)) {
      if (visiting.has(current)) { for (const id of chain) entities[id].blocked = 'cyclic-folder-ancestry'; break; }
      visiting.add(current); chain.push(current);
      const r = candidates.get(current);
      if (!r || entities[current].blocked) break;
      const parentId: string | null = r.location.parentId;
      if (!parentId) break;
      const parent = candidates.get(parentId);
      if (!entities[parentId]) { entities[current].blocked = 'pending-folder'; pending.add(r.recordId); break; }
      if (parent && (parent.kind !== 'folder' || parent.namespace !== r.namespace)) {
        entities[current].blocked = 'invalid-folder-ancestry'; quarantined[r.recordId] = 'invalid-folder-ancestry'; break;
      }
      current = parentId;
    }
    for (let index = chain.length - 1; index >= 0; index--) {
      const id = chain[index]; const r = candidates.get(id); visited.add(id);
      if (!r || entities[id].blocked) continue;
      const parentId = r.location.parentId;
      if (parentId && (!paths.has(parentId) || entities[parentId]?.blocked)) {
        entities[id].blocked = 'blocked-folder-ancestry';
        if (entities[parentId]?.blocked?.startsWith('pending') || headRecords.get(parentId)?.some(h => pending.has(h.recordId))) pending.add(r.recordId);
      } else paths.set(id, parentId ? `${paths.get(parentId)}/${r.location.name}` : r.location.name);
    }
  }
  // Propagate blockers found after a child was visited (e.g. sibling collisions).
  const blockedQueue = Object.keys(entities).filter(id => entities[id].blocked);
  const blocked = new Set(blockedQueue);
  for (let index = 0; index < blockedQueue.length; index++) {
    for (const child of dependents.get(blockedQueue[index]) ?? []) if (!blocked.has(child)) {
      entities[child].blocked = 'blocked-folder-ancestry'; blocked.add(child); blockedQueue.push(child);
    }
  }
  for (const [id, r] of candidates) if (!entities[id].blocked && paths.has(id)) { entities[id].record = r; entities[id].path = paths.get(id); }
  return { entities, pending: [...pending].sort(), quarantined };
}
