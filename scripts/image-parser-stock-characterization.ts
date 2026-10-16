/** Nonshipping historical grammar comparison, executed only by the owned proof wrapper. */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync,writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {execFileSync} from "node:child_process";
import {projectOwnedImages} from "../tests/unit/helpers/image-source-sync-baseline";
import {fixture} from "../tests/unit/helpers/image-source-fixture";
const hash=(bytes:string|Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
async function characterize(){
  const rows=[];
  const { parser } = await import("@lezer/markdown");
  for (const size of [10_000, 20_000, 40_000, 80_000]) {
    const source = "[".repeat(size / 2) + "]".repeat(size / 2);
    const beforeStock = performance.now();
    parser.parse(source);
    const afterStock = performance.now();
    const projection = projectOwnedImages(fixture(source).context);
    const observation = { fixture: "nested-stock-vs-projection", sourceUnits: size, stockMs: afterStock - beforeStock, projectionMs: performance.now() - afterStock };
    console.log(JSON.stringify(observation));
    assert.equal(projection.status,"ready");
    assert.equal(projection.source,source);
    rows.push({...observation,status:projection.status,sourceEqual:projection.source===source,sourceSha256:hash(source)});
  }
  return rows;
}
async function main(){
 const [file,expectedCommit,runId]=process.argv.slice(2),commit=execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
 const baseline=readFileSync(resolve("tests/unit/helpers/image-source-sync-baseline.ts"),"utf8").replaceAll('"../../../src/wiki/','"../../wiki/').replaceAll('"../../../src/renderer/comments/model"','"../comments/model"');
 const report={commit,runId,runtime:{node:process.versions.node,grammar:"@lezer/markdown"},baselineSha256:hash(baseline),sourceHashes:Object.fromEntries(["scripts/image-parser-stock-characterization.ts","scripts/check-image-parser-stock-report.cjs","scripts/run-image-parser-packed-proof.cjs","tests/unit/helpers/image-source-sync-baseline.ts","tests/unit/helpers/image-source-fixture.ts"].map(name=>[name,hash(readFileSync(resolve(name)))])),bundleSha256:hash(readFileSync(process.argv[1])),validated:false,failure:null as string|null,rows:[] as Awaited<ReturnType<typeof characterize>>};
 try{assert.equal(commit,expectedCommit);assert.ok(runId);assert.equal(report.baselineSha256,"cb138b0a67351c1eb2aae538440ffbf3fbc9e1d6f838e45368712de314a61335");report.rows=await characterize();report.validated=true;}
 catch(error){report.failure=String(error instanceof Error?error.stack:error);process.exitCode=1;}
 writeFileSync(file,JSON.stringify(report,null,2),{flag:"wx"});
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
