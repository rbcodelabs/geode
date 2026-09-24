import assert from 'node:assert/strict';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Client } from 'pg';
import { awsCredentialsProvider,getVercelOidcToken } from '@vercel/functions/oidc';
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import * as blob from '@vercel/blob';
import ddl from '../../src/catalog/dsql-catalog-schema.sql';
import { validateInventory } from './inventory.ts';

const inventory=validateInventory(PREVIEW_INVENTORY);
const {schema,denialSchema,target,tables}=inventory;
let running=false;
function authorized(req) {
  const supplied=Buffer.from(String(req.headers['x-geode-nonce']||'')),expected=Buffer.from(PREVIEW_NONCE);
  return supplied.length===expected.length && timingSafeEqual(supplied,expected);
}
async function binding() {
  assert.equal(process.env.VERCEL_ENV,'preview');
  assert.equal(process.env.PGHOST,target.host);assert.equal(process.env.AWS_REGION,target.region);assert.equal(process.env.AWS_ROLE_ARN,target.roleArn);
  assert.equal(process.env[PREVIEW_BLOB_TOKEN_NAME]?.match(/^vercel_blob_rw_([^_]+)_/)?.[1],target.blobStoreId);
  // These are deployment-binding checks, not JWT verification. AWS verifies the
  // SDK-provided token during federation; no request-provided token is accepted.
  const claims=JSON.parse(Buffer.from((await getVercelOidcToken()).split('.')[1],'base64url').toString());
  assert.equal(claims.project_id,target.projectId);assert.equal(claims.owner_id,target.teamId);assert.equal(claims.environment,'preview');
  assert.ok(claims.exp*1000>Date.now());
  assert.ok(process.env.VERCEL_BLOB_RETRIES===undefined || /^(?:[0-9]|10)$/.test(process.env.VERCEL_BLOB_RETRIES));
  return {token:process.env[PREVIEW_BLOB_TOKEN_NAME]};
}
async function adminConnection() {
  const signer=new DsqlSigner({hostname:target.host,region:target.region,credentials:awsCredentialsProvider({roleArn:target.roleArn}),expiresIn:600});
  const client=new Client({host:target.host,port:5432,database:'postgres',user:'admin',ssl:{rejectUnauthorized:true},password:()=>signer.getDbConnectAdminAuthToken(),connectionTimeoutMillis:10000,query_timeout:10000});
  await client.connect();return client;
}
async function worker(phase) {
  const env={PATH:process.env.PATH,NODE_ENV:'production',AWS_REGION:target.region,AWS_ROLE_ARN:target.roleArn,
    VERCEL_OIDC_TOKEN:await getVercelOidcToken(),[PREVIEW_BLOB_TOKEN_NAME]:process.env[PREVIEW_BLOB_TOKEN_NAME]};
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[join(__dirname,'worker.mjs'),phase],{env,stdio:['ignore','pipe','ignore'],timeout:120000});
    let output='';child.stdout.on('data',chunk=>{output+=chunk;if(output.length>65536)child.kill();});child.on('error',()=>reject(new Error('Worker startup failed')));
    child.on('close',(code,signal)=>{try{resolve({...JSON.parse(output.trim()),exitCode:code,signal});}catch{reject(new Error('Worker did not return a bounded report'));}});
  });
}
// Infrastructure entry glue is exercised only in the protected synthetic preview;
// resource-name/retention/inventory and runtime algorithms have deterministic tests.
export default async function handler(req,res) {
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST'||!authorized(req)||running){res.statusCode=403;return res.end('{}');}
  const action=req.headers['x-geode-action'];
  if(!['inspect','setup','run','cleanup'].includes(action)){res.statusCode=400;return res.end('{}');}
  running=true;const report={action,status:'failed',steps:[]};let client;let count=0;let stage='target-binding';
  try {
    const auth=await binding();
    if(action!=='cleanup') assert.ok(Date.now()<Date.parse(inventory.expiresAt),'Expired inventory');
    if(action==='inspect') {
      // Authenticated private store read; no object is created by inspection.
      const result=await blob.list({...auth,prefix:schema+'/',limit:1,abortSignal:AbortSignal.timeout(10000)});
      assert.equal(result.blobs.length,0);report.targetMatched=true;report.emptyPrefix=true;
    } else if(action==='run') {
      report.workers=[];
      for(const phase of ['publish','restore']) {stage=phase;const result=await worker(phase);report.workers.push(result);assert.equal(result.status,'ok');assert.equal(result.exitCode,0);}
      assert.notEqual(report.workers[0].pid,report.workers[1].pid);
      assert.equal(report.workers[0].projectionHash,report.workers[1].projectionHash);report.projectionsIdentical=true;
    } else {
      stage='admin-connect';client=await adminConnection();
      const query=async(text,values=[])=>{assert.ok(++count<=250,'Administrative SQL cap');return client.query(text,values);};
      const exists=async(kind,name)=>Number((await query(kind==='schema'?'SELECT count(*) AS n FROM pg_namespace WHERE nspname=$1':'SELECT count(*) AS n FROM pg_roles WHERE rolname=$1',[name])).rows[0].n)>0;
      if(action==='setup') {
        stage='ownership-preflight';for(const name of [schema,denialSchema]) {assert.equal(await exists('schema',name),false);assert.equal(await exists('role',name),false);}
        const existing=await blob.list({...auth,prefix:schema+'/',limit:1,abortSignal:AbortSignal.timeout(10000)});assert.equal(existing.blobs.length,0);
        for(const name of [schema,denialSchema]) {
          stage='create-role';await query(`CREATE ROLE "${name}" WITH LOGIN`);
          stage='create-schema';await query(`CREATE SCHEMA "${name}"`);
        }
        stage='map-runtime-role';await query(`AWS IAM GRANT "${schema}" TO '${target.roleArn}'`);
        await query(`SET search_path TO "${schema}"`);
        // This audited DDL contains no semicolons inside strings; no arbitrary SQL input.
        for(const statement of ddl.replace(/--[^\n]*/g,'').split(';').map(x=>x.trim()).filter(Boolean)) {
          assert.ok(/^CREATE TABLE (vault_sequence|object|catalog_entry|receipt) \(/.test(statement));
          stage='create-table';await query(statement);
        }
        await query(`CREATE TABLE "${denialSchema}".sentinel (id text PRIMARY KEY)`);
        await query(`GRANT USAGE ON SCHEMA "${schema}" TO "${schema}"`);
        for(const table of tables) await query(`GRANT SELECT,INSERT,UPDATE,DELETE ON "${schema}"."${table}" TO "${schema}"`);
        report.setupComplete=true;
      } else {
        // Exact inventory, not last process's in-memory flags. Safe after partial setup/run.
        const attempt=async(name,fn)=>{try{await fn();report.steps.push({name,ok:true});}catch{report.steps.push({name,ok:false});}};
        // One bounded batch of exact inventoried names; never a prefix deletion.
        await attempt('blob-delete',()=>blob.del([...inventory.blobKeys],{...auth,abortSignal:AbortSignal.timeout(10000)}));
        for(const name of [schema,denialSchema]) {
          await attempt('schema-delete',async()=>{
            if(await exists('schema',name)) {
              for(const table of name===schema?tables:['sentinel']) await query(`DROP TABLE IF EXISTS "${name}"."${table}"`);
              await query(`DROP SCHEMA "${name}"`);
            }
          });
          await attempt('role-delete',async()=>{
            const mappings=(await query('SELECT count(*) AS n FROM sys.iam_pg_role_mappings WHERE pg_role_name=$1',[name])).rows[0].n;
            if(Number(mappings)>0) await query(`AWS IAM REVOKE "${name}" FROM '${target.roleArn}'`);
            if(await exists('role',name)) await query(`DROP ROLE "${name}"`);
          });
        }
        stage='verify-residue';
        for(const name of [schema,denialSchema]) {assert.equal(await exists('schema',name),false);assert.equal(await exists('role',name),false);assert.equal(Number((await query('SELECT count(*) AS n FROM sys.iam_pg_role_mappings WHERE pg_role_name=$1',[name])).rows[0].n),0);}
        const residue=await blob.list({...auth,prefix:schema+'/',limit:1,abortSignal:AbortSignal.timeout(10000)});assert.equal(residue.blobs.length,0);assert.equal(residue.hasMore,false);
        assert.ok(report.steps.every(x=>x.ok));report.zeroResidue=true;
      }
    }
    report.status='ok';
  } catch(e) {report.failure={stage,code:typeof e.code==='string'?e.code:'assertion-or-transport'};}
  finally {
    if(client)await client.end().catch(()=>undefined);running=false;report.sqlStatements=count;
    res.statusCode=report.status==='ok'?200:502;res.end(JSON.stringify(report));
  }
}
