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
  type PublishRequest,
} from "../src/wiki/catalog-contract";
import { serializeWikiQueryProjection } from "../src/wiki/query-projection";
import { createPostgresCatalog, literal } from "../src/catalog/postgres-catalog-store";
import { buildProofVault, proofContentType, PROOF_PROJECTION, RESTORE_VAULT_ID } from "./catalog-proof-vault.mts";

/**
 * VM A: the publish side.
 *
 * A fresh Node process builds a synthetic multi-note vault on disk, reads it
 * back through the real local provider, and publishes it — notes, wikilinks
 * and binary attachments — into a disposable PostgreSQL schema through the
 * portable catalog contract.
 *
 * It runs in two modes:
 *
 * - **Standalone** (`npm run proof:catalog:postgres`): it creates its own
 *   randomly-named schema and drops it in `finally`, exactly as before.
 * - **Harness-driven** (`GEODE_CATALOG_SCHEMA` set): the harness owns the
 *   schema's whole lifecycle, and this process neither creates nor drops it.
 *   That is what lets VM B run afterwards, in its own process, against the
 *   same durable state — the only thing the two share.
 *
 * With `GEODE_PROJECTION_OUT` set, it writes the canonical projection of its
 * **pre-publish** snapshot to that path. VM B never reads that file; the
 * harness does, as the diff oracle.
 *
 * Phase 0's discipline is preserved and extended: every concurrency claim is
 * backed by an observed `pg_stat_activity` lock wait rather than a sleep, the
 * schema is randomly named and dropped by whoever created it, and no password
 * is passed as a command argument.
 */

assert.ok(!("window" in globalThis), "window must not exist");
assert.ok(!("document" in globalThis), "document must not exist");
assert.equal(process.versions.electron, undefined, "must not run under Electron");

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
/** Set by the two-process harness, which then owns create and drop. */
const providedSchema = process.env.GEODE_CATALOG_SCHEMA;
const projectionOut = process.env.GEODE_PROJECTION_OUT;
const catalog = createPostgresCatalog({
  schema: providedSchema ?? `geode_catalog_${randomUUID().replaceAll("-", "")}`,
  schemaDirectory: resolve("src/catalog"),
});

/** Wait for a condition to be *observed*, never for a duration to elapse. */
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error(`Timed out observing ${label}`);
}

/** Everything a publication can touch, as one comparable value. */
const snapshot = (): Promise<string> => catalog.query(`SELECT jsonb_build_object(
  'vaults', (SELECT jsonb_agg(to_jsonb(v) ORDER BY vault_id) FROM vault v),
  'entries', (SELECT jsonb_agg(jsonb_build_object('vaultId', vault_id, 'path', path, 'kind', kind,
     'text', text, 'contentAddress', content_address, 'sequence', sequence) ORDER BY vault_id, path) FROM catalog_entry),
  'objects', (SELECT jsonb_agg(jsonb_build_object('vaultId', vault_id, 'contentAddress', content_address,
     'contentType', content_type, 'byteLength', byte_length) ORDER BY vault_id, content_address) FROM object),
  'receipts', (SELECT jsonb_agg(to_jsonb(r) ORDER BY vault_id, mutation_id) FROM receipt r));`);

