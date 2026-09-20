import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { publish, validatePublication } from '../../src/wiki/catalog-contract.ts';
import { materializeRestoredVault } from '../../src/wiki/catalog-materialize.ts';
import { openLocalWikiProvider } from '../../src/wiki/folder-provider.ts';
import { serializeWikiQueryProjection } from '../../src/wiki/query-projection.ts';
import { buildProofVault, PROOF_PROJECTION, proofContentType } from '../catalog-proof-vault.mts';
import { objectKeyFor } from '../../src/catalog/object-store.ts';
import { literal, DSQL_CATALOG_LIMITS } from '../../src/catalog/dsql-catalog-store.ts';
import { scopedRuntime } from './runtime.mjs';

const sha = x=>createHash('sha256').update(x).digest('hex');
const {catalog,objects,usage,armWriteBarrier} = scopedRuntime();
const root = await mkdtemp(join(tmpdir(),'geode-cloud-worker-'));
const report = {phase:process.argv[2],pid:process.pid};
try {
  assert.equal(await catalog.query('SELECT current_user;'), process.env.PGUSER);
  if (report.phase === 'publish') {
    await buildProofVault(root);
    // Exercise both original silent-truncation regressions against real DSQL.
    await writeFile(join(root,' Draft.md'),'# Preserved leading space\n');
    await writeFile(join(root,'__GEODE_SPLIT__.md'),'# Preserved sentinel\n');
    const opened = await openLocalWikiProvider(root);
    assert.equal(opened.status,'ok');
    const view = opened.provider.snapshot();
    const projection = serializeWikiQueryProjection(view,PROOF_PROJECTION);
    report.projectionHash = sha(projection); report.projectionBytes = Buffer.byteLength(projection);
    const notes=[], assets=[];
    for(const file of view.listFiles()) {
      if(file.kind==='note') notes.push({path:file.path,text:view.readNote(file.path).note.text});
      else {const bytes=new Uint8Array(await readFile(join(root,file.path)));assets.push({path:file.path,bytes,contentAddress:sha(bytes),contentType:proofContentType(file.path)});}
    }
    const request={vaultId:'restore',mutationId:'first',baseSequence:0,notes,assets};
    const first=await publish(catalog.store,request,{limits:DSQL_CATALOG_LIMITS});
    assert.equal(first.status,'ok','initial publication');
    assert.deepEqual(await publish(catalog.store,request),first,'idempotent receipt');
    assert.equal((await publish(catalog.store,{...request,mutationId:'stale'})).status,'conflict');
    assert.equal(await catalog.query("SELECT max(sequence) FROM vault_sequence WHERE vault_id='restore';"),'1');
    report.idempotent=true;report.staleBaseRejected=true;
    const race={vaultId:'race',mutationId:'duplicate',baseSequence:0,notes:[{path:'Race.md',text:'# Race\n'}],assets:[]};
    const validation=validatePublication(race); assert.equal(validation.status,'ok');
    const p=validation.publication;
    assert.equal((await catalog.uploadObjects(p)).status,'ok');
    // Both write blocks are planned at base 0 before either may commit.
    const pre=await catalog.preflight(p);
    const block='BEGIN ISOLATION LEVEL REPEATABLE READ;\n'+catalog.publishSql(p,pre)+'COMMIT;';
    armWriteBarrier();
    const racers=await Promise.allSettled([catalog.query(block),catalog.query(block)]);
    assert.equal(racers.filter(r=>r.status==='fulfilled').length,1,'exactly one stale-snapshot write wins');
    report.raceFailures=racers.filter(r=>r.status==='rejected').map(r=>r.reason.message);
    const retries=await Promise.all([catalog.store.commit(p),catalog.store.commit(p),catalog.store.commit(p)]);
    assert.ok(retries.every(r=>r.status==='ok'));
    assert.deepEqual(retries[0],retries[1]);assert.deepEqual(retries[1],retries[2]);
    report.concurrentReplayReceipt=true;
    const liveRetry=validatePublication({...race,vaultId:'retry-race'}).publication;
    assert.equal((await catalog.uploadObjects(liveRetry)).status,'ok');
    const errorsBefore=usage.sqlStates.length;
    armWriteBarrier();
    const automatic=await Promise.all([catalog.store.commit(liveRetry),catalog.store.commit(liveRetry)]);
    assert.ok(automatic.every(r=>r.status==='ok'));
    assert.deepEqual(automatic[0],automatic[1]);
    assert.ok(usage.sqlStates.length>errorsBefore,'retry must actually see a database conflict');
    report.automaticRetrySqlStates=usage.sqlStates.slice(errorsBefore);
    report.sampleReadPlan=await catalog.query("EXPLAIN ANALYZE VERBOSE SELECT * FROM catalog_entry WHERE vault_id='restore';");
  } else {
    assert.equal(report.phase,'restore');
    const restored=await catalog.restoreSource().restore('restore');
    assert.equal(restored.status,'ok');
    assert.equal(restored.vault.notes.length,6);assert.equal(restored.vault.assets.length,3);
    assert.equal((await materializeRestoredVault(root,restored.vault)).status,'ok');
    const opened=await openLocalWikiProvider(root);assert.equal(opened.status,'ok');
    const projection=serializeWikiQueryProjection(opened.provider.snapshot(),PROOF_PROJECTION);
    report.projectionHash=sha(projection);report.projectionBytes=Buffer.byteLength(projection);
    // Bypass the adapter to demonstrate the missing database guarantees.
    const address=sha('honest'); const key=objectKeyFor('corrupt',address);
    await objects.put(key,new TextEncoder().encode('tampered'),'text/markdown');
    await catalog.query("INSERT INTO vault_sequence VALUES ('corrupt',1,'planted');");
    await catalog.query(`INSERT INTO object VALUES ('corrupt',${literal(address)},'text/markdown',8,${literal(key)});`);
    await catalog.query(`INSERT INTO catalog_entry VALUES ('corrupt','Bad.md','note',${literal(address)},'text/markdown',1);`);
    assert.equal((await catalog.restoreSource().restore('corrupt')).status,'invalid-content-address');
    await catalog.query("DELETE FROM object WHERE vault_id='corrupt';");
    assert.equal((await catalog.restoreSource().restore('corrupt')).status,'missing-object');
    report.corruptionRefused=true; report.danglingReferencePossible=true;
  }
  console.log(JSON.stringify({...report,status:'ok',usage}));
} catch(e) {
  console.log(JSON.stringify({...report,status:'failed',error:e.message,usage}));
  process.exitCode=1;
} finally {catalog.close();await rm(root,{recursive:true,force:true});}
