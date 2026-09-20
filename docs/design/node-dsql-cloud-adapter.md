# Node DSQL/private Blob adapter

This is the reusable Node adapter following the
[DSQL feasibility spike](dsql-catalog-findings.md), not a replacement for the
conventional PostgreSQL adapter. Its architecture is recorded in
[ADR 0025](../adr/0025-node-dsql-private-blob-adapter.md).

Local adapter and regression gates pass, and the synthetic protected-preview
proof passed on 2026-09-20. Cleanup and delivery evidence are recorded below.
Preview tooling is not a production deployment or automatic cleanup service.

## Public boundary

Import `createCloudCatalog` and `createPrivateBlobStore` from
`geode/catalog/cloud`. The package export resolves to TypeScript source for
in-repository bundling; this does not publish a registry package.

`createCloudCatalog(options)` exposes:

- `publish(request)`: validate against constructor policy and publish atomically
  in the metadata store, or return a named refusal.
- `restore(vaultId)`: return verified notes/assets, or a named refusal.
- `restoreFolder({ into, vaultId })`: verify first, then materialize exclusively;
  never overwrite an existing file. A filesystem failure can leave a partially
  created destination; it is not a filesystem transaction.
- `metrics()`: a nonsecret snapshot of database/credential/retry counters.
- `close()`: stop accepting work, drain started operations, and close the pool.

Low-level `createNodeDsqlCatalog` is also exported for explicit implementations
of the existing catalog ports. Neither handle exposes schema installation,
arbitrary SQL or admin-token generation. Injected pools/object stores are trusted
host seams: a caller supplying one is responsible for its transport and resource
bounds.

### Example: configured preview handle

The example assumes `deployment` and `inventory` have already been validated
against an explicitly authorized existing attachment. `inventory` must be
durably saved before any write, not merely assembled in memory. Values below
are illustrative limits, not a spending authorization.

```ts
import { createCloudCatalog, createPrivateBlobStore } from "geode/catalog/cloud";

const types = ["text/markdown", "application/octet-stream"];
const objects = createPrivateBlobStore({
  prefix: inventory.schema + "/",
  token: deployment.privateBlobToken,
  maxObjectBytes: 1024 * 1024,
  maxReadBytes: 16 * 1024 * 1024,
  maxUploadedBytes: 16 * 1024 * 1024,
  maxOperations: 500,
  timeoutMs: 10_000,
  beforeWrite: async pathname => {
    if (!inventory.blobKeys.includes(pathname)) {
      throw new Error("Uninventoried write refused");
    }
  },
});
const catalog = createCloudCatalog({
  schema: inventory.schema,
  objects,
  connection: {
    host: deployment.host, region: deployment.region,
    roleArn: deployment.roleArn, user: inventory.schema,
    maxConnections: 1, connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 1_000, maxLifetimeSeconds: 60,
    queryTimeoutMillis: 10_000,
  },
  limits: {
    maxNoteBytes: 1024 * 1024, maxAssetBytes: 1024 * 1024,
    maxPublicationBytes: 4 * 1024 * 1024, maxPublicationEntries: 500,
    allowedContentTypes: types,
  },
  restoreLimits: {
    maxNoteBytes: 1024 * 1024, maxAssetBytes: 1024 * 1024,
    maxVaultBytes: 4 * 1024 * 1024, maxEntries: 500,
    allowedContentTypes: types,
  },
  metadataLimits: {
    maxPathBytes: 1024, maxContentTypeBytes: 128, maxReceiptBytes: 4096,
  },
  maxAttempts: 5, retryBackoffMs: 20,
});
try {
  const result = await catalog.publish({
    vaultId: "synthetic-vault", mutationId: "first-publication", baseSequence: 0,
    notes: [{ path: "Welcome.md", text: "# Synthetic preview\n" }],
  });
  // Inspect result.status; do not assume the write succeeded.
  if (result.status === "ok") {
    await catalog.restoreFolder({ into: "/tmp/synthetic-restored-vault", vaultId: "synthetic-vault" });
  }
} finally {
  await catalog.close();
}
```

Choose the Blob object cap no larger than the configured note/asset policy.
Restore checks metadata before downloading, while the Blob adapter independently
caps actual decoded streamed bytes. HTTP `Content-Length` is an exact byte check
only for unencoded/identity responses: the SDK returns fetch-decoded compressed
bodies while retaining the encoded wire length. Missing lengths do not imply an
empty object. Catalog byte-length and digest checks still establish integrity.
Do not substitute an unbounded downloader and assume
the metadata check limits its memory. The adapter validates exact stable object
keys, byte lengths, SHA-256 content addresses, and strict UTF-8 note decoding;
leading BOM content is preserved.

## Authentication, transactions and limits

`pg` invokes an asynchronous password callback for each physical connection.
The callback creates a fresh Vercel OIDC AWS credential provider and DSQL signer;
it does not persist or print tokens. Token generation has a deadline. TLS
certificate verification is required; the configured SQL user cannot be
`admin`. Pools allow one or two connections, lifetime at most 3,000 seconds,
connection timeout at most 30 seconds, and query/idle timeout at most 60 seconds.
These are per-pool bounds: operators must also respect the aggregate worker cap.

