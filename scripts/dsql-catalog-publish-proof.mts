import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openLocalWikiProvider } from "../src/wiki/folder-provider";
import {
  publish,
  validatePublication,
  type CatalogAsset,
  type CatalogNote,
  type PublishReceipt,
  type PublishRequest,
} from "../src/wiki/catalog-contract";
import { serializeWikiQueryProjection } from "../src/wiki/query-projection";
import { createDsqlCatalog, literal, DSQL_CATALOG_LIMITS } from "../src/catalog/dsql-catalog-store";
import { createFilesystemObjectStore } from "../src/catalog/object-store";
import {
  buildProofVault,
  buildWideNoteText,
  proofContentType,
  PROOF_PROJECTION,
  RESTORE_VAULT_ID,
} from "./catalog-proof-vault.mts";

/**
 * VM A for the DSQL adapter: the publish side, and the optimistic-concurrency
 * question.
 *
 * It publishes the *same* fixture vault `catalog-publish-proof.mts` publishes,
 * through the same portable contract, into a DSQL-compatible schema and a
 * content-addressed object store. Reusing the fixture is the point: the restore
 * equality VM B has to reproduce is then directly comparable with the
 * PostgreSQL adapter's, rather than being a second claim about a second vault.
 *
 * ## The concurrency claim is different here, and it is stated as different
 *
 * `catalog-publish-proof.mts` observes three *lock waits* in
 * `pg_stat_activity` and asserts that a waiting duplicate sees the winner's
 * receipt before its base is tested. That property exists because PostgreSQL
 * blocks. Aurora DSQL does not block: repeatable-read snapshots, optimistic
 * concurrency, conflict raised at COMMIT.
 *
 * So this proof does not look for a lock wait. It constructs the situation
 * DSQL actually produces — a publication whose snapshot was taken before the
 * winner committed — and reports what happens, including the part that is a
 * loss rather than a win. Scenarios 5a, 5b and 5c are the answer, and 5c
 * exists specifically to show that 5b's success is bought by the retry loop
 * and not by anything intrinsic to the design.
 *
 * ## What local PostgreSQL can and cannot stand in for
 *
 * Every statement here is inside the DSQL-supported subset by construction, and
 * `tests/unit/dsql-catalog-schema.test.ts` enforces that on the schema file.
 * But this runs against conventional PostgreSQL, which accepts things DSQL
 * rejects and whose concurrency control is not DSQL's. `docs/design/
 * dsql-catalog-findings.md` lists what Phase B must re-observe on a real
 * cluster. Nothing here claims to have run on DSQL.
 */

assert.ok(!("window" in globalThis), "window must not exist");
assert.ok(!("document" in globalThis), "document must not exist");
assert.equal(process.versions.electron, undefined, "must not run under Electron");

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const providedSchema = process.env.GEODE_CATALOG_SCHEMA;
const projectionOut = process.env.GEODE_PROJECTION_OUT;

/**
 * Where object bytes live.
 *
 * A filesystem store standing in for Vercel Blob. Under the harness the
 * directory is supplied and owned by the harness, exactly as the schema is —
 * VM B reads it back in its own process, so it has to outlive VM A and be
 * durable, which an in-memory store is not.
 */
const objectRoot = process.env.GEODE_OBJECT_ROOT ?? (await mkdtemp(join(tmpdir(), "geode-dsql-objects-")));
const ownsObjectRoot = !process.env.GEODE_OBJECT_ROOT;

const catalog = createDsqlCatalog({
  schema: providedSchema ?? `geode_dsql_${randomUUID().replaceAll("-", "")}`,
  schemaDirectory: resolve("src/catalog"),
  objects: createFilesystemObjectStore(objectRoot),
});

/** Everything a publication can touch, as one comparable value. Plain SQL: no jsonb. */
const snapshotState = (): Promise<string> => catalog.query(
  "SELECT 'seq'||chr(9)||vault_id||chr(9)||sequence||chr(9)||mutation_id FROM vault_sequence " +
  "UNION ALL SELECT 'ent'||chr(9)||vault_id||chr(9)||path||chr(9)||kind||chr(9)||content_address||chr(9)||content_type||chr(9)||sequence FROM catalog_entry " +
  "UNION ALL SELECT 'obj'||chr(9)||vault_id||chr(9)||content_address||chr(9)||content_type||chr(9)||byte_length FROM object " +
  "UNION ALL SELECT 'rec'||chr(9)||vault_id||chr(9)||mutation_id||chr(9)||digest FROM receipt " +
  "ORDER BY 1;",
);

