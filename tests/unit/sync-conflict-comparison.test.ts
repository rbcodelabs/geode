import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { HistoryController, type HistoryConflict, type HistoryControllerPorts, type HistoryControllerState, type HistoryOperation } from '../../src/renderer/sync/history-controller';
import { APPEND_ONLY_PROTOCOL, SYNC_CONFLICT_COMPARE_MAX_BYTES, type AppendOnlySession, type HistoryRecord } from '../../src/renderer/sync/history-types';
import { SyncService } from '../../src/renderer/sync/sync-service';

const vault = randomUUID();
const signal = () => new AbortController().signal;
const encode = (value: string) => new TextEncoder().encode(value).buffer as ArrayBuffer;
const hash = (data: ArrayBuffer) => createHash('sha256').update(new Uint8Array(data)).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/* ------------------------------------------------------------------ *
 * Multi-client harness (mirrors tests/unit/sync-history-controller)    *
 * ------------------------------------------------------------------ */
function remote() {
    const records = new Map<string, HistoryRecord>();
    const blobs = new Map<string, ArrayBuffer>();
    const session: AppendOnlySession = {
        scan: async () => ({ status: 'complete', records: [...records.values()], cursor: String(records.size) }),
        putBlob: async (input) => { blobs.set(input.operationId, input.data.slice(0)); return { id: input.operationId, sha256: input.sha256, size: input.size }; },
        readBlob: async (ref) => { const value = blobs.get(ref.id); if (!value) throw new Error('missing blob'); return value.slice(0); },
        appendRecord: async (record) => { records.set(record.recordId, clone(record)); }, close: async () => { },
    };
    return { session, records, blobs };
}

