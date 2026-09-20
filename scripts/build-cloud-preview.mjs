import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

// Build only. Every deploy/call remains an explicit, separately recorded operator step.
const destination=resolve(process.argv[2]||'');
assert.ok(process.argv[2] && process.env.PREVIEW_ENV_FILE && process.env.PREVIEW_PROJECT_FILE,'Explicit isolated output, preview environment and project link required');
const env=parseEnv(await readFile(process.env.PREVIEW_ENV_FILE,'utf8'));
const project=JSON.parse(await readFile(process.env.PREVIEW_PROJECT_FILE,'utf8'));
assert.ok(process.env.EXPECTED_TEAM_ID===project.orgId && process.env.EXPECTED_PROJECT_ID===project.projectId,'Explicit approved project binding required');
const tokenName=process.env.PREVIEW_BLOB_TOKEN_NAME;
assert.match(tokenName??'',/^[A-Z][A-Z0-9_]+$/);
const storeId=env[tokenName]?.match(/^vercel_blob_rw_([^_]+)_/)?.[1];
assert.ok(storeId,'Existing attached private store token required');
assert.ok(process.env.PREVIEW_EXPECTED_TARGET_FILE,'Previously verified private target binding required');
const expectedTarget=JSON.parse(await readFile(process.env.PREVIEW_EXPECTED_TARGET_FILE,'utf8'));
assert.deepEqual({teamId:project.orgId,projectId:project.projectId,host:env.PGHOST,region:env.AWS_REGION,roleArn:env.AWS_ROLE_ARN,blobStoreId:storeId},expectedTarget,'Attached target changed: stop for owner confirmation');
await mkdir(destination,{recursive:true,mode:0o700});
const temporary=await mkdtemp(join(tmpdir(),'geode-preview-build-'));
try {
  // Bundle these helpers so their TypeScript imports resolve exactly like the runtime.
  const helper=join(temporary,'helpers.mjs');
  await build({stdin:{contents:"export * from './scripts/cloud-preview/fixture.mjs'; export * from './scripts/cloud-preview/inventory.ts';",resolveDir:process.cwd()},outfile:helper,bundle:true,platform:'node',format:'esm',banner:{js:"import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);"}});
  const {fixture,inventoryKeys,saveInventory}=await import(helper);
  const root=join(temporary,'vault');await mkdir(root);
  const {request}=await fixture(root);
  const schema='geode_wiki_preview_'+randomBytes(8).toString('hex');
  const createdAt=new Date().toISOString();
  const manifest={version:1,schema,denialSchema:schema+'_deny',tables:['receipt','catalog_entry','object','vault_sequence'],createdAt,expiresAt:new Date(Date.parse(createdAt)+24*3600_000).toISOString(),
    target:{teamId:project.orgId,projectId:project.projectId,host:env.PGHOST,region:env.AWS_REGION,roleArn:env.AWS_ROLE_ARN,blobStoreId:storeId},blobKeys:inventoryKeys(schema,request)};
  // This must succeed and fsync before producing anything deployable.
  await saveInventory(join(destination,'inventory.json'),manifest);
  const functionDir=join(destination,'.vercel/output/functions/api/geode-preview.func');
  await mkdir(functionDir,{recursive:true});
  const nonce=randomBytes(32).toString('hex');
  await writeFile(join(destination,'request-nonce'),nonce,{mode:0o600,flag:'wx'});
  for(const name of ['handler','worker']) {
    const isWorker=name==='worker';
    const result=await build({entryPoints:[`scripts/cloud-preview/${name}.mjs`],outfile:join(functionDir,isWorker?'worker.mjs':'index.js'),bundle:true,platform:'node',format:isWorker?'esm':'cjs',target:'node24',external:['pg-native'],loader:{'.sql':'text'},metafile:true,
      define:{PREVIEW_INVENTORY:JSON.stringify(manifest),PREVIEW_BLOB_TOKEN_NAME:JSON.stringify(tokenName),PREVIEW_NONCE:JSON.stringify(nonce)},
      ...(isWorker?{banner:{js:"import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);"}}:{})});
    const inputs=Object.keys(result.metafile.inputs);
    assert.ok(!inputs.some(p=>/postgres-catalog-store\.ts|dsql-catalog-store\.ts|src\/(main|preload|indexer)\//.test(p)),'No spike SQL or desktop code in cloud runtime');
    assert.ok(inputs.filter(p=>p.startsWith('src/renderer/')).every(p=>['src/renderer/api/frontmatter.ts','src/renderer/comments/model.ts'].includes(p)),'Only existing portable parser helpers may enter the cloud graph');
    await writeFile(join(destination,name+'-inputs.json'),JSON.stringify(inputs,null,2));
  }
  await writeFile(join(destination,'.vercel/project.json'),JSON.stringify(project));
  await writeFile(join(destination,'.vercel/output/config.json'),JSON.stringify({version:3}));
  await writeFile(join(functionDir,'.vc-config.json'),JSON.stringify({runtime:'nodejs24.x',handler:'index.js',launcherType:'Nodejs',maxDuration:300}));
  console.log(JSON.stringify({destination,schema,objectKeys:manifest.blobKeys.length,expiresAt:manifest.expiresAt}));
} finally { await rm(temporary,{recursive:true,force:true}); }
