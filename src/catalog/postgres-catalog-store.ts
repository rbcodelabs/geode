import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyRestoredVault,
  type CatalogRestoreSource,
  type CatalogStore,
  type CommitStatus,
  type PublishReceipt,
  type PublishResult,
  type RawRestoredEntry,
  type RawRestoredVault,
  type RestoreOptions,
  type RestoreResult,
  type ValidatedPublication,
} from "../wiki/catalog-contract";

/**
 * Reference PostgreSQL adapter for the portable catalog contract.
 *
 * This module is the *only* place in the build that knows a database exists.
 * It lives outside `src/wiki/` on purpose: the portable engine never imports
 * it, and `scripts/run-catalog-contract-proof.mjs` audits esbuild's complete
 * input graph to prove that rather than assert it.
 *
 * It speaks to PostgreSQL through `psql` and standard `PG*` libpq environment
 * variables, exactly as the Phase 0 fixture did, so no database client
 * dependency is added to the project and no password is ever placed in a
 * command argument. Credentials come from ordinary libpq configuration.
 *
 * It is a reference adapter, not a production client: one process per query,
 * no pooling, no retry policy, no observability. Its job is to make the
 * contract's transactional claims checkable.
 */

export interface PostgresCatalogOptions {
  /** A caller-owned schema. The adapter creates and drops exactly this one. */
  schema: string;
  /** Path to the `psql` executable. */
  psql?: string;
  env?: NodeJS.ProcessEnv;
  statementTimeout?: string;
  lockTimeout?: string;
  /**
   * Directory holding `postgres-catalog-schema.sql`. Defaults to this module's
   * own directory, which is correct when running from source and wrong when
   * running from a bundle — a bundled caller must pass the repo-relative path.
   */
  schemaDirectory?: string;
}

export interface PostgresSession {
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves with trimmed stdout on a clean exit, rejects with stderr otherwise. */
  readonly done: Promise<string>;
  /** Stdout so far, for observing a session that has not exited yet. */
  output(): string;
}

/**
 * Single-quoted SQL literal.
 *
 * Only quotes need doubling *because* `standard_conforming_strings` is on —
 * with it off, a backslash in note text would escape the closing quote. That
 * used to be an unstated dependency on a server default reachable from
 * `postgresql.conf` or `PGOPTIONS`; the session prefix below now sets it
 * explicitly, so this is an enforced invariant rather than an assumption.
 */
export const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Schemas this adapter will create, use and drop.
 *
 * Unquoted interpolation into `CREATE SCHEMA` / `DROP SCHEMA ... CASCADE` needs
 * the name to be a plain lowercase identifier, and the name arrives from the
 * caller — in every current caller, from the `GEODE_CATALOG_SCHEMA` environment
 * variable. The realistic failure is not an injection but a typo:
 * `GEODE_CATALOG_SCHEMA=public` would make `drop()` run
 * `DROP SCHEMA IF EXISTS public CASCADE` against a developer's own database.
 * So the pattern is checked *and* the schemas nobody means to hand to a
 * disposable adapter are named and refused.
 */
const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const RESERVED_SCHEMAS = new Set(["public", "information_schema"]);

export function assertOwnableSchema(schema: string): string {
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`GEODE_CATALOG: schema ${JSON.stringify(schema)} is not a plain lowercase SQL identifier`);
  }
  if (RESERVED_SCHEMAS.has(schema) || schema.startsWith("pg_")) {
    throw new Error(`GEODE_CATALOG: schema ${JSON.stringify(schema)} is not a schema this adapter may create or drop`);
  }
  return schema;
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * Map a `psql` failure onto a named contract status.
 *
 * The schema raises `GEODE_CATALOG:<REASON>` rather than a bare word so this
 * match cannot be fooled by the literal text `ON CONFLICT` appearing in a
 * statement PostgreSQL happens to echo back in an error context line.
 */
const REASONS: Record<string, CommitStatus> = {
  CONFLICT: "conflict",
  MUTATION_ID_REUSED: "mutation-id-reused",
  DUPLICATE_WITH_MISMATCHED_BYTES: "duplicate-with-mismatched-bytes",
  INVALID_CONTENT_ADDRESS: "invalid-content-address",
};

export function classifyFailure(message: string): CommitStatus {
  const marker = /GEODE_CATALOG:([A-Z_]+)/.exec(message);
  // An injected failure, a constraint violation or an unreachable server all
  // land here. `store-failed` says "the store refused and did not name a
  // reason this contract knows" — it is never used to paper over one that did.
  return (marker && REASONS[marker[1]]) ?? "store-failed";
}

