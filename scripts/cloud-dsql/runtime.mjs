import assert from 'node:assert/strict';
import { Client } from 'pg';
import * as blob from '@vercel/blob';
import { createDsqlCatalog, splitSqlStatements } from '../../src/catalog/dsql-catalog-store.ts';

export function scopedRuntime() {
  const schema = process.env.GEODE_SPIKE_SCHEMA;
  assert.match(schema, /^geode_wiki_spike_[a-f0-9]{16}$/);
  assert.equal(process.env.PGUSER, schema);
  const prefix = `${schema}/`;
  const usage = {sqlStatements:0,sqlStates:[],blobReads:0,blobWrites:0,blobLists:0,readBytes:0,writtenBytes:0};
  const auth = {token:process.env.BLOB_READ_WRITE_TOKEN};
  let barrier = null;
  function armWriteBarrier() {
    assert.equal(barrier,null);
    let release;
    const ready=new Promise(resolve=>{release=resolve;});
    barrier={arrivals:0,ready,release};
  }
  function pathname(key) {
    assert.match(key, /^[A-Za-z0-9_.-]+\/objects\/[a-f0-9]{64}$/);
    return prefix + key;
  }
  const objects = {
    async put(key, bytes, contentType) {
      assert.ok(++usage.blobWrites <= 40 && usage.writtenBytes + bytes.length < 4*1024*1024, 'Blob write budget');
      const result = await blob.put(pathname(key), bytes, {...auth,access:'private',contentType,addRandomSuffix:false,allowOverwrite:false});
      assert.equal(result.pathname, pathname(key));
      usage.writtenBytes += bytes.length;
      // This wrapper exposes stable logical keys and checks the physical key.
      return key;
    },
    async get(key) {
      assert.ok(++usage.blobReads <= 100, 'Blob read budget');
      const result = await blob.get(pathname(key), {...auth,access:'private',useCache:false});
      if (!result) return null;
      assert.equal(result.statusCode, 200);
      assert.ok(result.blob.size < 1024*1024, 'Blob read size budget');
      const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
      usage.readBytes += bytes.length;
      assert.ok(usage.readBytes < 16*1024*1024, 'Blob transfer budget');
      return bytes;
    },
    async delete(key) { await blob.del(pathname(key), auth); },
    async list(keyPrefix) {
      assert.ok(++usage.blobLists < 10);
      const result = await blob.list({...auth,prefix,limit:100});
      assert.equal(result.hasMore,false);
      return result.blobs.map(b=>b.pathname.slice(prefix.length)).filter(k=>k.startsWith(keyPrefix));
    },
  };
  async function executeSql(sql) {
    assert.ok(!/compass_|\bpublic\b/i.test(sql), 'No existing application schemas');
    const client = new Client({ssl:true,connectionTimeoutMillis:10000,query_timeout:10000});
    try {
      await client.connect();
      assert.equal((await client.query('SHOW standard_conforming_strings')).rows[0].standard_conforming_strings,'on');
      usage.sqlStatements++;
      const output = [];
      for (const statement of splitSqlStatements(sql)) {
        assert.ok(++usage.sqlStatements <= 400, 'SQL operation budget');
        if(barrier && /^INSERT INTO vault_sequence\b/.test(statement)) {
          const held=barrier;
          // Establish both transaction snapshots before either claims a slot.
          await client.query('SELECT count(*) FROM vault_sequence');usage.sqlStatements++;
          if(++held.arrivals===2) {barrier=null;held.release();}
          let timer;
          try {await Promise.race([held.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('write barrier timed out')),5000);})]);}
          finally {clearTimeout(timer);}
        }
        const result = await client.query({text:statement,rowMode:'array'});
        for (const row of result.rows) output.push(row.map(v=>v??'').join('|'));
      }
      return output.join('\n');
    } catch(e) {
      if(e.code) usage.sqlStates.push(e.code);
      throw new Error(`ERROR: ${e.code || 'XXXXX'}: ${e.message}`);
    } finally { await client.end(); }
  }
  return {catalog:createDsqlCatalog({schema,objects,executeSql,maxAttempts:8,retryBackoffMs:30}),objects,usage,armWriteBarrier};
}
