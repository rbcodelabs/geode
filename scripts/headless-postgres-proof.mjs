import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

// Uses an operator-supplied disposable PostgreSQL connection via standard PG*
// environment variables. Only its own random schema is created and removed.
const schema = `geode_phase0_${randomUUID().replaceAll("-", "")}`;
const psql = process.env.PSQL ?? "psql";
const sessions = new Set();
const prefix = `SET search_path TO ${schema}; SET statement_timeout = '10s'; SET lock_timeout = '8s';\n`;
function session(name = `${schema}_query`) {
  const child = spawn(psql, ["-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1"], {
    env: { ...process.env, PGAPPNAME: name }, stdio: ["pipe", "pipe", "pipe"],
  });
  sessions.add(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      sessions.delete(child);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`psql exited ${code}: ${stderr.trim()}`));
    });
  });
  // Concurrent losers may reject while the barrier observer is still running.
  done.catch(() => {});
  return { child, done, output: () => stdout };
}
async function query(sql) {
  const current = session();
  current.child.stdin.end(prefix + sql);
  return current.done;
}
async function until(check, label) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out observing ${label}`);
}
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const changeset = (id, base, changes, fail = false) =>
  `SELECT commit_proof(${literal(id)}, ${base}, ${literal(JSON.stringify(changes))}::jsonb, ${fail});\n`;
const mutation = (id, base, path, content, fail = false) => changeset(id, base, [{ path, content }], fail);
async function simultaneous(firstSql, secondSql) {
  const committed = await snapshot();
  const first = session();
  first.child.stdin.write(prefix + "BEGIN;\n" + firstSql + "\\echo HELD\n");
  await until(() => first.output().includes("HELD"), "first transaction holding publication lock");
  const name = `${schema}_waiter`;
  const second = session(name);
  second.child.stdin.end(prefix + secondSql);
  // Observe a real database lock wait, not a guessed sleep or sequential pair.
  await until(async () => await query(`SELECT count(*) FROM pg_stat_activity WHERE application_name = '${name}' AND wait_event_type = 'Lock';`) === "1", "second transaction blocked on publication lock");
  assert.equal(await snapshot(), committed, "readers must not see uncommitted publication");
  first.child.stdin.end("COMMIT;\n");
  return { first: (await first.done).replace(/\n?HELD\s*$/, ""), second: second.done };
}
async function snapshot() {
  return query(`SELECT jsonb_build_object(
    'vault', (SELECT jsonb_agg(to_jsonb(v)) FROM vault v),
    'catalog', (SELECT jsonb_agg(to_jsonb(c) ORDER BY path) FROM catalog c),
    'index', (SELECT jsonb_agg(to_jsonb(i) ORDER BY path) FROM search_index i),
    'receipts', (SELECT jsonb_agg(to_jsonb(r) ORDER BY mutation_id) FROM receipts r));`);
}

let created = false;
try {
  const sql = await readFile(new URL("./headless-postgres-proof.sql", import.meta.url), "utf8");
  await query(`CREATE SCHEMA ${schema};`);
  created = true;
  await query(sql);

  const receipt = await query(mutation("initial", 0, "Source.md", "first"));
  assert.equal(JSON.parse(receipt).sequence, 1);
  assert.equal(await query(mutation("initial", 0, "Source.md", "first")), receipt);
  await assert.rejects(query(mutation("initial", 0, "Source.md", "different")), /MUTATION_ID_REUSED/);
  await assert.rejects(query(mutation("stale", 0, "Stale.md", "lost")), /CONFLICT/);
  assert.equal(await query("SELECT sequence FROM vault;"), "1");
  assert.equal(await query("SELECT count(*) FROM catalog WHERE path = 'Stale.md';"), "0");

  const distinct = await simultaneous(mutation("winner", 1, "Winner.md", "published"), mutation("loser", 1, "Loser.md", "unpublished"));
  await assert.rejects(distinct.second, /CONFLICT/);
  assert.equal(JSON.parse(distinct.first).sequence, 2);
  assert.equal(await query("SELECT count(*) FROM receipts WHERE mutation_id = 'loser';"), "0");
  assert.equal(await query("SELECT count(*) FROM catalog WHERE path = 'Loser.md';"), "0");

  const identical = await simultaneous(mutation("retry", 2, "Retry.md", "same"), mutation("retry", 2, "Retry.md", "same"));
  assert.equal(await identical.second, identical.first);
  assert.equal(await query("SELECT sequence FROM vault;"), "3");
  assert.equal(await query("SELECT count(*) FROM receipts WHERE mutation_id = 'retry';"), "1");

  const reused = await simultaneous(mutation("reuse", 3, "Reuse.md", "original"), mutation("reuse", 3, "Reuse.md", "changed"));
  await assert.rejects(reused.second, /MUTATION_ID_REUSED/);
  assert.equal(await query("SELECT content FROM catalog WHERE path = 'Reuse.md';"), "original");
  assert.equal(await query("SELECT sequence FROM vault;"), "4");

  const before = await snapshot();
  await assert.rejects(query(changeset("rollback", 4, [
    { path: "Source.md", content: "broken" },
    { path: "Partial.md", content: "must disappear" },
  ], true)), /INJECTED_FAILURE/);
  assert.equal(await snapshot(), before, "sequence, catalog, derived index and receipt must all roll back");
  const recovered = JSON.parse(await query(changeset("rollback", 4, [
    { path: "Source.md", content: "recovered" },
    { path: "Partial.md", content: "published together" },
  ])));
  assert.equal(recovered.sequence, 5);
  assert.equal(recovered.entries, 2);
  for (const table of ["catalog", "search_index"]) {
    assert.equal(await query(`SELECT content FROM ${table} WHERE path = 'Source.md';`), "recovered");
    assert.equal(await query(`SELECT content FROM ${table} WHERE path = 'Partial.md';`), "published together");
  }
  console.log(JSON.stringify({ postgres: await query("SHOW server_version;"), cases: 6, concurrentLockWaitsObserved: 3, rollbackVerified: true, finalSequence: 5 }));
} finally {
  // Abort any open transaction before schema cleanup if a barrier/assert fails.
  for (const child of sessions) child.kill("SIGTERM");
  if (created) await query(`DROP SCHEMA ${schema} CASCADE;`);
}
