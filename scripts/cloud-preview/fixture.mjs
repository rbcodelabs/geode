import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openWikiSession } from '../../src/wiki/index.ts';
import { buildProofVault, proofContentType } from '../catalog-proof-vault.mts';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const raceText = '# Cold race\n';
export const boundaryText = '# Boundary\n';
export async function fixture(root) {
  await buildProofVault(root);
  await writeFile(join(root,' Draft.md'),'# Leading space\n');
  await writeFile(join(root,'__GEODE_SPLIT__.md'),'# Sentinel\n');
  const opened = await openWikiSession(root);
  if(opened.status!=='ok') throw new Error('Synthetic fixture capture failed');
  const notes=[],assets=[];
  for(const file of opened.session.listFiles()) {
    if(file.kind==='note') notes.push({path:file.path,text:opened.session.readNote(file.path).note.text});
    else {const bytes=new Uint8Array(await readFile(join(root,file.path)));assets.push({path:file.path,bytes,contentType:proofContentType(file.path),contentAddress:sha(bytes)});}
  }
  return {request:{vaultId:'restore',mutationId:'first',baseSequence:0,notes,assets},projection:project(opened.session)};
}
/** The same supported public SDK queries are evaluated in independent processes. */
export function project(session) {
  const files=session.listFiles();
  return JSON.stringify({files,notes:files.filter(f=>f.kind==='note').map(f=>[f.path,session.readNote(f.path),session.outgoingLinks(f.path),session.backlinks(f.path)]),
    searches:['plesiosaur','café','日本語'].map(q=>[q,session.search(q)]),
    resolutions:['Decision','Choice','Deep note','Nothing Here','Decision#Decision'].map(target=>[target,session.resolveLink('Index.md',target)])});
}
export function inventoryKeys(schema,request) {
  const keys=new Set();
  for(const note of request.notes) keys.add(`${schema}/restore/objects/${sha(note.text)}`);
  for(const asset of request.assets) keys.add(`${schema}/restore/objects/${asset.contentAddress}`);
  for(const vault of ['cold-race','sql-race','interrupted']) keys.add(`${schema}/${vault}/objects/${sha(raceText)}`);
  keys.add(`${schema}/boundary/objects/${sha(boundaryText)}`);
  keys.add(`${schema}/corrupt/objects/${sha('honest')}`);
  return [...keys].sort();
}
