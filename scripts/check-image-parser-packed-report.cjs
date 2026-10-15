/** Independent post-Electron terminal validation; never trusts the process exit alone. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const MODES=['canonical','instrumented','fault-error','fault-malformed'];
const NAMES=['index.html','broker.mjs','worker.mjs'];
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exactKeys=(value,keys,label)=>{assert.ok(record(value),label+' must be an object');assert.deepEqual(Object.keys(value).sort(),[...keys].sort(),label+' must contain the exact completed identities');};
function validatePackedRuntimeReport(file,expectedCommit,expectedRunId){
 const bytes=fs.readFileSync(file),report=JSON.parse(bytes);
 assert.equal(report.failure,null,'Native report records a failure');
 assert.equal(report.validated,true,'In-process final assertions did not complete');
 assert.match(expectedCommit,/^[a-f0-9]{40}$/);assert.ok(typeof expectedRunId==='string'&&expectedRunId.length>0);
 assert.equal(report.commit,expectedCommit,'Report belongs to a different commit');assert.equal(report.runId,expectedRunId,'Report belongs to a stale execution');
 for(const name of ['modes','resourceHashes','parentOrigins','effectivePreferences'])exactKeys(report[name],MODES,name);
 for(const mode of MODES){
  assert.ok(record(report.modes[mode]));assert.equal(report.modes[mode].proofMode,mode,'Mode identity mismatch');
  assert.ok(record(report.parentOrigins[mode]));assert.ok(record(report.effectivePreferences[mode]));
  exactKeys(report.resourceHashes[mode],NAMES,mode+' resource inventory');
  for(const name of NAMES){const expected=report.resourceHashes[mode][name];assert.match(expected,/^[a-f0-9]{64}$/);const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(file),mode,name))).digest('hex');assert.equal(actual,expected,mode+'/'+name+' bytes changed');}
 }
 return {validated:true,commit:expectedCommit,runId:expectedRunId,modes:MODES,resourceCount:MODES.length*NAMES.length,reportSha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
module.exports={validatePackedRuntimeReport};
if(require.main===module){try{console.log(JSON.stringify(validatePackedRuntimeReport(process.argv[2],process.argv[3],process.argv[4]),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
