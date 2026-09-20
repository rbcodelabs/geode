import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  nodeDigest,
  verifyRestoredVault,
  type CatalogLimits,
  type CatalogRestoreSource,
  type CatalogStore,
  type CommitStatus,
  type ContentAddress,
  type Digest,
  type PublishReceipt,
  type PublishResult,
  type RawRestoredEntry,
  type RawRestoredVault,
  type RestoreOptions,
  type RestoreResult,
  type ValidatedPublication,
} from "../wiki/catalog-contract";
import {
  createMemoryObjectStore,
  objectKeyFor,
  putImmutable,
  readVerified,
  type ObjectKey,
  type ObjectStore,
} from "./object-store";

/**
 * Aurora DSQL adapter for the portable catalog contract.
 *
 * A *second* reference adapter, beside `postgres-catalog-store.ts`, which is
 * unchanged. It implements the same two interfaces — `CatalogStore` and
 * `CatalogRestoreSource` — and `src/wiki/catalog-contract.ts` needed no change
 * to accommodate it. That is the premise of the whole extraction holding up
 * under a database with a materially smaller feature set, and it is worth
 * stating as a result rather than assuming as a design goal.
 *
 * ## What moved from the database into this file
 *
 * DSQL has no PL/pgSQL, so `publish_catalog()` and `restore_catalog()` have no
 * equivalent. The transaction they described is assembled here instead:
 *
 * - **Branching happens in a read transaction.** `preflight` asks three
 *   questions — is there already a receipt, what sequence is this vault at,
 *   which of these objects already exist — in one repeatable-read transaction.
 *   Every decision the PL/pgSQL function made with `IF ... THEN` is made from
 *   that answer, in TypeScript.
 * - **The write is a single non-branching statement block.** Because the
 *   preflight already decided everything, the write transaction never needs to
 *   read a row count or branch mid-flight. That matters more than it looks: it
 *   is what lets this adapter keep `postgres-catalog-store.ts`'s one-process-
 *   per-query model instead of growing an interactive session protocol, and it
 *   is what lets a proof hold the transaction open and drive it by hand.
 *
 * ## How serialization works without a lock
 *
 * The PostgreSQL schema serializes with `SELECT ... FOR UPDATE`: a publication
 * blocks until the previous one commits, then re-reads. DSQL has no blocking
 * lock waits — repeatable-read snapshots, optimistic concurrency, conflict
 * detected at COMMIT. So the `FOR UPDATE` is replaced by a uniqueness
 * constraint the racers collide on: publishing at base B inserts
 * `vault_sequence (vault_id, B + 1)`, and exactly one of two racers survives.
 *
 * The loser does not wait and does not see the winner's receipt. It gets an
 * abort. `commit` then retries it with a *fresh* snapshot, and the retry's
 * preflight sees the receipt and returns it. The outcome a caller observes is
 * the same one the PostgreSQL adapter produces; the mechanism is not, and the
 * difference is described honestly in
 * `docs/design/dsql-catalog-findings.md` rather than smoothed over here.
 *
 * ## What this adapter is not
 *
 * It is a reference adapter, exactly as its PostgreSQL sibling is: one `psql`
 * process per query, no pooling, no observability, no IAM token refresh. It
 * speaks the PostgreSQL wire protocol through `psql` and the standard libpq
 * `PG*` variables, so it adds no database client dependency and places no
 * password in a command argument. Against real DSQL those `PG*` variables carry
 * an IAM auth token as `PGPASSWORD`; generating that token is the caller's job
 * and no part of this file.
 */

/* --------------------------------------------------------------- literals */

/**
 * Single-quoted SQL literal. Duplicates quotes and nothing else, which is only
 * sufficient while `standard_conforming_strings` is on — the session prefix
 * sets it explicitly rather than inheriting a server default.
 */
export const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const RESERVED_SCHEMAS = new Set(["public", "information_schema", "sys"]);

/**
 * Schemas this adapter will create, use and drop.
 *
 * Same reasoning as the PostgreSQL adapter's version, plus `sys`: DSQL exposes
 * its own catalog views there (`sys.iam_pg_role_mappings` among them), and a
 * `DROP SCHEMA sys CASCADE` typo aimed at a disposable schema should not even
 * be expressible.
 */
export function assertOwnableSchema(schema: string): string {
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`GEODE_CATALOG: schema ${JSON.stringify(schema)} is not a plain lowercase SQL identifier`);
  }
  if (RESERVED_SCHEMAS.has(schema) || schema.startsWith("pg_")) {
    throw new Error(`GEODE_CATALOG: schema ${JSON.stringify(schema)} is not a schema this adapter may create or drop`);
  }
  return schema;
}

