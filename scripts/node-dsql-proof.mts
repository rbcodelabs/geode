import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {link,mkdir,rm,writeFile} from "node:fs/promises";
import {join,dirname} from "node:path";
import {Pool} from "pg";
import {createCloudCatalog,type NodeDsqlPool,type NodeDsqlOptions} from "../src/catalog/cloud";
import {createFilesystemObjectStore} from "../src/catalog/object-store";
import {openWikiSession} from "../src/wiki/index";

// Worker deliberately has no schema lifecycle API. The runner owns its schema.
const schema=process.env.GEODE_NODE_PROOF_SCHEMA!,root=process.env.GEODE_NODE_PROOF_ROOT!;
assert.match(schema,/^geode_node_proof_[a-f0-9]{32}$/);
assert.ok(root);
assert.ok(["127.0.0.1","localhost","::1"].includes(process.env.PGHOST??""),"local PostgreSQL only");
const bytes=new Uint8Array([0,1,2,255]);
const hash=(value:Uint8Array|string)=>createHash("sha256").update(value).digest("hex");
const notes=[{path:"Target.md",text:"---\naliases: [Destination]\n---\n# Target\nplesiosaur\n"},{path:" O'Brien.md",text:"[[Target]] [[Destination]] ![[asset.bin]]\n"},{path:"BOM.md",text:"\uFEFFunicode λ 🦕\n"}];
const request={vaultId:"proof",mutationId:"seed",baseSequence:0,notes,assets:[{path:"asset.bin",bytes,contentAddress:hash(bytes),contentType:"application/octet-stream"}]};
const objects=createFilesystemObjectStore(join(root,"objects"));
const pool=()=>new Pool({max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,query_timeout:10000,ssl:false});
const options=(driver:NodeDsqlPool):NodeDsqlOptions=>({schema,pool:driver,objects,limits:{maxNoteBytes:1024*1024,maxAssetBytes:1024*1024,maxPublicationBytes:4*1024*1024,maxPublicationEntries:500,allowedContentTypes:["application/octet-stream"]},restoreLimits:{maxNoteBytes:1024*1024,maxAssetBytes:1024*1024,maxVaultBytes:8*1024*1024,maxEntries:1000,allowedContentTypes:["application/octet-stream"]},metadataLimits:{maxPathBytes:1024,maxContentTypeBytes:128,maxReceiptBytes:4096},maxAttempts:3,retryBackoffMs:1});
async function projection(folder:string) {
  const opened=await openWikiSession(folder);assert.equal(opened.status,"ok");
  if(opened.status!=="ok")throw new Error("capture refused");
  const s=opened.session;
  return JSON.stringify({files:s.listFiles(),notes:notes.map(n=>s.readNote(n.path)),search:s.search("plesiosaur"),backlinks:s.backlinks("Target.md"),link:s.resolveLink(" O'Brien.md","Destination")});
}
const mode=process.argv[2];
if(mode==="publish") {
  const seeded=join(root,"seeded");await mkdir(seeded);
  for(const note of notes)await writeFile(join(seeded,note.path),note.text);
  await writeFile(join(seeded,"asset.bin"),bytes);
  const catalog=createCloudCatalog(options(pool()));
  try {
    const first=await catalog.publish(request);assert.equal(first.status,"ok");
    assert.deepEqual(await catalog.publish(request),first);
    assert.equal((await catalog.publish({...request,mutationId:"stale"})).status,"conflict");
    assert.equal((await catalog.publish({...request,notes:[{path:"Target.md",text:"changed"}]})).status,"mutation-id-reused");
    const boundary={vaultId:"boundary",mutationId:"boundary",baseSequence:0,notes:Array.from({length:500},(_,i)=>({path:`note-${i}.md`,text:"boundary"}))};
    assert.equal((await catalog.publish(boundary)).status,"ok");
    const before=catalog.metrics().sqlStatements;
    assert.equal((await catalog.publish({...boundary,notes:[...boundary.notes,{path:"overflow.md",text:"x"}]})).status,"entry-limit");
    assert.equal(catalog.metrics().sqlStatements,before);
    console.log(JSON.stringify({mode,pid:process.pid,projection:hash(await projection(seeded)),metrics:catalog.metrics(),boundaryEntries:500}));
  } finally {await catalog.close();}
} else if(mode==="restore") {
  const catalog=createCloudCatalog(options(pool()));
  try {
    const into=join(root,"restored");assert.equal((await catalog.restoreFolder({into,vaultId:"proof"})).status,"ok");
    console.log(JSON.stringify({mode,pid:process.pid,projection:hash(await projection(into)),metrics:catalog.metrics()}));
  } finally {await catalog.close();}
} else if(mode==="faults") {
  // Force both independent transaction snapshots to reach their sequence claim
  // before either issues it. PostgreSQL may report 23505, not DSQL's OC000.
  const driver=pool();let arrivals=0;let release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const codes:string[]=[];
  const racing:NodeDsqlPool={end:()=>driver.end(),connect:async()=>{
    const client=await driver.connect();return {release:(destroy)=>client.release(destroy),query:async(text,values)=>{
      if(text.startsWith("INSERT") && text.includes("vault_sequence") && values?.[0]==="race" && arrivals<2) {
        if(++arrivals===2)release();
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{await Promise.race([barrier,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Barrier timeout")),5000);})]);}finally{clearTimeout(timer);}
      }
      try{return await client.query(text,values);}catch(error){const code=(error as {code?:string}).code;if(code)codes.push(code);throw error;}
    }};
  }};
  // Exclusive filesystem create + a gate before the first object GET proves a
  // genuinely cold race, not just database contention over preuploaded bytes.
  let gets=0;let releaseReads!:()=>void;
  const readGate=new Promise<void>(resolve=>{releaseReads=resolve;});
  const cold={...objects,get:async(key:string)=>{if(key.startsWith("race/") && gets<2){if(++gets===2)releaseReads();await readGate;}return objects.get(key);},put:async(key:string,value:Uint8Array)=>{
    const file=join(root,"objects",key);await mkdir(dirname(file),{recursive:true});
    const temporary=join(dirname(file),`.geode-object-${randomUUID()}`);
    try {
      await writeFile(temporary,value,{flag:"wx"});
      // A Blob create is visible as complete bytes. link preserves exclusive
      // creation without exposing writeFile's partially written final path.
      await link(temporary,file);
      return key;
    } finally {await rm(temporary,{force:true});}
  }};
  const catalog=createCloudCatalog({...options(racing),objects:cold});
  try {
    const race={vaultId:"race",mutationId:"same",baseSequence:0,notes:[{path:"race.md",text:"cold object"}]};
    const results=await Promise.all([catalog.publish(race),catalog.publish(race)]);
    assert.equal(results[0].status,"ok");assert.deepEqual(results[0],results[1]);assert.equal(arrivals,2);assert.equal(gets,2);
    assert.ok(codes.some(code=>["23505","40001"].includes(code)));assert.ok(catalog.metrics().retries>=1);
    console.log(JSON.stringify({mode:"cold-race",codes,metrics:catalog.metrics()}));
  }finally{await catalog.close();}
  const failingDriver=pool();
  const fault:NodeDsqlPool={end:()=>failingDriver.end(),connect:async()=>{const client=await failingDriver.connect();return {release:(destroy)=>client.release(destroy),query:async(text,values)=>{
    if(text.startsWith("INSERT")&&text.includes(".receipt"))return client.query("SELECT 1/0");
    return client.query(text,values);
  }};}};
  const failed=createCloudCatalog(options(fault));
  try{assert.equal((await failed.publish({vaultId:"rollback",mutationId:"fail",baseSequence:0,notes:[{path:"fail.md",text:"unacknowledged orphan"}]})).status,"store-failed");}finally{await failed.close();}
  const checker=pool();
  try{
    for(const table of ["vault_sequence","catalog_entry","object","receipt"]){const result=await checker.query(`SELECT count(*) AS count FROM "${schema}".${table} WHERE vault_id=$1`,["rollback"]);assert.equal(result.rows[0].count,"0");}
    assert.equal((await objects.list("rollback/")).length,1,"failed transaction leaves only unacknowledged bytes");
    console.log(JSON.stringify({mode:"rollback",metadataRows:0,orphanObjects:1}));
  }finally{await checker.end();}
} else throw new Error("Unknown proof worker mode");
