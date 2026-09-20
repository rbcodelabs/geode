# Aurora DSQL catalog adapter — feasibility findings

Status: **Phase A emulation plus a successful real DSQL/private-Blob proof.**
Date: 2026-09-19
Relates to: [ADR 0022](../adr/0022-transactional-multi-vault-catalog-contract.md), whose
enforcement claims this document weakens in specific, named ways.

Phase A had no cloud access by design: no AWS call, no DSQL connection, no Vercel
Blob, no `@vercel/blob` dependency, zero spend. Every claim below was observed
against conventional PostgreSQL 17.11 in a disposable container, or is a static
property of the source. §6 is the list of things that statement makes unprovable
until Phase B. The Phase B addendum below supersedes those historical limits;
the earlier sections remain the account of the PostgreSQL emulation.

## Phase B addendum — 2026-09-20

The real proof ran as a temporary protected Vercel **preview**, then was removed.
Vercel preview OIDC successfully exchanged for short-lived AWS credentials; local
development tokens were denied. No AWS console login or long-lived AWS key was
needed. The administrator connection only provisioned and removed the isolated
schema, tables, scoped LOGIN role and IAM mapping. Separate publisher/restorer
processes received only scoped database credentials and a Blob token. They had no
administrator token. No Compass application schema or source was touched.

### Observed evidence, not emulation

- Six notes (including ` Draft.md` and `__GEODE_SPLIT__.md`) and three binary
  asset paths published and restored through the real portable wiki engine.
- Publisher PID 36 exited before restorer PID 48 started. Neither vault files nor
  projections were passed to the restorer. Both independently produced a
  **586,875-byte** resolution/search/backlink projection with SHA-256
  `4ce7f79d53d0ec5c2e84c721e78bc51ae54ed2d3008db2b5159ff70c58c7991e`.
- Replay returned the same receipt; sequence remained 1. Stale base was refused.
- Two transactions established snapshots before a barrier released either write.
  Exactly one succeeded; the loser returned **SQLSTATE `40001`, detail `OC000`**.
  Both races preuploaded objects to isolate SQL concurrency; they did not test
  overlapping first-time Blob uploads. A second synchronized race through `store.commit` observed that same failure
  and automatically retried to the winner's receipt. `OC000` is observed error
  detail, not the SQLSTATE guessed in Phase A. No `OC001` claim is established.
- Review found that exclusive-create Blob writes could reject a losing first
  upload before SQL retry began. A deterministic unit regression reproduced it.
  The adapter now rereads after a failed PUT and accepts only matching digest
  **and bytes**; corruption, absence and read failure remain refusals. This fix
  is unit-verified, not a new cloud observation. Cold-upload cloud contention
  remains a production-adapter verification requirement.
- A deliberately mismatched note object returned `invalid-content-address`.
  Deleting its catalog object row succeeded and restore returned `missing-object`:
  the lack of database-enforced referential integrity is real.
- All 11 Blob objects were deleted; the prefix was listed again and empty.
  Schema, database role and IAM mapping counts were all zero after teardown.
- Full invocation, including provisioning and teardown: **7,011 ms**.

### Compatibility findings discovered only on DSQL

DSQL accepted all four table definitions, including regex CHECK constraints. It
rejected `SET standard_conforming_strings` and `SET statement_timeout` with
`0A000`. The optional driver-backed execution seam now verifies the former with
`SHOW` and enforces timeouts in the client. The default psql path remains the
**local-emulation path**, not a verified real-DSQL runner. The cloud harness drops
each owned table separately before dropping its schema; it does not rely on
`DROP SCHEMA CASCADE` compatibility.

The public Blob variant passed once but later returned `missing-object` for an
object still enumerated by storage. Cache inconsistency is the likely explanation,
not proven by a cache trace. The successful final variant uses the existing
**private** Blob store with authenticated `useCache: false` reads. Do not infer
immediate restore consistency from a public CDN GET. Production work needs this
storage/access choice explicitly carried into its design.

The Blob wrapper requests no random suffix, asserts the returned physical
pathname, and exposes stable logical keys to the catalog. It does not prove that
the catalog supports arbitrary stores that return a different key; `uploadObjects`
currently discards such a returned key. That remains a production-adapter concern.

### Measured usage and cost interpretation

Final successful run: **161 worker SQL statements**, 22 Blob reads, 11 Blob writes,
535,729 bytes uploaded and 535,743 bytes downloaded. Administrative setup/teardown
queries and the final 2 prefix lists / 11 deletes are additional operations.
These are application counters, not billing meters. The earlier probes include
two failed session-setting attempts, public-store attempts, and access checks;
all verified cleanup. There were no new clusters or stores and no persistent data.