/* ------------------------------------------------------------ DDL splitting */

/**
 * Strip SQL comments and string literals, leaving executable structure.
 *
 * Exported because `tests/unit/dsql-catalog-schema.test.ts` uses it to grep the
 * schema for DSQL-incompatible syntax. Grepping the raw file would be worse
 * than useless: the schema's comments *name* every feature it had to remove, so
 * a naive grep for `TRIGGER` would fail on the very prose that explains why
 * there is no trigger. Stripping first means the guard reads the SQL, which is
 * the thing that has to be compatible.
 */
export function stripSqlNoise(sql: string): string {
  let out = "";
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      out += "\n";
      continue;
    }
    if (char === "'") {
      const end = sql.indexOf("'", index + 1);
      index = end === -1 ? sql.length : end;
      out += "''";
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Split a DDL file into individual statements.
 *
 * DSQL permits at most one DDL statement per transaction, so the schema file
 * cannot be executed in one go the way `postgres-catalog-schema.sql` is. The
 * split is quote- and comment-aware, which is only tractable because there are
 * no `$$`-quoted function bodies left — a direct consequence of having no
 * PL/pgSQL rather than a happy accident.
 */
export function splitSqlStatements(sql: string): readonly string[] {
  const statements: string[] = [];
  let current = "";
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
      continue;
    }
    if (char === "'") {
      const end = sql.indexOf("'", index + 1);
      const literalText = sql.slice(index, end === -1 ? sql.length : end + 1);
      current += literalText;
      index = end === -1 ? sql.length : end;
      continue;
    }
    if (char === ";") {
      if (current.trim()) statements.push(`${current.trim()};`);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(`${current.trim()};`);
  return statements;
}

/* ------------------------------------------------------------- row encoding */

/**
 * Encode one column so a row survives `psql`'s plain-text output intact.
 *
 * The restore read has to come back as parseable rows. `jsonb_build_object` is
 * how the PostgreSQL adapter does it; DSQL's guidance is to keep JSON out of
 * the database, and `jsonb` is not a type this schema uses. A plain delimiter
 * is not enough on its own, because a restore has to stay correct against rows
 * a *hostile or buggy* writer planted — a `content_type` containing a newline
 * would otherwise split one row into two and desynchronize everything after it.
 *
 * So every column is escaped server-side into a single line with no tabs, using
 * only `replace()` and `chr()` — two functions no PostgreSQL-compatible engine
 * is without. Backslash is escaped first, so the escape is unambiguous, and
 * `\0` is reserved for NULL, which the escaper itself can never emit.
 */
function encodedColumn(expression: string): string {
  const escaped =
    `replace(replace(replace(replace(${expression}, chr(92), chr(92)||chr(92)), ` +
    `chr(10), chr(92)||'n'), chr(13), chr(92)||'r'), chr(9), chr(92)||'t')`;
  return `coalesce(${escaped}, chr(92)||'0')`;
}

/** The inverse of `encodedColumn`. `\0` is NULL; nothing else can produce it. */
export function decodeColumn(value: string): string | null {
  if (value === "\\0") return null;
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") {
      out += value[index];
      continue;
    }
    index += 1;
    const code = value[index];
    out += code === "n" ? "\n" : code === "r" ? "\r" : code === "t" ? "\t" : code === "\\" ? "\\" : (code ?? "");
  }
  return out;
}

/**
 * Parse tagged psql rows without trimming their fields.
 *
 * A literal result-set sentinel is unsafe because every sentinel string is
 * also legal note-path text. Prefixing every row with a one-column tag keeps
 * all result sets in one repeatable-read transaction while making the framing
 * independent of user-controlled values. Encoded columns contain no literal
 * tabs or newlines, so the first tab is an unambiguous boundary.
 */
export function parseDsqlRows(raw: string): ReadonlyMap<string, readonly string[][]> {
  const rows = new Map<string, string[][]>();
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const [tag = "", ...fields] = line.split("\t");
    if (!tag) continue;
    const tagged = rows.get(tag) ?? [];
    tagged.push(fields);
    rows.set(tag, tagged);
  }
  return rows;
}

/* ----------------------------------------------------------- classification */

/**
 * SQLSTATEs that mean "this attempt lost a race; a fresh snapshot may win".
 *
 * `40001` is the serialization failure a repeatable-read snapshot raises when
 * its write conflicts with a committed one — the shape DSQL uses for optimistic
 * concurrency conflicts, and the shape local PostgreSQL produces under
 * `REPEATABLE READ`. `23505` is a unique violation, which is how two racers
 * colliding on `vault_sequence`, `object` or `receipt` lose. `40P01` is
 * deadlock, which DSQL should not produce but a local emulation can.
 *
 * `23505` being retryable is the non-obvious one and it is deliberate: the
 * adapter cannot tell from the error alone whether it collided with a
 * concurrent duplicate (retry, and the receipt will be there) or raced a
 * genuinely stale base (retry, and the preflight will say `conflict`). Both
 * resolve on the next preflight, and both resolve *terminally* — a stale base
 * does not retry a second time, because the preflight returns `conflict`
 * without attempting another write.
 */
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01", "23505", "OC000", "OC001"]);

