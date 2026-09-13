import { describe, expect, it } from 'vitest';
import { deriveHistory, mergeHistory, type HistoryStore } from '../../src/renderer/sync/history-reducer';
import { type HistoryRecord } from '../../src/renderer/sync/history-types';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const vault = uuid(1);
const empty = (): HistoryStore => ({ records: {}, quarantined: {} });
const record = (n: number, changes: Partial<HistoryRecord> = {}): HistoryRecord => ({ schema: 1, vaultId: vault, recordId: uuid(n), operationId: uuid(n+100000), deviceId: uuid(2), entityId: uuid(n+200000), namespace: 'content', parents: [], kind: 'file', deleted: false, location: { parentId: null, name: `${n}.md` }, blob: { id: `drive-${n}`, sha256: 'a'.repeat(64), size: 3 }, ...changes });
const reduce = (batch: unknown[]) => deriveHistory(mergeHistory(empty(), batch, vault));
describe('immutable history reducer', () => {
  it('projects a valid immutable file and never removes known history on an empty rescan', () => {
    const r = record(10); const store = mergeHistory(empty(), [r], vault);
    expect(deriveHistory(mergeHistory(store, [], vault)).entities[r.entityId]).toMatchObject({ heads: [r.recordId], path: '10.md', record: r });
  });
  it('retains edit/delete heads and only resolves acknowledged branches', () => {
    const a = record(10); const b = record(11, { entityId: a.entityId, parents: [a.recordId] }); const c = record(12, { entityId: a.entityId, parents: [a.recordId], deleted: true, blob: undefined });
    const d = record(13, { entityId: a.entityId, parents: [b.recordId] });
    expect(reduce([d,c,b,a]).entities[a.entityId]).toMatchObject({ heads: [c.recordId,d.recordId], blocked: 'concurrent-heads' });
    const e = record(14, { entityId: a.entityId, parents: [c.recordId,d.recordId] });
    expect(reduce([e,d,c,b,a]).entities[a.entityId].record).toEqual(e);
  });
  it('keeps missing causal ancestry pending until it arrives', () => {
    const a = record(10); const b = record(11, { entityId: a.entityId, parents: [a.recordId] });
    const first = mergeHistory(empty(), [b], vault);
    expect(deriveHistory(first).pending).toContain(b.recordId);
    expect(deriveHistory(first).entities[b.entityId].record).toBeUndefined();
    expect(deriveHistory(mergeHistory(first,[a],vault)).entities[a.entityId].record).toEqual(b);
  });
  it('quarantines contradictory IDs permanently, blocks descendants but leaves unrelated files usable', () => {
    const a = record(10); const b = record(11, { entityId: a.entityId, parents:[a.recordId] }); const other = record(12);
    const state = mergeHistory(empty(), [a,b,other,{...a,location:{parentId:null,name:'different.md'}}],vault);
    expect(state.quarantined[a.recordId]).toBeDefined();
    expect(deriveHistory(mergeHistory(state,[a],vault)).entities[a.entityId].record).toBeUndefined();
    expect(deriveHistory(state).entities[other.entityId].record).toEqual(other);
  });
  it.each(['../x','a/b','a\\b','..','.geode','.sync-conflict-x','A:bad','e\u0301.md','CON','x.'])('rejects unsafe name %s', name => {
    const r = record(10,{location:{parentId:null,name}}); const out = reduce([r]);
    expect(out.quarantined[r.recordId]).toBeDefined();
    expect(out.entities[r.entityId]?.record).toBeUndefined();
  });
  it.each([{schema:2},{vaultId:uuid(99)},{recordId:'bad'},{blob:{id:'x',sha256:'bad',size:3}},{blob:{id:'x',sha256:'a'.repeat(64),size:104857601}},{parents:[uuid(10)]}])('rejects malformed record %j', patch => {
    expect(Object.keys(reduce([{...record(10),...patch}]).quarantined)).not.toHaveLength(0);
  });
  it('rejects cross-entity causal parents and propagates invalid ancestors', () => {
    const a = record(10); const b = record(11,{parents:[a.recordId]}); const c = record(12,{entityId:b.entityId,parents:[b.recordId]});
    const out=reduce([a,b,c]); expect(out.entities[b.entityId].record).toBeUndefined(); expect(out.quarantined[b.recordId]).toBeDefined();
  });
  it('detects causal cycles', () => {
    const a=record(10,{parents:[uuid(11)]}); const b=record(11,{entityId:a.entityId,parents:[a.recordId]});
    expect(reduce([a,b]).entities[a.entityId].record).toBeUndefined(); expect(Object.keys(reduce([a,b]).quarantined)).toHaveLength(2);
  });
  it('derives stable folder ancestry across a folder rename', () => {
    const f=record(10,{kind:'folder',blob:undefined,location:{parentId:null,name:'Folder'}});
    const child=record(11,{location:{parentId:f.entityId,name:'note.md'}});
    const renamed=record(12,{entityId:f.entityId,parents:[f.recordId],kind:'folder',blob:undefined,location:{parentId:null,name:'New'}});
    expect(reduce([child,renamed,f]).entities[child.entityId].path).toBe('New/note.md');
  });
  it('blocks missing, conflicting and cyclic folder dependencies', () => {
    const f=record(10,{kind:'folder',blob:undefined,location:{parentId:uuid(200011),name:'F'}});
    const g=record(11,{kind:'folder',blob:undefined,location:{parentId:f.entityId,name:'G'}});
    expect(reduce([f]).pending).toContain(f.recordId);
    expect(reduce([f,g]).entities[f.entityId].record).toBeUndefined();
    const root={...f,location:{parentId:null,name:'F'}}; const edit=record(12,{...root,recordId:uuid(12),parents:[root.recordId],location:{parentId:null,name:'A'}}); const edit2=record(13,{...edit,recordId:uuid(13),location:{parentId:null,name:'B'}});
    expect(reduce([root,edit,edit2,g]).entities[g.entityId].record).toBeUndefined();
  });
  it('blocks folder deletion while live descendants remain', () => {
    const f=record(10,{kind:'folder',blob:undefined}); const c=record(11,{location:{parentId:f.entityId,name:'child.md'}}); const del=record(12,{...f,recordId:uuid(12),parents:[f.recordId],deleted:true});
    expect(reduce([f,c,del]).entities[f.entityId].record).toBeUndefined();
    const cd=record(13,{...c,recordId:uuid(13),parents:[c.recordId],deleted:true,blob:undefined});
    expect(reduce([f,c,del,cd]).entities[f.entityId].record).toEqual(del);
  });
  it('blocks same-casefold-path entities and descendants but isolates namespaces', () => {
    const a=record(10,{kind:'folder',blob:undefined,location:{parentId:null,name:'Same'}}); const b=record(11,{location:{parentId:null,name:'same'}}); const c=record(12,{location:{parentId:a.entityId,name:'child'}}); const p=record(13,{namespace:'portable-config',location:{parentId:null,name:'Same'}});
    const out=reduce([a,b,c,p]); expect(out.entities[a.entityId].record).toBeUndefined(); expect(out.entities[c.entityId].record).toBeUndefined(); expect(out.entities[p.entityId].record).toEqual(p);
  });
  it('converges for input permutations and duplicate delivery without mutating input', () => {
    const a=record(10); const b=record(11,{entityId:a.entityId,parents:[a.recordId]}); const c=record(12);
    expect(reduce([a,b,c,a])).toEqual(reduce([c,b,a])); expect(a.parents).toEqual([]);
  });
  it('reduces ten thousand independent records within a practical linearithmic budget', () => {
    const records=Array.from({length:10000},(_,i)=>record(i+10)); const start=performance.now();
    expect(Object.keys(reduce(records).entities)).toHaveLength(10000); expect(performance.now()-start).toBeLessThan(5000);
  });
  it('reserves quarantined variant paths so an unrelated create cannot overwrite ambiguous data', () => {
    const a=record(10,{location:{parentId:null,name:'same.md'}}); const alt={...a,blob:{...a.blob!,sha256:'b'.repeat(64)}}; const b=record(11,{location:a.location});
    expect(reduce([a,alt,b]).entities[b.entityId].record).toBeUndefined();
  });
  it('keeps deletion blocked by a quarantined child even when the child has no canonical record', () => {
    const f=record(10,{kind:'folder',blob:undefined,deleted:true}); const c=record(11,{location:{parentId:f.entityId,name:'child.md'}});
    expect(reduce([f,c,{...c,blob:{...c.blob!,size:-1}}]).entities[f.entityId].record).toBeUndefined();
  });
  it('rejects unknown fields instead of treating different immutable payloads as equivalent', () => {
    const a=record(10); expect(reduce([a,{...a,surprise:'different'}]).entities[a.entityId].record).toBeUndefined();
  });
  it('detaches quarantined evidence from caller mutation and remains JSON persistable', () => {
    const a=record(10,{blob:{id:'x',sha256:'bad',size:3}}); const state=mergeHistory(empty(),[a],vault); a.entityId=uuid(999);
    expect(deriveHistory(state).entities[uuid(200010)].blocked).toBeDefined();
    const circular: Record<string,unknown>={recordId:uuid(11),entityId:uuid(200011),namespace:'content'}; circular.extra=circular;
    expect(()=>JSON.stringify(mergeHistory(state,[circular],vault))).not.toThrow();
  });
  it('rejects reserved recovery directory names', () => {
    const a=record(10,{location:{parentId:null,name:'.geode-trash'}}); expect(reduce([a]).quarantined[a.recordId]).toBeDefined();
  });
  it('handles a ten thousand revision chain without recursive stack overflow', () => {
    const chain=Array.from({length:10000},(_,i)=>record(i+10,{entityId:uuid(999999),parents:i?[uuid(i+9)]:[]}));
    expect(reduce(chain.reverse()).entities[uuid(999999)].heads).toEqual([uuid(10009)]);
  });
  it('quarantines entity type changes even between causally unrelated roots', () => {
    const a=record(10); const b=record(11,{entityId:a.entityId,kind:'folder',blob:undefined}); const out=reduce([a,b]);
    expect(out.quarantined[a.recordId]).toBeDefined(); expect(out.quarantined[b.recordId]).toBeDefined();
  });
  it('quarantines incompatible folder namespace dependencies', () => {
    const f=record(10,{namespace:'portable-config',kind:'folder',blob:undefined}); const c=record(11,{location:{parentId:f.entityId,name:'x'}});
    expect(reduce([f,c]).quarantined[c.recordId]).toBeDefined();
  });
  it('reserves equivalent Unicode casefold names', () => {
    const a=record(10,{location:{parentId:null,name:'Straße.md'}}); const b=record(11,{location:{parentId:null,name:'STRASSE.md'}});
    expect(reduce([a,b]).entities[a.entityId].record).toBeUndefined();
  });
  it('rejects names that exceed a filesystem component byte limit', () => {
    const a=record(10,{location:{parentId:null,name:'😀'.repeat(100)}});
    expect(reduce([a]).quarantined[a.recordId]).toBeDefined();
  });
  it('converges across reordered incremental duplicate and contradictory delivery', () => {
    const a=record(10); const b=record(11,{entityId:a.entityId,parents:[a.recordId]}); const c=record(12,{entityId:a.entityId,parents:[a.recordId]}); const d=record(13); const alternate={...d,location:{parentId:null,name:'other'}};
    const expected=reduce([a,b,c,d,alternate]);
    for (const batch of [[alternate,b,d,c,a],[d,c,a,alternate,b],[c,b,alternate,a,d]]) {
      let state=empty(); for (const r of batch) state=mergeHistory(state,[r,r],vault);
      expect(deriveHistory(state)).toEqual(expected);
    }
  });
  it('does not project a head whose earlier revision has a missing folder dependency', () => {
    const folder=record(10,{kind:'folder',blob:undefined}); const a=record(11,{location:{parentId:folder.entityId,name:'x'}}); const b=record(12,{entityId:a.entityId,parents:[a.recordId]});
    const out=reduce([a,b]); expect(out.pending).toContain(b.recordId); expect(out.entities[b.entityId].record).toBeUndefined();
    expect(reduce([a,b,folder]).entities[b.entityId].record).toEqual(b);
  });
  it('does not repair a structurally invalid ancestor by moving a later head to root', () => {
    const notFolder=record(10); const a=record(11,{location:{parentId:notFolder.entityId,name:'x'}}); const b=record(12,{entityId:a.entityId,parents:[a.recordId]});
    const out=reduce([a,b,notFolder]); expect(out.quarantined[a.recordId]).toBeDefined(); expect(out.entities[b.entityId].record).toBeUndefined();
  });
});
