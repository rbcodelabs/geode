import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CatalogStore,
  CommitStatus,
  PublishReceipt,
  PublishResult,
  ValidatedPublication,
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

/** Single-quoted SQL literal. `standard_conforming_strings` is on by default, so only quotes need doubling. */
export const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

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
  /** Run SQL in a fresh session against the adapter's schema. */
  query(sql: string): Promise<string>;
  /** Start a session the caller drives, e.g. to hold a transaction open. */
  openSession(applicationName?: string): PostgresSession;
  /** The exact `publish_catalog(...)` call for a publication, for callers driving their own session. */
  publishSql(publication: ValidatedPublication, options?: { fail?: boolean }): string;
  install(): Promise<void>;
  /** Drop exactly this adapter's schema. Safe to call when `install` never ran. */
  drop(): Promise<void>;
  /** Terminate any sessions still running. */
  close(): void;
}

export function createPostgresCatalog(options: PostgresCatalogOptions): PostgresCatalog {
  const psql = options.psql ?? process.env.PSQL ?? "psql";
  const schema = options.schema;
  const prefix =
    `SET search_path TO ${schema}; ` +
    `SET statement_timeout = '${options.statementTimeout ?? "10s"}'; ` +
    `SET lock_timeout = '${options.lockTimeout ?? "8s"}';\n`;
  const live = new Set<ChildProcessWithoutNullStreams>();

  function openSession(applicationName = `${schema}_query`): PostgresSession {
    const child = spawn(psql, ["-X", "-q", "-A", "-t", "-w", "-v", "ON_ERROR_STOP=1"], {
      env: { ...(options.env ?? process.env), PGAPPNAME: applicationName },
      stdio: ["pipe", "pipe", "pipe"],
    });
    live.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
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

  function publishSql(publication: ValidatedPublication, { fail = false } = {}): string {
    const notes = publication.notes.map((note) => ({ path: note.path, text: note.text }));
    // Bytes travel as hex and are decoded server-side, which keeps binary
    // content out of the JSON payload and out of any shell quoting question.
    const assets = publication.assets.map((asset) => ({
      path: asset.path,
      contentAddress: asset.contentAddress,
      contentType: asset.contentType,
      hex: hex(asset.bytes),
    }));
    return `SELECT publish_catalog(${literal(publication.vaultId)}, ${literal(publication.mutationId)}, ` +
      `${literal(publication.digest)}, ${publication.baseSequence}, ` +
      `${literal(JSON.stringify(notes))}::jsonb, ${literal(JSON.stringify(assets))}::jsonb, ${fail});\n`;
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

  return {
    schema,
    store,
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
