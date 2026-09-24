import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createCloudCatalog, createPrivateBlobStore } from '../../src/catalog/cloud.ts';
import { nodeDsqlPoolConfig } from '../../src/catalog/node-dsql-catalog.ts';
import { validateInventory } from './inventory.ts';

export const inventory=validateInventory(PREVIEW_INVENTORY);
export const limits={maxNoteBytes:1024*1024,maxAssetBytes:1024*1024,maxPublicationBytes:4*1024*1024,maxPublicationEntries:500,
  allowedContentTypes:['text/markdown','image/png','application/pdf','application/octet-stream']};
function gate() {
  let n=0,release;
  const ready=new Promise(resolve=>{release=resolve;});
  return async()=>{if(++n===2)release();let timer;try{await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Race gate timed out')),5000);})]);}finally{clearTimeout(timer);}};
}
export function runtime(phase) {
  const {schema,target}=inventory;
  assert.ok(Date.now()<Date.parse(inventory.expiresAt),'Preview inventory expired');
  const authMetrics={tokensGenerated:0,authFailures:0};
  const pool=new Pool(nodeDsqlPoolConfig({host:target.host,region:target.region,roleArn:target.roleArn,user:schema,maxConnections:2,connectionTimeoutMillis:10000,idleTimeoutMillis:1000,maxLifetimeSeconds:60,queryTimeoutMillis:10000},authMetrics));
  pool.on('error',()=>{authMetrics.poolErrors=(authMetrics.poolErrors||0)+1;});
  let sqlCount=0;const sqlStates=[];let interrupt=false;let sqlGate=null;
  const transport={async connect(){const client=await pool.connect();return {async query(text,values=[]){
    assert.ok(++sqlCount<=3500,'SQL budget exceeded');
    if(sqlGate && /^INSERT INTO .*\.vault_sequence/.test(text) && values[0]==='sql-race') {const g=sqlGate;await g();}
    if(interrupt && /^INSERT INTO .*\.receipt/.test(text) && values[0]==='interrupted') {interrupt=false;throw new Error('Injected metadata interruption');}
    try{return await client.query(text,values);}catch(e){if(e.code)sqlStates.push(e.code);throw e;}
  },release:destroy=>client.release(destroy)};},end:()=>pool.end()};
  const objects=createPrivateBlobStore({prefix:schema+'/',token:process.env[PREVIEW_BLOB_TOKEN_NAME],maxObjectBytes:1024*1024,maxReadBytes:32*1024*1024,
    maxUploadedBytes:8*1024*1024,maxOperations:phase==='publish'?400:200,timeoutMs:10000,
    beforeWrite:async pathname=>{assert.ok(inventory.blobKeys.includes(pathname),'Uninventoried Blob write refused');}});
  let beforeGet=null,afterGet=null;
  const wrapped={...objects,async get(key){
    if(beforeGet && key.startsWith('cold-race/')) {const a=beforeGet,b=afterGet;await a();const result=await objects.get(key);await b();return result;}
    return objects.get(key);
  }};
  const catalog=createCloudCatalog({schema,pool:transport,objects:wrapped,limits,restoreLimits:{maxNoteBytes:limits.maxNoteBytes,maxAssetBytes:limits.maxAssetBytes,maxVaultBytes:4*1024*1024,maxEntries:500,allowedContentTypes:limits.allowedContentTypes},metadataLimits:{maxPathBytes:1024,maxContentTypeBytes:128,maxReceiptBytes:4096},maxAttempts:5,retryBackoffMs:20});
  return {catalog,objects,transport,metrics:()=>({catalog:catalog.metrics(),blob:objects.metrics(),auth:authMetrics,sqlCount,sqlStates}),
    armColdRace(){beforeGet=gate();afterGet=gate();},disarmColdRace(){beforeGet=null;afterGet=null;},
    armSqlRace(){const barrier=gate();let arrivals=0;sqlGate=async()=>{if(++arrivals===2)sqlGate=null;await barrier();};},
    interruptMetadata(){interrupt=true;}};
}
