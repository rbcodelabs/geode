import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
const directories:string[]=[],commit="a".repeat(40),runId="synthetic-current-run",names=["canonical","instrumented","fault-error","fault-malformed"];
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),"geode-packed-report-"));directories.push(directory);
 const report={commit,runId,validated:true,failure:null,modes:Object.fromEntries(names.map(mode=>[mode,{proofMode:mode}])),parentOrigins:Object.fromEntries(names.map(mode=>[mode,{}])),effectivePreferences:Object.fromEntries(names.map(mode=>[mode,{}])),resourceHashes:{} as Record<string,Record<string,string>>};
 for(const mode of names){mkdirSync(join(directory,mode));report.resourceHashes[mode]={};for(const name of ["index.html","broker.mjs","worker.mjs"]){const body="synthetic "+mode+name;writeFileSync(join(directory,mode,name),body);report.resourceHashes[mode][name]=createHash("sha256").update(body).digest("hex");}}
 return {directory,report,run(){const file=join(directory,"report.json");writeFileSync(file,JSON.stringify(report));return spawnSync(process.execPath,[resolve("scripts/check-image-parser-packed-report.cjs"),file,commit,runId],{encoding:"utf8"});}};
}
it("accepts a complete synthetic terminal fixture with matching fresh execution and resource hashes",()=>{const f=fixture();expect(f.run().status).toBe(0);});
it.each(["partial-failure","missing-mode","wrong-commit","stale-run","missing-final-marker","wrong-mode-identity","changed-resource","missing-resource","missing-parent-origin","missing-preferences","missing-file"])("rejects %s even when the Electron process returned zero",scenario=>{
 const f=fixture();
 if(scenario==="partial-failure"){f.report.failure="ERR_FAILED loading second window" as unknown as null;f.report.modes={canonical:{proofMode:"canonical"}};}
 if(scenario==="missing-mode")delete f.report.modes["fault-error"];
 if(scenario==="wrong-commit")f.report.commit="b".repeat(40);
 if(scenario==="stale-run")f.report.runId="synthetic-prior-run";
 if(scenario==="missing-final-marker")f.report.validated=false;
 if(scenario==="wrong-mode-identity")f.report.modes.instrumented.proofMode="canonical";
 if(scenario==="missing-resource")delete f.report.resourceHashes.instrumented;
 if(scenario==="missing-parent-origin")delete f.report.parentOrigins.instrumented;
 if(scenario==="missing-preferences")delete f.report.effectivePreferences.instrumented;
 if(scenario==="changed-resource")writeFileSync(join(f.directory,"canonical/worker.mjs"),"different synthetic bytes");
 if(scenario==="missing-file"){const result=spawnSync(process.execPath,[resolve("scripts/check-image-parser-packed-report.cjs"),join(f.directory,"missing.json"),commit,runId]);expect(result.status).not.toBe(0);return;}
 const result=f.run();expect(result.status).not.toBe(0);
});
