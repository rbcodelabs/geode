import {afterEach,expect,it} from "vitest";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
const directories:string[]=[],commit="a".repeat(40),runId="synthetic-stock-run",baselineSha256="cb138b0a67351c1eb2aae538440ffbf3fbc9e1d6f838e45368712de314a61335";
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),"geode-stock-report-"));directories.push(directory);
 const report={commit,runId,validated:true,failure:null,runtime:{node:process.versions.node,grammar:"@lezer/markdown"},baselineSha256,rows:[10000,20000,40000,80000].map(sourceUnits=>({fixture:"nested-stock-vs-projection",sourceUnits,sourceSha256:createHash("sha256").update("[".repeat(sourceUnits/2)+"]".repeat(sourceUnits/2)).digest("hex"),sourceEqual:true,status:"ready",stockMs:1,projectionMs:2}))};
 const sources=["scripts/image-parser-stock-characterization.ts","scripts/check-image-parser-stock-report.cjs","scripts/run-image-parser-packed-proof.cjs","tests/unit/helpers/image-source-sync-baseline.ts","tests/unit/helpers/image-source-fixture.ts"];
 Object.assign(report,{sourceHashes:Object.fromEntries(sources.map(name=>[name,createHash("sha256").update(readFileSync(name)).digest("hex")])),bundleSha256:createHash("sha256").update("synthetic stock bundle").digest("hex")});
 writeFileSync(join(directory,"stock-characterization.cjs"),"synthetic stock bundle");
 return {directory,report:report as typeof report & {sourceHashes:Record<string,string>;bundleSha256:string},run(){const file=join(directory,"stock-report.json");writeFileSync(file,JSON.stringify(report));return spawnSync(process.execPath,[resolve("scripts/check-image-parser-stock-report.cjs"),file,commit,runId],{encoding:"utf8"});}};
}
it("accepts all four complete historical comparison rows with fresh identity",()=>{expect(fixture().run().status).toBe(0);});
it.each(["failure","marker","commit","run","missing-row","duplicate-row","wrong-size","wrong-hash","wrong-status","changed-source","negative-timing","nonfinite-timing","runtime","baseline","fixture-name","missing-file","source-inventory","source-bytes","bundle-bytes"])("rejects %s even after a zero child exit",scenario=>{
 const f=fixture();
 if(scenario==="failure")f.report.failure="stock phase failed" as unknown as null;
 if(scenario==="marker")f.report.validated=false;
 if(scenario==="commit")f.report.commit="b".repeat(40);
 if(scenario==="run")f.report.runId="prior-run";
 if(scenario==="missing-row")f.report.rows.pop();
 if(scenario==="duplicate-row")f.report.rows[3]=f.report.rows[2];
 if(scenario==="wrong-size")f.report.rows[3].sourceUnits=79999;
 if(scenario==="wrong-hash")f.report.rows[3].sourceSha256="b".repeat(64);
 if(scenario==="wrong-status")f.report.rows[3].status="unsupported";
 if(scenario==="changed-source")f.report.rows[3].sourceEqual=false;
 if(scenario==="negative-timing")f.report.rows[3].stockMs=-1;
 if(scenario==="nonfinite-timing")f.report.rows[3].projectionMs=Infinity;
 if(scenario==="runtime")f.report.runtime.node="";
 if(scenario==="baseline")f.report.baselineSha256="b".repeat(64);
 if(scenario==="fixture-name")f.report.rows[3].fixture="other";
 if(scenario==="source-inventory")delete f.report.sourceHashes["scripts/image-parser-stock-characterization.ts"];
 if(scenario==="source-bytes")f.report.sourceHashes["scripts/image-parser-stock-characterization.ts"]="b".repeat(64);
 if(scenario==="bundle-bytes")writeFileSync(join(f.directory,"stock-characterization.cjs"),"changed bundle");
 if(scenario==="missing-file"){const result=spawnSync(process.execPath,[resolve("scripts/check-image-parser-stock-report.cjs"),join(f.directory,"missing.json"),commit,runId]);expect(result.status).not.toBe(0);return;}
 expect(f.run().status).not.toBe(0);
});