export function sqlStateOf(message: string): string | null {
  return /ERROR:\s+([0-9A-Z]{5}):/.exec(message)?.[1] ?? null;
}

export function isRetryable(message: string): boolean {
  const state = sqlStateOf(message);
  if (state !== null) return RETRYABLE_SQLSTATES.has(state);
  // A server that did not report a SQLSTATE at all. Match the wire text rather
  // than assume: a missed retry here turns a recoverable race into a spurious
  // refusal, which is the failure mode this whole loop exists to prevent.
  return /could not serialize|deadlock detected|duplicate key value|concurrent update/i.test(message);
}

/** Map a terminal failure onto a named contract status. */
export function classifyFailure(message: string): CommitStatus {
  const marker = /GEODE_CATALOG:([A-Z_]+)/.exec(message);
  if (marker?.[1] === "CONFLICT") return "conflict";
  if (marker?.[1] === "MUTATION_ID_REUSED") return "mutation-id-reused";
  if (marker?.[1] === "DUPLICATE_WITH_MISMATCHED_BYTES") return "duplicate-with-mismatched-bytes";
  return "store-failed";
}

/* ------------------------------------------------------------------ options */

export interface DsqlCatalogOptions {
  /** A caller-owned schema. The adapter creates and drops exactly this one. */
  schema: string;
  psql?: string;
  env?: NodeJS.ProcessEnv;
  statementTimeout?: string;
  /**
   * Where object bytes live. Defaults to an in-memory store, which is useful
   * for a unit test and useless for anything durable — a caller that means to
   * publish must supply one. Phase B supplies a Vercel Blob implementation of
   * this same interface; nothing else in this file changes.
   */
  objects?: ObjectStore;
  digest?: Digest;
  /**
   * How many times a publication may be re-attempted after a retryable
   * conflict. One means "no retry", which is not a sensible production value
   * and is exactly what a proof needs in order to show what the retry is
   * actually buying.
   */
  maxAttempts?: number;
  /** Base backoff in milliseconds. Jittered, per DSQL's thundering-herd guidance. */
  retryBackoffMs?: number;
  schemaDirectory?: string;
  /** Optional wire driver for runtimes without psql. Must execute the whole
   * block on one connection and return unaligned rows, retaining SQLSTATEs in
   * failures as `ERROR: <code>:` for the shared retry classifier. It must
   * verify standard_conforming_strings is on before executing literals;
   * DSQL does not permit setting that parameter. The driver must also enforce
   * its own query timeout: DSQL rejects SET statement_timeout. */
  executeSql?: (sql: string) => Promise<string>;
}

/**
 * Publication limits for DSQL.
 *
 * Tighter than `DEFAULT_CATALOG_LIMITS`, and tightened for a measured reason
 * rather than caution. A publication's write transaction modifies at most
 * `entries` deletes + `entries` inserts + `entries` object rows + one sequence
 * row + one receipt row. DSQL holds a transaction to 3,000 modified rows, so
 * the contract's default of 1,000 entries could reach 3,002 and fail. At 500 it
 * reaches 1,502.
 *
 * `maxPublicationBytes` stays generous because bytes no longer travel through
 * the database at all — they go to the object store before the transaction
 * opens, so the 10 MiB write-transaction ceiling does not see them.
 *
 * This is a `CatalogLimits` value, passed to `validatePublication` by a caller.
 * It required no change to the contract: per-deployment limits are what the
 * `limits` option has always been for.
 */
export const DSQL_CATALOG_LIMITS: Readonly<CatalogLimits> = Object.freeze({
  maxNoteBytes: 2 * 1024 * 1024,
  maxAssetBytes: 16 * 1024 * 1024,
  maxPublicationBytes: 64 * 1024 * 1024,
  maxPublicationEntries: 500,
  allowedContentTypes: Object.freeze([
    "text/markdown", "image/png", "image/jpeg", "image/gif", "image/webp",
    "image/svg+xml", "application/pdf", "application/octet-stream",
  ]),
});

export type DsqlObjectRestoreResult =
  | { readonly status: "ok"; readonly bytes: Uint8Array }
  | { readonly status: "missing-object" | "invalid-content-address" | "store-failed" };

