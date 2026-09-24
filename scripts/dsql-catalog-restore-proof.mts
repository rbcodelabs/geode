import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_RESTORE_LIMITS,
  restore,
  type RestoreResult,
  type RestoredVault,
} from "../src/wiki/catalog-contract";
import { materializeRestoredVault } from "../src/wiki/catalog-materialize";
import { serializeWikiQueryProjection } from "../src/wiki/query-projection";
import { openLocalWikiProvider } from "../src/wiki/folder-provider";
import { createDsqlCatalog, literal } from "../src/catalog/dsql-catalog-store";
import { createFilesystemObjectStore, objectKeyFor } from "../src/catalog/object-store";
import { PROOF_PROJECTION, RESTORE_VAULT_ID } from "./catalog-proof-vault.mts";

/**
 * VM B for the DSQL adapter: the restore side, in its own process.
 *
 * It shares two things with VM A and nothing else: the disposable schema and
 * the object-store directory. Both are owned by the harness, both are durable,
 * and VM B does not start until VM A's PID is gone. Everything it reconstructs,
 * it reconstructs from those two stores.
 *
 * Sharing *two* stores rather than one is itself part of the claim. The
 * PostgreSQL adapter's restore reads one system; this one has to reassemble a
 * vault from a catalog in a database and bytes in a separate object store, and
 * a restore that silently lost the join would show up as a vault with no
 * content rather than as an error.
 *
 * ## The corruption cases are not the same set as the PostgreSQL proof's
 *
 * ADR 0022 records that `missing-object` and `duplicate-with-mismatched-bytes`
 * are *unreachable* through the PostgreSQL schema — the composite foreign key
 * prevents the first and the object primary key prevents the second — so that
 * proof exercises them against raw fixtures and says so.
 *
 * Neither is unreachable here. There is no foreign key, so a catalog entry can
 * outlive its object row; there is no trigger, so an object's bytes can be
 * replaced. Those two cases move from "refused by the database" to "observed
 * against rows actually planted in it", which is a *weakening* of the system
 * that happens to be a strengthening of the test. This proof reports them as
 * store-observed, and the findings doc says plainly which guarantee was traded
 * for that.
 */

assert.ok(!("window" in globalThis), "window must not exist");
assert.ok(!("document" in globalThis), "document must not exist");
assert.equal(process.versions.electron, undefined, "must not run under Electron");

const schema = process.env.GEODE_CATALOG_SCHEMA;
assert.ok(schema, "GEODE_CATALOG_SCHEMA must name the schema VM A published into");
const objectRoot = process.env.GEODE_OBJECT_ROOT;
assert.ok(objectRoot, "GEODE_OBJECT_ROOT must name the object store VM A published into");
const projectionOut = process.env.GEODE_PROJECTION_OUT;

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const objects = createFilesystemObjectStore(objectRoot);
const catalog = createDsqlCatalog({ schema, schemaDirectory: resolve("src/catalog"), objects });
const source = catalog.restoreSource();

const fingerprint = (vault: RestoredVault): string => JSON.stringify({
  vaultId: vault.vaultId,
  sequence: vault.sequence,
  totalBytes: vault.totalBytes,
  notes: vault.notes.map((note) => [note.path, sha(new TextEncoder().encode(note.text))]),
  assets: vault.assets.map((asset) => [asset.path, asset.contentAddress, asset.contentType, sha(asset.bytes)]),
});

const ok = (result: RestoreResult, label: string): RestoredVault => {
  assert.equal(result.status, "ok", `${label} must restore (got ${result.status})`);
  if (result.status !== "ok") throw new Error("unreachable");
  return result.vault;
};

async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 6000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out observing ${label}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** Plant rows directly, bypassing the adapter. The only honest way to forge store-side corruption. */
async function plant(
  vaultId: string,
  object: { address: string; contentType: string; byteLength: number; key: string } | null,
  entry: { path: string; kind: string; address: string; contentType: string },
): Promise<void> {
  await catalog.query(
    `INSERT INTO vault_sequence (vault_id, sequence, mutation_id) VALUES (${literal(vaultId)}, 1, 'planted');`,
  );
  if (object) {
    await catalog.query(
      "INSERT INTO object (vault_id, content_address, content_type, byte_length, object_key) VALUES (" +
      `${literal(vaultId)}, ${literal(object.address)}, ${literal(object.contentType)}, ` +
      `${object.byteLength}, ${literal(object.key)});`,
    );
  }
  await catalog.query(
    "INSERT INTO catalog_entry (vault_id, path, kind, content_address, content_type, sequence) VALUES (" +
    `${literal(vaultId)}, ${literal(entry.path)}, ${literal(entry.kind)}, ` +
    `${literal(entry.address)}, ${literal(entry.contentType)}, 1);`,
  );
}

