/** Unskipped actual complete-source coverage relocated under ADR0043. */
import {test,expect} from "@playwright/test";
import {mkdir,readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {runChild,OwnedProcessGroups,collectProcessGroupRss} from "../../scripts/large-vault-runner-lib.mjs";

test.describe.configure({retries:0});
test("parses all complete ceiling fixtures with owned asynchronous Reading authority",async({},info)=>{
  test.setTimeout(360_000);
  await mkdir(info.outputDir,{recursive:true});
  const terminal=info.outputPath("packed-parser-terminal.json");
  const result=await runChild({script:resolve("scripts/run-image-parser-packed-proof.cjs"),args:[terminal],cwd:process.cwd(),resultFile:terminal,logFile:info.outputPath("packed-parser-native.log"),timeoutMs:330_000});
  expect(result.code).toBe(0);expect(result.status).toBe("ok");expect(result.result.validated).toBe(true);
  const validation=result.result;
  const reportPath=resolve("test-results/image-parser-packed-proof",validation.report);
  const reportBytes=await readFile(reportPath);
  const report=JSON.parse(reportBytes.toString("utf8"));
  expect(validation.commit).toBe(execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim());
  expect(report.commit).toBe(validation.commit);expect(report.runId).toBe(validation.runId);
  expect(createHash("sha256").update(reportBytes).digest("hex")).toBe(validation.reportSha256);
  expect(report.failure).toBeNull();expect(report.validated).toBe(true);
  expect(Object.keys(report.modes).sort()).toEqual(["canonical","fault-error","fault-malformed","instrumented"]);
  expect(validation).not.toHaveProperty("phaseStartedAt");
  const stockBytes=await readFile(resolve("test-results/image-parser-packed-proof",validation.stock.report));
  const stock=JSON.parse(stockBytes.toString("utf8"));
  expect(createHash("sha256").update(stockBytes).digest("hex")).toBe(validation.stock.reportSha256);
  expect(stock.commit).toBe(validation.commit);expect(stock.runId).toBe(validation.runId);
  expect(stock.validated).toBe(true);expect(stock.failure).toBeNull();
  expect(stock.rows.map((row:{sourceUnits:number})=>row.sourceUnits)).toEqual([10000,20000,40000,80000]);
  expect(stock.rows.every((row:{status:string;sourceEqual:boolean})=>row.status==="ready"&&row.sourceEqual)).toBe(true);
  const guard=JSON.parse(await readFile(terminal+".guard.json","utf8"));
  expect(guard.cleanupUncertainty).toBe(false);
  // Check only identity-verified observed groups. Polling cannot establish
  // universal containment of descendants born/reparented between samples.
  const tracker=new OwnedProcessGroups(0);tracker.started=true;
  for(const sample of guard.samples)for(const process of sample.processes)tracker.identities.set(process.pid,process.started);
  await expect.poll(async()=> (await collectProcessGroupRss(0,tracker)).processes.length).toBe(0);
});
