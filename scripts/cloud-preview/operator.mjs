import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile,open,writeFile,mkdir,rmdir,unlink } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { assertActionAllowed } from './operator-policy.mjs';

const [directory,action]=process.argv.slice(2);assert.ok(directory);
assert.ok(['deploy','recover','inspect','setup','run','cleanup','remove'].includes(action));
const root=resolve(directory),inventory=JSON.parse(await readFile(join(root,'inventory.json'),'utf8'));
assert.match(inventory.schema,/^geode_wiki_preview_[a-f0-9]{16}$/);
const project=JSON.parse(await readFile(join(root,'.vercel/project.json'),'utf8'));
assert.equal(project.orgId,inventory.target.teamId);assert.equal(project.projectId,inventory.target.projectId);
const lock=join(root,'operator.lock');await mkdir(lock); // Atomic, never remove another operator's lock.
const journal=join(root,'operations.jsonl');
async function record(value) {const file=await open(journal,'a',0o600);try{await file.writeFile(JSON.stringify({at:new Date().toISOString(),...value})+'\n');await file.sync();}finally{await file.close();}const directory=await open(root,'r');try{await directory.sync();}finally{await directory.close();}}
function cli(args) {const split=args.indexOf('--');const scoped=split<0?[...args,'--cwd',root]:[...args.slice(0,split),'--cwd',root,...args.slice(split)];return execFileSync('vercel',scoped,{encoding:'utf8',timeout:360000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});}
try {
  let rows=[];try{rows=(await readFile(journal,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code!=='ENOENT')throw e;}
  const previous=kind=>rows.filter(r=>r.kind===kind);
  assertActionAllowed(rows,action,previous('deployment').at(-1)?.id);
  if(!['cleanup','remove','recover'].includes(action))assert.ok(Date.now()<Date.parse(inventory.expiresAt),'Expired preview inventory');
  if(action==='deploy') {
    await record({kind:'deploy-intent',schema:inventory.schema,projectId:project.projectId,teamId:project.orgId});
    // Unique metadata persisted before the write enables exact recovery after CLI termination.
    const output=JSON.parse(cli(['deploy','--prebuilt','--yes','--target','preview','--meta',`geodePreview=${inventory.schema}`,'--format','json']));
    await record({kind:'deploy-result',output});
    console.log(JSON.stringify(output));
  } else if(action==='recover') {
    const output=JSON.parse(cli(['ls','--meta',`geodePreview=${inventory.schema}`,'--environment','preview','--format','json']));
    const deployments=output.deployments ?? output;
    assert.ok(Array.isArray(deployments));assert.ok(deployments.length<=1,'Multiple candidates: stop for manual reconciliation');
    if(deployments.length===1) {
      const listed=deployments[0];assert.equal(listed.meta?.geodePreview,inventory.schema);
      assert.match(listed.url,/^[a-z0-9-]+\.vercel\.app$/);
      // CLI list intentionally omits deployment IDs. Resolve the unique URL,
      // then verify all scope fields before recording an actionable ID.
      const d=JSON.parse(cli(['api',`/v13/deployments/${listed.url}?teamId=${inventory.target.teamId}`,'--raw']));
      assert.match(d.id,/^dpl_[A-Za-z0-9]+$/);assert.equal(d.projectId,inventory.target.projectId);assert.equal(d.ownerId,inventory.target.teamId);
      assert.equal(d.url,listed.url);assert.equal(d.meta?.geodePreview,inventory.schema);assert.notEqual(d.target,'production');
      await record({kind:'deployment',id:d.id,url:d.url});
    } else await record({kind:'deployment-absent'});
    console.log(JSON.stringify({count:deployments.length}));
  } else {
    const deployment=previous('deployment').at(-1);assert.ok(deployment,'Run recover to bind the exact deployment ID');
    assert.match(deployment.id,/^dpl_[A-Za-z0-9]+$/);
    if(action==='remove') {
      assert.ok(rows.some(r=>r.kind==='cleanup-result'&&r.result.zeroResidue===true),'Verify exact resource cleanup before removing recovery endpoint');
      await record({kind:'remove-intent',id:deployment.id});cli(['remove',deployment.id,'--yes']);await record({kind:'removed',id:deployment.id});console.log(JSON.stringify({removed:deployment.id}));
    } else {
      const max=action==='cleanup'?2:1;
      assert.ok(previous(action+'-intent').length<max,'Invocation allowance exhausted; reconcile evidence before any repeat');
      const nonce=(await readFile(join(root,'request-nonce'),'utf8')).trim();assert.match(nonce,/^[a-f0-9]{64}$/);
      const config=join(root,'request.curl');
      await writeFile(config,`request = "POST"\nheader = "x-geode-nonce: ${nonce}"\nheader = "x-geode-action: ${action}"\nsilent\nshow-error\nmax-time = 290\n`,{flag:'wx',mode:0o600});
      try {
        await record({kind:action+'-intent',id:deployment.id});
        const result=JSON.parse(cli(['curl','/api/geode-preview','--deployment',deployment.id,'--','--config',config]));
        await record({kind:action+'-result',id:deployment.id,result});console.log(JSON.stringify(result));
        assert.equal(result.status,'ok',`${action} verification failed; cleanup remains available`);
      } finally {await unlink(config);}
    }
  }
} catch(error) {
  // ChildProcess errors can embed curl's headers. Never echo command/error objects.
  await record({kind:'operator-error',action,code:typeof error.code==='string'?error.code:'operation-failed'});
  // Deploy has no secret CLI arguments; preserve only its bounded diagnostics.
  if(action==='deploy' && error.stderr) {const diagnostic=String(error.stderr).slice(-2000);await record({kind:'deploy-diagnostic',diagnostic});console.error(diagnostic);}
  console.error('Preview operation did not complete successfully. Inspect the private journal; recover/cleanup before retrying.');process.exitCode=1;
} finally {await rmdir(lock);}
