import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_RESTORE_LIMITS,
  restore,
  validatePublication,
  verifyRestoredVault,
  type RestoreResult,
  type RestoredVault,
} from "../src/wiki/catalog-contract";
import { materializeRestoredVault } from "../src/wiki/catalog-materialize";
import { serializeWikiQueryProjection } from "../src/wiki/query-projection";
import { openLocalWikiProvider } from "../src/wiki/folder-provider";
import { createPostgresCatalog, literal } from "../src/catalog/postgres-catalog-store";
import { PROOF_PROJECTION, RESTORE_VAULT_ID } from "./catalog-proof-vault.mts";

/**
 * VM B: the restore side, in its own process.
 *
 * This process shares nothing with VM A but the disposable schema. It does not
 * receive VM A's snapshot, its vault directory, its output or its projection;
 * it is started only after VM A has fully exited, and it re-derives everything
 * from durable state. The harness — `scripts/run-catalog-restore-proof.mjs` —
 * owns the schema and is the only thing that ever sees both projections.
 *
 * What it proves, in order:
 *
 * 1. A restore returns the published vault, verified rather than trusted.
 * 2. The restored vault materializes onto a folder the **real** engine opens,
 *    so the reconstructed snapshot comes from `openLocalWikiProvider` and not
 *    from a restore-only index that might agree for the wrong reasons.
 * 3. Repeated restores, with VM A gone, are byte-identical.
 * 4. A publication interrupted before its receipt exists leaves the restorable
 *    vault untouched.
 * 5. Corruption planted *behind* the contract — bad address, truncated bytes,
 *    a disallowed content type, a dangling object — is refused on the way out,
 *    by name.
 */

assert.ok(!("window" in globalThis), "window must not exist");
assert.ok(!("document" in globalThis), "document must not exist");
assert.equal(process.versions.electron, undefined, "must not run under Electron");

const schema = process.env.GEODE_CATALOG_SCHEMA;
assert.ok(schema, "GEODE_CATALOG_SCHEMA must name the schema VM A published into");
const projectionOut = process.env.GEODE_PROJECTION_OUT;

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const catalog = createPostgresCatalog({ schema, schemaDirectory: resolve("src/catalog") });
const source = catalog.restoreSource();

/** A restored vault as a comparable value, so "the same read twice" is checkable. */
const fingerprint = (vault: RestoredVault): string => JSON.stringify({
  vaultId: vault.vaultId,
  sequence: vault.sequence,
  totalBytes: vault.totalBytes,
  notes: vault.notes.map((note) => [note.path, note.text]),
  assets: vault.assets.map((asset) => [asset.path, asset.contentAddress, asset.contentType, sha(asset.bytes)]),
});

const ok = (result: RestoreResult, label: string): RestoredVault => {
  assert.equal(result.status, "ok", `${label} must restore (got ${result.status})`);
  if (result.status !== "ok") throw new Error("unreachable");
  return result.vault;
};

