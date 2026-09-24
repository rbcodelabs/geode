import assert from "node:assert/strict";
import {execFileSync,spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {mkdir,mkdtemp,readFile,rm,rmdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {Pool} from "pg";
import {build} from "esbuild";

// Local-only proof. Optional explicit container selection reuses a stopped
// disposable container; credentials never leave the child process environment.
const lock="/tmp/geode-machine-heavy-tests.lock";
try {await mkdir(lock);}catch{throw new Error("Heavy-test lock occupied; retry after its owner releases it");}
let directory,admin,started=false,created=false;
const container=process.env.GEODE_PROOF_CONTAINER;
const schema=`geode_node_proof_${randomUUID().replaceAll("-","")}`;
try {
  const env={...process.env};
  if(container){
    assert.match(container,/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
    const info=JSON.parse(execFileSync("podman",["inspect",container],{encoding:"utf8"}))[0];
    assert.equal(info.State.Running,false,"refuse to take ownership of an already-running container");
    const vars=Object.fromEntries(info.Config.Env.map(item=>{const i=item.indexOf("=");return [item.slice(0,i),item.slice(i+1)];}));
    const binding=info.HostConfig.PortBindings["5432/tcp"]?.[0];assert.ok(binding?.HostPort);
    Object.assign(env,{PGHOST:"127.0.0.1",PGPORT:binding.HostPort,PGUSER:vars.POSTGRES_USER??"postgres",PGDATABASE:vars.POSTGRES_DB??vars.POSTGRES_USER??"postgres",PGPASSWORD:vars.POSTGRES_PASSWORD,PGSSLMODE:"disable"});
    execFileSync("podman",["start",container],{stdio:"ignore"});started=true;
    let ready=false;
    for(let i=0;i<30;i++){try{execFileSync("podman",["exec",container,"pg_isready","-U",env.PGUSER],{stdio:"ignore"});ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}
    assert.ok(ready,"local PostgreSQL did not become ready");
  }
  assert.ok(["127.0.0.1","localhost","::1"].includes(env.PGHOST??""),"PGHOST must explicitly identify local PostgreSQL");
  directory=await mkdtemp(join(tmpdir(),"geode-node-dsql-proof-"));
  admin=new Pool({host:env.PGHOST,port:Number(env.PGPORT??5432),user:env.PGUSER,database:env.PGDATABASE,password:env.PGPASSWORD,ssl:false,max:1,connectionTimeoutMillis:5000,query_timeout:10000});
  await admin.query(`CREATE SCHEMA "${schema}"`);created=true;
  const ddl=(await readFile("src/catalog/dsql-catalog-schema.sql","utf8")).replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean);
  assert.equal(ddl.length,4);
  for(const statement of ddl){assert.match(statement,/^CREATE TABLE (vault_sequence|object|catalog_entry|receipt) \(/);await admin.query(statement.replace(/^CREATE TABLE /,`CREATE TABLE "${schema}".`));}
  const outfile=join(directory,"worker.mjs");
  const bundle=await build({entryPoints:[resolve("scripts/node-dsql-proof.mts")],outfile,bundle:true,platform:"node",format:"esm",target:"node22",metafile:true,banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"}});
  const sources=Object.keys(bundle.metafile.inputs).filter(p=>p.startsWith("src/"));
  assert.ok(sources.includes("src/catalog/cloud.ts"));
  for(const excluded of ["src/catalog/postgres-catalog-store.ts","src/catalog/dsql-catalog-store.ts","src/main/main.ts"])assert.ok(!sources.includes(excluded),`unexpected dependency ${excluded}`);
  const workerEnv={...env,GEODE_NODE_PROOF_ROOT:directory,GEODE_NODE_PROOF_SCHEMA:schema};
  async function run(mode){return new Promise((resolveRun,reject)=>{
    const child=spawn(process.execPath,[outfile,mode],{env:workerEnv,stdio:["ignore","pipe","pipe"]});let output="",errors="";
    const timeout=setTimeout(()=>child.kill("SIGKILL"),30_000);
    child.stdout.setEncoding("utf8");child.stderr.setEncoding("utf8");child.stdout.on("data",s=>{output+=s;});child.stderr.on("data",s=>{errors+=s;});
    child.on("error",error=>{clearTimeout(timeout);reject(error);});
    child.on("close",code=>{
      clearTimeout(timeout);
      try {
        assert.equal(code,0,`Local ${mode} proof failed: ${errors}`);
        let alive=true;try{process.kill(child.pid,0);}catch{alive=false;}
        assert.equal(alive,false);
        const rows=output.trim().split("\n").map(line=>JSON.parse(line));
        console.log(output.trim());resolveRun(rows);
      } catch(error) {reject(error);}
    });
  });}
  const published=await run("publish"),restored=await run("restore");
  assert.notEqual(published[0].pid,restored[0].pid);assert.equal(published[0].projection,restored[0].projection);
  await run("faults");
  console.log(JSON.stringify({status:"passed",backend:"local-postgresql-not-DSQL",independentProcesses:true,projection:published[0].projection}));
} finally {
  try{if(admin){try{if(created){await admin.query(`DROP SCHEMA "${schema}" CASCADE`);assert.equal((await admin.query("SELECT count(*) AS count FROM information_schema.schemata WHERE schema_name=$1",[schema])).rows[0].count,"0");console.log(JSON.stringify({cleanup:"schema-absent"}));}}finally{await admin.end();}}}
  finally{try{if(directory)await rm(directory,{recursive:true,force:true});}finally{try{if(started)execFileSync("podman",["stop",container],{stdio:"ignore"});}finally{await rmdir(lock);}}}
}
