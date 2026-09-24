import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const consumer = await mkdtemp(join(tmpdir(), "geode-package-consumer-"));
const node = process.env.GEODE_PROOF_NODE ?? process.execPath;
try {
  execFileSync(process.execPath, [join(root, "scripts/build-headless-package.mjs")], { cwd: root, stdio: "inherit" });
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", consumer], { cwd: join(root, "packages/headless"), encoding: "utf8" }));
  for (const file of packed.files) {
    assert.ok(/^(dist\/|README\.md$|LICENSE$|package\.json$)/.test(file.path), `Unexpected artifact ${file.path}`);
    assert.ok(!/\.map$|\.sql$|fixtures|schema-admin|postgres-catalog-store|types\/renderer\//.test(file.path), `Private artifact ${file.path}`);
  }
  await writeFile(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", join(consumer, packed.filename), "@types/node@25.9.2"], { cwd: consumer, stdio: "inherit" });
  const source = `
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {openWikiSession} from '@rbcodelabs/geode-headless/wiki';
import {createPrivateBlobStore,createCloudCatalog} from '@rbcodelabs/geode-headless/catalog/cloud';
import {createDocumentStore} from '@rbcodelabs/geode-headless/documents';
assert.equal(typeof createPrivateBlobStore,'function');
assert.equal(typeof createCloudCatalog,'function');
await mkdir('vault');
const opened=await openWikiSession('vault');
assert.equal(opened.status,'ok');
if(opened.status!=='ok')throw Error('open');
await opened.session.createNote('Hello.md','# Hello\\n[[World]]');
await opened.session.createNote('World.md','Body');
assert.equal(opened.session.readNote('World.md').status,'ok');
assert.equal(opened.session.search('Body').hits.length,1);
const store=createDocumentStore({namespace:'synthetic-workspace',maxContentBytes:4096,objects:{
 async put(key,bytes){await mkdir(dirname('objects/'+key),{recursive:true});await writeFile('objects/'+key,bytes,{flag:'wx'});return key;},
 async get(key){try{return await readFile('objects/'+key);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
}});
const saved=await store.putContent('\\uFEFF# Hi 🦎\\r\\n');
assert.equal(saved.status,'ok');
assert.deepEqual(await store.readContent(saved.reference),{status:'ok',text:'\\uFEFF# Hi 🦎\\r\\n'});
assert.deepEqual(await store.readContent({...saved.reference,namespace:'another'}),{status:'namespace-mismatch'});
await writeFile('reference.json',JSON.stringify(saved.reference));
await assert.rejects(import('@rbcodelabs/geode-headless/dist/types/catalog/object-store.js'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
console.log(JSON.stringify({node:process.version,packageImports:3,wiki:true,documents:true,privateImportsBlocked:true}));
`;
  await writeFile(join(consumer, "proof.mjs"), source);
  execFileSync(node, ["proof.mjs"], { cwd: consumer, stdio: "inherit" });
  await writeFile(join(consumer, "reopened.mjs"), `
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createDocumentStore} from '@rbcodelabs/geode-headless/documents';
const store=createDocumentStore({namespace:'synthetic-workspace',maxContentBytes:4096,objects:{
 async put(){throw Error('read-only proof');},async get(key){return readFile('objects/'+key);}
}});
const reference=JSON.parse(await readFile('reference.json','utf8'));
assert.deepEqual(await store.readContent(reference),{status:'ok',text:'\\uFEFF# Hi 🦎\\r\\n'});
console.log(JSON.stringify({freshProcessRead:true,node:process.version}));
`);
  execFileSync(node, ["reopened.mjs"], { cwd: consumer, stdio: "inherit" });
  await writeFile(join(consumer, "types.mts"), `
import {createDocumentStore,type DocumentContentReference,type DocumentObjectStore} from '@rbcodelabs/geode-headless/documents';
import {openWikiSession,type WikiSession} from '@rbcodelabs/geode-headless/wiki';
import {createPrivateBlobStore,type PrivateBlobOptions} from '@rbcodelabs/geode-headless/catalog/cloud';
declare const objects: DocumentObjectStore;
declare const ref: DocumentContentReference;
const store=createDocumentStore({namespace:'synthetic',objects,maxContentBytes:1024});
const result=await store.readContent(ref);
if(result.status==='ok'){const text:string=result.text;}
void openWikiSession; void createPrivateBlobStore;
`);
  execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--strict", "--noEmit", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--types", "node", "types.mts"], { cwd: consumer, stdio: "inherit" });
  console.log(JSON.stringify({ artifact: packed.filename, files: packed.files.length, consumerTypecheck: "passed" }));
} finally {
  await rm(consumer, { recursive: true, force: true });
}
