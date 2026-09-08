import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { HistoryController, type HistoryControllerState, type HistoryControllerPorts, type HistoryOperation, type HistoryLocalSnapshot, type HistoryLocalResource, type HistoryApply } from '../../src/renderer/sync/history-controller';
import { type AppendOnlySession, type HistoryRecord, type BlobRef } from '../../src/renderer/sync/history-types';
const vault = randomUUID();
const signal = () => new AbortController().signal;
const encode = (value: string) => new TextEncoder().encode(value).buffer;
const hash = (data: ArrayBuffer) => createHash('sha256').update(new Uint8Array(data)).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function remote() {
    const records = new Map<string, HistoryRecord>();
    const blobs = new Map<string, ArrayBuffer>();
    let putFailure = false;
    let badRead = false;
    let reset = false;
    const session: AppendOnlySession = {
        scan: async () => ({ status: 'complete', records: [...records.values()], cursor: String(records.size), reset }),
        putBlob: async (input) => { const id = input.operationId; blobs.set(id, input.data.slice(0)); if (putFailure) {
            putFailure = false;
            throw new Error('lost upload response');
        } return { id, sha256: input.sha256, size: input.size }; },
        readBlob: async (ref) => badRead ? encode('corrupt') : blobs.get(ref.id)!.slice(0),
        appendRecord: async (record) => { const prior = records.get(record.recordId); if (prior && JSON.stringify(prior) !== JSON.stringify(record))
            throw new Error('contradictory replay'); records.set(record.recordId, clone(record)); }, close: async () => { },
    };
    return { session, records, blobs, failPut: () => { putFailure = true; }, corrupt: () => { badRead = true; }, reset: () => { reset = true; } };
}
function client(r: ReturnType<typeof remote>, initial: Record<string, string> = {}) {
    const files = new Map<string, ArrayBuffer>(Object.entries(initial).map(([path, text]) => [path, encode(text)]));
    const folders = new Set<string>();
    for (const path of files.keys()) {
        const parts = path.split('/');
        for (let i = 1; i < parts.length; i++)
            folders.add(parts.slice(0, i).join('/'));
    }
    let state: HistoryControllerState | null = null;
    const operations = new Map<string, HistoryOperation>();
    const staged = new Map<string, ArrayBuffer>();
    const applied = new Set<string>();
    let scopeKey = 'all', excluded: string[] = [], blocked: string[] = [];
    let authority = true;
    let guardFailure = false;
    let metadataBytes = 0;
    let savedStates = 0;
    let reads = 0;
    const deviceId = randomUUID();
    const ports: HistoryControllerPorts = {
        load: async () => state ? clone(state) : null, save: async (next) => { metadataBytes += JSON.stringify(next).length; savedStates++; state = clone(next); },
        loadOperations: async () => [...operations.values()].map(clone), saveOperation: async (op) => { metadataBytes += JSON.stringify(op).length; operations.set(op.id, clone(op)); },
        snapshot: async () => ({ authoritative: authority, scopeKey, entries: [...[...folders].map(path => ({ namespace: 'content' as const, path, kind: 'folder' as const })), ...[...files].map(([path, data]) => ({ namespace: 'content' as const, path, kind: 'file' as const, sha256: hash(data), size: data.byteLength }))], excluded: excluded.map(path => ({ namespace: 'content' as const, path, reason: 'excluded' })), blocked: blocked.map(path => ({ namespace: 'content' as const, path, reason: 'blocked' })) }),
        read: async (resource) => { reads++; return files.get(resource.path)!.slice(0); }, stage: async (id, data) => { const prior = staged.get(id); if (prior && hash(prior) !== hash(data))
            throw new Error('stage overwrite'); staged.set(id, data.slice(0)); return id; }, readStage: async (key) => staged.get(key)!.slice(0),
        apply: async (input) => {
            if (applied.has(input.operationId))
                return;
            if (guardFailure)
                throw new Error('guard mismatch');
            const current = files.has(input.path) ? hash(files.get(input.path)!) : folders.has(input.path) ? 'folder' : null;
            if (current !== input.expectedHash)
                throw new Error('guard mismatch');
            if (input.deleted) {
                if (input.kind === 'folder') {
                    if ([...files.keys(), ...folders].some(p => p.startsWith(`${input.path}/`)))
                        throw new Error('nonempty folder');
                    folders.delete(input.path);
                }
                else
                    files.delete(input.path);
            }
            else if (input.kind === 'folder')
                folders.add(input.path);
            else
                files.set(input.path, input.data!.slice(0));
            applied.add(input.operationId);
        }, isIncluded: (_ns, path) => !excluded.some(p => path === p || path.startsWith(`${p}/`)), assertContext: () => { }, newId: () => randomUUID(),
    };
    const make = () => new HistoryController({ vaultId: vault, deviceId, bindingKey: `${deviceId}:${vault}`, session: r.session, ports });
    let controller = make();
    return { files, folders, ports, operations, staged, get controller() { return controller; }, restart: () => { controller = make(); }, setFile: (path: string, text: string) => files.set(path, encode(text)), text: (path: string) => files.has(path) ? new TextDecoder().decode(files.get(path)) : undefined,
        exclude: (paths: string[]) => { excluded = paths; scopeKey = JSON.stringify(paths); }, block: (paths: string[]) => { blocked = paths; }, authority: (value: boolean) => { authority = value; }, failGuard: (value: boolean) => { guardFailure = value; }, state: () => state, metrics: () => ({ metadataBytes, savedStates, reads }) };
}
async function start(c: ReturnType<typeof client>) { await c.controller.preview(signal()); return c.controller.run({ approvePreview: true }, signal()); }
describe('append-only history controller', () => {
    for (const folder of [false, true]) it(`allocates a fresh identity when a committed ${folder ? 'folder' : 'file'} old path is reused after rename`, async () => {
        const r = remote(), a = client(r, folder ? { 'a/n.md': 'one' } : { 'a.md': 'one' });
        await start(a);
        const originalIds = new Set([...r.records.values()].map(record => record.entityId));
        if (folder) { a.folders.delete('a'); a.folders.add('b'); a.files.delete('a/n.md'); a.setFile('b/n.md', 'one'); }
        else { a.files.delete('a.md'); a.setFile('b.md', 'one'); }
        await a.controller.run({}, signal());
        a.restart();
        if (folder) { a.folders.add('a'); a.setFile('a/new.md', 'new'); }
        else a.setFile('a.md', 'new');
        const first = await a.controller.preview(signal());
        const second = await a.controller.preview(signal());
        expect(second.signature).toBe(first.signature);
        await a.controller.run({ approvePreview: true }, signal());
        const newIds = new Set([...r.records.values()].map(record => record.entityId));
        expect(newIds.size).toBe(originalIds.size + (folder ? 2 : 1));
        const b = client(r); await start(b);
        expect(b.text(folder ? 'b/n.md' : 'b.md')).toBe('one');
        expect(b.text(folder ? 'a/new.md' : 'a.md')).toBe('new');
    });
    it('imports a remote portable category over un-authored defaults on a fresh device', async () => {
        const r = remote(), a = client(r, { 'editor.json': 'remote config' }), b = client(r, { 'editor.json': 'defaults' });
        const entityId = randomUUID();
        for (const [c, initialDefault] of [[a, false], [b, true]] as const) {
            const snapshot = c.ports.snapshot;
            c.ports.snapshot = async () => ({ ...await snapshot(), entries: [{ namespace: 'portable-config', path: 'editor.json', kind: 'file', sha256: hash(c.files.get('editor.json')!), size: c.files.get('editor.json')!.byteLength, entityId, ...(initialDefault ? { initialDefault: true } : {}) }] });
        }
        await start(a); const result = await start(b);
        expect(result.conflicts).toEqual([]); expect(b.text('editor.json')).toBe('remote config'); expect(r.records.size).toBe(1);
    });
    it('blocks missing blobs even for equal local bytes while unrelated files progress and availability can recover', async () => {
        const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a);
        const record = [...r.records.values()][0]; let status: 'pending'|'available' = 'pending';
        const scan = r.session.scan;
        r.session.scan = async (...args) => ({ ...await scan(...args), reset: true, blobAvailability: [{ id: record.blob!.id, status }] });
        const b = client(r, { 'a.md': 'one', 'b.md': 'unrelated' });
        const blocked = await start(b); expect(blocked.blocked).toContainEqual({ namespace: 'content', path: 'a.md', reason: 'pending-blob' });
        expect([...r.records.values()].some(item => item.location.name === 'b.md')).toBe(true);
        expect(Object.values(b.state()!.baseline).some(item => item.path === 'a.md')).toBe(false);
        status = 'available'; const recovered = await b.controller.run({}, signal()); expect(recovered.blocked).toEqual([]); expect(recovered.upToDate).toBe(true);
    });
    it('keeps corruption sticky for a physical blob but permits a healthy later head', async () => {
        const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const original = [...r.records.values()][0];
        const scan = r.session.scan; let status: 'corrupt'|'available' = 'corrupt';
        r.session.scan = async (...args) => ({ ...await scan(...args), blobAvailability: [{ id: original.blob!.id, status }] });
        expect((await a.controller.preview(signal())).blocked).toContainEqual({ namespace: 'content', path: 'a.md', reason: 'corrupt-blob' });
        status = 'available'; expect((await a.controller.preview(signal())).blocked).toHaveLength(1);
        const data = encode('two'), id = randomUUID(); r.blobs.set(id, data);
        const next = { ...original, recordId: randomUUID(), operationId: randomUUID(), parents: [original.recordId], blob: { id, sha256: hash(data), size: data.byteLength } }; r.records.set(next.recordId, next);
        const result = await a.controller.run({}, signal()); expect(result.blocked).toEqual([]); expect(a.text('a.md')).toBe('two');
    });
    it('requires exact preview approval before first publication', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await expect(a.controller.run({}, signal())).rejects.toThrow(); expect(r.records.size).toBe(0); await start(a); expect(r.records.size).toBe(1); });
    it('rejects stale first-sync preview after local edits', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await a.controller.preview(signal()); a.setFile('a.md', 'two'); await expect(a.controller.run({ approvePreview: true }, signal())).rejects.toThrow(); expect(r.records.size).toBe(0); });
    it('converges two independent clients and reconstructs a third from history', async () => { const r = remote(), a = client(r, { 'Folder/a.md': 'one' }); await start(a); const b = client(r); await start(b); expect(b.text('Folder/a.md')).toBe('one'); a.setFile('Folder/a.md', 'two'); await a.controller.run({}, signal()); await b.controller.run({}, signal()); expect(b.text('Folder/a.md')).toBe('two'); const c = client(r); await start(c); expect(c.text('Folder/a.md')).toBe('two'); });
    it('adopts identical first-join bytes without duplicate publication', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const b = client(r, { 'a.md': 'one' }); await start(b); expect(r.records.size).toBe(1); expect(Object.keys(b.state()!.baseline)).toHaveLength(1); });
    it('preserves different first-join bytes as a concurrent branch', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const b = client(r, { 'a.md': 'two' }); const result = await start(b); expect(b.text('a.md')).toBe('two'); expect(result.conflicts).toHaveLength(1); expect(r.records.size).toBe(2); });
    it('uses acknowledged parents for offline concurrent edits', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const b = client(r); await start(b); a.setFile('a.md', 'from A'); b.setFile('a.md', 'from B'); await a.controller.run({}, signal()); const result = await b.controller.run({}, signal()); expect(result.conflicts).toHaveLength(1); expect(a.text('a.md')).toBe('from A'); expect(b.text('a.md')).toBe('from B'); const branches = [...r.records.values()].filter(x => x.parents.length); expect(branches[0].parents).toEqual(branches[1].parents); });
    it('resumes interrupted upload with immutable staged bytes and original IDs', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await a.controller.preview(signal()); r.failPut(); await expect(a.controller.run({ approvePreview: true }, signal())).rejects.toThrow('lost upload response'); const id = [...a.operations.keys()][0]; a.setFile('a.md', 'later'); a.restart(); await a.controller.run({}, signal()); expect(a.operations.has(id)).toBe(true); expect([...r.records.values()].some(x => x.blob?.sha256 === hash(encode('one')))).toBe(true); expect(a.text('a.md')).toBe('later'); });
    it('never infers new-device absence or scope exclusion as deletion', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const b = client(r); await start(b); b.exclude(['a.md']); b.files.delete('a.md'); await b.controller.preview(signal()); await b.controller.run({ approvePreview: true }, signal()); expect([...r.records.values()].some(x => x.deleted)).toBe(false); });
    it('publishes explicit baseline-backed deletion and applies it remotely', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const b = client(r); await start(b); a.files.delete('a.md'); await a.controller.run({}, signal()); await b.controller.run({}, signal()); expect(b.files.has('a.md')).toBe(false); expect([...r.records.values()].some(x => x.deleted)).toBe(true); });
    it('does not publish deletions for blocked or incomplete local snapshots', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); a.files.delete('a.md'); a.block(['a.md']); const result = await a.controller.run({}, signal()); expect(result.upToDate).toBe(false); expect(r.records.size).toBe(1); a.block([]); a.authority(false); await expect(a.controller.run({}, signal())).rejects.toThrow(); expect(r.records.size).toBe(1); });
    it('rejects corrupt downloaded blob bytes before local mutation', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const b = client(r); await b.controller.preview(signal()); r.corrupt(); await expect(b.controller.run({ approvePreview: true }, signal())).rejects.toThrow(); expect(b.files.size).toBe(0); });
    it('retains a failed guarded-apply journal and retries after restart', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const b = client(r); await b.controller.preview(signal()); b.failGuard(true); await expect(b.controller.run({ approvePreview: true }, signal())).rejects.toThrow('guard mismatch'); expect(b.state()!.pendingBatch?.length).toBeGreaterThan(0); b.failGuard(false); b.restart(); await b.controller.run({}, signal()); expect(b.text('a.md')).toBe('one'); });
    it('keeps unseen branches unresolved when resolving displayed heads', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const b = client(r), c = client(r); await start(b); await start(c); a.setFile('a.md', 'A'); b.setFile('a.md', 'B'); await a.controller.run({}, signal()); const conflict = (await b.controller.run({}, signal())).conflicts[0]; c.setFile('a.md', 'C'); await c.controller.run({}, signal()); const result = await b.controller.resolve({ entityId: conflict.entityId, heads: conflict.heads, choice: { kind: 'current' } }, signal()); expect(result.conflicts).toHaveLength(1); const resolution = [...r.records.values()].find(x => x.parents.length === 2)!; expect(resolution.parents.sort()).toEqual(conflict.heads.sort()); });
    it('retains history on reset scans and does not treat omitted remote records as deletions', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); r.records.clear(); r.reset(); await a.controller.run({}, signal()); expect(a.text('a.md')).toBe('one'); expect(Object.keys(a.state()!.history.records)).toHaveLength(1); });
    it('detects unique file renames without replacing entity identity', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const original = [...r.records.values()][0]; a.files.delete('a.md'); a.setFile('b.md', 'one'); await a.controller.run({}, signal()); expect([...r.records.values()].every(x => x.entityId === original.entityId)).toBe(true); const b = client(r); await start(b); expect(b.text('b.md')).toBe('one'); expect(b.files.has('a.md')).toBe(false); });
    it('keeps ten thousand publications linear in persisted metadata bytes', async () => { const r = remote(), initial = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`${i}.md`, `value-${i}`])); const a = client(r, initial); await start(a); expect(r.records.size).toBe(10000); expect(a.metrics().metadataBytes).toBeLessThan(80000000); expect(a.metrics().savedStates).toBeLessThan(12); }, 30000);
    it('retains stable folder identity for an unambiguous subtree rename and safely moves another client', async () => {
        const r = remote(), a = client(r, { 'Old/a.md': 'one', 'Old/nested/b.md': 'two' });
        await start(a);
        const before = [...r.records.values()].find(x => x.kind === 'folder' && x.location.name === 'Old')!;
        const b = client(r);
        await start(b);
        a.files.delete('Old/a.md');
        a.files.delete('Old/nested/b.md');
        a.folders.clear();
        a.folders.add('New');
        a.folders.add('New/nested');
        a.setFile('New/a.md', 'one');
        a.setFile('New/nested/b.md', 'two');
        await a.controller.run({}, signal());
        const rename = [...r.records.values()].find(x => x.kind === 'folder' && x.location.name === 'New')!;
        expect(rename.entityId).toBe(before.entityId);
        await b.controller.run({}, signal());
        expect(b.text('New/a.md')).toBe('one');
        expect(b.text('New/nested/b.md')).toBe('two');
        expect(b.folders.has('Old')).toBe(false);
    });
    it('publishes and applies empty-directory deletion after child deletion', async () => { const r = remote(), a = client(r, { 'Folder/a.md': 'one' }); await start(a); const b = client(r); await start(b); a.files.clear(); a.folders.clear(); await a.controller.run({}, signal()); await b.controller.run({}, signal()); expect(b.files.size).toBe(0); expect(b.folders.size).toBe(0); });
    it('does not erase a concurrently edited child when its folder is deleted', async () => { const r = remote(), a = client(r, { 'Folder/a.md': 'one' }); await start(a); const b = client(r); await start(b); a.files.clear(); a.folders.clear(); b.setFile('Folder/a.md', 'edited'); await a.controller.run({}, signal()); const out = await b.controller.run({}, signal()); expect(b.text('Folder/a.md')).toBe('edited'); expect(out.upToDate).toBe(false); expect(out.conflicts.length).toBeGreaterThan(0); });
    it('rejects a malformed persisted state instead of silently resetting history', async () => { const r = remote(), a = client(r); a.ports.load = async () => ({ schema: 99 }); await expect(a.controller.preview(signal())).rejects.toThrow('Unsupported sync state'); expect(r.records.size).toBe(0); });
    it('honors context cancellation after a late upload response without publishing a record', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await a.controller.preview(signal()); const abort = new AbortController(); const put = r.session.putBlob; r.session.putBlob = async (...args) => { const result = await put(...args); abort.abort(); return result; }; await expect(a.controller.run({ approvePreview: true }, abort.signal)).rejects.toThrow(); expect(r.records.size).toBe(0); expect(a.state()!.pendingBatch?.length).toBe(1); });
    it('keeps a receipt recoverable when apply commits before its refresh callback fails', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const b = client(r); await b.controller.preview(signal()); const apply = b.ports.apply; let fail = true; b.ports.apply = async (input) => { await apply(input); if (fail) {
        fail = false;
        throw new Error('refresh failed');
    } }; await expect(b.controller.run({ approvePreview: true }, signal())).rejects.toThrow('refresh failed'); expect(Object.keys(b.state()!.baseline)).toHaveLength(0); b.restart(); await b.controller.run({}, signal()); expect(b.text('a.md')).toBe('one'); expect(b.state()!.pendingBatch).toBeUndefined(); });
    it('preserves selected remote conflict bytes through guarded explicit resolution', async () => { const r = remote(), a = client(r, { 'a.md': 'A' }); await start(a); const b = client(r, { 'a.md': 'B' }); const out = await start(b); const conflict = out.conflicts[0], version = [...r.records.values()].find(x => x.blob?.sha256 === hash(encode('A')))!; await b.controller.resolve({ entityId: conflict.entityId, heads: conflict.heads, choice: { kind: 'version', recordId: version.recordId } }, signal()); expect(b.text('a.md')).toBe('A'); expect((await b.controller.run({}, signal())).conflicts).toHaveLength(0); });
    it('can explicitly stop retrying a stale guarded batch without overwriting the changed local file', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const b = client(r); await b.controller.preview(signal()); b.failGuard(true); await expect(b.controller.run({ approvePreview: true }, signal())).rejects.toThrow(); b.setFile('a.md', 'local later'); b.failGuard(false); const result = await b.controller.abandonPending(signal()); expect(result.requiresApproval).toBe(true); expect(b.text('a.md')).toBe('local later'); expect(b.state()!.pendingBatch).toBeUndefined(); expect([...b.operations.values()].some(o => o.phase === 'abandoned')).toBe(true); await b.controller.preview(signal()); const next = await b.controller.run({ approvePreview: true }, signal()); expect(next.conflicts).toHaveLength(1); });
    it('does not publish file-to-folder kind replacement into the original identity', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); a.files.delete('a.md'); a.folders.add('a.md'); const result = await a.controller.run({}, signal()); expect(result.conflicts).toHaveLength(1); expect(r.records.size).toBe(1); expect(Object.keys(a.state()!.history.quarantined)).toHaveLength(0); });
    it('rejects duplicate local resource identity instead of last-map-wins', async () => { const r = remote(), a = client(r, { 'a.md': 'one', 'b.md': 'two' }); const snapshot = a.ports.snapshot; const identity = randomUUID(); a.ports.snapshot = async () => { const value = await snapshot(); return { ...value, entries: value.entries.map(e => ({ ...e, entityId: identity })) }; }; await expect(a.controller.preview(signal())).rejects.toThrow(); expect(r.records.size).toBe(0); });
    it('uses the actual local path when resolving concurrent rename heads as current', async () => { const r = remote(), a = client(r, { 'base.md': 'one' }); await start(a); const b = client(r); await start(b); a.files.delete('base.md'); a.setFile('A.md', 'one'); b.files.delete('base.md'); b.setFile('B.md', 'one'); await a.controller.run({}, signal()); const out = await b.controller.run({}, signal()); const conflict = out.conflicts[0]; await b.controller.resolve({ entityId: conflict.entityId, heads: conflict.heads, choice: { kind: 'current' } }, signal()); const last = [...r.records.values()].find(x => x.parents.length === 2)!; expect(last.location.name).toBe('B.md'); expect(last.deleted).toBe(false); });
    it('applies a selected renamed file at that version location rather than the display fallback', async () => { const r = remote(), a = client(r, { 'base.md': 'one' }); await start(a); const b = client(r); await start(b); a.files.delete('base.md'); a.setFile('A.md', 'one'); b.files.delete('base.md'); b.setFile('B.md', 'one'); await a.controller.run({}, signal()); const conflict = (await b.controller.run({}, signal())).conflicts[0]; const chosen = [...r.records.values()].find(x => x.location.name === 'A.md')!; await b.controller.resolve({ entityId: conflict.entityId, heads: conflict.heads, choice: { kind: 'version', recordId: chosen.recordId } }, signal()); expect(b.text('A.md')).toBe('one'); expect(b.files.has('B.md')).toBe(false); expect((await b.controller.run({}, signal())).conflicts).toHaveLength(0); });
    it('applies a selected folder rename through guarded child moves while retaining edited child bytes', async () => { const r = remote(), a = client(r, { 'Old/a.md': 'one' }); await start(a); const b = client(r); await start(b); a.files.delete('Old/a.md'); a.folders.clear(); a.folders.add('A'); a.setFile('A/a.md', 'one'); b.files.delete('Old/a.md'); b.folders.clear(); b.folders.add('B'); b.setFile('B/a.md', 'one'); await a.controller.run({}, signal()); const conflicts = (await b.controller.run({}, signal())).conflicts; const chosen = [...r.records.values()].find(x => x.kind === 'folder' && x.location.name === 'A')!; const conflict = conflicts.find(x => x.entityId === chosen.entityId)!; b.setFile('B/a.md', 'local edit'); await b.controller.resolve({ entityId: conflict.entityId, heads: conflict.heads, choice: { kind: 'version', recordId: chosen.recordId } }, signal()); expect(b.text('A/a.md')).toBe('local edit'); expect(b.folders.has('B')).toBe(false); });
    it('does not mutate anything when staging the second intent fails with ENOSPC', async () => { const r = remote(), a = client(r, { 'a.md': 'one', 'b.md': 'two' }); await a.controller.preview(signal()); const stage = a.ports.stage; let calls = 0; a.ports.stage = async (...args) => { if (++calls === 2)
        throw new Error('ENOSPC'); return stage(...args); }; await expect(a.controller.run({ approvePreview: true }, signal())).rejects.toThrow('ENOSPC'); expect(r.records.size).toBe(0); expect(r.blobs.size).toBe(0); expect(a.operations.size).toBe(1); a.ports.stage = stage; a.restart(); await start(a); expect(r.records.size).toBe(2); expect([...a.operations.values()].filter(x => x.phase === 'prepared')).toHaveLength(1); });
    it('keeps unchanged-but-excluded pending paths recoverable through explicit abandonment', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const b = client(r); await b.controller.preview(signal()); b.failGuard(true); await expect(b.controller.run({ approvePreview: true }, signal())).rejects.toThrow(); b.exclude(['a.md']); b.failGuard(false); const after = await b.controller.abandonPending(signal()); expect(after.requiresApproval).toBe(true); expect(after.excluded).toHaveLength(1); expect(b.state()!.pendingBatch).toBeUndefined(); });
    it('rejects a foreign-vault pending intent before replaying any provider mutation', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await a.controller.preview(signal()); r.failPut(); await expect(a.controller.run({ approvePreview: true }, signal())).rejects.toThrow(); const intent = [...a.operations.values()][0]; intent.record.vaultId = randomUUID(); a.restart(); await expect(a.controller.run({}, signal())).rejects.toThrow(); expect(r.records.size).toBe(0); });
    it('preserves a partial scan union without advancing the durable cursor or mutating canonical data', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const cursor = a.state()!.cursor; const parent = [...r.records.values()][0]; const change = { ...parent, recordId: randomUUID(), operationId: randomUUID(), parents: [parent.recordId] }; r.session.scan = async () => ({ status: 'partial', records: [change], cursor: 'must-not-commit' }); a.setFile('a.md', 'later'); await expect(a.controller.run({}, signal())).rejects.toThrow('Complete remote history scan'); expect(a.state()!.cursor).toBe(cursor); expect(a.state()!.history.records[change.recordId]).toBeDefined(); expect(r.records.size).toBe(1); expect(a.text('a.md')).toBe('later'); });
    it('blocks a missing structural parent but continues an unrelated root file', async () => { const r = remote(), a = client(r, { 'nested/a.md': 'one', 'root.md': 'two' }); const snapshot = a.ports.snapshot; a.ports.snapshot = async () => { const current = await snapshot(); return { ...current, entries: current.entries.filter(x => x.kind === 'file') }; }; const out = await start(a); expect(out.blocked.some(x => x.path === 'nested/a.md')).toBe(true); expect([...r.records.values()].some(x => x.location.name === 'root.md')).toBe(true); expect(out.upToDate).toBe(false); });
    it('keeps ambiguous empty-folder renames visible rather than replacing their identities', async () => { const r = remote(), a = client(r); a.folders.add('OldA'); a.folders.add('OldB'); await start(a); a.folders.clear(); a.folders.add('NewA'); a.folders.add('NewB'); const out = await a.controller.run({}, signal()); expect(out.blocked.some(x => x.reason === 'ambiguous-rename')).toBe(true); expect(r.records.size).toBe(2); });
    it('retains an untracked new child during selected folder-location resolution', async () => { const r = remote(), a = client(r, { 'Old/a.md': 'one' }); await start(a); const b = client(r); await start(b); a.files.delete('Old/a.md'); a.folders.clear(); a.folders.add('A'); a.setFile('A/a.md', 'one'); b.files.delete('Old/a.md'); b.folders.clear(); b.folders.add('B'); b.setFile('B/a.md', 'one'); await a.controller.run({}, signal()); const conflicts = (await b.controller.run({}, signal())).conflicts; const chosen = [...r.records.values()].find(x => x.kind === 'folder' && x.location.name === 'A')!; b.setFile('B/new.md', 'new local'); await b.controller.resolve({ entityId: chosen.entityId, heads: conflicts.find(x => x.entityId === chosen.entityId)!.heads, choice: { kind: 'version', recordId: chosen.recordId } }, signal()); expect(b.text('A/new.md')).toBe('new local'); expect(b.files.has('B/new.md')).toBe(false); });
    it('bounds metadata persistence for ten thousand files in structural folders and reconstructs them', async () => { const r = remote(), initial = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => [`Folder-${Math.floor(i / 100)}/${i}.md`, `value-${i}`])); const a = client(r, initial); await start(a); expect(r.records.size).toBe(10100); expect(a.metrics().metadataBytes).toBeLessThan(85000000); const b = client(r); await start(b); expect(b.files.size).toBe(10000); expect(b.folders.size).toBe(100); expect(b.metrics().metadataBytes).toBeLessThan(70000000); }, 30000);
    it('does not publish a kind replacement when remote file history is already concurrent', async () => { const r = remote(), a = client(r, { 'a.md': 'one' }); await start(a); const b = client(r); await start(b); a.setFile('a.md', 'A'); b.setFile('a.md', 'B'); await a.controller.run({}, signal()); await b.controller.run({}, signal()); b.files.delete('a.md'); b.folders.add('a.md'); const count = r.records.size; await b.controller.run({}, signal()); expect(r.records.size).toBe(count); });
    it('makes unidentifiable quarantined history visible as a blocker', async () => { const r = remote(), a = client(r); r.session.scan = async () => ({ status: 'complete', records: [{ schema: 9, unexpected: true }] }); const out = await a.controller.preview(signal()); expect(out.blocked.length + out.conflicts.length).toBeGreaterThan(0); expect(out.upToDate).toBe(false); });
});
