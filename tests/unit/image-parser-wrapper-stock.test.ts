/** Actual wrapper CLI with synthetic child boundaries; not native isolation evidence. */
import {afterEach,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {spawnSync} from "node:child_process";
import {runChild,OwnedProcessGroups,collectProcessGroupRss} from "../../scripts/large-vault-runner-lib.mjs";
const directories:string[]=[];
afterEach(()=>{for(const p of directories.splice(0))rmSync(p,{recursive:true,force:true});});
function fixture(mode:string){
 const root=mkdtempSync(join(tmpdir(),"geode-stock-wrapper-"));directories.push(root);
 for(const name of ["scripts/run-image-parser-packed-proof.cjs","scripts/check-image-parser-packed-report.cjs","scripts/check-image-parser-stock-report.cjs","scripts/image-parser-stock-characterization.ts","tests/unit/helpers/image-source-sync-baseline.ts","tests/unit/helpers/image-source-fixture.ts"]){const file=join(root,name);mkdirSync(dirname(file),{recursive:true});copyFileSync(resolve(name),file);}
 const hook=join(root,"synthetic-boundaries.cjs");
 writeFileSync(hook,String.raw`
const Module=require('node:module'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),original=cp.execFileSync;
const root=${JSON.stringify(root)},mode=${JSON.stringify(mode)},commit='a'.repeat(40),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),load=Module._load;
Module._load=function(name,...rest){
 if(name==='electron')return process.execPath;
 if(name==='esbuild')return {buildSync:options=>fs.writeFileSync(options.outfile,'synthetic stock bundle')};
 if(name==='node:child_process')return {...cp,execFileSync(file,args,options){
  if(file==='git')return commit;
  if(args.some(value=>String(value).endsWith('proof-image-parser-packed.cjs'))){
   const directory=options.env.GEODE_IMAGE_PARSER_PROOF_OUTPUT,runId=options.env.GEODE_IMAGE_PARSER_PROOF_RUN_ID,names=['canonical','instrumented','fault-error','fault-malformed'];
   const report={commit,runId,validated:true,failure:null,modes:Object.fromEntries(names.map(name=>[name,{proofMode:name}])),parentOrigins:Object.fromEntries(names.map(name=>[name,{}])),effectivePreferences:Object.fromEntries(names.map(name=>[name,{}])),resourceHashes:{}};
   for(const mode of names){fs.mkdirSync(path.join(directory,mode));report.resourceHashes[mode]={};for(const name of ['index.html','broker.mjs','worker.mjs']){const bytes='synthetic '+mode+name;fs.writeFileSync(path.join(directory,mode,name),bytes);report.resourceHashes[mode][name]=hash(bytes);}}
   fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify(report));return '';
  }
  if(String(args[0]).endsWith('stock-characterization.cjs')){
   if(mode==='nonzero')return original(process.execPath,['-e','process.exit(23)'],options);
   if(mode==='missing')return original(process.execPath,['-e',''],options);
   if(mode==='hang')return original(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],'entered');setInterval(()=>{},1000)",path.join(root,'stock-entered')],options);
   const report={commit:mode==='stale'?'b'.repeat(40):commit,runId:args[3],validated:mode!=='partial',failure:null,runtime:{node:process.versions.node,grammar:'@lezer/markdown'},baselineSha256:'cb138b0a67351c1eb2aae538440ffbf3fbc9e1d6f838e45368712de314a61335',sourceHashes:Object.fromEntries(['scripts/image-parser-stock-characterization.ts','scripts/check-image-parser-stock-report.cjs','scripts/run-image-parser-packed-proof.cjs','tests/unit/helpers/image-source-sync-baseline.ts','tests/unit/helpers/image-source-fixture.ts'].map(name=>[name,hash(fs.readFileSync(path.join(root,name)))])),bundleSha256:hash(fs.readFileSync(args[0])),rows:[10000,20000,40000,80000].map(sourceUnits=>({fixture:'nested-stock-vs-projection',sourceUnits,sourceSha256:hash('['.repeat(sourceUnits/2)+']'.repeat(sourceUnits/2)),sourceEqual:true,status:'ready',stockMs:1,projectionMs:2}))};
   return original(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],process.argv[2],{flag:'wx'})",args[1],JSON.stringify(report)],options);
  }
  return original(file,args,options);
 }};
 return load.call(this,name,...rest);
};`);
 return {root,hook,script:join(root,"scripts/run-image-parser-packed-proof.cjs"),terminal:join(root,"terminal.json")};
}
it.each(["nonzero","missing","partial","stale"])("never writes terminal success after native pass and stock %s",mode=>{
 const f=fixture(mode),result=spawnSync(process.execPath,[f.script,f.terminal],{cwd:f.root,env:{...process.env,NODE_OPTIONS:`--require ${f.hook}`},encoding:"utf8"});
 expect(result.status).not.toBe(0);expect(existsSync(f.terminal)).toBe(false);
});
it("writes terminal success only after both fresh reports validate",()=>{
 const f=fixture("positive"),result=spawnSync(process.execPath,[f.script,f.terminal],{cwd:f.root,env:{...process.env,NODE_OPTIONS:`--require ${f.hook}`},encoding:"utf8"});
 expect(result.status,result.stderr).toBe(0);const terminal=JSON.parse(readFileSync(f.terminal,"utf8"));expect(terminal.validated).toBe(true);expect(terminal.stock.validated).toBe(true);expect(terminal.stock.runId).toBe(terminal.runId);
});
it("the existing aggregate owner times out a real hanging stock descendant and cleans observed groups",async()=>{
 const f=fixture("hang"),previous=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=`--require ${f.hook}`;
 try{
  const result=await runChild({script:f.script,args:[f.terminal],cwd:f.root,resultFile:f.terminal,logFile:join(f.root,"owned.log"),timeoutMs:1800});
  expect(existsSync(join(f.root,"stock-entered"))).toBe(true);expect(result.status).toBe("timeout");expect(result.result.validated).not.toBe(true);
  const guard=JSON.parse(readFileSync(f.terminal+".guard.json","utf8"));expect(guard.cleanupUncertainty).toBe(false);
  const tracker=new OwnedProcessGroups(0);tracker.started=true;for(const sample of guard.samples)for(const p of sample.processes)tracker.identities.set(p.pid,p.started);
  await expect.poll(async()=>(await collectProcessGroupRss(0,tracker)).processes.length).toBe(0);
 }finally{if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;}
});
