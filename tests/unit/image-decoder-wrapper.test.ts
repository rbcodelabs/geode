/** Actual runner CLI with explicitly synthetic child output; no native proof claim. */
import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { runChild, OwnedProcessGroups, collectProcessGroupRss } from "../../scripts/large-vault-runner-lib.mjs";
import { validDecoderReport } from "./helpers/image-decoder-report-fixture";
const require = createRequire(import.meta.url), { IMAGE_DECODER_SOURCE_PATHS } = require("../../scripts/check-image-decoder-report.cjs");
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "geode-six-wrapper-")); directories.push(root);
  const manifest = JSON.parse(readFileSync("tests/fixtures/image-decoder/manifest.json", "utf8"));
  for (const file of [...IMAGE_DECODER_SOURCE_PATHS, "tests/fixtures/image-decoder/manifest.json", ...manifest.fixtures.map((row: any) => row.path), manifest.corruptPNG.path]) {
    mkdirSync(dirname(join(root, file)), { recursive: true }); copyFileSync(resolve(file), join(root, file));
  }
  mkdirSync(join(root, "dist")); writeFileSync(join(root, "dist/preload.js"), "synthetic test preload");
  writeFileSync(join(root, "synthetic-report.json"), JSON.stringify(validDecoderReport().report));
  const hook = join(root, "synthetic-boundaries.cjs");
  writeFileSync(hook, String.raw`
const Module=require('node:module'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process'),original=cp.execFileSync;
const root=${JSON.stringify(root)},mode=${JSON.stringify(mode)},commit='a'.repeat(40),hash=value=>crypto.createHash('sha256').update(value).digest('hex'),load=Module._load;
Module._load=function(name,...rest){
 if(name==='electron')return process.execPath;
 if(name==='electron/package.json')return {version:'42.10.0'};
 if(name==='node:child_process')return {...cp,execFileSync(file,args,options){
  if(file==='git')return commit;
  if(args.some(value=>String(value).endsWith('proof-image-decoder.cjs'))){
   if(mode==='nonzero')return original(process.execPath,['-e','process.exit(23)'],options);
   if(mode==='missing')return original(process.execPath,['-e',''],options);
   if(mode==='hang')return original(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],'entered');setInterval(()=>{},1000)",path.join(root,'native-entered')],options);
   const directory=options.env.GEODE_IMAGE_DECODER_OUTPUT,runId=options.env.GEODE_IMAGE_DECODER_RUN_ID;
   fs.writeFileSync(path.join(directory,'native-helper.js'),'synthetic native helper');fs.writeFileSync(path.join(directory,'actual-reader.cjs'),'synthetic actual-reader boundary');
   const report=JSON.parse(fs.readFileSync(path.join(root,'synthetic-report.json')));
   report.commit=commit;report.runId=mode==='stale'?'ad925431-abcd-4000-9000-100000000000':runId;
   report.completed=mode!=='partial';report.failure=mode==='failure'?'synthetic native error':null;
   report.runtime.platform=process.platform;
   report.fixtureManifestSha256=hash(fs.readFileSync(path.join(root,'tests/fixtures/image-decoder/manifest.json')));
   report.bundleSha256=hash(fs.readFileSync(path.join(directory,'native-helper.js')));report.readerBundleSha256=hash(fs.readFileSync(path.join(directory,'actual-reader.cjs')));
   report.preloadSha256=hash(fs.readFileSync(path.join(root,'dist/preload.js')));
   for(const source of Object.keys(report.sourceHashes))report.sourceHashes[source]=hash(fs.readFileSync(path.join(root,source)));
   return original(process.execPath,['-e',"require('node:fs').writeFileSync(process.argv[1],process.argv[2],{flag:'wx'})",path.join(directory,'report.json'),JSON.stringify(report)],options);
  }
  return original(file,args,options);
 }};
 return load.call(this,name,...rest);
};`);
  return { root, hook, script: join(root, "scripts/run-image-decoder-proof.cjs"), terminal: join(root, "terminal.json") };
}
it.each(["nonzero", "missing", "partial", "stale", "failure"])("never writes terminal success after a synthetic child %s", mode => {
  const f = fixture(mode), result = spawnSync(process.execPath, [f.script, f.terminal], { cwd: f.root, env: { ...process.env, NODE_OPTIONS: `--require ${f.hook}` }, encoding: "utf8" });
  expect(result.status).not.toBe(0); expect(existsSync(f.terminal)).toBe(false);
});
it("writes fresh digest-bound success only after actual runner validation of a synthetic complete fixture", () => {
  const f = fixture("positive"), result = spawnSync(process.execPath, [f.script, f.terminal], { cwd: f.root, env: { ...process.env, NODE_OPTIONS: `--require ${f.hook}` }, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const terminal = JSON.parse(readFileSync(f.terminal, "utf8")), directory = join(f.root, "test-results/image-decoder-proof", terminal.runId);
  expect(terminal.validated).toBe(true); expect(terminal.runId).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.parse(readFileSync(join(directory, "validation.json"), "utf8"))).toEqual(terminal);
  expect(readFileSync(join(directory, "actual-preload.js"))).toEqual(readFileSync(join(f.root, "dist/preload.js")));
});
it("the existing owner terminates a real hanging synthetic descendant and verifies observed groups", async () => {
  const f = fixture("hang"), previous = process.env.NODE_OPTIONS; process.env.NODE_OPTIONS = `--require ${f.hook}`;
  try {
    const result = await runChild({ script: f.script, args: [f.terminal], cwd: f.root, resultFile: f.terminal, logFile: join(f.root, "owned.log"), timeoutMs: 1800 });
    expect(existsSync(join(f.root, "native-entered"))).toBe(true); expect(result.status).toBe("timeout"); expect(result.result.validated).not.toBe(true);
    const guard = JSON.parse(readFileSync(f.terminal + ".guard.json", "utf8")); expect(guard.cleanupUncertainty).toBe(false);
    const tracker = new OwnedProcessGroups(0); tracker.started = true;
    for (const sample of guard.samples) for (const process of sample.processes) tracker.identities.set(process.pid, process.started);
    await expect.poll(async () => (await collectProcessGroupRss(0, tracker)).processes.length).toBe(0);
  } finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
});