export interface PostgresCatalog {
  readonly schema: string;
  /** The contract surface. Hand this to `publish()`; nothing else should reach the adapter. */
  readonly store: CatalogStore;
  /**
   * The read surface. Hand this to `restore()`.
   *
   * A factory rather than a property because the verification limits are a
   * per-call policy, not a property of the connection — a caller restoring
   * under tighter ceilings should not have to build a second adapter.
   */
  restoreSource(options?: RestoreOptions): CatalogRestoreSource;
  /**
   * The raw, unverified read. Exposed so a proof can observe what the store
   * actually returned *before* the contract refused it; ordinary callers want
   * `restoreSource`, which verifies.
   */
  readVault(vaultId: string): Promise<RawRestoredVault | null>;
  /** Run SQL in a fresh session against the adapter's schema. */
  query(sql: string): Promise<string>;
  /** Start a session the caller drives, e.g. to hold a transaction open. */
  openSession(applicationName?: string): PostgresSession;
  /**
   * The exact `publish_catalog(...)` call for a publication, for callers
   * driving their own session. `failBeforeReceipt` dies in the window after
   * the entries are written and before the receipt exists.
   */
  publishSql(publication: ValidatedPublication, options?: { fail?: boolean; failBeforeReceipt?: boolean }): string;
  install(): Promise<void>;
  /** Drop exactly this adapter's schema. Safe to call when `install` never ran. */
  drop(): Promise<void>;
  /** Terminate any sessions still running. */
  close(): void;
}