The publication limit cannot exceed 500 entries. This bounds a transaction's
entry/object/receipt/sequence mutations below DSQL's 3,000-row limit; it is not a
claim that every future payload or workload is supported. Metadata path/type
limits bound parameter payload size. Object bytes are outside the SQL transaction.

A read transaction checks receipt/base before uploads; the write transaction
rechecks them afterward. An identical replay returns its receipt before testing
the stale base. Reusing an id for changed content is refused. `40001`/`23505`
cause bounded fresh-transaction retry. A failed connection is discarded. Retry
exhaustion returns `store-failed`, with a distinct metric rather than a new
portable status.

Restore SQL bounds row count and text projections before results enter Node.
Paths, duplicate identities, recorded lengths and aggregate bytes are checked
before object reads. Notes and assets both pass digest verification. Runtime
schema separation, integrity checks and bounded reads are not a defense against
an independently privileged writer changing the shared cluster or store.

## Metrics and spending

Database metrics include SQL statements, transactions, retries/exhaustions,
failures, auth/pool failures, tokens generated and restored bytes. Private Blob
metrics separately report logical calls, reserved attempts, actual uploaded/read
bytes, reserved upload bytes and failures. They contain no note content or tokens.
Encoding and missing-length metrics are response counts, not recorded header values.

The pinned Blob SDK permits up to ten retries. The wrapper conservatively
reserves eleven attempts per logical call and eleven times upload bytes. A
reservation is neither evidence those attempts occurred nor a billing charge.
Listings, deletes, setup/admin operations, deployment compute and separate
processes must also be included in the operator's total budget. Per-instance
counters reset with the process and are not a durable global spending ledger.
Estimate against current published rates, stop before approved thresholds, and
never infer zero spend from missing billing data.

## Reproducible local proof

```sh
# Explicit local PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD already configured:
node scripts/run-node-dsql-proof.mjs

# Or select an existing, stopped disposable Podman container explicitly:
GEODE_PROOF_CONTAINER=synthetic-postgres node scripts/run-node-dsql-proof.mjs
```

The runner only accepts loopback PostgreSQL, acquires
`/tmp/geode-machine-heavy-tests.lock` itself, and refuses an occupied lock. Do
not invoke it inside a separately held copy of that lock. It generates one
`geode_node_proof_*` schema, installs the four-table DDL, launches independent
publisher/restorer processes, and cleans that exact schema and temporary files
in `finally`. A selected container must be stopped at entry and is stopped on
exit. Container credentials are passed privately, never printed. Worker phases
have a 30-second timeout.

Observed locally on 2026-09-20:

- Publisher exited before a different restorer process started; both public
  wiki projections hashed to
  `09413f620c493da9d7200f3a3afca8476d2af317ff85923b13a366d51dd8b047`.
- The fixture included three notes, an attachment, leading whitespace/apostrophe
  in a path, Unicode and a BOM; restored total was 116 bytes.
- A 500-entry publication passed; 501 entries refused without additional SQL.
- A cold GET gate, exclusive filesystem create and SQL sequence barrier made
  duplicate callers converge. PostgreSQL reported `23505` and one retry.
- A real division-by-zero SQL error at receipt insertion rolled back all four
  metadata tables for that publication; one unacknowledged orphan object remained
  until owned test-directory cleanup.
- Cleanup verified the generated schema absent. The final-version proof passed
  twice; main/headless TypeScript and targeted adapter tests were green.

This is PostgreSQL evidence, not real DSQL `40001`, Vercel auth, or private Blob
consistency evidence. Those checks remain separate preview gates.

## Preview build and operator lifecycle

Preview-only build tooling is `scripts/build-cloud-preview.mjs`. Supply an
isolated output directory plus these explicit bindings:

| Input | Meaning |
|---|---|
| `PREVIEW_ENV_FILE` | Private file containing the selected existing preview attachment environment |
| `PREVIEW_PROJECT_FILE` | Existing Vercel project link file |
| `EXPECTED_TEAM_ID`, `EXPECTED_PROJECT_ID` | Independently approved exact project binding |
| `PREVIEW_BLOB_TOKEN_NAME` | Explicit private-store token variable name; no default-store fallback |
| `PREVIEW_EXPECTED_TARGET_FILE` | Previously verified endpoint/region/role/store identity binding |

Keep these files, the generated request nonce, and inventory outside published
source. Do not print the environment file. Stop if the current attachment differs
from the verified binding; never select a different cluster/store to make a test
pass. An environment pull does not establish that a local OIDC subject has the
preview deployment's trust permissions.

The builder writes an exclusive owner-only, fsynced `inventory.json` before
producing deployable files. It lists the synthetic schema, empty denial fixture,
tables, exact object keys, target identity and expiry. Private Blob writes refuse
uninventoried keys. No wildcard deletion of unrelated schemas, stores or projects
is permitted.