/** Read through the verified object boundary and preserve the failure cause. */
export async function readObjectForRestore(
  store: ObjectStore,
  key: ObjectKey,
  contentAddress: ContentAddress,
  digest: Digest = nodeDigest,
): Promise<DsqlObjectRestoreResult> {
  const result = await readVerified(store, key, contentAddress, digest);
  if (result.status === "ok") return result;
  if (result.status === "absent") return { status: "missing-object" };
  if (result.status === "address-mismatch") return { status: "invalid-content-address" };
  return { status: "store-failed" };
}

class DsqlObjectRestoreError extends Error {
  constructor(
    readonly status: "missing-object" | "invalid-content-address" | "store-failed",
    readonly path: string,
    readonly contentAddress: ContentAddress,
  ) {
    super(`GEODE_CATALOG:${status}`);
  }
}

/** Notes are content-addressed too under this adapter; this is the type they carry. */
const NOTE_CONTENT_TYPE = "text/markdown";

/** One object a publication needs in the store: note bytes and asset bytes alike. */
interface PublishedObject {
  readonly contentAddress: ContentAddress;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/** One path the publication claims, and the object it points at. */
interface PublishedEntry {
  readonly path: string;
  readonly kind: "note" | "attachment";
  readonly contentAddress: ContentAddress;
  readonly contentType: string;
}

/** What a preflight read learned. Every branch the PL/pgSQL function took is decided from this. */
export interface Preflight {
  readonly receipt: { readonly digest: string; readonly receipt: string } | null;
  readonly currentSequence: number;
  /** Object rows already recorded for this vault, by content address. */
  readonly existingObjects: ReadonlyMap<ContentAddress, { readonly byteLength: number; readonly objectKey: ObjectKey }>;
}

export interface DsqlCatalog {
  readonly schema: string;
  readonly objects: ObjectStore;
  readonly store: CatalogStore;
  restoreSource(options?: RestoreOptions): CatalogRestoreSource;
  readVault(vaultId: string): Promise<RawRestoredVault | null>;
  query(sql: string): Promise<string>;
  openSession(applicationName?: string): DsqlSession;
  preflight(publication: ValidatedPublication): Promise<Preflight>;
  /**
   * The statement block a publication commits, without `BEGIN`/`COMMIT`.
   *
   * Exposed for the same reason `publishSql` is on the PostgreSQL adapter: a
   * concurrency proof has to be able to hold the transaction open and release
   * it on its own schedule. Everything it needs to know was decided by
   * `preflight`, so this block never branches.
   */
  publishSql(publication: ValidatedPublication, preflight: Preflight): string;
  /** Upload every object a publication needs, before any catalog row references one. */
  uploadObjects(publication: ValidatedPublication): Promise<{ readonly status: "ok" } | { readonly status: CommitStatus }>;
  install(): Promise<void>;
  drop(): Promise<void>;
  close(): void;
}

export interface DsqlSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly done: Promise<string>;
  output(): string;
}

/* ------------------------------------------------------------------ adapter */