const count = async (sql: string): Promise<string> => (await catalog.query(sql)).trim();

let installed = false;
const root = await mkdtemp(join(tmpdir(), "geode-dsql-vault-a-"));
try {
  /* ---------- A synthetic vault on disk, read through the real provider ---- */
  await buildProofVault(root);
  const wideNoteBytes = Buffer.byteLength(buildWideNoteText(), "utf8");
  assert.ok(wideNoteBytes > 6 * 64 * 1024, `the wide note must be substantial; it is ${wideNoteBytes} bytes`);

  const opened = await openLocalWikiProvider(root);
  assert.equal(opened.status, "ok", "the local provider must open the synthetic vault");
  if (opened.status !== "ok") throw new Error("unreachable");
  const view = opened.provider.snapshot();
  assert.equal(view.listFiles().length, 7, "four notes and three attachments");

  const projection = serializeWikiQueryProjection(view, PROOF_PROJECTION);
  if (projectionOut) await writeFile(projectionOut, projection, "utf8");

  const notes: CatalogNote[] = [];
  const assets: CatalogAsset[] = [];
  for (const file of view.listFiles()) {
    if (file.kind === "note") {
      const read = view.readNote(file.path);
      assert.equal(read.status, "ok", `note ${file.path} must be readable`);
      if (read.status === "ok") notes.push({ path: file.path, text: read.note.text });
    } else {
      const bytes = new Uint8Array(await readFile(join(root, file.path)));
      assets.push({ path: file.path, contentAddress: sha(bytes), contentType: proofContentType(file.path), bytes });
    }
  }
  assert.equal(notes.length, 4);
  assert.equal(assets.length, 3);
  assert.equal(new Set(assets.map((asset) => asset.contentAddress)).size, 2,
    "two attachments must share one content address");

  if (!providedSchema) {
    await catalog.install();
    installed = true;
  }

  const vaultA = "vault-a";
  const limits = DSQL_CATALOG_LIMITS;
  const request = (overrides: Partial<PublishRequest> = {}): PublishRequest => ({
    vaultId: vaultA, mutationId: "publish-1", baseSequence: 0, notes, assets, ...overrides,
  });
  const send = (overrides: Partial<PublishRequest> = {}) => publish(catalog.store, request(overrides), { limits });

  /* ---------- 1. Initial publication -------------------------------------- */
  const first = await send();
  assert.equal(first.status, "ok", "the initial publication must commit");
  if (first.status !== "ok") throw new Error("unreachable");
  assert.equal(first.receipt.sequence, 1);
  assert.equal(first.receipt.noteCount, 4);
  assert.equal(first.receipt.assetCount, 3);

  /* ---------- 1b. The pristine vault VM B restores ------------------------- */
  const pristine = await send({ vaultId: RESTORE_VAULT_ID, mutationId: "publish-1" });
  assert.equal(pristine.status, "ok", "the restore fixture must publish");

  // Seven entries, six distinct objects: the two attachments holding identical
  // PNG bytes collapse to one, and the four notes — content-addressed here, as
  // they are not in the PostgreSQL schema — contribute four more.
  assert.equal(
    await count(`SELECT count(*) FROM object WHERE vault_id = ${literal(RESTORE_VAULT_ID)};`),
    "6",
    "identical bytes must be stored once, whether they came from a note or an attachment",
  );
  assert.equal(
    await count(`SELECT count(*) FROM catalog_entry WHERE vault_id = ${literal(RESTORE_VAULT_ID)};`),
    "7",
  );

  /* ---------- 2. Idempotent replay; reused id with changed payload --------- */
  const retry = await send();
  assert.equal(retry.status, "ok");
  if (retry.status !== "ok") throw new Error("unreachable");
  assert.deepEqual(retry.receipt, first.receipt, "an identical retry must return the original receipt");
  assert.equal(
    await count(`SELECT coalesce(max(sequence), 0) FROM vault_sequence WHERE vault_id = ${literal(vaultA)};`),
    "1",
    "an identical retry must not advance the sequence",
  );
  assert.equal(
    await count(`SELECT count(*) FROM vault_sequence WHERE vault_id = ${literal(vaultA)};`),
    "1",
    "an identical retry must not claim a second sequence slot",
  );

  const reused = await send({ notes: [{ path: "Index.md", text: "something else entirely" }, notes[1]] });
  assert.equal(reused.status, "mutation-id-reused", "a reused mutation id with a changed payload must be refused");

  /* ---------- 3. A stale base conflicts and publishes nothing -------------- */
  const stale = await send({ mutationId: "stale-1", baseSequence: 0, notes: [{ path: "Lost.md", text: "lost" }], assets: [] });
  assert.equal(stale.status, "conflict");
  assert.equal(await count("SELECT count(*) FROM catalog_entry WHERE path = 'Lost.md';"), "0");

  /* ---------- 4. Different vaults do not interact -------------------------- */
  const other = await send({
    vaultId: "vault-b", mutationId: "publish-1", baseSequence: 0,
    notes: [{ path: "Index.md", text: "# Another vault\n" }], assets: [],
  });
  assert.equal(other.status, "ok", "a different vault publishes independently");
  if (other.status !== "ok") throw new Error("unreachable");
  assert.equal(other.receipt.sequence, 1, "each vault owns its own sequence");
  assert.equal(
    await count("SELECT count(*) FROM receipt WHERE mutation_id = 'publish-1';"),
    "3",
    "mutation ids are scoped per vault",
  );

  /* ======================================================================== *
   * 5. The optimistic-concurrency question                                   *
   * ======================================================================== *
   *
   * The PostgreSQL schema's load-bearing claim is:
   *
   *   "Serialize publication for this vault only, then check receipts, so a
   *    waiting duplicate sees the winner's receipt before its base is tested."
   *
   * It depends on there being a *wait*. There is none here. What follows
   * establishes, in order: that the property is genuinely lost (5a), that the
   * observable outcome survives anyway (5b), and that it survives only because
   * of the retry (5c).
   */
  const vaultOcc = "vault-occ";
  const seeded = await send({
    vaultId: vaultOcc, mutationId: "seed", baseSequence: 0,
    notes: [{ path: "Occ.md", text: "seed" }], assets: [],
  });
  assert.equal(seeded.status, "ok");

  const duplicate = request({
    vaultId: vaultOcc, mutationId: "concurrent", baseSequence: 1,
    notes: [{ path: "Occ.md", text: "published once" }], assets: [],
  });
  const validated = validatePublication(duplicate, { limits });
  assert.equal(validated.status, "ok");
  if (validated.status !== "ok") throw new Error("unreachable");

  /* ---- 5a. The duplicate does NOT see the winner's receipt --------------- *
   *
   * Made deterministic rather than raced, because the claim is about *when a
   * snapshot was taken*, and a snapshot's age is something this proof can
   * control exactly. The loser's preflight runs first and observes no receipt.
   * The winner then publishes to completion. The loser's write then runs with
   * that now-stale preflight — which is precisely the state a DSQL transaction
   * is in when it committed its snapshot before a concurrent winner landed.
   *
   * Under the PostgreSQL schema the equivalent session would have been
   * *blocked* at this point and would have re-read the receipt on waking. Here
   * it has already decided, from a snapshot that no longer describes the world.
   */
  const losersPreflight = await catalog.preflight(validated.publication);
  assert.equal(losersPreflight.receipt, null,
    "5a: before the winner commits, the duplicate's preflight sees no receipt");
  assert.equal(losersPreflight.currentSequence, 1,
    "5a: and sees a base that is still current");

  const winner = await publish(catalog.store, duplicate, { limits });
  assert.equal(winner.status, "ok", "5a: the winner must commit");
  if (winner.status !== "ok") throw new Error("unreachable");
  assert.equal(winner.receipt.sequence, 2);

  // The loser now writes on the strength of a preflight taken before that.
  await catalog.uploadObjects(validated.publication);
  let loserFailure = "";
  try {
    await catalog.query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ;\n" +
      catalog.publishSql(validated.publication, losersPreflight) + "COMMIT;\n",
    );
    assert.fail("5a: a duplicate writing from a stale preflight must not commit");
  } catch (error) {
    loserFailure = error instanceof Error ? error.message : String(error);
  }
  assert.match(loserFailure, /duplicate key value|could not serialize|23505|40001/,
    "5a: it must lose on the sequence-slot uniqueness constraint, not commit a second publication");
  assert.equal(
    await count(`SELECT count(*) FROM vault_sequence WHERE vault_id = ${literal(vaultOcc)};`),
    "2",
    "5a: the refused duplicate must not have claimed a slot",
  );
  assert.equal(
    await count(`SELECT count(*) FROM receipt WHERE vault_id = ${literal(vaultOcc)};`),
    "2",
    "5a: the refused duplicate must not have written a receipt",
  );

  /* ---- 5b. The outcome survives, via retry ------------------------------- *
   *
   * The same duplicate, run through `commit()` rather than driven by hand. Its
   * first preflight now sees the winner's receipt — because it is a *fresh*
   * snapshot, which is the whole difference — and returns it verbatim.
   */
  const replayed = await publish(catalog.store, duplicate, { limits });
  assert.equal(replayed.status, "ok", "5b: the duplicate must resolve to the winner's receipt");
  if (replayed.status !== "ok") throw new Error("unreachable");
  assert.deepEqual(replayed.receipt, winner.receipt,
    "5b: a duplicate must return the winner's receipt verbatim");
  assert.equal(
    await count(`SELECT coalesce(max(sequence), 0) FROM vault_sequence WHERE vault_id = ${literal(vaultOcc)};`),
    "2",
    "5b: two publications of one mutation id must advance the sequence exactly once",
  );

  /* ---- 5b'. The same, under genuine concurrency -------------------------- *
   *
   * 5a and 5b are deterministic by construction. This is the unstaged version:
   * six identical publications launched at once against one vault. Exactly one
   * may claim the sequence slot, all six must return the identical receipt, and
   * the retry loop is what makes the other five arrive there.
   */
  const vaultRace = "vault-race";
  assert.equal((await send({
    vaultId: vaultRace, mutationId: "seed", baseSequence: 0,
    notes: [{ path: "Race.md", text: "seed" }], assets: [],
  })).status, "ok");

  const racing = request({
    vaultId: vaultRace, mutationId: "racer", baseSequence: 1,
    notes: [{ path: "Race.md", text: "raced" }], assets: [],
  });
  const raced = await Promise.all(
    Array.from({ length: 6 }, () => publish(catalog.store, racing, { limits })),
  );
  const racedOk = raced.filter((result) => result.status === "ok");
  assert.equal(racedOk.length, 6, `all six concurrent duplicates must succeed; got ${raced.map((r) => r.status).join(",")}`);
  const receipts = racedOk.map((result) => JSON.stringify((result as { receipt: PublishReceipt }).receipt));
  assert.equal(new Set(receipts).size, 1, "all six must return one identical receipt");
  assert.equal(
    await count(`SELECT count(*) FROM vault_sequence WHERE vault_id = ${literal(vaultRace)};`),
    "2",
    "six concurrent identical publications must claim exactly one new sequence slot",
  );
  assert.equal(
    await count(`SELECT count(*) FROM receipt WHERE vault_id = ${literal(vaultRace)};`),
    "2",
    "and must write exactly one new receipt",
  );

  /* ---- 5c. The retry is what buys it ------------------------------------- *
   *
   * The same race with retry disabled. If 5b's result were intrinsic to the
   * design rather than bought by the retry loop, this would still succeed. It
   * must not — and if it ever does, 5b is proving nothing.
   */
  const noRetry = createDsqlCatalog({
    schema: catalog.schema,
    schemaDirectory: resolve("src/catalog"),
    objects: createFilesystemObjectStore(objectRoot),
    maxAttempts: 1,
  });
  let unretried: readonly string[] = [];
  try {
    const vaultNoRetry = "vault-noretry";
    assert.equal((await publish(noRetry.store, {
      vaultId: vaultNoRetry, mutationId: "seed", baseSequence: 0,
      notes: [{ path: "N.md", text: "seed" }], assets: [],
    }, { limits })).status, "ok");
    const contested = {
      vaultId: vaultNoRetry, mutationId: "once", baseSequence: 1,
      notes: [{ path: "N.md", text: "contested" }], assets: [],
    };
    unretried = (await Promise.all(
      Array.from({ length: 6 }, () => publish(noRetry.store, contested, { limits })),
    )).map((result) => result.status);
  } finally {
    noRetry.close();
  }
  const survived = unretried.filter((status) => status === "ok").length;
  assert.ok(survived < 6,
    `5c: without retry, a concurrent duplicate must be able to fail; all ${unretried.length} succeeded`);
  assert.ok(survived >= 1, "5c: exactly one racer should still win outright");

  /* ---------- 6. Immutability is NO LONGER enforced ----------------------- *
   *
   * The PostgreSQL proof asserts `UPDATE object` and `DELETE FROM object` are
   * refused by a trigger. DSQL has no triggers, so they are not refused — and
   * this proof asserts that they *succeed*, rather than quietly omitting the
   * scenario. An unenforceable guarantee that is simply not mentioned is how a
   * weakened system comes to look unchanged.
   *
   * What replaces prevention is detection on the way out, which VM B exercises.
   */
  const vaultMutable = "vault-mutable";
  assert.equal((await send({
    vaultId: vaultMutable, mutationId: "seed", baseSequence: 0,
    notes: [], assets: [assets[0]],
  })).status, "ok");
  const objectsBefore = await count(`SELECT count(*) FROM object WHERE vault_id = ${literal(vaultMutable)};`);
  assert.equal(objectsBefore, "1");

  await catalog.query(`UPDATE object SET content_type = 'image/gif' WHERE vault_id = ${literal(vaultMutable)};`);
  const mutatedType = await count(`SELECT content_type FROM object WHERE vault_id = ${literal(vaultMutable)};`);
  assert.equal(mutatedType, "image/gif",
    "6: object metadata is mutable without a trigger, and this proof says so");

  await catalog.query(`DELETE FROM object WHERE vault_id = ${literal(vaultMutable)};`);
  assert.equal(
    await count(`SELECT count(*) FROM object WHERE vault_id = ${literal(vaultMutable)};`),
    "0",
    "6: stored object metadata can be deleted wholesale, leaving a dangling catalog entry",
  );
  // The catalog entry survives its object: the composite foreign key that used
  // to make this impossible does not exist. VM B is what catches it.
  assert.equal(
    await count(`SELECT count(*) FROM catalog_entry WHERE vault_id = ${literal(vaultMutable)};`),
    "1",
    "6: the dangling catalog entry remains, for VM B to refuse by name",
  );

  /* ---------- 7. A catalog entry for a vault with no sequence ------------- *
   *
   * Previously refused by `REFERENCES vault (vault_id)`. Now it inserts. The
   * refusal has to come from the contract on the way out.
   *
   * The entry is otherwise *complete* — its object row exists and its bytes are
   * in the store — so the only thing wrong with this vault is that it has no
   * sequence. A fixture missing two things at once would prove only that the
   * contract refuses it for one of them.
   */
  const orphanVaultBytes = new TextEncoder().encode("# Orphan\n");
  const orphanVaultAddress = sha(orphanVaultBytes);
  await catalog.objects.put(`vault-orphan/objects/${orphanVaultAddress}`, orphanVaultBytes, "text/markdown");
  await catalog.query(
    "INSERT INTO object (vault_id, content_address, content_type, byte_length, object_key) VALUES (" +
    `'vault-orphan', ${literal(orphanVaultAddress)}, 'text/markdown', ${orphanVaultBytes.byteLength}, ` +
    `'vault-orphan/objects/${orphanVaultAddress}');`,
  );
  await catalog.query(
    "INSERT INTO catalog_entry (vault_id, path, kind, content_address, content_type, sequence) VALUES (" +
    `'vault-orphan', 'Orphan.md', 'note', ${literal(orphanVaultAddress)}, 'text/markdown', 1);`,
  );
  assert.equal(await count("SELECT count(*) FROM catalog_entry WHERE vault_id = 'vault-orphan';"), "1",
    "7: an entry for a vault that never published now inserts without complaint");
  assert.equal(await count("SELECT count(*) FROM vault_sequence WHERE vault_id = 'vault-orphan';"), "0",
    "7: and it has no sequence at all, which is the only thing wrong with it");

  /* ---------- 8. Rollback: a failed transaction leaves nothing behind ----- */
  const before = await snapshotState();
  const failing = validatePublication(request({
    vaultId: vaultA, mutationId: "rollback", baseSequence: 1,
    notes: [{ path: "Partial.md", text: "must disappear" }], assets: [],
  }), { limits });
  assert.equal(failing.status, "ok");
  if (failing.status !== "ok") throw new Error("unreachable");
  const pre = await catalog.preflight(failing.publication);
  await catalog.uploadObjects(failing.publication);
  await assert.rejects(
    catalog.query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ;\n" + catalog.publishSql(failing.publication, pre) +
      // A statement that cannot succeed, standing in for a mid-transaction
      // failure. The whole block must roll back with it.
      "INSERT INTO receipt (vault_id, mutation_id, digest, receipt) VALUES ('vault-a', 'rollback', 'x', 'y');\n" +
      "COMMIT;\n",
    ),
    /duplicate key value|23505/,
  );
  assert.equal(await snapshotState(), before,
    "8: sequence slot, object rows, catalog entries and receipt must roll back together");

  // The object bytes, however, are already in the store and stay there. That
  // asymmetry is deliberate and is the price of moving bytes out of the
  // transaction: an orphaned object wastes storage, whereas the other ordering
  // would leave a catalog entry pointing at nothing.
  const orphanAddress = sha(new TextEncoder().encode("must disappear"));
  const orphan = await catalog.objects.get(`vault-a/objects/${orphanAddress}`);
  assert.ok(orphan !== null, "8: the rolled-back publication's bytes remain in the object store as an orphan");

  const recovered = await send({
    mutationId: "rollback", baseSequence: 1,
    notes: [{ path: "Partial.md", text: "published together" }], assets: [],
  });
  assert.equal(recovered.status, "ok", "8: the mutation id is reusable after a rolled-back attempt");

  /* ---------- 9. Portable refusals never reach the database --------------- */
  const receiptsBefore = await count("SELECT count(*) FROM receipt;");
  const portableRefusals = {
    oversize: (await send({ mutationId: "big", baseSequence: 2, assets: [], notes: [{ path: "Big.md", text: "x".repeat(3 * 1024 * 1024) }] })).status,
    invalidContentAddress: (await send({ mutationId: "bad-hash", baseSequence: 2, notes: [], assets: [{ ...assets[0], contentAddress: sha(new Uint8Array([0])) }] })).status,
    duplicateWithMismatchedBytes: (await send({
      mutationId: "dupe", baseSequence: 2, notes: [],
      assets: [assets[0], { path: "assets/copy.png", contentAddress: assets[0].contentAddress, contentType: "image/png", bytes: new Uint8Array([0]) }],
    })).status,
    unsupportedContentType: (await send({ mutationId: "bad-type", baseSequence: 2, notes: [], assets: [{ ...assets[0], contentType: "application/x-msdownload" }] })).status,
    invalidPath: (await send({ mutationId: "escape", baseSequence: 2, assets: [], notes: [{ path: "../Escape.md", text: "x" }] })).status,
    notANote: (await send({ mutationId: "not-note", baseSequence: 2, assets: [], notes: [{ path: "Image.png", text: "x" }] })).status,
    entryLimit: (await send({
      mutationId: "too-many", baseSequence: 2, assets: [],
      notes: Array.from({ length: DSQL_CATALOG_LIMITS.maxPublicationEntries + 1 }, (_unused, index) => ({ path: `n${index}.md`, text: `${index}` })),
    })).status,
  };
  assert.deepEqual(portableRefusals, {
    oversize: "oversize",
    invalidContentAddress: "invalid-content-address",
    duplicateWithMismatchedBytes: "duplicate-with-mismatched-bytes",
    unsupportedContentType: "unsupported-content-type",
    invalidPath: "invalid-path",
    notANote: "not-a-note",
    // The DSQL entry ceiling is 500 rather than the contract default of 1,000,
    // because a publication's transaction modifies up to three rows per entry
    // and DSQL caps a transaction at 3,000.
    entryLimit: "entry-limit",
  }, "every refusal must be reported by its own distinct status");
  assert.equal(await count("SELECT count(*) FROM receipt;"), receiptsBefore,
    "a refused publication must not write a receipt");

  /* ---------- 10. Store-side duplicate-with-mismatched-bytes -------------- *
   *
   * The PostgreSQL schema compares stored bytes inside the transaction. There
   * are no stored bytes in this database, so the check has two halves: the
   * recorded byte length contradicting the incoming bytes, and the object
   * store's own `putImmutable` refusing to let one key mean two byte strings.
   */
  const plantedAddress = sha(new Uint8Array([3, 1, 4]));
  await catalog.query(
    "INSERT INTO object (vault_id, content_address, content_type, byte_length, object_key) VALUES (" +
    `${literal(vaultA)}, ${literal(plantedAddress)}, 'image/png', 99, 'vault-a/objects/${plantedAddress}');`,
  );
  const mismatched = await send({
    mutationId: "mismatch", baseSequence: 2, notes: [],
    assets: [{ path: "assets/planted.png", contentAddress: plantedAddress, contentType: "image/png", bytes: new Uint8Array([3, 1, 4]) }],
  });
  assert.equal(mismatched.status, "duplicate-with-mismatched-bytes",
    "10: a recorded length that contradicts the incoming bytes must be refused");

  // And the object-store half: plant different bytes at the key an address
  // names, then publish that address honestly.
  const forkedBytes = new Uint8Array([5, 5, 5]);
  const forkedAddress = sha(forkedBytes);
  await catalog.objects.put(`vault-a/objects/${forkedAddress}`, new Uint8Array([9, 9, 9, 9]), "image/png");
  const forked = await send({
    mutationId: "forked", baseSequence: 2, notes: [],
    assets: [{ path: "assets/forked.png", contentAddress: forkedAddress, contentType: "image/png", bytes: forkedBytes }],
  });
  assert.equal(forked.status, "duplicate-with-mismatched-bytes",
    "10: the object store must refuse to let one content address mean two byte strings");

  console.log(JSON.stringify({
    nodeOnly: true,
    adapter: "dsql",
    postgres: await catalog.query("SHOW server_version;"),
    emulatedNotReal: "conventional PostgreSQL; see docs/design/dsql-catalog-findings.md",
    schemaOwnedByHarness: Boolean(providedSchema),
    objectRootOwnedByHarness: !ownsObjectRoot,
    vaultsPublished: 7,
    firstReceipt: first.receipt,
    restoreVaultId: RESTORE_VAULT_ID,
    distinctObjectsForRestoreVault: 6,
    wideNoteBytes,
    projectionBytes: Buffer.byteLength(projection, "utf8"),
    projectionWritten: Boolean(projectionOut),
    // The headline results, named so a reader does not have to infer them.
    occDuplicateSawWinnersReceiptBeforeBaseTested: false,
    occDuplicateResolvedByRetry: true,
    occConcurrentDuplicatesAllReturningOneReceipt: 6,
    occWithoutRetrySucceeded: survived,
    occWithoutRetryStatuses: [...new Set(unretried)].sort(),
    objectImmutabilityEnforcedByDatabase: false,
    referentialIntegrityEnforcedByDatabase: false,
    danglingCatalogEntryCreated: true,
    rollbackVerified: true,
    orphanedObjectBytesAfterRollback: true,
    portableRefusals: Object.keys(portableRefusals).length,
  }));
} finally {
  catalog.close();
  if (installed) await catalog.drop();
  await rm(root, { recursive: true, force: true });
  if (ownsObjectRoot) await rm(objectRoot, { recursive: true, force: true });
}