After an explicitly authorized build, the operator takes the output directory
and one action. It persists deployment intents before invoking Vercel and uses
the inventory's unique deployment metadata to recover an exact deployment ID:

```sh
node scripts/cloud-preview/operator.mjs "$PREVIEW_DIR" deploy
node scripts/cloud-preview/operator.mjs "$PREVIEW_DIR" recover
node scripts/cloud-preview/operator.mjs "$PREVIEW_DIR" inspect
node scripts/cloud-preview/operator.mjs "$PREVIEW_DIR" setup
node scripts/cloud-preview/operator.mjs "$PREVIEW_DIR" run
# Cleanup is mandatory even when setup/run fails. Inspect every result.
node scripts/cloud-preview/operator.mjs "$PREVIEW_DIR" cleanup
node scripts/cloud-preview/operator.mjs "$PREVIEW_DIR" cleanup # idempotency check
node scripts/cloud-preview/operator.mjs "$PREVIEW_DIR" remove
node scripts/cloud-preview/operator.mjs "$PREVIEW_DIR" recover # must report zero
```

Only one setup/run is allowed per inventory. Starting cleanup prevents further
setup/run actions. Removing the recovery endpoint requires successful cleanup
after its latest resource-write intent, on the same deployment. An uncertain
deploy must be reconciled manually; the operator refuses a second deployment
attempt even when a subsequent listing is empty, because listings can lag an
accepted request. A run interrupted while holding `operator.lock`
requires checking that the owning process has exited before clearing that exact
local lock. Do not remove another active operator's lock or reset its journal.

The operator uses the installed Vercel CLI's signed-in session/protection bypass.
Its separate nonce is passed via an owner-only temporary curl config, never a
command argument or log. This is not a public application endpoint. No production
target or promotion command is issued.

After interruption, preserve the inventory and deployment identity, inspect what
exists, rerun exact cleanup, then remove the preview. Do not use a new random
inventory to clean an old run. At most one active synthetic dataset/deployment
is permitted; the empty denial fixture is part of the same run. Maximum retention
is 24 hours, and cleanup must finish before verification is declared complete.
Expiry stops ordinary work but is not a deletion scheduler: a human/operator
must ensure cleanup even after process termination or lost connectivity.

The attached project principal may retain admin-capable IAM permissions. The
runtime chooses a scoped SQL role; synthetic cross-schema denial checks must
never query existing application/customer data. No IAM trust, existing app schema,
production alias, or existing project configuration change is part of this tool.

## Protected-preview evidence, 2026-09-20

The final run used fresh Vercel OIDC-backed credentials, the non-admin synthetic
SQL role, and authenticated private Blob reads. The publisher exited before a
different restorer process started. Both public wiki projections were 556,369
bytes and hashed to
`63b51bb2f876ea0dcb740c79417be800657f8dfd46c2b526da1c14e8919171dc`.
The restorer materialized 535,701 verified bytes.

- Identical replay, stale-base and changed-mutation refusals passed.
- Cold exclusive-upload callers converged on one receipt. A separate forced SQL
  overlap observed actual DSQL `40001` and a successful fresh-transaction retry.
- A 500-entry publication passed; 501 entries refused before database/Blob I/O.
- The scoped SQL connection received `42501` against an empty denial fixture.
  No existing application/customer table was queried.
- Injected metadata interruption returned no acknowledgement and no restorable
  publication. Corrupted bytes were refused by both independent processes.
- The first attempt failed restore. Local reproduction identified the SDK's
  encoded/absent length behavior; regression tests preceded the fix. The final
  cloud restore observed one encoded and one missing-length response and passed.
  Failed-attempt evidence is retained rather than represented as success.

Final local gates: main/headless TypeScript clean; 3,448 unit tests passed,
including 77 added tests; build and Electron E2E passed (328 tests, two existing
opt-in skips); all twelve existing local proof suites and the new two-process
Node PostgreSQL proof passed. The final provider-only correction does not enter
the desktop build graph. Independent read-only correctness/security review found
no remaining blocker. No UI changed, so visual/screenshot checks are inapplicable.

Both attempts were cleaned with a separate operator process using the durable
inventory, each twice with zero residue verified. Exact schemas, roles, IAM/SQL
mapping and Blob names were removed; both preview deployments were deleted and
their recovery listings were empty. The second attempt began only after the
first was removed. This exercises recovery from an unsuccessful run, not every
possible hard-kill point or a scheduled cleanup service.

Cumulative counters: 376 SQL statements, 1,331 conservatively reserved Blob
attempts (including administrative cleanup/listings), 1,071,492 uploaded bytes,
and 11,786,676 retry-reserved upload bytes. These stayed below the approved
operation stop thresholds. Rate-based planning stayed below the monetary stop
threshold; exact billed spend was unavailable. No merge, release, production
readiness, IAM isolation, scale claim, or billing-grade cost measurement follows
from the synthetic proof.
