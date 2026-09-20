import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Client } from 'pg';
import { awsCredentialsProvider } from '@vercel/functions/oidc';
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import * as blob from '@vercel/blob';
import ddl from '../../src/catalog/dsql-catalog-schema.sql';
import { splitSqlStatements } from '../../src/catalog/dsql-catalog-store.ts';

const schema = SPIKE_SCHEMA; // supplied by the audited local build, not a request
assert.match(schema,/^geode_wiki_spike_[a-f0-9]{16}$/);
const tables=['receipt','catalog_entry','object','vault_sequence'];
let running=false;
function worker(phase, env) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[join(__dirname,'worker.mjs'),phase],{env,stdio:['ignore','pipe','pipe'],timeout:85000});
    let output=''; let errors='';
    child.stdout.on('data',x=>{output+=x;});child.stderr.on('data',x=>{errors+=x;});
    child.on('error',reject);
    child.on('close',(code,signal)=>{
      try {
        const result=JSON.parse(output.trim());
        result.exitCode=code;result.signal=signal;
        // The parent waits for process exit; no heap/files/projection go to B.
        resolve(result);
      } catch {reject(new Error(`Worker ${phase} exited ${code}/${signal}: ${errors.slice(0,1500)}`));}
    });
  });
}
export default async function handler(req,res) {
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST'||process.env.VERCEL_ENV!=='preview'||running) {res.statusCode=403;return res.end('{}');}
  running=true;
  const report={schema,status:'failed',cleanup:[],workers:[]};
  let admin;let roleCreated=false;let mapped=false;let schemaCreated=false;
  let stage='authenticate';const started=Date.now();
  const blobToken=process.env[SPIKE_BLOB_TOKEN_NAME];
  const auth={token:blobToken};
  const prefix=schema+'/';
  const arn=process.env.AWS_ROLE_ARN;
  try {
    assert.ok(blobToken,'Configured private Blob token must be present');
    assert.match(arn,/^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9_+=,.@\/-]+$/);
    const credentials=await awsCredentialsProvider({roleArn:arn,clientConfig:{region:process.env.AWS_REGION}})();
    const signer=new DsqlSigner({credentials,hostname:process.env.PGHOST,region:process.env.AWS_REGION,expiresIn:600});
    admin=new Client({host:process.env.PGHOST,user:'admin',database:'postgres',ssl:true,password:await signer.getDbConnectAdminAuthToken(),connectionTimeoutMillis:10000,query_timeout:10000});
    await admin.connect();
    stage='create-role';await admin.query(`CREATE ROLE ${schema} WITH LOGIN`);roleCreated=true;
    stage='map-role';await admin.query(`AWS IAM GRANT ${schema} TO '${arn}'`);mapped=true;
    stage='create-schema';await admin.query(`CREATE SCHEMA ${schema}`);schemaCreated=true;
    await admin.query(`SET search_path TO ${schema}`);
    let index=0;
    for(const statement of splitSqlStatements(ddl)) {stage=`create-table-${index++}`;await admin.query(statement);}
    stage='grant-scoped-access';await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${schema}`);
    for(const table of tables) await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.${table} TO ${schema}`);
    const env={PATH:process.env.PATH,NODE_ENV:'production',PGHOST:process.env.PGHOST,PGPORT:'5432',PGDATABASE:'postgres',PGUSER:schema,PGPASSWORD:await signer.getDbConnectAuthToken(),BLOB_READ_WRITE_TOKEN:blobToken,GEODE_SPIKE_SCHEMA:schema};
    for(const phase of ['publish','restore']) {
      stage=phase;
      const result=await worker(phase,env);report.workers.push(result);
      assert.equal(result.status,'ok',`${phase} proof`);
      assert.equal(result.exitCode,0);
    }
    assert.notEqual(report.workers[0].pid,report.workers[1].pid);
    assert.equal(report.workers[0].projectionHash,report.workers[1].projectionHash);
    report.projectionsIdentical=true;report.status='ok';
  } catch(e) {report.failure={stage,error:e.message,code:e.code||null};}
  finally {
    async function cleanup(step, fn) {try {await fn();report.cleanup.push({step,ok:true});}catch(e){report.cleanup.push({step,ok:false,error:e.message,code:e.code||null});report.status='cleanup-failed';}}
    if(schemaCreated) {
      for(const table of tables) await cleanup('drop-'+table,()=>admin.query(`DROP TABLE IF EXISTS ${schema}.${table}`));
      await cleanup('drop-schema',()=>admin.query(`DROP SCHEMA ${schema}`));
    }
    if(mapped) await cleanup('revoke-mapping',()=>admin.query(`AWS IAM REVOKE ${schema} FROM '${arn}'`));
    if(roleCreated) await cleanup('drop-role',()=>admin.query(`DROP ROLE ${schema}`));
    await cleanup('blob-prefix',async()=>{
      const listing=await blob.list({...auth,prefix,limit:100});
      assert.equal(listing.hasMore,false);report.blobObjectsRemoved=listing.blobs.length;
      for(const b of listing.blobs) {assert.ok(b.pathname.startsWith(prefix));await blob.del(b.url,auth);}
      const after=await blob.list({...auth,prefix,limit:100});assert.equal(after.blobs.length,0);assert.equal(after.hasMore,false);
      report.blobResidue=0;
    });
    if(admin) {
      await cleanup('verify-database-residue',async()=>{
        report.schemaResidue=(await admin.query('SELECT count(*)::text AS n FROM pg_namespace WHERE nspname=$1',[schema])).rows[0].n;
        report.roleResidue=(await admin.query('SELECT count(*)::text AS n FROM pg_roles WHERE rolname=$1',[schema])).rows[0].n;
        report.mappingResidue=(await admin.query('SELECT count(*)::text AS n FROM sys.iam_pg_role_mappings WHERE pg_role_name=$1',[schema])).rows[0].n;
        assert.equal(report.schemaResidue,'0');assert.equal(report.roleResidue,'0');assert.equal(report.mappingResidue,'0');
      });
      await admin.end();
    }
    report.durationMs=Date.now()-started;running=false;
    res.statusCode=report.status==='ok'?200:502;res.end(JSON.stringify(report));
  }
}