export function createDsqlCatalog(options: DsqlCatalogOptions): DsqlCatalog {
  const psql = options.psql ?? process.env.PSQL ?? "psql";
  const schema = assertOwnableSchema(options.schema);
  const objects = options.objects ?? createMemoryObjectStore();
  const digest = options.digest ?? nodeDigest;
  const maxAttempts = options.maxAttempts ?? 5;
  const backoffMs = options.retryBackoffMs ?? 10;
  const live = new Set<ChildProcessWithoutNullStreams>();

  // `VERBOSITY verbose` is what puts the SQLSTATE on the error line, which is
  // what `isRetryable` matches. Without it psql prints only the message text,
  // and the retry classifier falls back to string matching.
  const prefix =
    "\\set VERBOSITY verbose\n" +
    `SET search_path TO ${schema}; ` +
    "SET standard_conforming_strings = on; " +
    `SET statement_timeout = '${options.statementTimeout ?? "10s"}';\n`;

  function openSession(applicationName = `${schema}_query`): DsqlSession {
    const child = spawn(psql, ["-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1"], {
      env: { ...(options.env ?? process.env), PGAPPNAME: applicationName },
      stdio: ["pipe", "pipe", "pipe"],
    });
    live.add(child);
    // Decode across chunk boundaries, not per Buffer — see the same call and
    // the same reasoning in `postgres-catalog-store.ts`. Note text now travels
    // through this pipe on the way out, so a per-chunk decode would corrupt a
    // multi-byte character straddling a 64 KiB boundary.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const done = new Promise<string>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        live.delete(child);
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`psql exited ${code}: ${stderr.trim()}`));
      });
    });
    done.catch(() => { /* observed by whoever asked for it, if anyone */ });
    return { child, done, output: () => stdout };
  }

  async function query(sql: string): Promise<string> {
    if (options.executeSql) {
      return options.executeSql(`SET search_path TO ${schema};\n` + sql);
    }
    const current = openSession();
    current.child.stdin.end(prefix + sql);
    return current.done;
  }

  /* ------------------------------------------------------- publication shape */

  /**
   * Flatten a publication into the objects it needs and the paths it claims.
   *
   * Notes become objects here. Their content address is the SHA-256 of their
   * UTF-8 bytes, computed through the injectable `Digest` seam rather than
   * inline, so a caller that substituted a digest for the contract gets the
   * same substitution here.
   */
  function shapeOf(publication: ValidatedPublication): {
    objects: readonly PublishedObject[];
    entries: readonly PublishedEntry[];
  } {
    const utf8 = new TextEncoder();
    const byAddress = new Map<ContentAddress, PublishedObject>();
    const entries: PublishedEntry[] = [];
    for (const note of publication.notes) {
      const bytes = utf8.encode(note.text);
      const contentAddress = digest.sha256Hex(bytes);
      if (!byAddress.has(contentAddress)) {
        byAddress.set(contentAddress, { contentAddress, contentType: NOTE_CONTENT_TYPE, bytes });
      }
      entries.push({ path: note.path, kind: "note", contentAddress, contentType: NOTE_CONTENT_TYPE });
    }
    for (const asset of publication.assets) {
      if (!byAddress.has(asset.contentAddress)) {
        byAddress.set(asset.contentAddress, {
          contentAddress: asset.contentAddress, contentType: asset.contentType, bytes: asset.bytes,
        });
      }
      entries.push({
        path: asset.path, kind: "attachment",
        contentAddress: asset.contentAddress, contentType: asset.contentType,
      });
    }
    return { objects: [...byAddress.values()], entries };
  }

  /* ------------------------------------------------------------- preflight */

  /**
   * One repeatable-read read transaction answering every question the write
   * needs, so the write itself never has to branch.
   *
   * Three statements with `\echo` sentinels between them: psql runs them in
   * order and the whole stdout is parsed at the end, so this needs no
   * interactive protocol.
   */
  async function preflight(publication: ValidatedPublication): Promise<Preflight> {
    const { objects: needed } = shapeOf(publication);
    const addresses = needed.map((object) => literal(object.contentAddress)).join(", ");
    const raw = await query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ;\n" +
      `SELECT 'R'||chr(9)||${encodedColumn("digest")}||chr(9)||${encodedColumn("receipt")} FROM receipt ` +
      `WHERE vault_id = ${literal(publication.vaultId)} AND mutation_id = ${literal(publication.mutationId)};\n` +
      `SELECT 'S'||chr(9)||cast(coalesce(max(sequence), 0) as text) FROM vault_sequence ` +
      `WHERE vault_id = ${literal(publication.vaultId)};\n` +
      (addresses
        ? `SELECT 'O'||chr(9)||content_address||chr(9)||byte_length||chr(9)||${encodedColumn("object_key")} FROM object ` +
          `WHERE vault_id = ${literal(publication.vaultId)} AND content_address IN (${addresses});\n`
        : "SELECT 'O' WHERE false;\n") +
      "COMMIT;\n",
    );
    const rows = parseDsqlRows(raw);

    const receiptLine = rows.get("R")?.[0];
    let receipt: Preflight["receipt"] = null;
    if (receiptLine) {
      const [storedDigest, storedReceipt] = receiptLine;
      receipt = { digest: decodeColumn(storedDigest ?? "") ?? "", receipt: decodeColumn(storedReceipt ?? "") ?? "" };
    }

    const existingObjects = new Map<ContentAddress, { byteLength: number; objectKey: ObjectKey }>();
    for (const row of rows.get("O") ?? []) {
      const [address, byteLength, objectKey] = row;
      if (!address) continue;
      existingObjects.set(address, {
        byteLength: Number(byteLength),
        objectKey: decodeColumn(objectKey ?? "") ?? "",
      });
    }

    return { receipt, currentSequence: Number(rows.get("S")?.[0]?.[0] ?? "0"), existingObjects };
  }

  /* --------------------------------------------------------------- uploads */

  /**
   * Put every object the publication needs into the object store, **before**
   * the transaction that references them opens.
   *
   * This ordering is the entire replacement for the composite foreign key from
   * `catalog_entry` to `object`. Bytes exist first, so a committed catalog
   * entry always has bytes behind it. If the transaction then fails, the
   * uploads are orphans — wasted storage, and never a dangling reference. The
   * asymmetry is deliberate: the other order would trade wasted storage for a
   * catalog that points at nothing, which is the failure the foreign key used
   * to make impossible.
   */
  async function uploadObjects(publication: ValidatedPublication): Promise<{ status: "ok" } | { status: CommitStatus }> {
    const { objects: needed } = shapeOf(publication);
    for (const object of needed) {
      const key = objectKeyFor(publication.vaultId, object.contentAddress);
      const put = await putImmutable(objects, key, object.bytes, object.contentType, object.contentAddress, digest);
      if (put.status !== "ok") return { status: put.status };
    }
    return { status: "ok" };
  }

  /* ----------------------------------------------------------- publish SQL */

  function receiptFor(publication: ValidatedPublication): PublishReceipt {
    return {
      vaultId: publication.vaultId,
      mutationId: publication.mutationId,
      // Known without reading anything back: the publication claims exactly
      // `base + 1`, and the uniqueness constraint on `vault_sequence` is what
      // guarantees it either gets that slot or gets nothing.
      sequence: publication.baseSequence + 1,
      digest: publication.digest,
      noteCount: publication.notes.length,
      assetCount: publication.assets.length,
    };
  }

  function publishSql(publication: ValidatedPublication, pre: Preflight): string {
    const { objects: needed, entries } = shapeOf(publication);
    const vault = literal(publication.vaultId);
    const sequence = publication.baseSequence + 1;
    const statements: string[] = [];

    // 1. Claim the sequence slot. A duplicate racer collides on this primary
    //    key; a stale base collides with whoever already took the slot. Either
    //    way the transaction aborts and nothing below it lands.
    statements.push(
      `INSERT INTO vault_sequence (vault_id, sequence, mutation_id) VALUES (` +
      `${vault}, ${sequence}, ${literal(publication.mutationId)});`,
    );

    // 2. Object metadata, for the objects not already recorded. Bytes are
    //    already in the object store by the time this runs.
    const missing = needed.filter((object) => !pre.existingObjects.has(object.contentAddress));
    if (missing.length) {
      statements.push(
        "INSERT INTO object (vault_id, content_address, content_type, byte_length, object_key) VALUES " +
        missing.map((object) =>
          `(${vault}, ${literal(object.contentAddress)}, ${literal(object.contentType)}, ` +
          `${object.bytes.byteLength}, ${literal(objectKeyFor(publication.vaultId, object.contentAddress))})`,
        ).join(", ") + ";",
      );
    }

    // 3. Replace the claimed paths. DELETE-then-INSERT rather than
    //    `ON CONFLICT DO UPDATE`: this adapter depends on no upsert semantics
    //    it has not observed, and a DELETE of an absent row modifies nothing,
    //    so the unconditional delete costs no rows against the 3,000 ceiling.
    //    DELETE is also the only truncation DSQL supports at all.
    if (entries.length) {
      statements.push(
        `DELETE FROM catalog_entry WHERE vault_id = ${vault} AND path IN (` +
        entries.map((entry) => literal(entry.path)).join(", ") + ");",
      );
      statements.push(
        "INSERT INTO catalog_entry (vault_id, path, kind, content_address, content_type, sequence) VALUES " +
        entries.map((entry) =>
          `(${vault}, ${literal(entry.path)}, ${literal(entry.kind)}, ` +
          `${literal(entry.contentAddress)}, ${literal(entry.contentType)}, ${sequence})`,
        ).join(", ") + ";",
      );
    }

    // 4. The receipt, last. Its primary key is the second place a concurrent
    //    duplicate loses, and the only place one with a *changed* payload does.
    statements.push(
      "INSERT INTO receipt (vault_id, mutation_id, digest, receipt) VALUES (" +
      `${vault}, ${literal(publication.mutationId)}, ${literal(publication.digest)}, ` +
      `${literal(JSON.stringify(receiptFor(publication)))});`,
    );
    return statements.join("\n") + "\n";
  }

  /* ------------------------------------------------------------- the store */

  const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

  const store: CatalogStore = {
    async commit(publication): Promise<PublishResult> {
      const entryCount = publication.notes.length + publication.assets.length;
      if (entryCount > DSQL_CATALOG_LIMITS.maxPublicationEntries) {
        // `ValidatedPublication` proves the caller used *some* limits, not that
        // it used this adapter's 3,000-row-derived ceiling. Refuse before I/O
        // rather than constructing a transaction DSQL is guaranteed to reject.
        return {
          status: "entry-limit",
          observed: entryCount,
          allowed: DSQL_CATALOG_LIMITS.maxPublicationEntries,
        };
      }
      let lastFailure = "";
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let pre: Preflight;
        try {
          pre = await preflight(publication);
        } catch (error) {
          return { status: classifyFailure(error instanceof Error ? error.message : String(error)) };
        }

        // Every branch the PL/pgSQL function took, taken here instead, and in
        // the same order: receipt before base, so an idempotent replay is never
        // refused for a base that the original publication already advanced
        // past.
        if (pre.receipt) {
          if (pre.receipt.digest !== publication.digest) return { status: "mutation-id-reused" };
          try {
            const stored = JSON.parse(pre.receipt.receipt) as PublishReceipt;
            return {
              status: "ok",
              receipt: {
                vaultId: stored.vaultId, mutationId: stored.mutationId,
                sequence: Number(stored.sequence), digest: stored.digest,
                noteCount: Number(stored.noteCount), assetCount: Number(stored.assetCount),
              },
            };
          } catch {
            return { status: "store-failed" };
          }
        }
        if (pre.currentSequence !== publication.baseSequence) return { status: "conflict" };

        // An address already recorded with a different length means one content
        // address has come to describe two byte strings. The PostgreSQL schema
        // catches this by comparing stored bytes inside the transaction; there
        // are no stored bytes here, so the recorded length is what contradicts.
        // The object store's own `putImmutable` catches the byte-level case.
        const { objects: needed } = shapeOf(publication);
        const contradiction = needed.find((object) => {
          const existing = pre.existingObjects.get(object.contentAddress);
          return existing !== undefined && existing.byteLength !== object.bytes.byteLength;
        });
        if (contradiction) return { status: "duplicate-with-mismatched-bytes" };

        const uploaded = await uploadObjects(publication);
        if (uploaded.status !== "ok") return { status: uploaded.status };

        try {
          await query("BEGIN ISOLATION LEVEL REPEATABLE READ;\n" + publishSql(publication, pre) + "COMMIT;\n");
          return { status: "ok", receipt: receiptFor(publication) };
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : String(error);
          if (!isRetryable(lastFailure) || attempt === maxAttempts) return { status: classifyFailure(lastFailure) };
          // Jittered backoff: DSQL's guidance is explicit that a retry storm
          // against a hot key is its own problem.
          await sleep(Math.round(backoffMs * attempt * (0.5 + Math.random())));
        }
      }
      // Every attempt lost a race and none resolved into a named outcome. This
      // is a failure mode the lock-waiting design does not have: there, a
      // waiter blocks until it can decide. `store-failed` is the honest status
      // — the store refused for a reason this contract does not name — and the
      // findings doc records that a caller can no longer distinguish it from an
      // unreachable database.
      return { status: classifyFailure(lastFailure) };
    },
  };

  /* ------------------------------------------------------------- the reader */

  async function readVault(vaultId: string): Promise<RawRestoredVault | null> {
    const raw = await query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ;\n" +
      `SELECT 'S'||chr(9)||cast(coalesce(max(sequence), 0) as text) FROM vault_sequence ` +
      `WHERE vault_id = ${literal(vaultId)};\n` +
      `SELECT 'E'||chr(9)||${encodedColumn("e.path")}||chr(9)||${encodedColumn("e.kind")}||chr(9)||` +
      `${encodedColumn("e.content_address")}||chr(9)||${encodedColumn("e.content_type")}||chr(9)||` +
      `${encodedColumn("cast(o.byte_length as text)")}||chr(9)||${encodedColumn("o.object_key")} ` +
      // LEFT JOIN on purpose, exactly as the PostgreSQL schema does: a catalog
      // entry whose object row is gone must come back as an entry with no
      // bytes, so the contract can refuse it by name rather than have it
      // silently vanish from the result set.
      `FROM catalog_entry e LEFT JOIN object o ON o.vault_id = e.vault_id ` +
      `AND o.content_address = e.content_address WHERE e.vault_id = ${literal(vaultId)} ORDER BY e.path;\n` +
      "COMMIT;\n",
    );
    const rows = parseDsqlRows(raw);
    const sequence = Number(rows.get("S")?.[0]?.[0] ?? "0");
    const entryRows = rows.get("E") ?? [];
    // No sequence and no entries: this vault was never published.
    if (sequence === 0 && !entryRows.length) return null;

    const entries: RawRestoredEntry[] = [];
    for (const row of entryRows) {
      const [path, kind, contentAddress, contentType, byteLength, objectKey] = row;
      const address = decodeColumn(contentAddress ?? "");
      const key = decodeColumn(objectKey ?? "");
      const recordedLength = decodeColumn(byteLength ?? "");
      let bytes: Uint8Array | null = null;
      if (address !== null && key !== null) {
        const restored = await readObjectForRestore(objects, key, address, digest);
        if (restored.status !== "ok") {
          throw new DsqlObjectRestoreError(
            restored.status,
            decodeColumn(path ?? "") ?? "",
            address,
          );
        }
        bytes = restored.bytes;
      }
      entries.push({
        path: decodeColumn(path ?? "") ?? "",
        kind: decodeColumn(kind ?? "") ?? "",
        // Notes arrive as bytes here and become text in `hydrateNotes`, after
        // their content address has been checked. A raw read does not decide.
        text: null,
        contentAddress: address,
        contentType: decodeColumn(contentType ?? ""),
        byteLength: recordedLength === null ? null : Number(recordedLength),
        bytes,
      });
    }
    return { vaultId, sequence, entries };
  }

  /**
   * Turn note objects back into note text, verifying the address first.
   *
   * This exists because of a gap in the portable contract that is nobody's
   * mistake: `CatalogNote` carries `text`, not a content address, so
   * `verifyRestoredVault` has nothing to recompute for a note. Under the
   * PostgreSQL adapter that costs nothing — note text lives in a column and
   * never leaves the database. Under this one, note bytes make a round trip
   * through a separate object store, and no part of the contract can tell
   * whether they came back intact.
   *
   * So the adapter checks, and reports the failure using the contract's
   * *existing* vocabulary rather than inventing a status: a note whose bytes do
   * not hash to their recorded address is `invalid-content-address`, and one
   * whose object the store cannot produce is `missing-object` — the same two
   * names the contract itself would use for an attachment in the same state.
   * That is what keeps a reader from having to learn which adapter produced a
   * refusal in order to understand it.
   *
   * Attachments pass through untouched, because the contract *can* check those
   * and does.
   */
  function hydrateNotes(raw: RawRestoredVault):
    | { readonly ok: true; readonly vault: RawRestoredVault }
    | { readonly ok: false; readonly refusal: RestoreResult } {
    const entries: RawRestoredEntry[] = [];
    for (const entry of raw.entries) {
      if (entry.kind !== "note") {
        entries.push(entry);
        continue;
      }
      if (typeof entry.contentAddress !== "string") {
        entries.push(entry);
        continue;
      }
      if (!(entry.bytes instanceof Uint8Array)) {
        return { ok: false, refusal: { status: "missing-object", path: entry.path, contentAddress: entry.contentAddress } };
      }
      if (digest.sha256Hex(entry.bytes) !== entry.contentAddress) {
        return { ok: false, refusal: { status: "invalid-content-address", path: entry.path, contentAddress: entry.contentAddress } };
      }
      // Strict decode: invalid UTF-8 must not become a string full of U+FFFD,
      // which is corruption nothing downstream could see. A note that cannot be
      // decoded has no text, which the contract refuses as `incomplete-entry`.
      const text = decodeUtf8(entry.bytes);
      entries.push({ ...entry, text, bytes: null });
    }
    return { ok: true, vault: { ...raw, entries } };
  }

  function restoreSource(restoreOptions: RestoreOptions = {}): CatalogRestoreSource {
    return {
      async restore(vaultId): Promise<RestoreResult> {
        let raw: RawRestoredVault | null;
        try {
          raw = await readVault(vaultId);
        } catch (error) {
          if (error instanceof DsqlObjectRestoreError) {
            return {
              status: error.status,
              ...(error.status === "store-failed"
                ? {}
                : { path: error.path, contentAddress: error.contentAddress }),
            };
          }
          return { status: "store-failed" };
        }
        if (!raw) return { status: "absent" };
        const hydrated = hydrateNotes(raw);
        if (!hydrated.ok) return hydrated.refusal;
        // The adapter does I/O; the portable contract decides. Unchanged from
        // the PostgreSQL adapter, and deliberately so — a second adapter must
        // not invent its own refusal vocabulary.
        return verifyRestoredVault(hydrated.vault, restoreOptions);
      },
    };
  }

  return {
    schema,
    objects,
    store,
    restoreSource,
    readVault,
    query,
    openSession,
    preflight,
    publishSql,
    uploadObjects,
    async install() {
      const directory = options.schemaDirectory ?? fileURLToPath(new URL(".", import.meta.url));
      const ddl = await readFile(join(directory, "dsql-catalog-schema.sql"), "utf8");
      await query(`CREATE SCHEMA ${schema};`);
      // One DDL statement per transaction. DSQL requires it; issuing them
      // separately against conventional PostgreSQL is merely harmless, which is
      // what makes this installer usable against both.
      for (const statement of splitSqlStatements(ddl)) await query(statement);
    },
    async drop() {
      await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
    },
    close() {
      for (const child of live) child.kill("SIGTERM");
    },
  };
}

/** Strict UTF-8 decode. Returns null rather than substituting U+FFFD for invalid bytes. */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
