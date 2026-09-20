import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Deliberately builds only: publishing requires separate explicit authority.
const destination=resolve(process.argv[2]);
const dependencies=process.env.SPIKE_DEPENDENCY_ROOT;
const blobTokenName=process.env.SPIKE_BLOB_TOKEN_NAME;
assert.match(blobTokenName??'',/^[A-Z][A-Z0-9_]+$/,'Name an existing private Blob token variable');
assert.ok(dependencies,'Set SPIKE_DEPENDENCY_ROOT to an existing node_modules with pg, DSQL signer, Vercel functions and Blob');
const schema='geode_wiki_spike_'+randomBytes(8).toString('hex');
const functionDir=join(destination,'.vercel/output/functions/api/geode-spike.func');
await mkdir(functionDir,{recursive:true});
for(const [source,name] of [['handler','index'],['worker','worker']]) {
  const worker=source==='worker';
  const result=await build({entryPoints:[`scripts/cloud-dsql/${source}.mjs`],outfile:join(functionDir,name+(worker?'.mjs':'.js')),bundle:true,platform:'node',format:worker?'esm':'cjs',target:'node24',nodePaths:[dependencies],external:['pg-native'],loader:{'.sql':'text'},define:{SPIKE_SCHEMA:JSON.stringify(schema),SPIKE_BLOB_TOKEN_NAME:JSON.stringify(blobTokenName)},metafile:true,...(worker?{banner:{js:"import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);"}}:{})});
  assert.ok(!Object.keys(result.metafile.inputs).some(p=>p.endsWith('postgres-catalog-store.ts')));
  await writeFile(join(destination,name+'-inputs.json'),JSON.stringify(Object.keys(result.metafile.inputs),null,2));
}
await writeFile(join(destination,'.vercel/output/config.json'),JSON.stringify({version:3}));
await writeFile(join(functionDir,'.vc-config.json'),JSON.stringify({runtime:'nodejs24.x',handler:'index.js',launcherType:'Nodejs',maxDuration:300}));
console.log(JSON.stringify({schema,destination}));
