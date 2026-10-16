/** Historical comparison evidence; timing values are observations, not speed thresholds. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const BASELINE_SHA256='cb138b0a67351c1eb2aae538440ffbf3fbc9e1d6f838e45368712de314a61335';
const SIZES=[10000,20000,40000,80000];
// Direct stock harness/baseline inventory; not an exhaustive transitive dependency graph.
const SOURCES=['scripts/image-parser-stock-characterization.ts','scripts/check-image-parser-stock-report.cjs','scripts/run-image-parser-packed-proof.cjs','tests/unit/helpers/image-source-sync-baseline.ts','tests/unit/helpers/image-source-fixture.ts'];
function validateStockReport(file,expectedCommit,expectedRunId,sourceRoot=process.cwd()){
 const bytes=fs.readFileSync(file),report=JSON.parse(bytes);
 assert.equal(report.failure,null,'Stock report records a failure');assert.equal(report.validated,true,'Stock assertions did not complete');
 assert.match(expectedCommit,/^[a-f0-9]{40}$/);assert.ok(typeof expectedRunId==='string'&&expectedRunId.length>0);
 assert.equal(report.commit,expectedCommit,'Stock report belongs to a different commit');assert.equal(report.runId,expectedRunId,'Stock report belongs to a stale execution');
 assert.equal(report.baselineSha256,BASELINE_SHA256,'Historical baseline changed');
 assert.match(report.runtime?.node,/^\d+\.\d+\.\d+(?:[-+].*)?$/);assert.equal(report.runtime.grammar,'@lezer/markdown');
 assert.deepEqual(Object.keys(report.sourceHashes||{}).sort(),[...SOURCES].sort());
 for(const name of SOURCES)assert.equal(report.sourceHashes[name],crypto.createHash('sha256').update(fs.readFileSync(path.join(sourceRoot,name))).digest('hex'),'Stock source changed '+name);
 assert.equal(report.bundleSha256,crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(file),'stock-characterization.cjs'))).digest('hex'),'Stock bundle changed');
 assert.ok(Array.isArray(report.rows));assert.equal(report.rows.length,SIZES.length);
 for(const [index,size] of SIZES.entries()){
  const row=report.rows[index];assert.equal(row.fixture,'nested-stock-vs-projection');assert.equal(row.sourceUnits,size);
  assert.equal(row.sourceSha256,crypto.createHash('sha256').update('['.repeat(size/2)+']'.repeat(size/2)).digest('hex'));
  assert.equal(row.sourceEqual,true);assert.equal(row.status,'ready');
  for(const key of ['stockMs','projectionMs'])assert.ok(typeof row[key]==='number'&&Number.isFinite(row[key])&&row[key]>=0,'Invalid stock timing '+key);
 }
 return {validated:true,commit:expectedCommit,runId:expectedRunId,rows:SIZES.length,reportSha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
module.exports={validateStockReport,BASELINE_SHA256,SIZES,SOURCES};
if(require.main===module){try{console.log(JSON.stringify(validateStockReport(process.argv[2],process.argv[3],process.argv[4]),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