export function createPostgresCatalog(options: PostgresCatalogOptions): PostgresCatalog {
  const psql = options.psql ?? process.env.PSQL ?? "psql";
  // Refused at construction, before any statement is built — the same
  // "decide it without a database" discipline the portable contract applies to
  // a publication.
  const schema = assertOwnableSchema(options.schema);
  const prefix =
    `SET search_path TO ${schema}; ` +
    // Not a default to rely on: `literal()` doubles quotes and nothing else,
    // which is only sufficient while this is on. Note text is fully
    // caller-controlled and flows through `literal()`.
    `SET standard_conforming_strings = on; ` +
    `SET statement_timeout = '${options.statementTimeout ?? "10s"}'; ` +
    `SET lock_timeout = '${options.lockTimeout ?? "8s"}';\n`;
  const live = new Set<ChildProcessWithoutNullStreams>();

  function openSession(applicationName = `${schema}_query`): PostgresSession {
    const child = spawn(psql, ["-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1"], {
      env: { ...(options.env ?? process.env), PGAPPNAME: applicationName },
      stdio: ["pipe", "pipe", "pipe"],
    });
    live.add(child);
    // `setEncoding` before the first `data` listener, not `String(chunk)` after
    // it. A pipe delivers 64 KiB chunks at arbitrary byte offsets, so a
    // multi-byte character routinely straddles a chunk boundary; decoding each
    // Buffer independently turns exactly that character into U+FFFD. Nothing
    // downstream would catch it — every JSON structural character is ASCII, so
    // the mangled payload still parses, and notes carry no content address for
    // `verifyRestoredVault` to check. The decoder these calls install holds the
    // partial sequence across the boundary and emits it whole.
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
    // A caller may legitimately never await a losing concurrent session.
    done.catch(() => { /* observed by whoever asked for it, if anyone */ });
    return { child, done, output: () => stdout };
  }

  async function query(sql: string): Promise<string> {
    const current = openSession();
    current.child.stdin.end(prefix + sql);
    return current.done;
  }

  function publishSql(publication: ValidatedPublication, { fail = false, failBeforeReceipt = false } = {}): string {
    const notes = publication.notes.map((note) => ({ path: note.path, text: note.text }));
    // Bytes travel as hex and are decoded server-side, which keeps binary
    // content out of the JSON payload and out of any shell quoting question.
    const assets = publication.assets.map((asset) => ({
      path: asset.path,
      contentAddress: asset.contentAddress,
      contentType: asset.contentType,
      hex: hex(asset.bytes),
    }));
    // The eighth argument is emitted only when it is set, so the ordinary call
    // this generates stays byte-identical to the one before the injection
    // point existed, and the schema default carries the common case.
    const before = failBeforeReceipt ? ", true" : "";
    return `SELECT publish_catalog(${literal(publication.vaultId)}, ${literal(publication.mutationId)}, ` +
      `${literal(publication.digest)}, ${publication.baseSequence}, ` +
      `${literal(JSON.stringify(notes))}::jsonb, ${literal(JSON.stringify(assets))}::jsonb, ${fail}${before});\n`;
  }

  const store: CatalogStore = {
    async commit(publication) {
      let raw: string;
      try {
        raw = await query(publishSql(publication));
      } catch (error) {
        return { status: classifyFailure(error instanceof Error ? error.message : String(error)) };
      }
      let parsed: PublishReceipt & { sequence: number };
      try {
        parsed = JSON.parse(raw) as PublishReceipt & { sequence: number };
      } catch {
        return { status: "store-failed" };
      }
      return {
        status: "ok",
        receipt: {
          vaultId: parsed.vaultId,
          mutationId: parsed.mutationId,
          sequence: Number(parsed.sequence),
          digest: parsed.digest,
          noteCount: Number(parsed.noteCount),
          assetCount: Number(parsed.assetCount),
        },
      };
    },
  };

  /**
   * One row as `restore_catalog` emits it. Every field is optional because
   * this is what the *database* said, not what the contract will accept.
   */
  interface RestoreRow {
    path?: unknown; kind?: unknown; text?: unknown;
    contentAddress?: unknown; contentType?: unknown; byteLength?: unknown; hex?: unknown;
  }

  const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

  function toEntry(row: RestoreRow): RawRestoredEntry {
    // `hex` is the only place a malformed value could throw rather than be
    // refused, so a hex string the store cannot have produced yields no bytes
    // and becomes `missing-object` — never an exception out of a read.
    const raw = asString(row.hex);
    const bytes = raw !== null && /^(?:[0-9a-fA-F]{2})*$/.test(raw) ? new Uint8Array(Buffer.from(raw, "hex")) : null;
    return {
      path: asString(row.path) ?? "",
      kind: asString(row.kind) ?? "",
      text: asString(row.text),
      contentAddress: asString(row.contentAddress),
      contentType: asString(row.contentType),
      byteLength: typeof row.byteLength === "number" ? row.byteLength : null,
      bytes,
    };
  }

  async function readVault(vaultId: string): Promise<RawRestoredVault | null> {
    // REPEATABLE READ is redundant for a single statement and stated anyway:
    // it is the property the restore depends on, and a future edit that splits
    // the read should not have to rediscover that.
    const raw = await query(
      "BEGIN ISOLATION LEVEL REPEATABLE READ;\n" +
      `SELECT restore_catalog(${literal(vaultId)});\n` +
      "COMMIT;\n",
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { vaultId?: unknown; sequence?: unknown; entries?: unknown };
    return {
      vaultId: asString(parsed.vaultId) ?? vaultId,
      sequence: typeof parsed.sequence === "number" ? parsed.sequence : Number.NaN,
      entries: Array.isArray(parsed.entries) ? parsed.entries.map((row) => toEntry(row as RestoreRow)) : [],
    };
  }

  function restoreSource(options: RestoreOptions = {}): CatalogRestoreSource {
    return {
      async restore(vaultId): Promise<RestoreResult> {
        let raw: RawRestoredVault | null;
        try {
          raw = await readVault(vaultId);
        } catch {
          // A read has no named database-side refusals — the schema raises
          // none on this path — so an unreachable server, a dropped schema and
          // unparseable output all land on the one honest status.
          return { status: "store-failed" };
        }
        if (!raw) return { status: "absent" };
        // The adapter does I/O; the portable contract decides. Every refusal a
        // restore can produce is named in `src/wiki/catalog-contract.ts`, so a
        // second adapter cannot invent its own vocabulary — or quietly skip
        // the verification by answering from its own reasoning about the read.
        return verifyRestoredVault(raw, options);
      },
    };
  }

  return {
    schema,
    store,
    restoreSource,
    readVault,
    query,
    openSession,
    publishSql,
    async install() {
      const directory = options.schemaDirectory ?? fileURLToPath(new URL(".", import.meta.url));
      const ddl = await readFile(join(directory, "postgres-catalog-schema.sql"), "utf8");
      await query(`CREATE SCHEMA ${schema};`);
      await query(ddl);
    },
    async drop() {
      await query(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`);
    },
    close() {
      for (const child of live) child.kill("SIGTERM");
    },
  };
}
