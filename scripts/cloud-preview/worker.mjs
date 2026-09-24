import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWikiSession } from '../../src/wiki/index.ts';
import { fixture,project,sha,raceText,boundaryText } from './fixture.mjs';
import { runtime,inventory } from './runtime.mjs';

const phase=process.argv[2];assert.ok(['publish','restore'].includes(phase));
const r=runtime(phase);const root=await mkdtemp(join(tmpdir(),'geode-preview-worker-'));
const report={phase,pid:process.pid,status:'failed'};
try {
  if(phase==='publish') {
    const f=await fixture(root);report.projectionHash=sha(f.projection);report.projectionBytes=Buffer.byteLength(f.projection);
    const first=await r.catalog.publish(f.request);assert.equal(first.status,'ok');
    assert.deepEqual(await r.catalog.publish(f.request),first);
    assert.equal((await r.catalog.publish({...f.request,mutationId:'stale'})).status,'conflict');
    assert.equal((await r.catalog.publish({...f.request,notes:[{path:'changed.md',text:'changed'}]})).status,'mutation-id-reused');
    report.replayAndRefusals=true;
    const request=vaultId=>({vaultId,mutationId:'race',baseSequence:0,notes:[{path:'Race.md',text:raceText}],assets:[]});
    r.armColdRace();
    const cold=await Promise.all([r.catalog.publish(request('cold-race')),r.catalog.publish(request('cold-race'))]);
    r.disarmColdRace();assert.equal(cold[0].status,'ok');assert.deepEqual(cold[0],cold[1]);report.coldRace=true;
    // Only SQL overlap is forced here; the cold-object overlap was independently exercised above.
    await r.objects.put(`sql-race/objects/${sha(raceText)}`,Buffer.from(raceText),'text/markdown');
    r.armSqlRace();const sql=await Promise.all([r.catalog.publish(request('sql-race')),r.catalog.publish(request('sql-race'))]);
    assert.equal(sql[0].status,'ok');assert.deepEqual(sql[0],sql[1]);assert.ok(r.metrics().sqlStates.includes('40001'));assert.ok(r.metrics().catalog.retries>0);report.realOccRetry=true;
    r.interruptMetadata();assert.equal((await r.catalog.publish(request('interrupted'))).status,'store-failed');
    assert.equal((await r.catalog.restore('interrupted')).status,'absent');report.interruptedMetadataUnacknowledged=true;
    const boundary={vaultId:'boundary',mutationId:'limit',baseSequence:0,notes:Array.from({length:500},(_,i)=>({path:`n${i}.md`,text:boundaryText})),assets:[]};
    const before=r.metrics();assert.equal((await r.catalog.publish({...boundary,notes:[...boundary.notes,{path:'extra.md',text:'extra'}]})).status,'entry-limit');
    assert.equal(r.metrics().sqlCount,before.sqlCount);assert.equal(r.metrics().blob.calls,before.blob.calls);
    assert.equal((await r.catalog.publish(boundary)).status,'ok');report.entryBoundary=500;
    const client=await r.transport.connect();try {
      await assert.rejects(client.query(`SELECT * FROM "${inventory.denialSchema}".sentinel`),error=>error.code==='42501');report.scopedRoleDenied=true;
    } finally {client.release(true);}
    assert.equal((await r.catalog.publish({vaultId:'corrupt',mutationId:'one',baseSequence:0,notes:[{path:'Honest.md',text:'honest'}],assets:[]})).status,'ok');
    const key=`corrupt/objects/${sha('honest')}`;await r.objects.delete(key);await r.objects.put(key,Buffer.from('wrong!'),'text/markdown');
    assert.equal((await r.catalog.restore('corrupt')).status,'invalid-content-address');report.corruptionRefused=true;
  } else {
    const restored=await r.catalog.restoreFolder({into:root,vaultId:'restore'});assert.equal(restored.status,'ok');
    const opened=await openWikiSession(root);assert.equal(opened.status,'ok');
    const projection=project(opened.session);report.projectionHash=sha(projection);report.projectionBytes=Buffer.byteLength(projection);
    assert.equal((await r.catalog.restore('corrupt')).status,'invalid-content-address');
    report.restoreAcrossProcess=true;
  }
  report.status='ok';
} catch(e) {report.error=e.message;report.code=e.code||null;process.exitCode=1;}
finally {await r.catalog.close();await rm(root,{recursive:true,force:true});report.metrics=r.metrics();console.log(JSON.stringify(report));}