let installed = false;
const root = await mkdtemp(join(tmpdir(), "geode-catalog-vault-a-"));
try {
  // --- A synthetic vault on disk, read back through the real provider -------
  await buildProofVault(root);
  const pngBytes = new Uint8Array(await readFile(join(root, "assets/diagram.png")));

  const opened = await openLocalWikiProvider(root);
  assert.equal(opened.status, "ok", "the local provider must open the synthetic vault");
  if (opened.status !== "ok") throw new Error("unreachable");
  const view = opened.provider.snapshot();

  // The publication carries exactly what the engine sees, so the catalog is
  // never a second, hand-curated view of the vault.
  assert.equal(view.listFiles().length, 6, "three notes and three attachments");
  assert.deepEqual(
    [...new Set(view.backlinks("Index.md").references.map((reference) => reference.sourcePath))].sort(),
    ["notes/Decision.md", "notes/Deep note.md"],
    "the synthetic vault must actually contain resolving wikilinks",
  );
  const sourceResolution = {
    decision: view.resolve("Index.md", "Decision").path,
    alias: view.resolve("Index.md", "Choice").path,
    asset: view.resolve("Index.md", "assets/diagram.png").path,
    missing: view.resolve("Index.md", "Nothing Here").status,
    external: view.resolve("Index.md", "https://example.com/page").status,
    search: view.search("plesiosaur").hits.map((hit) => hit.path),
    backlinks: view.backlinks("Index.md").references.length,
  };

  // The equality VM B has to reproduce, captured *before* anything is
  // published. Written for the harness to diff; VM B never sees it.
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
      // Snapshots never carry attachment bytes; the publisher supplies them.
      const bytes = new Uint8Array(await readFile(join(root, file.path)));
      assets.push({ path: file.path, contentAddress: sha(bytes), contentType: proofContentType(file.path), bytes });
    }
  }
  assert.equal(notes.length, 3);
  assert.equal(assets.length, 3);
  assert.equal(new Set(assets.map((asset) => asset.contentAddress)).size, 2,
    "two attachments must share one content address, so restore has to expand one object into two files");

  if (!providedSchema) {
    await catalog.install();
    installed = true;
  }

  const vaultA = "vault-a";
  const vaultB = "vault-b";
  const request = (overrides: Partial<PublishRequest> = {}): PublishRequest => ({
    vaultId: vaultA, mutationId: "publish-1", baseSequence: 0, notes, assets, ...overrides,
  });

  // --- 1. Initial publication ----------------------------------------------
  const first = await publish(catalog.store, request());
  assert.equal(first.status, "ok", "the initial publication must commit");
  if (first.status !== "ok") throw new Error("unreachable");
  assert.equal(first.receipt.sequence, 1);
  assert.equal(first.receipt.noteCount, 3);
  assert.equal(first.receipt.assetCount, 3);

  // --- 1b. The vault VM B restores ------------------------------------------
  // Published once, from the same captured snapshot, and never touched again.
  // `vault-a` below goes on to absorb conflict, rollback and mismatch
  // scenarios, so it is deliberately not the vault the restore claim is made
  // about.
  const pristine = await publish(catalog.store, request({ vaultId: RESTORE_VAULT_ID, mutationId: "publish-1" }));
  assert.equal(pristine.status, "ok", "the restore fixture must publish");
  if (pristine.status !== "ok") throw new Error("unreachable");
  assert.equal(pristine.receipt.sequence, 1);
  assert.equal(
    await catalog.query(`SELECT count(*) FROM object WHERE vault_id = ${literal(RESTORE_VAULT_ID)};`),
    "2",
    "identical bytes at two paths must be stored once",
  );

  // Bytes round-trip out of `bytea` byte-identical, not merely same-length.
  const storedHex = await catalog.query(
    `SELECT encode(bytes, 'hex') FROM object WHERE vault_id = ${literal(vaultA)} AND content_address = ${literal(assets[0].contentAddress)};`,
  );
  assert.equal(storedHex, Buffer.from(pngBytes).toString("hex"), "attachment bytes must be stored exactly");
  assert.equal(
    await catalog.query(
      `SELECT count(*) FROM object WHERE vault_id = ${literal(vaultA)} AND encode(sha256(bytes), 'hex') <> content_address;`,
    ),
    "0",
    "the store's own digest must equal the declared content address for every object",
  );

  // --- 2. Identical retry is free; a reused id with a changed payload is not -
  const retry = await publish(catalog.store, request());
  assert.equal(retry.status, "ok");
  if (retry.status !== "ok") throw new Error("unreachable");
  assert.deepEqual(retry.receipt, first.receipt, "an identical retry must return the original receipt");
  assert.equal(await catalog.query(`SELECT sequence FROM vault WHERE vault_id = ${literal(vaultA)};`), "1",
    "an identical retry must not advance the sequence");

  const reused = await publish(catalog.store, request({
    notes: [{ path: "Index.md", text: "# Index\n\nSomething else entirely.\n" }, notes[1]],
  }));
  assert.equal(reused.status, "mutation-id-reused", "a reused mutation id with a changed payload must be refused");
  assert.equal(
    await catalog.query(`SELECT text FROM catalog_entry WHERE vault_id = ${literal(vaultA)} AND path = 'Index.md';`),
    notes.find((note) => note.path === "Index.md")!.text.trimEnd(),
    "the winner's bytes must be intact after a reuse refusal",
  );

  // --- 3. A stale base conflicts and publishes nothing ----------------------
  const stale = await publish(catalog.store, request({ mutationId: "stale-1", baseSequence: 0, notes: [{ path: "Lost.md", text: "lost" }], assets: [] }));
  assert.equal(stale.status, "conflict");
  assert.equal(await catalog.query(`SELECT count(*) FROM catalog_entry WHERE path = 'Lost.md';`), "0");
  assert.equal(await catalog.query(`SELECT sequence FROM vault WHERE vault_id = ${literal(vaultA)};`), "1");

  // --- 4. Same vault serializes; a different vault does not -----------------
  // Phase 0 proved the first half for one vault. The multi-vault claim is the
  // second half, and it is worth nothing unless both are observed.
  const held = catalog.openSession(`${catalog.schema}_holder`);
  const committedBefore = await snapshot();
  const winnerPublication = validatePublication(request({ mutationId: "winner", baseSequence: 1, notes: [{ path: "Winner.md", text: "published" }], assets: [] }));
  assert.equal(winnerPublication.status, "ok");
  if (winnerPublication.status !== "ok") throw new Error("unreachable");
  held.child.stdin.write(
    `SET search_path TO ${catalog.schema}; SET statement_timeout = '10s'; SET lock_timeout = '8s';\n` +
    "BEGIN;\n" + catalog.publishSql(winnerPublication.publication) + "\\echo HELD\n",
  );
  await until(() => held.output().includes("HELD"), "the first transaction holding vault-a's publication lock");

  // A second publication of the *same* vault must block on a real lock.
  const waiterName = `${catalog.schema}_waiter`;
  const waiter = catalog.openSession(waiterName);
  const loserPublication = validatePublication(request({ mutationId: "loser", baseSequence: 1, notes: [{ path: "Loser.md", text: "unpublished" }], assets: [] }));
  assert.equal(loserPublication.status, "ok");
  if (loserPublication.status !== "ok") throw new Error("unreachable");
  waiter.child.stdin.end(
    `SET search_path TO ${catalog.schema}; SET statement_timeout = '10s'; SET lock_timeout = '8s';\n` +
    catalog.publishSql(loserPublication.publication),
  );
  await until(
    async () => (await catalog.query(
      `SELECT count(*) FROM pg_stat_activity WHERE application_name = ${literal(waiterName)} AND wait_event_type = 'Lock';`,
    )) === "1",
    "a same-vault publication blocked on the publication lock",
  );
  assert.equal(await snapshot(), committedBefore, "readers must not see an uncommitted publication");

  // A different vault publishes to completion while vault-a is still held.
  const otherVault = await publish(catalog.store, request({
    vaultId: vaultB, mutationId: "publish-1", baseSequence: 0,
    notes: [{ path: "Index.md", text: "# Another vault\n" }], assets: [],
  }));
  assert.equal(otherVault.status, "ok", "a different vault must not block behind vault-a's lock");
  if (otherVault.status !== "ok") throw new Error("unreachable");
  assert.equal(otherVault.receipt.sequence, 1, "each vault owns its own sequence");
  assert.equal(await catalog.query(`SELECT sequence FROM vault WHERE vault_id = ${literal(vaultA)};`), "1",
    "vault-b's publication must not advance vault-a");

  // Per-vault mutation ids: vault-b reused "publish-1" with a different payload
  // and was accepted, because idempotency keys are scoped to their vault.
  // Three vaults now hold a receipt under that one id: vault-a, vault-restore
  // and vault-b.
  assert.equal(await catalog.query(`SELECT count(*) FROM receipt WHERE mutation_id = 'publish-1';`), "3");

  held.child.stdin.end("COMMIT;\n");
  await held.done;
  await assert.rejects(waiter.done, /GEODE_CATALOG:CONFLICT/, "the blocked same-vault publication must lose on its base");
  assert.equal(await catalog.query(`SELECT count(*) FROM catalog_entry WHERE path = 'Loser.md';`), "0");
  assert.equal(await catalog.query(`SELECT sequence FROM vault WHERE vault_id = ${literal(vaultA)};`), "2");

  // --- 4b/4c. Concurrent reuse of one mutation id --------------------------
  // Phase 0 asserts these two as separate scenario groups, and the sequential
  // versions above do not stand in for them: the schema's claim is that a
  // *waiting* duplicate checks its receipt after the winner commits and before
  // its own base is tested. That ordering only exists under contention, so it
  // is only observable under contention.
  //
  // Run on their own vault so vault-a's sequence arithmetic below is
  // untouched, and so the claim is stated where it is true — per vault.
  const vaultDup = "vault-dup";
  const dupBase = await publish(catalog.store, request({
    vaultId: vaultDup, mutationId: "seed", baseSequence: 0,
    notes: [{ path: "Dup.md", text: "seed" }], assets: [],
  }));
  assert.equal(dupBase.status, "ok");

  /**
   * Hold one publication open, block a second behind it on an observed lock
   * wait, then release the first and hand back both outcomes.
   */
  async function contend(label: string, first: PublishRequest, second: PublishRequest): Promise<{
    winner: string; waiter: Promise<string>;
  }> {
    const held = validatePublication(first);
    const challenger = validatePublication(second);
    assert.equal(held.status, "ok");
    assert.equal(challenger.status, "ok");
    if (held.status !== "ok" || challenger.status !== "ok") throw new Error("unreachable");
    const prefix = `SET search_path TO ${catalog.schema}; SET statement_timeout = '10s'; SET lock_timeout = '8s';\n`;
    const holder = catalog.openSession(`${catalog.schema}_${label}_holder`);
    holder.child.stdin.write(prefix + "BEGIN;\n" + catalog.publishSql(held.publication) + "\\echo HELD\n");
    await until(() => holder.output().includes("HELD"), `${label}: the winner holding the publication lock`);
    const name = `${catalog.schema}_${label}_waiter`;
    const blocked = catalog.openSession(name);
    blocked.child.stdin.end(prefix + catalog.publishSql(challenger.publication));
    await until(
      async () => (await catalog.query(
        `SELECT count(*) FROM pg_stat_activity WHERE application_name = ${literal(name)} AND wait_event_type = 'Lock';`,
      )) === "1",
      `${label}: the duplicate blocked on the publication lock`,
    );
    holder.child.stdin.end("COMMIT;\n");
    const winner = (await holder.done).split("\n").map((line) => line.trim()).find((line) => line.startsWith("{")) ?? "";
    return { winner, waiter: blocked.done };
  }

  // Group 4: same id, same payload. The waiter must return the *winner's*
  // receipt rather than conflicting on a base that is now stale — which is the
  // whole reason the schema checks receipts after taking the lock.
  const identical = request({
    vaultId: vaultDup, mutationId: "concurrent", baseSequence: 1,
    notes: [{ path: "Dup.md", text: "published once" }], assets: [],
  });
  const same = await contend("same", identical, { ...identical });
  assert.deepEqual(
    JSON.parse(await same.waiter),
    JSON.parse(same.winner),
    "a concurrent identical duplicate must return the winner's receipt verbatim",
  );
  assert.equal(JSON.parse(same.winner).sequence, 2);
  assert.equal(await catalog.query(`SELECT sequence FROM vault WHERE vault_id = ${literal(vaultDup)};`), "2",
    "two concurrent identical publications must advance the sequence exactly once");
  assert.equal(await catalog.query(`SELECT count(*) FROM receipt WHERE vault_id = ${literal(vaultDup)};`), "2",
    "a concurrent duplicate must not create a second receipt");

  // Group 5: same id, different payload. The waiter must reject, and the
  // winner's bytes must survive the rejection intact.
  const divergent = request({
    vaultId: vaultDup, mutationId: "diverging", baseSequence: 2,
    notes: [{ path: "Dup.md", text: "the winner's bytes" }], assets: [],
  });
  const diverged = await contend("diverge", divergent, {
    ...divergent, notes: [{ path: "Dup.md", text: "the loser's bytes" }],
  });
  await assert.rejects(diverged.waiter, /GEODE_CATALOG:MUTATION_ID_REUSED/,
    "a concurrent duplicate with a changed payload must be refused, not silently accepted");
  assert.equal(
    await catalog.query(`SELECT text FROM catalog_entry WHERE vault_id = ${literal(vaultDup)} AND path = 'Dup.md';`),
    "the winner's bytes",
    "a rejected concurrent duplicate must leave the winner's bytes intact",
  );
  assert.equal(await catalog.query(`SELECT sequence FROM vault WHERE vault_id = ${literal(vaultDup)};`), "3");

  // --- 5. Rollback: a failure after writes leaves nothing behind ------------
  const before = await snapshot();
  const failing = validatePublication(request({
    mutationId: "rollback", baseSequence: 2,
    notes: [{ path: "Index.md", text: "# broken\n" }, { path: "Partial.md", text: "must disappear" }],
    assets: [{ path: "assets/extra.png", contentAddress: sha(new Uint8Array([7, 7, 7])), contentType: "image/png", bytes: new Uint8Array([7, 7, 7]) }],
  }));
  assert.equal(failing.status, "ok");
  if (failing.status !== "ok") throw new Error("unreachable");
  await assert.rejects(
    catalog.query(catalog.publishSql(failing.publication, { fail: true })),
    /GEODE_CATALOG:INJECTED_FAILURE/,
  );
  assert.equal(await snapshot(), before, "sequence, catalog entries, objects and receipts must all roll back together");

  const recovered = await publish(catalog.store, request({
    mutationId: "rollback", baseSequence: 2,
    notes: [{ path: "Index.md", text: "# recovered\n" }, { path: "Partial.md", text: "published together" }],
    assets: [{ path: "assets/extra.png", contentAddress: sha(new Uint8Array([7, 7, 7])), contentType: "image/png", bytes: new Uint8Array([7, 7, 7]) }],
  }));
  assert.equal(recovered.status, "ok", "the same mutation id is reusable after a rolled-back attempt");
  if (recovered.status !== "ok") throw new Error("unreachable");
  assert.equal(recovered.receipt.sequence, 3);
  assert.equal(
    await catalog.query(`SELECT count(*) FROM catalog_entry WHERE vault_id = ${literal(vaultA)} AND path IN ('Index.md', 'Partial.md', 'assets/extra.png');`),
    "3",
    "the retry must publish every entry",
  );

  // --- 6. Immutability is enforced, not documented -------------------------
  await assert.rejects(
    catalog.query(`UPDATE object SET content_type = 'image/gif' WHERE vault_id = ${literal(vaultA)};`),
    /GEODE_CATALOG:OBJECT_IMMUTABLE/,
    "stored objects must be insert-only",
  );
  await assert.rejects(
    catalog.query(`DELETE FROM object WHERE vault_id = ${literal(vaultA)};`),
    /GEODE_CATALOG:OBJECT_IMMUTABLE/,
  );

  // --- 7. Store-side duplicate-with-mismatched-bytes ------------------------
  // Plant an object whose recorded address does not describe its bytes — the
  // state a corrupted client, a weakened digest or a bug would produce — then
  // publish a legitimate asset at that address. The store must refuse rather
  // than let one content address come to mean two things. Planting it directly
  // is honest: pretending SHA-256 collided would not be.
  const plantedBytes = new Uint8Array([4, 2]);
  const plantedAddress = sha(new Uint8Array([3, 1, 4]));
  await catalog.query(
    `INSERT INTO object (vault_id, content_address, content_type, byte_length, bytes) VALUES (` +
    `${literal(vaultA)}, ${literal(plantedAddress)}, 'image/png', ${plantedBytes.byteLength}, ` +
    `decode(${literal(Buffer.from(plantedBytes).toString("hex"))}, 'hex'));`,
  );
  const mismatched = await publish(catalog.store, request({
    mutationId: "mismatch", baseSequence: 3, notes: [],
    assets: [{ path: "assets/planted.png", contentAddress: plantedAddress, contentType: "image/png", bytes: new Uint8Array([3, 1, 4]) }],
  }));
  assert.equal(mismatched.status, "duplicate-with-mismatched-bytes",
    "the store must refuse to overwrite bytes at an existing content address");
  assert.equal(await catalog.query(`SELECT sequence FROM vault WHERE vault_id = ${literal(vaultA)};`), "3",
    "a refused publication must not advance the sequence");

  // The store verifies content addresses itself rather than trusting a client
  // that bypassed the portable validator.
  await assert.rejects(
    catalog.query(`SELECT publish_catalog(${literal(vaultA)}, 'lying', 'digest', 3, '[]'::jsonb, ` +
      `${literal(JSON.stringify([{ path: "assets/lie.png", contentAddress: sha(new Uint8Array([0])), contentType: "image/png", hex: "0102" }]))}::jsonb);`),
    /GEODE_CATALOG:INVALID_CONTENT_ADDRESS/,
    "the store must not trust a client-declared content address",
  );

  // --- 8. Portable refusals never reach the database -----------------------
  const receiptsBefore = await catalog.query("SELECT count(*) FROM receipt;");
  const portableRefusals = {
    oversize: (await publish(catalog.store, request({ mutationId: "big", baseSequence: 3, assets: [], notes: [{ path: "Big.md", text: "x".repeat(3 * 1024 * 1024) }] }))).status,
    invalidContentAddress: (await publish(catalog.store, request({ mutationId: "bad-hash", baseSequence: 3, notes: [], assets: [{ ...assets[0], contentAddress: sha(new Uint8Array([0])) }] }))).status,
    duplicateWithMismatchedBytes: (await publish(catalog.store, request({
      mutationId: "dupe", baseSequence: 3, notes: [],
      assets: [assets[0], { path: "assets/copy.png", contentAddress: assets[0].contentAddress, contentType: "image/png", bytes: new Uint8Array([0]) }],
    }))).status,
    unsupportedContentType: (await publish(catalog.store, request({ mutationId: "bad-type", baseSequence: 3, notes: [], assets: [{ ...assets[0], contentType: "application/x-msdownload" }] }))).status,
    invalidPath: (await publish(catalog.store, request({ mutationId: "escape", baseSequence: 3, assets: [], notes: [{ path: "../Escape.md", text: "x" }] }))).status,
    notANote: (await publish(catalog.store, request({ mutationId: "not-note", baseSequence: 3, assets: [], notes: [{ path: "Image.png", text: "x" }] }))).status,
  };
  assert.deepEqual(portableRefusals, {
    oversize: "oversize",
    invalidContentAddress: "invalid-content-address",
    duplicateWithMismatchedBytes: "duplicate-with-mismatched-bytes",
    unsupportedContentType: "unsupported-content-type",
    invalidPath: "invalid-path",
    notANote: "not-a-note",
  }, "every refusal must be reported by its own distinct status");
  assert.equal(await catalog.query("SELECT count(*) FROM receipt;"), receiptsBefore,
    "a refused publication must not write a receipt");

  // --- 9. What VM B has to reconstruct -------------------------------------
  // Stated here as durable state, not as a value handed to anyone: VM B reads
  // the schema for itself, in its own process.
  const published = JSON.parse(await catalog.query(
    `SELECT jsonb_build_object('sequence', (SELECT sequence FROM vault WHERE vault_id = ${literal(RESTORE_VAULT_ID)}),
      'noteCount', (SELECT count(*) FROM catalog_entry WHERE vault_id = ${literal(RESTORE_VAULT_ID)} AND kind = 'note'),
      'assetCount', (SELECT count(*) FROM catalog_entry WHERE vault_id = ${literal(RESTORE_VAULT_ID)} AND kind = 'attachment'),
      'objectCount', (SELECT count(*) FROM object WHERE vault_id = ${literal(RESTORE_VAULT_ID)}));`,
  ));

  console.log(JSON.stringify({
    nodeOnly: true,
    postgres: await catalog.query("SHOW server_version;"),
    schemaOwnedByHarness: Boolean(providedSchema),
    vaultsPublished: 4,
    // Phase 0's six scenario groups, re-asserted against the multi-vault
    // schema: initial/retry/reuse, stale base, concurrent distinct ids,
    // concurrent same id and payload, concurrent same id and changed payload,
    // and failure after writes and receipt insertion.
    phase0ScenarioGroups: 6,
    sourceResolution,
    firstReceipt: first.receipt,
    restoreVaultId: RESTORE_VAULT_ID,
    published,
    projectionBytes: Buffer.byteLength(projection, "utf8"),
    projectionWritten: Boolean(projectionOut),
    lockWaitsObserved: 3,
    concurrentDifferentVaultCompleted: true,
    rollbackVerified: true,
    immutabilityEnforced: true,
    portableRefusals: Object.keys(portableRefusals).length,
  }));
} finally {
  catalog.close();
  // Only whoever created the schema drops it. Under the harness that is the
  // harness, in a `finally` of its own, after VM B has also finished.
  if (installed) await catalog.drop();
  await rm(root, { recursive: true, force: true });
}
