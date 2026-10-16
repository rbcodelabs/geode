/** Owns a fresh output and validates it after the actual Electron process exits. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {validatePackedRuntimeReport}=require('./check-image-parser-packed-report.cjs');
const {validateStockReport}=require('./check-image-parser-stock-report.cjs');
const root=path.resolve(__dirname,'..'),base=path.join(root,'test-results','image-parser-packed-proof');
try{
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),runId=crypto.randomUUID(),directory=path.join(base,runId);
 fs.mkdirSync(base,{recursive:true});fs.mkdirSync(directory);
 // Canonical require triggers Electron's normal lazy installer when needed.
 execFileSync(require('electron'),['--no-sandbox',path.join(__dirname,'proof-image-parser-packed.cjs')],{cwd:root,stdio:'inherit',env:{...process.env,GEODE_IMAGE_PARSER_PROOF_OUTPUT:directory,GEODE_IMAGE_PARSER_PROOF_RUN_ID:runId}});
 const result=validatePackedRuntimeReport(path.join(directory,'report.json'),commit,runId);
 const stockBundle=path.join(directory,'stock-characterization.cjs'),stockReport=path.join(directory,'stock-report.json');
 // A separate owned Node child keeps the historical synchronous baseline out of
 // canonical host/broker/worker resources. The outer E2E deadline still owns it.
 require('esbuild').buildSync({absWorkingDir:root,entryPoints:['scripts/image-parser-stock-characterization.ts'],outfile:stockBundle,bundle:true,platform:'node',format:'cjs',packages:'external',logLevel:'silent'});
 execFileSync(process.execPath,[stockBundle,stockReport,commit,runId],{cwd:root,stdio:'inherit'});
 const stock=validateStockReport(stockReport,commit,runId,root);
 const validation={...result,report:path.relative(base,path.join(directory,'report.json')),stock:{...stock,report:path.relative(base,stockReport)}};
 fs.writeFileSync(path.join(directory,'validation.json'),JSON.stringify(validation,null,2));
 if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify({status:'ok',...validation},null,2),{flag:'wx'});
 console.log(JSON.stringify(validation,null,2));
}catch(error){console.error(error.stack||error);process.exitCode=1;}
