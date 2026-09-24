import { describe, expect, it, vi } from "vitest";
import { createNodeDsqlCatalog } from "../../src/catalog/node-dsql-catalog";
import { DEFAULT_CATALOG_LIMITS, DEFAULT_RESTORE_LIMITS, nodeDigest, validatePublication } from "../../src/wiki/catalog-contract";
import { createMemoryObjectStore, objectKeyFor } from "../../src/catalog/object-store";

function publication(text = "hello") {
  const result = validatePublication({ vaultId: "vault", mutationId: "mutation", baseSequence: 0, notes: [{ path: " O'Brien.md", text }] });
  if (result.status !== "ok") throw new Error(result.status);
  return result.publication;
}
function setup(handler?: (text: string, values: unknown[]) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>) {
  const calls: {text: string; values: unknown[]}[] = [];
  const releases: boolean[] = [];
  const pool = { connect: vi.fn(async () => ({
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      return { rows: handler ? await handler(text, values) : text.includes("max(sequence)") ? [{ sequence: "0" }] : [] };
    }), release: (destroy = false) => releases.push(destroy),
  })), end: vi.fn(async () => {}) };
  const objects = createMemoryObjectStore();
  const options = { schema: "test_catalog", pool, objects, limits: { ...DEFAULT_CATALOG_LIMITS, maxPublicationEntries: 500 }, restoreLimits: DEFAULT_RESTORE_LIMITS, metadataLimits: {maxPathBytes: 1024, maxContentTypeBytes: 128, maxReceiptBytes: 4096}, maxAttempts: 3, retryBackoffMs: 0 };
  return { pool, objects, options, calls, releases };
}
describe("Node DSQL catalog", () => {
  it("parameterizes values and commits after immutable bytes exist", async () => {
    const s = setup(); const adapter = createNodeDsqlCatalog(s.options);
    const result = await adapter.store.commit(publication());
    expect(result).toMatchObject({ status: "ok", receipt: { sequence: 1 } });
    expect(s.calls.some(c => c.text.includes("O'Brien"))).toBe(false);
    expect(s.calls.some(c => c.values.includes(" O'Brien.md"))).toBe(true);
    expect(s.calls.at(-1)?.text).toBe("COMMIT");
    expect(s.objects.size()).toBe(1);
    await adapter.close(); await adapter.close(); expect(s.pool.end).toHaveBeenCalledTimes(1);
    expect(await adapter.store.commit(publication())).toEqual({ status: "store-failed" });
  });
  it("enforces constructor publication ceilings before any I/O", async () => {
    const s = setup(); s.options.limits.maxNoteBytes = 1;
    expect(await createNodeDsqlCatalog(s.options).store.commit(publication())).toMatchObject({status: "oversize"});
    expect(s.pool.connect).not.toHaveBeenCalled(); expect(s.objects.size()).toBe(0);
  });
  it("replays an identical receipt before checking stale base", async () => {
    const p = publication(); const receipt = { vaultId: p.vaultId, mutationId: p.mutationId, sequence: 1, digest: p.digest, noteCount: 1, assetCount: 0 };
    const s = setup(text => text.includes("FROM \"test_catalog\".receipt") ? [{digest:p.digest, receipt:JSON.stringify(receipt)}] : [{sequence:"9"}]);
    expect(await createNodeDsqlCatalog(s.options).store.commit(p)).toEqual({status:"ok",receipt});
    expect(s.objects.size()).toBe(0);
    expect(await createNodeDsqlCatalog(s.options).store.commit(publication("changed"))).toEqual({status:"mutation-id-reused"});
  });
  it.each(["40001", "23505"])("retries %s on a fresh transaction and reports exhaustion", async code => {
    const s = setup(text => { if (text.startsWith("INSERT INTO") && text.includes("vault_sequence")) throw Object.assign(new Error("private failure"), {code}); return text.includes("max(sequence)") ? [{sequence:"0"}] : []; });
    const adapter = createNodeDsqlCatalog(s.options);
    expect(await adapter.store.commit(publication())).toEqual({status:"store-failed"});
    expect(s.pool.connect).toHaveBeenCalledTimes(4); // Initial read plus three fresh write snapshots.
    expect(s.calls.filter(c => c.text === "ROLLBACK")).toHaveLength(3);
    expect(adapter.metrics()).toMatchObject({retries:2,retryExhaustions:1});
    expect(JSON.stringify(adapter.metrics())).not.toContain("private failure");
  });
  it("refuses assigned keys instead of publishing dangling stable metadata", async () => {
    const s=setup(); s.objects.put=vi.fn(async()=>"unexpected-key");
    expect(await createNodeDsqlCatalog(s.options).store.commit(publication())).toEqual({status:"store-failed"});
    expect(s.calls.some(c=>c.text.startsWith("INSERT"))).toBe(false);
  });
  it("bounds metadata rows and recorded bytes before object I/O", async () => {
    const hash=nodeDigest.sha256Hex(new TextEncoder().encode("hello"));
    const row={path:"note.md",kind:"note",content_address:hash,content_type:"text/markdown",byte_length:"999999999",object_key:objectKeyFor("vault",hash)};
    const s=setup(text=>text.includes("LEFT JOIN")?[row]:text.includes("max(sequence)")?[{sequence:"1"}]:[]);
    s.objects.get=vi.fn(async()=>null);
    expect(await createNodeDsqlCatalog(s.options).restoreSource().restore("vault")).toMatchObject({status:"oversize"});
    expect(s.objects.get).not.toHaveBeenCalled();
    const sql=s.calls.find(c=>c.text.includes("LEFT JOIN"));
    expect(sql?.text).toContain("LIMIT $"); expect(sql?.text).toContain("octet_length");
  });
  it("verifies note digest and recorded length before returning text", async () => {
    const bytes=new TextEncoder().encode("hello"), hash=nodeDigest.sha256Hex(bytes);
    const row={path:"note.md",kind:"note",content_address:hash,content_type:"text/markdown",byte_length:"5",object_key:objectKeyFor("vault",hash)};
    const s=setup(text=>text.includes("LEFT JOIN")?[row]:text.includes("max(sequence)")?[{sequence:"1"}]:[]);
    await s.objects.put(row.object_key,new TextEncoder().encode("wrong"),"text/markdown");
    expect(await createNodeDsqlCatalog(s.options).restoreSource().restore("vault")).toMatchObject({status:"invalid-content-address"});
    await s.objects.delete(row.object_key); await s.objects.put(row.object_key,bytes,"text/markdown"); row.byte_length="4";
    expect(await createNodeDsqlCatalog(s.options).restoreSource().restore("vault")).toMatchObject({status:"byte-length-mismatch"});
  });
  it("batches a supported 500-entry publication into bounded parameterized statements", async()=>{
    const s=setup(), adapter=createNodeDsqlCatalog(s.options);
    const validated=validatePublication({vaultId:"vault",mutationId:"large",baseSequence:0,notes:Array.from({length:500},(_,i)=>({path:`note-${i}.md`,text:`body-${i}`}))});
    if(validated.status!=="ok") throw new Error(validated.status);
    expect((await adapter.store.commit(validated.publication)).status).toBe("ok");
    expect(s.calls.length).toBeLessThan(20);
  });
  it("rejects malformed restore paths before reading objects",async()=>{
    const hash=nodeDigest.sha256Hex(utf8("hi"));
    const s=setup(text=>text.includes("LEFT JOIN")?[{path:"../escape.md",kind:"note",content_address:hash,content_type:"text/markdown",byte_length:"2",object_key:objectKeyFor("vault",hash)}]:text.includes("max(sequence)")?[{sequence:"1"}]:[]);
    s.objects.get=vi.fn(async()=>utf8("hi"));
    expect(await createNodeDsqlCatalog(s.options).restoreSource().restore("vault")).toMatchObject({status:"invalid-path"});
    expect(s.objects.get).not.toHaveBeenCalled();
  });
  it.each(["matching","mismatch","absent","outage"])("recovers a cold exclusive-create loser only for verified matching bytes: %s",async outcome=>{
    const s=setup(); let reads=0;
    s.objects.get=vi.fn(async()=>{ if(++reads===1)return null; if(outcome==="outage")throw new Error("offline"); return outcome==="absent"?null:utf8(outcome==="matching"?"hello":"wrong");});
    s.objects.put=vi.fn(async()=>{throw new Error("already exists");});
    const result=await createNodeDsqlCatalog(s.options).store.commit(publication());
    expect(result.status).toBe(outcome==="matching"?"ok":outcome==="mismatch"?"duplicate-with-mismatched-bytes":"store-failed");
    if(outcome!=="matching")expect(s.calls.some(c=>c.text.startsWith("INSERT"))).toBe(false);
  });
  it("close waits for an already-started upload and prevents later metadata writes",async()=>{
    const s=setup();let finish!:()=>void;let started!:()=>void;
    const entered=new Promise<void>(r=>{started=r;});
    s.objects.put=vi.fn(async key=>{started();await new Promise<void>(r=>{finish=r;});return key;});
    const adapter=createNodeDsqlCatalog(s.options),writing=adapter.store.commit(publication());
    await entered;let closed=false;const closing=adapter.close().then(()=>{closed=true;});
    await Promise.resolve();await Promise.resolve();expect(closed).toBe(false);
    finish();expect(await writing).toEqual({status:"store-failed"});await closing;
    expect(s.calls.some(c=>c.text.startsWith("INSERT"))).toBe(false);
  });
  it("does not publish a receipt which exceeds its configured read bound",async()=>{
    const s=setup();s.options.metadataLimits.maxReceiptBytes=1;
    expect(await createNodeDsqlCatalog(s.options).store.commit(publication())).toEqual({status:"store-failed"});
    expect(s.pool.connect).not.toHaveBeenCalled();
  });
  it("refuses a stale base without uploading",async()=>{
    const s=setup(text=>text.includes("max(sequence)")?[{sequence:"1"}]:[]);
    expect(await createNodeDsqlCatalog(s.options).store.commit(publication())).toEqual({status:"conflict"});expect(s.objects.size()).toBe(0);
  });
  it.each(["{",JSON.stringify({sequence:1}),JSON.stringify({vaultId:"another",mutationId:"mutation",sequence:1,digest:"a",noteCount:1,assetCount:0})])("refuses malformed receipt %s",async receipt=>{
    const p=publication(),s=setup(text=>text.includes(".receipt")?[{digest:p.digest,receipt}]:[]);
    expect(await createNodeDsqlCatalog(s.options).store.commit(p)).toEqual({status:"store-failed"});
  });
  it("reconnects after an expired credential failure",async()=>{
    const s=setup();s.pool.connect.mockRejectedValueOnce(Object.assign(new Error("expired secret"),{code:"28P01"}));
    const adapter=createNodeDsqlCatalog(s.options);
    expect((await adapter.store.commit(publication())).status).toBe("ok");
    expect(adapter.metrics()).toMatchObject({retries:1,authFailures:1});
  });
  it("does not retry or reveal arbitrary SQL failures",async()=>{
    const s=setup(()=>{throw Object.assign(new Error("SELECT private"),{code:"42501"});});
    const adapter=createNodeDsqlCatalog(s.options);
    expect(await adapter.store.commit(publication())).toEqual({status:"store-failed"});expect(s.pool.connect).toHaveBeenCalledTimes(1);expect(s.releases).toEqual([true]);
  });
  it("returns the winning receipt after OCC retry rather than a stale conflict",async()=>{
    const p=publication(),receipt={vaultId:p.vaultId,mutationId:p.mutationId,sequence:1,digest:p.digest,noteCount:1,assetCount:0};let failed=false;
    const s=setup(text=>{if(text.startsWith("INSERT") && !failed){failed=true;throw Object.assign(new Error("race"),{code:"40001"});}if(failed && text.includes("FROM \"test_catalog\".receipt"))return [{digest:p.digest,receipt:JSON.stringify(receipt)}];return text.includes("max(sequence)")?[{sequence:"0"}]:[];});
    expect(await createNodeDsqlCatalog(s.options).store.commit(p)).toEqual({status:"ok",receipt});
  });
  it.each([
    [{object_key:"other/objects/"+"a".repeat(64)},"invalid-content-address"],
    [{object_key:null,byte_length:null},"missing-object"],
    [{byte_length:"-1"},"byte-length-mismatch"],
    [{content_address:"not-a-hash"},"invalid-content-address"],
    [{kind:"surprise"},"unknown-entry-kind"],
  ])("refuses hostile metadata before object I/O: %j",async(overrides,status)=>{
    const hash=nodeDigest.sha256Hex(utf8("hi")),row={path:"note.md",kind:"note",content_address:hash,content_type:"text/markdown",byte_length:"2",object_key:objectKeyFor("vault",hash),...overrides};
    const s=setup(text=>text.includes("LEFT JOIN")?[row]:text.includes("max(sequence)")?[{sequence:"1"}]:[]);s.objects.get=vi.fn(async()=>utf8("hi"));
    expect((await createNodeDsqlCatalog(s.options).restoreSource().restore("vault")).status).toBe(status);expect(s.objects.get).not.toHaveBeenCalled();
  });
  it("bounds aggregate bytes across repeated references before GET",async()=>{
    const hash=nodeDigest.sha256Hex(utf8("hi"));
    const s=setup(text=>text.includes("LEFT JOIN")?["a.md","b.md"].map(path=>({path,kind:"note",content_address:hash,content_type:"text/markdown",byte_length:"2",object_key:objectKeyFor("vault",hash)})):text.includes("max(sequence)")?[{sequence:"1"}]:[]);s.objects.get=vi.fn(async()=>utf8("hi"));s.options.restoreLimits={...DEFAULT_RESTORE_LIMITS,maxVaultBytes:3};
    expect(await createNodeDsqlCatalog(s.options).restoreSource().restore("vault")).toMatchObject({status:"oversize",limit:"vault-bytes"});expect(s.objects.get).not.toHaveBeenCalled();
  });
  it("preserves a note's leading UTF-8 BOM exactly",async()=>{
    const text="\uFEFFhello",bytes=utf8(text),hash=nodeDigest.sha256Hex(bytes);
    const s=setup(sql=>sql.includes("LEFT JOIN")?[{path:"note.md",kind:"note",content_address:hash,content_type:"text/markdown",byte_length:String(bytes.byteLength),object_key:objectKeyFor("vault",hash)}]:sql.includes("max(sequence)")?[{sequence:"1"}]:[]);
    await s.objects.put(objectKeyFor("vault",hash),bytes,"text/markdown");
    expect(await createNodeDsqlCatalog(s.options).restoreSource().restore("vault")).toMatchObject({status:"ok",vault:{notes:[{path:"note.md",text}],totalBytes:bytes.byteLength}});
  });
});
const utf8=(text:string)=>new TextEncoder().encode(text);