function client(r: ReturnType<typeof remote>, initial: Record<string, string> = {}) {
    const files = new Map<string, ArrayBuffer>(Object.entries(initial).map(([path, text]) => [path, encode(text)]));
    const folders = new Set<string>();
    for (const path of files.keys()) { const parts = path.split('/'); for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/')); }
    let state: HistoryControllerState | null = null;
    const operations = new Map<string, HistoryOperation>();
    const staged = new Map<string, ArrayBuffer>();
    const applied = new Set<string>();
    const writes = { save: 0, saveOperation: 0, stage: 0, apply: 0 };
    const deviceId = randomUUID();
    const ports: HistoryControllerPorts = {
        load: async () => state ? clone(state) : null,
        save: async (next) => { writes.save++; state = clone(next); },
        loadOperations: async () => [...operations.values()].map(clone),
        saveOperation: async (op) => { writes.saveOperation++; operations.set(op.id, clone(op)); },
        snapshot: async () => ({ authoritative: true, scopeKey: 'all', entries: [...[...folders].map(path => ({ namespace: 'content' as const, path, kind: 'folder' as const })), ...[...files].map(([path, data]) => ({ namespace: 'content' as const, path, kind: 'file' as const, sha256: hash(data), size: data.byteLength }))], excluded: [], blocked: [] }),
        read: async (resource) => { const value = files.get(resource.path); if (!value) throw new Error('missing local file'); return value.slice(0); },
        stage: async (id, data) => { writes.stage++; staged.set(id, data.slice(0)); return id; },
        readStage: async (key) => staged.get(key)!.slice(0),
        apply: async (input) => {
            writes.apply++;
            if (applied.has(input.operationId)) return;
            const current = files.has(input.path) ? hash(files.get(input.path)!) : folders.has(input.path) ? 'folder' : null;
            if (current !== input.expectedHash) throw new Error('guard mismatch');
            if (input.deleted) { if (input.kind === 'folder') folders.delete(input.path); else files.delete(input.path); }
            else if (input.kind === 'folder') folders.add(input.path);
            else files.set(input.path, input.data!.slice(0));
            applied.add(input.operationId);
        },
        isIncluded: () => true, assertContext: () => { }, newId: () => randomUUID(),
    };
    const controller = new HistoryController({ vaultId: vault, deviceId, bindingKey: `${deviceId}:${vault}`, session: r.session, ports });
    return {
        files, folders, ports, controller, writes,
        setFile: (path: string, text: string) => files.set(path, encode(text)),
        text: (path: string) => files.has(path) ? new TextDecoder().decode(files.get(path)!) : undefined,
        state: () => state,
        resetWrites: () => { writes.save = 0; writes.saveOperation = 0; writes.stage = 0; writes.apply = 0; },
    };
}

async function start(c: ReturnType<typeof client>) { await c.controller.preview(signal()); return c.controller.run({ approvePreview: true }, signal()); }

/** Two clients diverging on the same Markdown path. */
async function diverged(left = 'from A', right = 'from B') {
    const r = remote();
    const a = client(r, { 'a.md': 'base' }); await start(a);
    const b = client(r); await start(b);
    a.setFile('a.md', left); b.setFile('a.md', right);
    await a.controller.run({}, signal());
    const conflict = (await b.controller.run({}, signal())).conflicts[0];
    b.resetWrites();
    return { r, a, b, conflict };
}

/* ------------------------------------------------------------------ *
 * Seeded controller: crafted durable state, no planning, no writes     *
 * ------------------------------------------------------------------ */
const deviceId = randomUUID();
const record = (over: Partial<HistoryRecord> & { entityId: string }): HistoryRecord => ({
    schema: 1, vaultId: vault, recordId: randomUUID(), operationId: randomUUID(), deviceId: randomUUID(),
    namespace: 'content', parents: [], kind: 'file', deleted: false, location: { parentId: null, name: 'a.md' }, ...over,
});

function seeded(input: { conflict: HistoryConflict; records: HistoryRecord[]; files?: Record<string, ArrayBuffer>; blobs?: Record<string, ArrayBuffer> }) {
    const state: HistoryControllerState = {
        schema: 1, bindingKey: `${deviceId}:${vault}`, vaultId: vault, deviceId,
        history: { records: Object.fromEntries(input.records.map(r => [r.recordId, r])), quarantined: {} },
        baseline: {}, reservedEntities: {}, approved: true, conflicts: [input.conflict], blocked: [], completedOperations: [],
    };
    const files = new Map<string, ArrayBuffer>(Object.entries(input.files ?? {}));
    const blobs = new Map<string, ArrayBuffer>(Object.entries(input.blobs ?? {}));
    const forbidden = (name: string) => async (): Promise<never> => { throw new Error(`unexpected write: ${name}`); };
    const session: AppendOnlySession = {
        scan: async () => { throw new Error('unexpected scan'); },
        putBlob: forbidden('putBlob'), appendRecord: forbidden('appendRecord'),
        readBlob: async (ref) => { const value = blobs.get(ref.id); if (!value) throw new Error('missing blob'); return value.slice(0); },
        close: async () => { },
    };
    const ports: HistoryControllerPorts = {
        load: async () => clone(state), save: forbidden('save'), loadOperations: async () => [], saveOperation: forbidden('saveOperation'),
        snapshot: async () => { throw new Error('unexpected snapshot'); },
        read: async (resource) => { const value = files.get(resource.path); if (!value) throw new Error('missing local file'); return value.slice(0); },
        stage: forbidden('stage'), readStage: forbidden('readStage'), apply: forbidden('apply'),
        isIncluded: () => true, assertContext: () => { }, newId: () => randomUUID(),
    };
    return { controller: new HistoryController({ vaultId: vault, deviceId, bindingKey: `${deviceId}:${vault}`, session, ports }), session, blobs };
}

const textHead = (entityId: string, text: string, over: Partial<HistoryRecord> = {}) => {
    const data = encode(text), id = randomUUID();
    return { data, blobId: id, record: record({ entityId, blob: { id, sha256: hash(data), size: data.byteLength }, ...over }) };
};

describe('conflict comparison — describe', () => {
    it('describes a same-path Markdown conflict across three heads without any write', async () => {
        const r = remote();
        const a = client(r, { 'a.md': 'base' }); await start(a);
        const b = client(r); await start(b);
        const c = client(r); await start(c);
        a.setFile('a.md', 'AAA'); b.setFile('a.md', 'BBB'); c.setFile('a.md', 'CCC');
        await a.controller.run({}, signal());
        await b.controller.run({}, signal());
        await c.controller.run({}, signal());
        const conflict = (await b.controller.run({}, signal())).conflicts[0];
        expect(conflict.heads).toHaveLength(3);

        b.resetWrites();
        const putBlob = vi.spyOn(r.session, 'putBlob'); const appendRecord = vi.spyOn(r.session, 'appendRecord');
        const comparison = await b.controller.describeConflict(conflict.entityId, signal());

        expect(comparison.entityId).toBe(conflict.entityId);
        expect(comparison.namespace).toBe('content');
        expect(comparison.path).toBe('a.md');
        expect(comparison.comparable).toBe(true);
        expect(comparison.notComparable).toBeUndefined();
        expect(comparison.heads).toHaveLength(3);
        for (const head of comparison.heads) {
            expect(conflict.heads).toContain(head.recordId);
            expect(head.deviceId).toMatch(/^[0-9a-f-]{36}$/);
            expect(head.kind).toBe('file');
            expect(head.deleted).toBe(false);
            expect(head.sha256).toMatch(/^[a-f0-9]{64}$/);
            expect(head.size).toBeGreaterThan(0);
        }
        expect(comparison.local).toMatchObject({ present: true, path: 'a.md', sha256: hash(encode('BBB')) });
        expect(b.writes).toEqual({ save: 0, saveOperation: 0, stage: 0, apply: 0 });
        expect(putBlob).not.toHaveBeenCalled(); expect(appendRecord).not.toHaveBeenCalled();
        expect(r.records.size).toBe(4);
        expect(b.state()!.conflicts).toHaveLength(1);
    });

    it('rejects an unknown conflict entity as stale', async () => {
        const { b } = await diverged();
        await expect(b.controller.describeConflict(randomUUID(), signal())).rejects.toThrow(/stale/i);
    });

    for (const scenario of [
        { name: 'portable-config', blocker: 'portable-config', build: () => { const entityId = randomUUID(); const one = textHead(entityId, 'one', { namespace: 'portable-config', location: { parentId: null, name: 'editor.json' } }), two = textHead(entityId, 'two', { namespace: 'portable-config', location: { parentId: null, name: 'editor.json' } }); return { conflict: { entityId, namespace: 'portable-config' as const, path: 'editor.json', heads: [one.record.recordId, two.record.recordId], reason: 'concurrent-heads' }, records: [one.record, two.record], blobs: { [one.blobId]: one.data, [two.blobId]: two.data }, files: { 'editor.json': encode('local') } }; } },
        { name: 'folder', blocker: 'folder', build: () => { const entityId = randomUUID(); const one = record({ entityId, kind: 'folder', location: { parentId: null, name: 'Notes' } }), two = record({ entityId, kind: 'folder', location: { parentId: null, name: 'Notes' } }); return { conflict: { entityId, namespace: 'content' as const, path: 'Notes', heads: [one.recordId, two.recordId], reason: 'concurrent-heads' }, records: [one, two] }; } },
        { name: 'delete', blocker: 'deleted-version', build: () => { const entityId = randomUUID(); const one = textHead(entityId, 'one'); const two = record({ entityId, deleted: true }); return { conflict: { entityId, namespace: 'content' as const, path: 'a.md', heads: [one.record.recordId, two.recordId], reason: 'concurrent-heads' }, records: [one.record, two], blobs: { [one.blobId]: one.data }, files: { 'a.md': encode('local') } }; } },
        { name: 'rename or move', blocker: 'rename-or-move', build: () => { const entityId = randomUUID(); const one = textHead(entityId, 'one', { location: { parentId: null, name: 'A.md' } }), two = textHead(entityId, 'two', { location: { parentId: null, name: 'B.md' } }); return { conflict: { entityId, namespace: 'content' as const, path: 'A.md', heads: [one.record.recordId, two.record.recordId], reason: 'concurrent-heads' }, records: [one.record, two.record], blobs: { [one.blobId]: one.data, [two.blobId]: two.data }, files: { 'A.md': encode('local') } }; } },
        { name: 'non-Markdown', blocker: 'non-markdown', build: () => { const entityId = randomUUID(); const one = textHead(entityId, 'one', { location: { parentId: null, name: 'a.txt' } }), two = textHead(entityId, 'two', { location: { parentId: null, name: 'a.txt' } }); return { conflict: { entityId, namespace: 'content' as const, path: 'a.txt', heads: [one.record.recordId, two.record.recordId], reason: 'concurrent-heads' }, records: [one.record, two.record], blobs: { [one.blobId]: one.data, [two.blobId]: two.data }, files: { 'a.txt': encode('local') } }; } },
    ] as const) it(`reports a ${scenario.name} conflict as not comparable`, async () => {
        const built = scenario.build() as Parameters<typeof seeded>[0];
        const { controller } = seeded(built);
        const comparison = await controller.describeConflict(built.conflict.entityId, signal());
        expect(comparison.comparable).toBe(false);
        expect(comparison.notComparable).toBe(scenario.blocker);
        expect(comparison.heads).toHaveLength(built.conflict.heads.length);
    });

    it('reports an oversize remote head as not comparable without reading it', async () => {
        const entityId = randomUUID();
        const one = textHead(entityId, 'small');
        const big = textHead(entityId, 'big');
        big.record.blob = { id: big.blobId, sha256: big.record.blob!.sha256, size: SYNC_CONFLICT_COMPARE_MAX_BYTES + 1 };
        const { controller, session } = seeded({ conflict: { entityId, namespace: 'content', path: 'a.md', heads: [one.record.recordId, big.record.recordId], reason: 'concurrent-heads' }, records: [one.record, big.record], blobs: { [one.blobId]: one.data, [big.blobId]: big.data }, files: { 'a.md': encode('local') } });
        const readBlob = vi.spyOn(session, 'readBlob');
        const comparison = await controller.describeConflict(entityId, signal());
        expect(comparison.comparable).toBe(false);
        expect(comparison.notComparable).toBe('oversize');
        expect(readBlob).not.toHaveBeenCalled();
    });

    it('reports an oversize local file as not comparable', async () => {
        const entityId = randomUUID();
        const one = textHead(entityId, 'one'), two = textHead(entityId, 'two');
        const big = new Uint8Array(SYNC_CONFLICT_COMPARE_MAX_BYTES + 1).fill(0x61).buffer;
        const { controller } = seeded({ conflict: { entityId, namespace: 'content', path: 'a.md', heads: [one.record.recordId, two.record.recordId], reason: 'concurrent-heads' }, records: [one.record, two.record], blobs: { [one.blobId]: one.data, [two.blobId]: two.data }, files: { 'a.md': big } });
        const comparison = await controller.describeConflict(entityId, signal());
        expect(comparison.comparable).toBe(false);
        expect(comparison.notComparable).toBe('oversize');
        expect(comparison.local.present).toBe(true);
    });

    it('reports a missing local file as not comparable', async () => {
        const entityId = randomUUID();
        const one = textHead(entityId, 'one'), two = textHead(entityId, 'two');
        const { controller } = seeded({ conflict: { entityId, namespace: 'content', path: 'a.md', heads: [one.record.recordId, two.record.recordId], reason: 'concurrent-heads' }, records: [one.record, two.record], blobs: { [one.blobId]: one.data, [two.blobId]: two.data } });
        const comparison = await controller.describeConflict(entityId, signal());
        expect(comparison.comparable).toBe(false);
        expect(comparison.notComparable).toBe('missing-content');
        expect(comparison.local.present).toBe(false);
    });

    it('honors cancellation while describing', async () => {
        const { b, conflict } = await diverged();
        const abort = new AbortController(); abort.abort();
        await expect(b.controller.describeConflict(conflict.entityId, abort.signal)).rejects.toThrow();
    });
});

describe('conflict comparison — read', () => {
    it('lazily reads each of three heads and the local file without any write', async () => {
        const r = remote();
        const a = client(r, { 'a.md': 'base' }); await start(a);
        const b = client(r); await start(b);
        const c = client(r); await start(c);
        a.setFile('a.md', 'AAA'); b.setFile('a.md', 'BBB'); c.setFile('a.md', 'CCC');
        await a.controller.run({}, signal());
        await b.controller.run({}, signal());
        await c.controller.run({}, signal());
        const conflict = (await b.controller.run({}, signal())).conflicts[0];

        b.resetWrites();
        const putBlob = vi.spyOn(r.session, 'putBlob'); const appendRecord = vi.spyOn(r.session, 'appendRecord');
        const texts: string[] = [];
        for (const recordId of conflict.heads) texts.push(await b.controller.readConflictText(conflict.entityId, { kind: 'version', recordId }, signal()));
        expect(texts.sort()).toEqual(['AAA', 'BBB', 'CCC']);
        expect(await b.controller.readConflictText(conflict.entityId, { kind: 'current' }, signal())).toBe('BBB');
        expect(b.writes).toEqual({ save: 0, saveOperation: 0, stage: 0, apply: 0 });
        expect(putBlob).not.toHaveBeenCalled(); expect(appendRecord).not.toHaveBeenCalled();
        expect(r.records.size).toBe(4);
    });

    it('rejects a head that does not belong to the displayed conflict', async () => {
        const { b, conflict } = await diverged();
        await expect(b.controller.readConflictText(conflict.entityId, { kind: 'version', recordId: randomUUID() }, signal())).rejects.toThrow(/invalid selected conflict version/i);
    });

    it('rejects an oversize head instead of loading it inline', async () => {
        const entityId = randomUUID();
        const one = textHead(entityId, 'one');
        const big = textHead(entityId, 'big');
        big.record.blob = { id: big.blobId, sha256: big.record.blob!.sha256, size: SYNC_CONFLICT_COMPARE_MAX_BYTES + 1 };
        const { controller } = seeded({ conflict: { entityId, namespace: 'content', path: 'a.md', heads: [one.record.recordId, big.record.recordId], reason: 'concurrent-heads' }, records: [one.record, big.record], blobs: { [one.blobId]: one.data, [big.blobId]: big.data }, files: { 'a.md': encode('local') } });
        await expect(controller.readConflictText(entityId, { kind: 'version', recordId: big.record.recordId }, signal())).rejects.toThrow(/1 MiB/);
    });

    it('rejects an oversize local file instead of loading it inline', async () => {
        const entityId = randomUUID();
        const one = textHead(entityId, 'one'), two = textHead(entityId, 'two');
        const big = new Uint8Array(SYNC_CONFLICT_COMPARE_MAX_BYTES + 1).fill(0x61).buffer;
        const { controller } = seeded({ conflict: { entityId, namespace: 'content', path: 'a.md', heads: [one.record.recordId, two.record.recordId], reason: 'concurrent-heads' }, records: [one.record, two.record], blobs: { [one.blobId]: one.data, [two.blobId]: two.data }, files: { 'a.md': big } });
        await expect(controller.readConflictText(entityId, { kind: 'current' }, signal())).rejects.toThrow(/1 MiB/);
    });

    it('rejects corrupt blob bytes with the integrity error', async () => {
        const entityId = randomUUID();
        const one = textHead(entityId, 'one'), two = textHead(entityId, 'two');
        const { controller, blobs } = seeded({ conflict: { entityId, namespace: 'content', path: 'a.md', heads: [one.record.recordId, two.record.recordId], reason: 'concurrent-heads' }, records: [one.record, two.record], blobs: { [one.blobId]: one.data, [two.blobId]: two.data }, files: { 'a.md': encode('local') } });
        blobs.set(one.blobId, encode('tampered bytes'));
        await expect(controller.readConflictText(entityId, { kind: 'version', recordId: one.record.recordId }, signal())).rejects.toThrow(/integrity/i);
    });

    it('rejects a head whose blob is unavailable', async () => {
        const entityId = randomUUID();
        const one = textHead(entityId, 'one'), two = textHead(entityId, 'two');
        const { controller, blobs } = seeded({ conflict: { entityId, namespace: 'content', path: 'a.md', heads: [one.record.recordId, two.record.recordId], reason: 'concurrent-heads' }, records: [one.record, two.record], blobs: { [one.blobId]: one.data, [two.blobId]: two.data }, files: { 'a.md': encode('local') } });
        blobs.delete(one.blobId);
        await expect(controller.readConflictText(entityId, { kind: 'version', recordId: one.record.recordId }, signal())).rejects.toThrow(/missing blob/);
    });

    it('rejects a head that carries no content reference', async () => {
        const entityId = randomUUID();
        const one = textHead(entityId, 'one'), two = textHead(entityId, 'two');
        delete one.record.blob;
        const { controller } = seeded({ conflict: { entityId, namespace: 'content', path: 'a.md', heads: [one.record.recordId, two.record.recordId], reason: 'concurrent-heads' }, records: [one.record, two.record], blobs: { [two.blobId]: two.data }, files: { 'a.md': encode('local') } });
        await expect(controller.readConflictText(entityId, { kind: 'version', recordId: one.record.recordId }, signal())).rejects.toThrow(/content reference/i);
    });

    for (const side of ['version', 'current'] as const) it(`rejects invalid UTF-8 from the ${side} side`, async () => {
        const entityId = randomUUID();
        const garbage = new Uint8Array([0xff, 0xfe, 0xfd, 0x80]).buffer;
        const blobId = randomUUID();
        const one = record({ entityId, blob: { id: blobId, sha256: hash(garbage), size: garbage.byteLength } });
        const two = textHead(entityId, 'two');
        const { controller } = seeded({ conflict: { entityId, namespace: 'content', path: 'a.md', heads: [one.recordId, two.record.recordId], reason: 'concurrent-heads' }, records: [one, two.record], blobs: { [blobId]: garbage, [two.blobId]: two.data }, files: { 'a.md': side === 'current' ? garbage : encode('local') } });
        const choice = side === 'current' ? { kind: 'current' as const } : { kind: 'version' as const, recordId: one.recordId };
        await expect(controller.readConflictText(entityId, choice, signal())).rejects.toThrow(/UTF-8/);
    });

    it('cancels a pending head read mid-flight', async () => {
        const { b, conflict } = await diverged();
        const abort = new AbortController();
        const original = b.controller['options'].session.readBlob.bind(b.controller['options'].session);
        b.controller['options'].session.readBlob = async (ref, s) => { const value = await original(ref, s); abort.abort(); return value; };
        await expect(b.controller.readConflictText(conflict.entityId, { kind: 'version', recordId: conflict.heads[0] }, abort.signal)).rejects.toThrow();
    });
});

describe('reviewed local snapshot precondition', () => {
    for (const kind of ['current', 'version'] as const) it(`accepts a ${kind} resolution whose reviewed local hash still matches`, async () => {
        const { r, b, conflict } = await diverged();
        const chosen = [...r.records.values()].find(x => x.blob?.sha256 === hash(encode('from A')))!;
        const choice = kind === 'current' ? { kind: 'current' as const } : { kind: 'version' as const, recordId: chosen.recordId };
        const result = await b.controller.resolve({ entityId: conflict.entityId, heads: conflict.heads, choice, reviewedLocalSha256: hash(encode('from B')) }, signal());
        expect(result.conflicts).toHaveLength(0);
        expect(b.text('a.md')).toBe(kind === 'current' ? 'from B' : 'from A');
    });

    for (const kind of ['current', 'version'] as const) it(`rejects a ${kind} resolution whose reviewed local hash is stale`, async () => {
        const { r, b, conflict } = await diverged();
        const chosen = [...r.records.values()].find(x => x.blob?.sha256 === hash(encode('from A')))!;
        const choice = kind === 'current' ? { kind: 'current' as const } : { kind: 'version' as const, recordId: chosen.recordId };
        const before = r.records.size;
        await expect(b.controller.resolve({ entityId: conflict.entityId, heads: conflict.heads, choice, reviewedLocalSha256: hash(encode('something else')) }, signal())).rejects.toThrow(/reviewed|compare again/i);
        expect(r.records.size).toBe(before);
        expect(b.text('a.md')).toBe('from B');
        expect(b.state()!.pendingBatch).toBeUndefined();
        expect(b.writes.stage).toBe(0);
        expect(b.writes.apply).toBe(0);
    });

    it('treats a reviewed hash against an absent local file as stale', async () => {
        const { r, b, conflict } = await diverged();
        b.files.delete('a.md');
        const before = r.records.size;
        await expect(b.controller.resolve({ entityId: conflict.entityId, heads: conflict.heads, choice: { kind: 'current' }, reviewedLocalSha256: hash(encode('from B')) }, signal())).rejects.toThrow(/reviewed|compare again/i);
        expect(r.records.size).toBe(before);
    });

    it('rejects a stale reviewed hash even when the local file changed after review', async () => {
        const { r, b, conflict } = await diverged();
        const reviewed = hash(encode('from B'));
        b.setFile('a.md', 'edited after review');
        const before = r.records.size;
        await expect(b.controller.resolve({ entityId: conflict.entityId, heads: conflict.heads, choice: { kind: 'current' }, reviewedLocalSha256: reviewed }, signal())).rejects.toThrow(/reviewed|compare again/i);
        expect(r.records.size).toBe(before);
        expect(b.text('a.md')).toBe('edited after review');
    });

    it('behaves exactly as before when no reviewed hash is supplied', async () => {
        const { b, conflict } = await diverged();
        const result = await b.controller.resolve({ entityId: conflict.entityId, heads: conflict.heads, choice: { kind: 'current' } }, signal());
        expect(result.conflicts).toHaveLength(0);
        expect(b.text('a.md')).toBe('from B');
    });

    it('still rejects a stale head selection before considering the reviewed hash', async () => {
        const { b, conflict } = await diverged();
        await expect(b.controller.resolve({ entityId: conflict.entityId, heads: [randomUUID()], choice: { kind: 'current' }, reviewedLocalSha256: hash(encode('from B')) }, signal())).rejects.toThrow(/stale/i);
    });
});

/* ------------------------------------------------------------------ *
 * SyncService surface                                                  *
 * ------------------------------------------------------------------ */
const descriptor = { schema: 1, protocol: APPEND_ONLY_PROTOCOL, vaultId: randomUUID(), rootId: 'root', descriptorId: 'descriptor', name: 'Shared' };

function historyService() {
    const stored = new Map<string, unknown>(); const operations = new Map<string, unknown>(); const blobs = new Map<string, ArrayBuffer>(); const records: HistoryRecord[] = [];
    let text = 'local text';
    const files = [{ path: 'Note.md', isFolder: false, size: text.length, mtime: 1, ctime: 1 }];
    const host = {
        config: { read: async () => null },
        deviceState: { read: async (key: string) => structuredClone(stored.get(key) ?? null), write: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); }, remove: async (key: string) => { stored.delete(key); } },
        vaultFiles: { onChange: () => () => { }, reconcileScan: async () => ({ status: 'complete', entries: files }), readBinary: async () => encode(text) },
        syncSafety: { claimOwner: async () => 'lease', releaseOwner: async () => { }, storage: async (_t: string, _b: string, request: any) => { if (request.action === 'load-operations') return [...operations.values()]; if (request.action === 'save-operation') { operations.set(request.key, structuredClone(request.value)); return; } if (request.action === 'stage') { blobs.set(request.key, request.data.slice(0)); return request.key; } return blobs.get(request.key)!.slice(0); } },
    };
    const service = new SyncService(host as never, () => '/synthetic/vault');
    service.register('owner', {
        id: 'history', name: 'History', protocol: APPEND_ONLY_PROTOCOL, capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 },
        discover: async () => [descriptor], createVault: async () => descriptor,
        open: async () => ({
            scan: async () => ({ status: 'complete', records: structuredClone(records) }),
            putBlob: async (input: any) => { blobs.set(input.operationId, input.data.slice(0)); return { id: input.operationId, sha256: input.sha256, size: input.size }; },
            readBlob: async (ref: any) => { const value = blobs.get(ref.id); if (!value) throw new Error('missing blob'); return value.slice(0); },
            appendRecord: async (r: any) => { if (!records.some(item => item.recordId === r.recordId)) records.push(structuredClone(r)); }, close: async () => { },
        }),
    } as never);
    return { service, records, blobs, setText: (value: string) => { text = value; files[0].size = value.length; } };
}