const materialized = await mkdtemp(join(tmpdir(), "geode-dsql-vault-b-"));
try {
  /* ---------- 1. VM A is gone --------------------------------------------- */
  await until(
    async () => (await catalog.query(
      `SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE ${literal(schema + "%")};`,
    )).trim() === "1",
    "every session VM A opened having gone away",
  );

  /* ---------- 2. Restore, verified rather than trusted -------------------- */
  const first = ok(await restore(source, RESTORE_VAULT_ID), "the published vault");
  assert.equal(first.sequence, 1, "the restored vault carries the sequence it was published at");
  assert.equal(first.notes.length, 4);
  assert.equal(first.assets.length, 3);
  assert.equal(new Set(first.assets.map((asset) => asset.contentAddress)).size, 2,
    "one stored object must expand back into the two paths that shared it");
  for (const asset of first.assets) {
    assert.equal(sha(asset.bytes), asset.contentAddress, `${asset.path} bytes must hash to their address`);
  }

  const refusedIds = {
    invalidVaultId: (await restore(source, "not a vault id")).status,
    absent: (await restore(source, "never-published")).status,
  };
  assert.deepEqual(refusedIds, { invalidVaultId: "invalid-vault-id", absent: "absent" });

  /* ---------- 3. Materialize, then open with the real engine -------------- */
  const written = await materializeRestoredVault(materialized, first);
  assert.equal(written.status, "ok", "the restored vault must materialize");
  assert.equal(written.noteCount, 4);
  assert.equal(written.assetCount, 3);

  const opened = await openLocalWikiProvider(materialized);
  assert.equal(opened.status, "ok", "the real provider must open the restored folder");
  if (opened.status !== "ok") throw new Error("unreachable");
  const view = opened.provider.snapshot();
  assert.equal(view.listFiles().length, 7, "the restored folder must hold every published entry");
  assert.ok(view.info.discoveryComplete, "the restored capture must be complete");

  const projection = serializeWikiQueryProjection(view, PROOF_PROJECTION);
  if (projectionOut) await writeFile(projectionOut, projection, "utf8");

  /* ---------- 4. Repeated reads, with VM A long gone ---------------------- */
  const second = ok(await restore(source, RESTORE_VAULT_ID), "a repeated restore");
  const third = ok(await restore(source, RESTORE_VAULT_ID), "a third restore");
  assert.equal(fingerprint(second), fingerprint(first), "a repeated restore must return the same vault");
  assert.equal(fingerprint(third), fingerprint(first), "restores must not drift with repetition");

  /* ---------- 5. Corruption planted behind the contract ------------------- *
   *
   * Every case writes state the adapter would have refused. Cases (a), (b) and
   * (c) are the same three the PostgreSQL proof plants. Cases (d) and (e) are
   * the ones ADR 0022 records as *unreachable* through the PostgreSQL schema —
   * they are reachable here, which is the loss this spike exists to measure.
   * Case (f) is new territory entirely: note bytes can now be corrupted,
   * because note bytes now leave the database.
   */
  const honestBytes = new Uint8Array([1, 2, 3, 4]);
  const honestAddress = sha(honestBytes);
  const lyingAddress = sha(new Uint8Array([9, 9, 9]));

  // (a) The object store returns bytes that do not hash to the recorded address.
  await objects.put(objectKeyFor("corrupt-address", lyingAddress), honestBytes, "image/png");
  await plant("corrupt-address",
    { address: lyingAddress, contentType: "image/png", byteLength: 4, key: objectKeyFor("corrupt-address", lyingAddress) },
    { path: "assets/lie.png", kind: "attachment", address: lyingAddress, contentType: "image/png" });

  // (b) The recorded length disagrees with the bytes — a truncated or padded read.
  await objects.put(objectKeyFor("corrupt-length", honestAddress), honestBytes, "image/png");
  await plant("corrupt-length",
    { address: honestAddress, contentType: "image/png", byteLength: 9, key: objectKeyFor("corrupt-length", honestAddress) },
    { path: "assets/short.png", kind: "attachment", address: honestAddress, contentType: "image/png" });

  // (c) A content type outside the allowlist.
  await objects.put(objectKeyFor("corrupt-type", honestAddress), honestBytes, "application/x-msdownload");
  await plant("corrupt-type",
    { address: honestAddress, contentType: "application/x-msdownload", byteLength: 4, key: objectKeyFor("corrupt-type", honestAddress) },
    { path: "assets/tool.exe", kind: "attachment", address: honestAddress, contentType: "application/x-msdownload" });

  // (d) A catalog entry pointing at an object row that does not exist.
  //     ADR 0022: "unreachable ... the catalog entry's foreign key prevents
  //     the second". There is no foreign key here, so it plants cleanly and the
  //     refusal is observed against the database rather than a raw fixture.
  await plant("corrupt-dangling", null,
    { path: "assets/gone.png", kind: "attachment", address: honestAddress, contentType: "image/png" });

  // (e) The object row exists and the bytes behind it are gone. A blob deleted
  //     out of band — the failure mode a `bytea` column could not have.
  await plant("corrupt-evaporated",
    { address: honestAddress, contentType: "image/png", byteLength: 4, key: objectKeyFor("corrupt-evaporated", honestAddress) },
    { path: "assets/vanished.png", kind: "attachment", address: honestAddress, contentType: "image/png" });
  // deliberately never put the bytes

  // (f) A *note* whose bytes were tampered with in the object store.
  //     Impossible under the PostgreSQL adapter, where note text never leaves
  //     the database. `verifyRestoredVault` cannot catch this — `CatalogNote`
  //     has no content address — so the adapter catches it, using the
  //     contract's own name for it.
  const noteBytes = new TextEncoder().encode("# Honest note\n");
  const noteAddress = sha(noteBytes);
  await objects.put(objectKeyFor("corrupt-note", noteAddress), new TextEncoder().encode("# Tampered\n"), "text/markdown");
  await plant("corrupt-note",
    { address: noteAddress, contentType: "text/markdown", byteLength: 14, key: objectKeyFor("corrupt-note", noteAddress) },
    { path: "Note.md", kind: "note", address: noteAddress, contentType: "text/markdown" });

  // (g) Oversize, measured against tighter ceilings rather than a huge fixture.
  const oversize = await restore(
    catalog.restoreSource({ limits: { ...DEFAULT_RESTORE_LIMITS, maxNoteBytes: 8 } }),
    RESTORE_VAULT_ID,
  );

  const restoreRefusals = {
    invalidContentAddress: (await restore(source, "corrupt-address")).status,
    byteLengthMismatch: (await restore(source, "corrupt-length")).status,
    unsupportedContentType: (await restore(source, "corrupt-type")).status,
    danglingObjectRow: (await restore(source, "corrupt-dangling")).status,
    evaporatedBytes: (await restore(source, "corrupt-evaporated")).status,
    tamperedNote: (await restore(source, "corrupt-note")).status,
    oversize: oversize.status,
  };
  assert.deepEqual(restoreRefusals, {
    invalidContentAddress: "invalid-content-address",
    byteLengthMismatch: "byte-length-mismatch",
    unsupportedContentType: "unsupported-content-type",
    // Both dangling shapes land on the same name, and that is correct: from the
    // contract's side "this entry resolves to no bytes" is one condition,
    // whether the metadata row or the object behind it is what went missing.
    danglingObjectRow: "missing-object",
    evaporatedBytes: "missing-object",
    tamperedNote: "invalid-content-address",
    oversize: "oversize",
  }, "every restore refusal must be reported by its own distinct status");
  assert.equal((oversize as { limit?: string }).limit, "note-bytes", "an oversize restore must name the limit it tripped");

  // The planted corruption is still sitting in both stores; the contract simply
  // refused to hand it out. A restore is a checkpoint, not a repair.
  assert.equal(
    (await catalog.query("SELECT count(*) FROM object WHERE vault_id = 'corrupt-address';")).trim(),
    "1",
    "refusing a restore must not modify the store",
  );
  assert.ok(
    (await objects.get(objectKeyFor("corrupt-address", lyingAddress))) !== null,
    "refusing a restore must not modify the object store either",
  );

  /* ---------- 6. The vault VM A left dangling on purpose ------------------ *
   *
   * VM A deleted `vault-mutable`'s object row while its catalog entry survived
   * — something the PostgreSQL foreign key made impossible. The refusal has to
   * come from the contract, because nothing else is left to make it.
   */
  const mutilated = await restore(source, "vault-mutable");
  assert.equal(mutilated.status, "missing-object",
    "6: the entry VM A orphaned by deleting its object row must be refused by name");

  /* ---------- 7. A catalog entry with no sequence at all ------------------ *
   *
   * VM A inserted an entry for `vault-orphan`, which never published and has no
   * `vault_sequence` row. Previously refused by `REFERENCES vault (vault_id)`.
   */
  const orphan = await restore(source, "vault-orphan");
  assert.equal(orphan.status, "invalid-sequence",
    "7: a vault with entries but no sequence must be refused by name, not restored at sequence 0");

  console.log(JSON.stringify({
    nodeOnly: true,
    adapter: "dsql",
    sharesOnlyTheSchemaAndObjectRoot: true,
    vmASessionsRemaining: 0,
    restoredVaultId: RESTORE_VAULT_ID,
    restoredSequence: first.sequence,
    restoredNotes: first.notes.length,
    restoredAssets: first.assets.length,
    distinctObjects: new Set(first.assets.map((asset) => asset.contentAddress)).size,
    totalBytes: first.totalBytes,
    materializedFiles: written.noteCount + written.assetCount,
    reopenedWithRealEngine: view.listFiles().length,
    repeatedRestoresIdentical: 3,
    restoreRefusals: Object.keys(restoreRefusals).length,
    // Six are observed against rows planted in the database/object store. The
    // seventh is the honest fixture restored under an eight-byte configured
    // limit, so counting it as store-planted would overstate the corruption
    // proof. PostgreSQL still needs raw fixtures for two states that its keys
    // make unreachable; DSQL needs none.
    restoreRefusalsFromStore: Object.keys(restoreRefusals).length - 1,
    restoreRefusalsFromLimits: 1,
    restoreRefusalsFromRawFixtures: 0,
    danglingEntryFromVmARefused: true,
    orphanVaultRefused: true,
    projectionBytes: Buffer.byteLength(projection, "utf8"),
    projectionWritten: Boolean(projectionOut),
  }));
} finally {
  catalog.close();
  await rm(materialized, { recursive: true, force: true });
}