/** Wait for a condition to be *observed*, never for a duration to elapse. */
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 6000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out observing ${label}`);
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** Plant rows directly, bypassing `publish_catalog`. The only way to forge store-side corruption honestly. */
async function plant(vaultId: string, object: { address: string; contentType: string; byteLength: number; hex: string } | null, entry: { path: string; kind: string; address: string | null; text: string | null }): Promise<void> {
  await catalog.query(`INSERT INTO vault (vault_id, sequence) VALUES (${literal(vaultId)}, 1) ON CONFLICT DO NOTHING;`);
  if (object) {
    await catalog.query(
      `INSERT INTO object (vault_id, content_address, content_type, byte_length, bytes) VALUES (` +
      `${literal(vaultId)}, ${literal(object.address)}, ${literal(object.contentType)}, ${object.byteLength}, ` +
      `decode(${literal(object.hex)}, 'hex')) ON CONFLICT DO NOTHING;`,
    );
  }
  await catalog.query(
    `INSERT INTO catalog_entry (vault_id, path, kind, text, content_address, sequence) VALUES (` +
    `${literal(vaultId)}, ${literal(entry.path)}, ${literal(entry.kind)}, ` +
    `${entry.text === null ? "NULL" : literal(entry.text)}, ` +
    `${entry.address === null ? "NULL" : literal(entry.address)}, 1);`,
  );
}

const materialized = await mkdtemp(join(tmpdir(), "geode-catalog-vault-b-"));
try {
  // --- 1. VM A is gone -------------------------------------------------------
  // The harness waited for VM A's exit; this confirms it at the database, which
  // is the only place the two processes ever met. Exactly one backend carries
  // this schema's application name — the session asking the question — and it
  // is waited for rather than asserted outright, because a backend outlives its
  // disconnected client by an unbounded-but-brief moment and a flaky proof is
  // worth less than a patient one.
  await until(
    async () => (await catalog.query(
      `SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE ${literal(schema + "%")};`,
    )) === "1",
    "every session VM A opened having gone away",
  );

  // --- 2. Restore, verified rather than trusted -----------------------------
  const first = ok(await restore(source, RESTORE_VAULT_ID), "the published vault");
  assert.equal(first.sequence, 1, "the restored vault carries the sequence it was published at");
  assert.equal(first.notes.length, 3);
  assert.equal(first.assets.length, 3);
  assert.equal(new Set(first.assets.map((asset) => asset.contentAddress)).size, 2,
    "one stored object must expand back into the two paths that shared it");
  for (const asset of first.assets) {
    assert.equal(sha(asset.bytes), asset.contentAddress, `${asset.path} bytes must hash to their address`);
  }

  // A vault-id the contract rejects never becomes a query.
  const refusedIds = {
    invalidVaultId: (await restore(source, "not a vault id")).status,
    absent: (await restore(source, "never-published")).status,
  };
  assert.deepEqual(refusedIds, { invalidVaultId: "invalid-vault-id", absent: "absent" });

  // --- 3. Materialize, then open with the real engine -----------------------
  const written = await materializeRestoredVault(materialized, first);
  assert.equal(written.status, "ok", "the restored vault must materialize");
  assert.equal(written.noteCount, 3);
  assert.equal(written.assetCount, 3);

  const opened = await openLocalWikiProvider(materialized);
  assert.equal(opened.status, "ok", "the real provider must open the restored folder");
  if (opened.status !== "ok") throw new Error("unreachable");
  const view = opened.provider.snapshot();
  assert.equal(view.listFiles().length, 6, "the restored folder must hold every published entry");
  assert.ok(view.info.discoveryComplete, "the restored capture must be complete");

  const projection = serializeWikiQueryProjection(view, PROOF_PROJECTION);
  if (projectionOut) await writeFile(projectionOut, projection, "utf8");

  // --- 4. Repeated reads, with VM A long gone -------------------------------
  const second = ok(await restore(source, RESTORE_VAULT_ID), "a repeated restore");
  const third = ok(await restore(source, RESTORE_VAULT_ID), "a third restore");
  assert.equal(fingerprint(second), fingerprint(first), "a repeated restore must return the same vault");
  assert.equal(fingerprint(third), fingerprint(first), "restores must not drift with repetition");

  // --- 5. A publication interrupted before its receipt exists ---------------
  // The sequence, objects and catalog entries are all written, and the
  // transaction then dies before the receipt row. Nothing may survive it, and
  // — because no receipt was recorded — the mutation id must not be burned.
  const interrupted = validatePublication({
    vaultId: RESTORE_VAULT_ID, mutationId: "interrupted", baseSequence: 1,
    notes: [{ path: "Ghost.md", text: "must never be restorable" }], assets: [],
  });
  assert.equal(interrupted.status, "ok");
  if (interrupted.status !== "ok") throw new Error("unreachable");
  const receiptsBefore = await catalog.query(`SELECT count(*) FROM receipt WHERE vault_id = ${literal(RESTORE_VAULT_ID)};`);
  await assert.rejects(
    catalog.query(catalog.publishSql(interrupted.publication, { failBeforeReceipt: true })),
    /GEODE_CATALOG:INJECTED_FAILURE_BEFORE_RECEIPT/,
    "the injected failure must fire inside the pre-receipt window",
  );
  assert.equal(
    await catalog.query(`SELECT count(*) FROM receipt WHERE vault_id = ${literal(RESTORE_VAULT_ID)};`),
    receiptsBefore,
    "an interrupted publication must not leave a receipt",
  );
  const afterInterrupt = ok(await restore(source, RESTORE_VAULT_ID), "a restore after an interrupted publication");
  assert.equal(fingerprint(afterInterrupt), fingerprint(first),
    "an interrupted publication must leave the restorable vault byte-identical");
  assert.equal(afterInterrupt.notes.some((note) => note.path === "Ghost.md"), false);

  // The same mutation id is still usable, because nothing acknowledged it.
  const recovered = await catalog.query(catalog.publishSql(interrupted.publication));
  assert.equal(JSON.parse(recovered).sequence, 2, "the interrupted mutation id must still be usable");
  const afterRecovery = ok(await restore(source, RESTORE_VAULT_ID), "a restore after the retry");
  assert.equal(afterRecovery.sequence, 2);
  assert.equal(afterRecovery.notes.some((note) => note.path === "Ghost.md"), true);

  // --- 6. Corruption planted behind the contract is refused on the way out --
  // Every case below writes rows `publish_catalog` would have refused. That is
  // the whole point: a restore that trusted its store would materialize all of
  // them onto disk, and a restore is the last place the bytes can still be
  // checked before an engine treats them as a vault.
  const honestBytes = new Uint8Array([1, 2, 3, 4]);
  const honestHex = "01020304";

  // (a) Recorded address does not describe the bytes.
  await plant("corrupt-address", {
    address: sha(new Uint8Array([9, 9, 9])), contentType: "image/png", byteLength: 4, hex: honestHex,
  }, { path: "assets/lie.png", kind: "attachment", address: sha(new Uint8Array([9, 9, 9])), text: null });

  // (b) Recorded length disagrees with the bytes — a truncated or padded read.
  const truncatedAddress = sha(honestBytes);
  await plant("corrupt-length", {
    address: truncatedAddress, contentType: "image/png", byteLength: 9, hex: honestHex,
  }, { path: "assets/short.png", kind: "attachment", address: truncatedAddress, text: null });

  // (c) A content type outside the allowlist, stored before the allowlist said so.
  await plant("corrupt-type", {
    address: truncatedAddress, contentType: "application/x-msdownload", byteLength: 4, hex: honestHex,
  }, { path: "assets/tool.exe", kind: "attachment", address: truncatedAddress, text: null });

  // (d) A catalog entry pointing at bytes the store cannot produce. The schema's
  //     foreign key stops this from happening here, so the refusal is observed
  //     against the raw row the store *would* return if the object vanished —
  //     honest about which half of the stack is being exercised.
  const dangling = verifyRestoredVault({
    vaultId: "corrupt-missing", sequence: 1,
    entries: [{ path: "assets/gone.png", kind: "attachment", contentAddress: truncatedAddress, contentType: "image/png", byteLength: 4, bytes: null }],
  });

  // (e) One address describing two byte strings. The store's primary key on
  //     (vault_id, content_address) makes this unreachable through the schema,
  //     which is the schema working — so it is exercised against a raw vault.
  const forked = verifyRestoredVault({
    vaultId: "corrupt-forked", sequence: 1,
    entries: [
      { path: "assets/a.png", kind: "attachment", contentAddress: truncatedAddress, contentType: "image/png", byteLength: 4, bytes: honestBytes },
      { path: "assets/b.png", kind: "attachment", contentAddress: truncatedAddress, contentType: "image/png", byteLength: 2, bytes: new Uint8Array([7, 7]) },
    ],
  });

  // (f) Oversize, measured against tighter ceilings rather than by storing a
  //     multi-megabyte fixture. The limits are the policy under test.
  const oversize = await restore(
    catalog.restoreSource({ limits: { ...DEFAULT_RESTORE_LIMITS, maxNoteBytes: 8 } }),
    RESTORE_VAULT_ID,
  );

  const restoreRefusals = {
    invalidContentAddress: (await restore(source, "corrupt-address")).status,
    byteLengthMismatch: (await restore(source, "corrupt-length")).status,
    unsupportedContentType: (await restore(source, "corrupt-type")).status,
    missingObject: dangling.status,
    duplicateWithMismatchedBytes: forked.status,
    oversize: oversize.status,
  };
  assert.deepEqual(restoreRefusals, {
    invalidContentAddress: "invalid-content-address",
    byteLengthMismatch: "byte-length-mismatch",
    unsupportedContentType: "unsupported-content-type",
    missingObject: "missing-object",
    duplicateWithMismatchedBytes: "duplicate-with-mismatched-bytes",
    oversize: "oversize",
  }, "every restore refusal must be reported by its own distinct status");
  assert.equal((oversize as { limit?: string }).limit, "note-bytes", "an oversize restore must name the limit it tripped");

  // The planted corruption is still sitting in the store; the contract simply
  // refused to hand it out. A restore is a checkpoint, not a repair.
  assert.equal(
    await catalog.query(`SELECT count(*) FROM object WHERE vault_id = 'corrupt-address';`),
    "1",
    "refusing a restore must not modify the store",
  );

  console.log(JSON.stringify({
    nodeOnly: true,
    sharesOnlyTheSchema: true,
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
    interruptedPublishLeftNothing: true,
    restoreRefusals: Object.keys(restoreRefusals).length,
    // Split honestly: four are observed against rows actually planted in the
    // database, two against raw vault fixtures because this schema's keys make
    // them unreachable through it. Reporting six undifferentiated would claim
    // a database observation that was not made.
    restoreRefusalsFromStore: 4,
    restoreRefusalsFromRawFixtures: 2,
    projectionBytes: Buffer.byteLength(projection, "utf8"),
    projectionWritten: Boolean(projectionOut),
  }));
} finally {
  catalog.close();
  // The schema belongs to the harness. VM B never drops it — VM B is not the
  // thing that created it, and a process that tears down state it did not own
  // is how a two-process proof turns into a race.
  await rm(materialized, { recursive: true, force: true });
}