describe('sync service conflict comparison surface', () => {
    it('describes and reads a conflict through the guarded controller path', async () => {
        const { service, records, blobs, setText } = historyService();
        try {
            await service.activate('history');
            await service.createVault('Shared');
            await service.updateScope({ other: false, mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });
            await service.preview(); await service.run({ approvePreview: true });
            const note = records.find(r => r.kind === 'file')!;
            const remoteBytes = encode('remote text'); const blobId = randomUUID(); blobs.set(blobId, remoteBytes);
            records.push({ ...note, recordId: randomUUID(), operationId: randomUUID(), deviceId: randomUUID(), parents: [], blob: { id: blobId, sha256: hash(remoteBytes), size: remoteBytes.byteLength } });
            setText('local text');
            await service.preview();
            const conflict = service.getHistoryDetails()!.conflicts[0];
            expect(conflict).toBeDefined();

            const comparison = await service.describeHistoryConflict(conflict.entityId);
            expect(comparison.comparable).toBe(true);
            expect(comparison.path).toBe('Note.md');
            expect(comparison.heads).toHaveLength(2);
            expect(comparison.local.sha256).toBe(hash(encode('local text')));
            expect(await service.readHistoryConflictText(conflict.entityId, { kind: 'current' })).toBe('local text');
            const remoteHead = comparison.heads.find(h => h.sha256 === hash(remoteBytes))!;
            expect(await service.readHistoryConflictText(conflict.entityId, { kind: 'version', recordId: remoteHead.recordId })).toBe('remote text');
        } finally { await service.cancel(); }
    });

    it('requires an append-only provider', async () => {
        const service = new SyncService({} as never, () => '/synthetic/vault');
        await expect(service.describeHistoryConflict(randomUUID())).rejects.toThrow(/provider/i);
        await expect(service.readHistoryConflictText(randomUUID(), { kind: 'current' })).rejects.toThrow(/provider/i);
    });

    it('waits for in-flight sync work instead of failing fast', async () => {
        let release!: () => void;
        const service = new SyncService({ deviceState: { read: async () => null, write: async () => { } } } as never, () => '/synthetic/vault');
        const provider = { id: 'history' };
        (service as any).selected = provider; (service as any).providers.set('history', provider);
        // withController clears this.running in its finally; model that here.
        (service as any).running = new Promise<void>(resolve => { release = () => { (service as any).running = undefined; resolve(); }; });
        const pending = service.describeHistoryConflict(randomUUID());
        const settled = vi.fn(); pending.catch(settled);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(settled).not.toHaveBeenCalled();
        release();
        await expect(pending).rejects.toThrow(/create or join/i);
    });

    it('does not flip global sync status to error when a comparison fails', async () => {
        const service = new SyncService({ deviceState: { read: async () => null, write: async () => { } } } as never, () => '/synthetic/vault');
        (service as any).selected = { id: 'history' };
        (service as any).status = { state: 'conflict', providerId: 'history', conflicts: 1 };
        await expect(service.describeHistoryConflict(randomUUID())).rejects.toThrow();
        expect(service.getStatus().state).toBe('conflict');
        await expect(service.readHistoryConflictText(randomUUID(), { kind: 'current' })).rejects.toThrow();
        expect(service.getStatus().state).toBe('conflict');
        // The same failure through a non-silent path still reports as before.
        await expect(service.preview()).rejects.toThrow();
        expect(service.getStatus().state).toBe('error');
    });

    it('cancels a pending comparison when sync is cancelled', async () => {
        let finish!: (value: unknown) => void;
        const service = new SyncService({ deviceState: { read: () => new Promise(resolve => { finish = resolve; }) }, vaultFiles: { onChange: () => () => { } } } as never, () => '/synthetic/vault');
        (service as any).selected = { id: 'history' };
        const pending = service.describeHistoryConflict(randomUUID());
        const rejection = expect(pending).rejects.toThrow();
        await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
        const cancelling = service.cancel(); finish(null);
        await rejection; await cancelling;
    });
});