`EXPLAIN ANALYZE VERBOSE` of the nine-row catalog read reported **0.02924 DPU**
(0.01350 compute + 0.01574 read; zero write), 0.617 ms execution. At the published
US East rate of $8/million DPUs, that sample is approximately $0.000000234; it is
**not** the cost of the complete spike. DSQL's statement estimates exclude
transaction/background overhead and are explicitly not billing-grade.

Cost model for a real vault: catalog DPUs per publish/restore × frequency, retained
catalog GB-month, Blob PUT/GET/LIST operations, retained content-addressed byte
GB-month and transfer GB, plus runtime compute. Repeated publications with new
content grow retained storage without garbage collection. The bounded fixture
traffic gives no indication of approaching the $25 ceiling, but an exact billed
total was not available; do not report zero spend or an audited total.

Sources: [AWS DSQL pricing](https://aws.amazon.com/rds/aurora/dsql/pricing/),
[DSQL statement estimates](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/understanding-dpus-explain-analyze.html),
[Vercel Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk),
[Blob usage dimensions](https://vercel.com/docs/vercel-blob/usage-and-pricing).

### Reproduction and limits

`scripts/build-cloud-dsql-probe.mjs` builds only; deployment still requires explicit
authority. Supply a throwaway destination, `SPIKE_DEPENDENCY_ROOT` naming an
existing dependency directory with pg/DSQL signer/Vercel functions/Blob, and
`SPIKE_BLOB_TOKEN_NAME` naming an existing **private** token variable. Link only
that throwaway directory to the authorized project. No dependency, credential,
host path or project link is added to the portable engine or production app.

The harness is a bounded experiment, not production infrastructure: at most two
concurrent writers, 400 SQL statements per worker, 40 writes / 4 MiB upload and
100 reads / 16 MiB download per worker; child timeout 85 seconds and function
timeout 300 seconds. It is not safe for unattended repeated execution. `finally`
cannot survive forced process termination; the reported schema identifier is the
recovery target if cleanup is interrupted. A production adapter needs durable
orphan recovery, scoped credential lifecycle, pooling, metering and independent
security review. No synchronization, production adapter or Compass integration is
delivered by this spike.

---

## 1. What replaced each removed feature

The merged catalog cannot run on Aurora DSQL. Six mechanisms it depends on do not
exist there. `src/catalog/postgres-catalog-schema.sql` and
`src/catalog/postgres-catalog-store.ts` are **unchanged** and remain the valid
reference adapter for conventional PostgreSQL; the DSQL work is a second adapter
beside them, not a replacement.

| PostgreSQL mechanism | DSQL | Replaced by | Where |
| --- | --- | --- | --- |
| `REFERENCES vault (vault_id)` ×3 | absent | Nothing enforcing. A vault exists iff it has a `vault_sequence` row; an entry for a vault with none restores as `invalid-sequence` | contract, on read |
| Composite FK `catalog_entry → object` | absent | **Write ordering**: object bytes are stored, then object rows and catalog entries land in one transaction. Detection is `missing-object` on read | adapter + contract |
| `CREATE TRIGGER object_no_mutation` | absent | **Nothing prevents it.** Content-addressed keys plus digest verification on read detect it | see §2 |
| `CREATE TRIGGER object_no_truncate` | absent | **Nothing.** `TRUNCATE` is itself unsupported, but `DELETE FROM object` achieves the same and is unblocked | see §2 |
| `publish_catalog()` in PL/pgSQL | absent | Application-layer transaction: a branching preflight read, then one non-branching write block | `dsql-catalog-store.ts` |
| `restore_catalog()` in PL/pgSQL | absent | Two plain `SELECT`s in one repeatable-read transaction | `dsql-catalog-store.ts` |
| `PERFORM … FOR UPDATE` (blocking lock) | no blocking waits | `vault_sequence (vault_id, sequence)` primary key + bounded OCC retry | see §3 |
| `jsonb` receipt column | store JSON as TEXT | `receipt text`, parsed by the adapter | schema |
| `bytea` object bytes | 10 MiB write-transaction ceiling | **Content-addressed object store behind an injectable seam** | `object-store.ts` |

### Three changes that are more than a substitution

**Note bytes are now content-addressed.** ADR 0022 records extending content
addressing to note bytes as "a deliberate non-decision". DSQL decides it: a write
transaction is capped near 10 MiB while `DEFAULT_CATALOG_LIMITS` permits a 64 MiB
publication, so carrying note text in `catalog_entry.text` makes the contract's own
declared limits unpublishable. Notes and attachments are now both objects, and a
publication's transaction size is proportional to *entry count*, not bytes.

A side effect is a small net gain: note bytes now get a SHA-256 they never had.
The contract cannot check it — `CatalogNote` carries `text`, not an address — so
the adapter does, reporting failures with the contract's existing
`invalid-content-address` and `missing-object` names rather than inventing new ones.

**The sequence counter became an append-only log.** `UPDATE vault SET sequence =
sequence + 1` is a read-modify-write on a hot key, which DSQL's own guidance warns
against and which needs a blocking lock to be safe. Publishing at base *B* now
inserts `vault_sequence (vault_id, B+1)`; the primary key makes exactly one racer
win, with no session ever waiting on another. The current sequence is
`max(sequence)` over the key prefix. There is no compaction — the log grows with
publication count, matching ADR 0022's existing stance of no GC.

**Publication entry limit tightened to 500.** A publication modifies up to
`entries` deletes + `entries` inserts + `entries` object rows + 2. At the contract
default of 1,000 that reaches 3,002, over DSQL's 3,000-row transaction cap. At 500
it reaches 1,502. `DSQL_CATALOG_LIMITS` is an ordinary `CatalogLimits` value. The
normal caller should pass it to `publish`, and the adapter also repeats the entry
count guard before any I/O. That defensive check is intentional contract friction:
`ValidatedPublication` proves that *some* limit was applied, but does not carry the
limit that produced it, so the adapter cannot otherwise guarantee DSQL's structural
ceiling.

---

## 2. What is no longer guaranteed

This is the section to read sceptically. The PostgreSQL schema *prevented* these;
the DSQL schema *detects* most of them and misses one entirely.

### Enforcement that is simply gone

A client with write access to the schema — which the adapter itself has — can now
do all of the following. Each was refused outright before.

| Action | Before | Now | Detected? |
| --- | --- | --- | --- |
| `UPDATE object SET content_type = …` | `GEODE_CATALOG:OBJECT_IMMUTABLE` | **succeeds** | **No.** Restore reads the entry's content type, not the object's metadata column |
| `UPDATE object SET byte_length = …` | refused | **succeeds** | Attachments: `byte-length-mismatch`. Notes: not detected by this metadata check |
| `DELETE FROM object WHERE …` | refused | **succeeds** | Yes — `missing-object` on restore |
| `DELETE FROM object` (all rows) | refused by two triggers | **succeeds** | Yes, per entry, on restore |
| `INSERT INTO catalog_entry` naming an absent address | refused by composite FK | **succeeds** | Yes — `missing-object` |
| `INSERT INTO catalog_entry` for a vault that never published | refused by FK to `vault` | **succeeds** | Yes — `invalid-sequence` |
| Overwriting a blob at a content-addressed key | n/a (bytes were in `bytea`) | **succeeds** | Yes — `invalid-content-address` |

`scripts/dsql-catalog-publish-proof.mts` §6 and §7 **assert that these succeed**
rather than omitting the scenarios. An unenforceable guarantee that is quietly
dropped from the test suite is how a weakened system comes to look unchanged.

### The precise shape of the loss

- **Immutability is now a read-time check, not a write-time prevention.** Nothing
  stops bad bytes being written; the next restore refuses them. Between the write
  and that restore, the catalog holds state the old schema could not represent.
- **Referential integrity is now an ordering convention.** The adapter stores bytes
  before the transaction that references them, so a *successful* publication never
  dangles. Nothing enforces that ordering on a second writer, and no constraint
  would catch one that got it wrong.
- **Two failure modes moved from unreachable to reachable.** ADR 0022 records that
  `missing-object` and `duplicate-with-mismatched-bytes` are unreachable through the
  PostgreSQL schema, so that proof exercises them against raw fixtures. Under DSQL
  both are reachable. `dsql-catalog-restore-proof.mts` plants six refusal cases in
  the real stores; the seventh (`oversize`) restores the honest fixture under an
  eight-byte configured limit (`restoreRefusalsFromRawFixtures: 0`, against the
  PostgreSQL proof's 2). Better test coverage; worse system.
- **Rollback is no longer total.** The database transaction still rolls back
  atomically — sequence slot, object rows, catalog entries and receipt together,
  verified in §8 of the publish proof. But object *bytes* are written before it
  opens, so a failed publication leaves orphaned blobs. This is the deliberate
  direction of the asymmetry: wasted storage rather than a catalog pointing at
  nothing. There is no garbage collector.
- **Nothing is enforced against a privileged client, and now nothing is enforced
  against an unprivileged one either.** ADR 0022 already conceded that
  `ALTER TABLE object DISABLE TRIGGER ALL` was available to the schema owner, so the
  trigger was "a guarantee against a buggy client, not a privileged one". That
  guarantee against the buggy client is what has been lost. What remains is
  `tests/unit/dsql-catalog-schema.test.ts`, which greps the adapter for `UPDATE
  object` / `DELETE FROM object` and fails if either appears — a real check against
  *this adapter regressing*, and no check at all against any other writer.

### What survived intact

All five publish semantics hold, observed in the proof:

1. Idempotent replay returns the original receipt verbatim; the sequence advances once.
2. Stale-base publication is rejected (`conflict`), publishing nothing.
3. A duplicate in flight does not double-apply — see §3 for the mechanism, which changed.
4. Object bytes cannot change once written **via this adapter** (`putImmutable` refuses).
5. No catalog entry references an absent object **after a successful publication**.

Refusal vocabulary is unchanged and unflattened: both adapters name the same
condition the same way, which is why `verifyRestoredVault` is still the thing that
decides and the adapter is still only doing I/O.

---

## 3. The OCC answer: the property does **not** survive

The PostgreSQL schema's load-bearing comment is:

> Serialize publication for this vault only, then check receipts, so a waiting
> duplicate sees the winner's receipt before its base is tested.

**That property is lost.** It cannot hold under optimistic concurrency, because it
is a statement about a transaction that *waits*, and under OCC nothing waits.

### Evidence

`scripts/dsql-catalog-publish-proof.mts` §5, run against PostgreSQL 17.11 under
`REPEATABLE READ`:

- **5a — the property is genuinely gone.** Made deterministic rather than raced,
  because the claim is about *when a snapshot was taken*. The duplicate's preflight
  runs first and observes `receipt: null` and a still-current base. The winner then
  publishes to completion. The duplicate's write then executes against that snapshot
  and **fails** on the `vault_sequence` primary key — it never saw the winner's
  receipt, and its base was never usefully tested. Asserted: no extra sequence slot,
  no extra receipt.
- **5b — the observable outcome survives anyway.** The same duplicate through
  `commit()` returns the winner's receipt *verbatim* (`deepEqual`), and the sequence
  advanced exactly once. Its preflight is a **fresh** snapshot, which is the entire
  difference.
- **5b′ — under genuine concurrency.** Six identical publications launched at once:
  all six returned `ok`, all six receipts identical (`new Set(receipts).size === 1`),
  exactly one new `vault_sequence` row, exactly one new `receipt` row.
- **5c — the retry is what buys it.** The same race with `maxAttempts: 1`:
  `occWithoutRetrySucceeded: 1`, statuses `["ok", "store-failed"]`. One racer won
  outright and **five failed**. Without the retry loop, 5b does not happen.

### What replaces it

A **bounded retry over a fresh snapshot**. The guarantee is no longer
"within one transaction, a duplicate observes the winner"; it is "across at most
*N* attempts, a duplicate converges on the winner's receipt". Three consequences
that are strictly worse and should be stated as such:

1. **It is no longer atomic with respect to a single call.** The duplicate performs
   a full failed write attempt, including its object uploads, before converging.
   Uploads are idempotent so this is wasted work, not corruption.
2. **It can be exhausted.** Under sufficient contention all attempts lose and
   `commit` returns a refusal where the PostgreSQL adapter would have blocked and
   then succeeded. The lock-waiting design has no equivalent failure mode.
3. **The exhausted case is indistinguishable from an unreachable database.** Both
   return `store-failed` — visible directly in 5c's observed statuses. `CommitStatus`
   has no name for "lost every race", and *inventing* one would mean changing
   `src/wiki/catalog-contract.ts`, which this spike deliberately did not do. This is
   the strongest candidate for a contract amendment, and it is recorded here as a
   question for the owner rather than taken.

### The hot key is deliberate and unavoidable

DSQL's guidance says to avoid hot keys. Per-vault publication *is* a hot key: the
`(vault_id, B+1)` slot is the coordination point, and it has to be, because
"publications of one vault serialize" is the semantic being bought. Only
publications of the *same vault at the same base* contend; different vaults never
touch the same key. This is DSQL's own "accept contention only for genuine
constraints" case.

---

## 4. `catalog-contract.ts` did **not** need to change

This was the premise the whole architecture rests on, and the spike was instructed
to stop and escalate if it broke. It held. `src/wiki/catalog-contract.ts` is
byte-identical to `eb3918d`.

Every DSQL accommodation landed in the adapter layer or in a value the contract
already parameterises, but the transaction ceiling exposed one boundary mismatch:

- Tighter limits → `DSQL_CATALOG_LIMITS`, an ordinary `CatalogLimits`, plus a
  defensive adapter-side entry guard because `ValidatedPublication` does not retain
  which limits validated it.
- Content-addressed notes → invisible to the contract; `RawRestoredEntry` already
  carries `text` for notes and the adapter supplies it.
- New failure modes → every one of them already had a name in `RestoreStatus` or
  `CommitStatus`.
- Byte storage → the adapter's own seam; the contract never knew where bytes lived.

Three frictions worth recording, none of which forced a source change to the
portable contract in this spike:

- **`store-failed` is now overloaded** (§3.3).
- **The adapter has to repeat one validation-class decision.** Returning
  `entry-limit` from `commit` preserves the named refusal and prevents a known-bad
  3,002-row transaction, but it cuts against the contract's stated ideal that every
  `ValidationStatus` is decided before an adapter is contacted. A future contract
  revision could carry effective limits on the store or the validated publication;
  this spike does not silently make that architectural change.
- **The contract cannot verify note integrity**, because `CatalogNote` has no content
  address. Under the PostgreSQL adapter that costs nothing; here the adapter must
  check, and a bug in *that* check would not be caught by the contract. The adapter
  reports using the contract's existing names so the vocabulary stays consistent.

---

## 5. Historical Phase A scope boundaries

- No DSQL query, no Vercel Blob operation, no `@vercel/blob` dependency and no
  cloud mutation. A read-only auth probe used the Vercel-provided Preview
  environment and confirmed the local-development OIDC subject is not trusted by
  the Preview/Production AWS role (`sts:AssumeRoleWithWebIdentity` denied). The
  valid no-login path is therefore an authorized Vercel runtime, where the request
  carries the trusted OIDC token; no local AWS login is required. The temporary
  environment file was deleted immediately. Zero database/blob spend observed.
- `postgres-catalog-schema.sql` and `postgres-catalog-store.ts` untouched; both
  PostgreSQL proofs still pass.
- Local PostgreSQL ran in a dedicated throwaway container (`geode-dsql-spike-pg`,
  port 55450), stopped afterwards. Unrelated database containers were never touched.
- No change to the desktop app, vault format, or `src/wiki/`.
- No synchronization, no Compass Docs integration, no merge, release, tag or deploy.

---

## 6. Historical Phase A checklist for real DSQL and Vercel Blob

At the end of Phase A, everything below was **unverified**. The Phase B addendum
above records which observations now supersede this checklist. Local PostgreSQL accepts syntax DSQL rejects and
its concurrency control is not DSQL's, so a green Phase A proves only that the
design is coherent — not that it runs.

### 6.1 Will the schema install at all?

`tests/unit/dsql-catalog-schema.test.ts` proves the schema does not *use* the six
features DSQL lacks. It cannot prove DSQL accepts what remains. Each of these is a
guess until a cluster says otherwise:

1. **`CHECK (content_address ~ '^[0-9a-f]{64}$')`** — POSIX regex in a CHECK
   constraint. Two tables depend on it. **Highest install-time risk in the file.**
2. **`bigint`** columns.
3. **`CHECK (kind IN ('note','attachment'))`** — an `IN` list in a CHECK.
4. **Composite primary keys** on all four tables.
5. **`CREATE SCHEMA` / `DROP SCHEMA … CASCADE`** — the disposable-schema lifecycle.
   `CASCADE` is the doubtful half.
6. **One-DDL-per-transaction installer** — `splitSqlStatements` produces four
   statements issued separately. Correct for DSQL by construction; never run there.

### 6.2 Will the queries run?

7. **`RETURNING`**, **`DELETE … WHERE path IN (…)`** with up to 500 literals,
   **`LEFT JOIN`** across `catalog_entry`/`object`, **`max()`** with `coalesce`.
8. **`chr()` and `replace()`** — the row encoder's entire basis. If either is absent
   the restore read cannot be parsed at all.
9. **`SET search_path` / `SET standard_conforming_strings` / `SET statement_timeout`**
   in the session prefix.
10. **`BEGIN ISOLATION LEVEL REPEATABLE READ`** — accepted, or rejected as redundant
    given DSQL's fixed isolation?

### 6.3 Concurrency — the part local PostgreSQL most misrepresents

11. **Does DSQL raise the conflict where this design expects it?** Local PostgreSQL
    *blocks* on a duplicate-key insert until the other transaction resolves, then
    errors. DSQL should not block and should abort at COMMIT. The outcome class is
    the same; the timing, and therefore the retry's cost, is not.
12. **The real SQLSTATE.** `RETRYABLE_SQLSTATES` guesses `OC000`/`OC001` alongside
    the standard `40001`/`23505`. **If DSQL's actual code is not in that set, every
    conflict becomes a terminal `store-failed` and §3's 5b result evaporates.** This
    is the single highest-risk assumption in the adapter.
13. **Re-run 5a/5b/5b′/5c on the cluster.** 5c especially: the whole claim that the
    retry is load-bearing rests on losers actually failing.
14. **How many retries are enough?** `maxAttempts: 5` with jittered backoff is
    unmeasured. Needs a real contention distribution.
15. **Whether `vault_sequence` becomes a throughput ceiling** at realistic publication
    rates.

### 6.4 Transaction limits — measured, not assumed

16. **Confirm a 500-entry publication fits** under 3,000 rows, 10 MiB and 5 minutes
    *as DSQL counts them*. The row arithmetic in `DSQL_CATALOG_LIMITS` is derived
    from documentation, not observed.
17. **Statement size.** A 500-path `DELETE … IN` plus a 500-row multi-row `INSERT`
    produces a large statement. No documented limit was found; none was tested.

### 6.5 Vercel Blob

18. **Key assignment.** The schema stores `object_key` precisely because Blob may
    append a random suffix. Confirm `addRandomSuffix: false` behaves as expected and
    that the returned pathname is what must be recorded.
19. **Read-after-write.** The adapter uploads then immediately commits metadata
    referencing the upload. If Blob is not read-after-write consistent, a restore
    racing a publication sees `missing-object`.
20. **Immutability options.** Whether Blob offers write-once or conditional-put that
    could restore some of §2's lost prevention rather than leaving it at detection.
21. **Latency and cost** of one `get` per object per restore. The restore currently
    fetches every object individually and serially — a 500-entry vault is 500 round
    trips. Almost certainly needs batching or parallelism; deliberately not optimised
    in Phase A.
22. **Deletion and orphan cleanup.** §2 notes rolled-back publications leave orphan
    blobs. There is no GC. Needs a policy.

### 6.6 Auth and operations

23. **IAM token as `PGPASSWORD`**, 15-minute expiry, 60-minute connection cap. The
    adapter spawns one `psql` per query and has no token refresh. This is fine for a
    reference adapter and is **not** a production client.
24. **`sslmode=verify-full` and `sslnegotiation=direct`.**
25. **Scoped database roles.** The adapter connects as schema owner. §2's enforcement
    gaps are partly addressable with a non-owner role that lacks UPDATE/DELETE on
    `object` — which would restore *some* of the trigger's guarantee through
    privilege rather than through a trigger. This is the most promising recovery of
    what was lost, and it is untried.

---

## 7. Historical Phase A verification status

| Claim | How |
| --- | --- |
| Schema uses none of the six forbidden features | Static, `tests/unit/dsql-catalog-schema.test.ts`, guard proven able to fail |
| Adapter never mutates an object row | Static grep of the adapter, in the same test |
| Five publish semantics hold | Observed, `proof:catalog:dsql` against PostgreSQL 17.11 |
| OCC property lost; outcome preserved by retry | Observed, §5a–5c of the same proof |
| Immutability and referential integrity unenforced | Observed — the proof asserts the violations *succeed* |
| Six store-planted restore refusals plus one configured-limit refusal | Observed, `proof:catalog:dsql-restore` |
| Two-process restore reproduces VM A's projection | Observed, projections byte-identical |
| Input-graph audit non-vacuous | Observed — broken deliberately, failed with `vm-b: unexpected runtime dependency: src/wiki/search.ts`, then restored |
| `catalog-contract.ts` unchanged | `git diff` empty against `eb3918d` |
| **Anything about Aurora DSQL itself at Phase A** | **Not verified then; see Phase B addendum for current evidence and remaining limits.** |
