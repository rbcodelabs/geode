/**
 * The catalog SDK — publish a folder, restore a folder.
 *
 * `src/wiki/index.ts` is the engine's entry point and deliberately says nothing
 * about a catalog: ADR 0022 keeps the portable contract and its PostgreSQL
 * adapter outside the wiki graph, and `scripts/run-wiki-sdk-proof.mjs` audits
 * esbuild's input set to keep that true. So a caller that wants publish and
 * restore cannot get them from the wiki SDK, and must not assemble them by
 * hand out of `validatePublication`, `publish`, `restore`,
 * `materializeRestoredVault` and the adapter — that assembly *is* logic, and
 * re-deriving it in every caller is how two callers end up publishing subtly
 * different vaults.
 *
 * This module is that assembly, once, in the layer that already knows a
 * database exists. It is the catalog's counterpart to `src/wiki/index.ts`: a
 * narrowing, not a re-export. At runtime it exports exactly two functions.
 * `CatalogStore`, `CatalogRestoreSource`, `validatePublication`,
 * `verifyRestoredVault`, `publishSql`, `openSession`, `install` and `drop` all
 * stay internal — schema lifecycle is an administrative act with its own
 * script, not something a publish command should be able to reach.
 *
 * ## What it does not do
 *
 * It does not create or drop a schema, and it does not invent a configuration
 * format. The schema name and the libpq `PG*` variables come from the
 * environment or from the caller's arguments, exactly as
 * `src/catalog/postgres-catalog-store.ts` already expects.
 *
 * ## Every refusal keeps its own name
 *
 * `PublishFolderStatus` and `RestoreFolderStatus` are unions that *include* the
 * contract's own status vocabularies rather than collapsing them. A caller can
 * still tell `oversize` from `portability-collision` from `conflict`, and the
 * accompanying `RefusalDetail` — which path, which limit, observed vs. allowed
 * — travels with it. The three statuses added here name failures the contract
 * has no opinion about because they happen before or after it: the folder could
 * not be captured, one of its files could not be read, or the schema name is
 * not one this adapter may use.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import {
  openWikiSession,
  type CaptureError,
  type Diagnostic,
} from "../wiki/index";
import {
  DEFAULT_CATALOG_LIMITS,
  DEFAULT_RESTORE_LIMITS,
  nodeDigest,
  publish,
  restore,
  type CatalogAsset,
  type CatalogLimits,
  type CatalogNote,
  type PublishReceipt,
  type PublishRefusal,
  type RefusalDetail,
  type RestoreLimits,
  type RestoreStatus,
} from "../wiki/catalog-contract";
import { materializeRestoredVault } from "../wiki/catalog-materialize";
import { createPostgresCatalog } from "./postgres-catalog-store";

/* ------------------------------------------------------------------ types */

export type {
  CatalogLimits,
  PublishReceipt,
  PublishRefusal,
  RefusalDetail,
  RestoreLimits,
  RestoreStatus,
} from "../wiki/catalog-contract";

/**
 * How to reach the durable catalog.
 *
 * No connection string and no config file: the adapter speaks to PostgreSQL
 * through `psql` and the standard libpq `PG*` variables, so credentials arrive
 * the way every other PostgreSQL client on the machine already gets them. The
 * schema is the one thing that must be named, because it is the unit this
 * adapter is allowed to own.
 */
export interface CatalogConnection {
  readonly schema: string;
  /** Path to the `psql` executable. Defaults to `PSQL`, then `psql` on PATH. */
  readonly psql?: string;
  /** Environment handed to `psql`. Defaults to this process's environment. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Why a folder publication was refused.
 *
 * The first three are this module's own; everything after is the portable
 * contract's vocabulary, unchanged and unflattened.
 */
export type PublishFolderStatus =
  /** The schema name is not one the adapter may create, use or drop. */
  | "invalid-schema"
  /** The folder could not be captured at all. `error` carries the capture error. */
  | "vault-unavailable"
  /** One captured file could not be read back. `path` names it. */
  | "entry-unreadable"
  | PublishRefusal;

/**
 * What the engine knew about its own coverage at the moment of publication.
 *
 * Carried on a *successful* publish on purpose. A vault whose walk was cut
 * short still publishes — the contract has no opinion about completeness — and
 * a caller that is never told cannot distinguish "this vault has four notes"
 * from "this vault has four notes that I got to". Absence is only provable when
 * `discoveryComplete` is true.
 */
export interface PublishedCoverage {
  readonly discoveryComplete: boolean;
  readonly noteContentComplete: boolean;
  readonly aliasCoverageComplete: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export type PublishFolderResult =
  | {
      readonly status: "ok";
      readonly receipt: PublishReceipt;
      readonly coverage: PublishedCoverage;
    }
  | { readonly status: "vault-unavailable"; readonly error: CaptureError }
  | { readonly status: "invalid-schema"; readonly schema: string; readonly reason: string }
  | { readonly status: "entry-unreadable"; readonly path: string; readonly reason: string }
  | ({ readonly status: PublishRefusal } & RefusalDetail);

export interface PublishFolderOptions {
  /** The folder to publish. Captured through the wiki SDK, so the catalog gets exactly what the engine sees. */
  readonly root: string;
  readonly vaultId: string;
  /** Idempotency key. An identical replay returns the original receipt. */
  readonly mutationId: string;
  /** The sequence the caller believes the vault is at. A stale base is a `conflict`. */
  readonly baseSequence: number;
  readonly connection: CatalogConnection;
  readonly limits?: CatalogLimits;
}

/** Why a folder restore was refused. `escaping-path` and `write-failed` come from materialization. */
export type RestoreFolderStatus =
  | "invalid-schema"
  | RestoreStatus
  | "escaping-path"
  | "write-failed";

export type RestoreFolderResult =
  | {
      readonly status: "ok";
      readonly root: string;
      readonly vaultId: string;
      readonly sequence: number;
      readonly noteCount: number;
      readonly assetCount: number;
      readonly totalBytes: number;
    }
  | { readonly status: "invalid-schema"; readonly schema: string; readonly reason: string }
  | {
      readonly status: "escaping-path" | "write-failed";
      readonly root: string;
      readonly path?: string;
    }
  | ({ readonly status: RestoreStatus } & RefusalDetail);

export interface RestoreFolderOptions {
  /** The folder to write into. Every entry is created exclusively; an existing file is a `write-failed`. */
  readonly into: string;
  readonly vaultId: string;
  readonly connection: CatalogConnection;
  readonly limits?: RestoreLimits;
}

/* ----------------------------------------------------------- content type */

/**
 * Attachment content types, by extension.
 *
 * Extension-based typing is a guess, and it is labelled as one rather than
 * dressed up as sniffing. Anything unrecognised is published as
 * `application/octet-stream`, which the default allowlist accepts — so the
 * allowlist's teeth are in a caller's *tightened* limits, not in this table.
 * The contract still verifies the content address against the bytes either way,
 * which is the check that actually protects the store.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".md": "text/markdown",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
});

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return CONTENT_TYPES[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Build the adapter, or report an unusable schema by name.
 *
 * `createPostgresCatalog` throws on a schema it may not own — `public`, a
 * `pg_` prefix, anything that is not a plain lowercase identifier. A thrown
 * error is the wrong shape for a surface whose whole claim is that refusals are
 * named, so it is converted here rather than left to escape into a caller's
 * stack trace.
 */
function connect(connection: CatalogConnection):
  | { readonly status: "ok"; readonly catalog: ReturnType<typeof createPostgresCatalog> }
  | { readonly status: "invalid-schema"; readonly schema: string; readonly reason: string } {
  try {
    return {
      status: "ok",
      catalog: createPostgresCatalog({
        schema: connection.schema,
        psql: connection.psql,
        env: connection.env,
      }),
    };
  } catch (error) {
    return {
      status: "invalid-schema",
      schema: connection.schema,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/* --------------------------------------------------------------- publish */

/**
 * Capture a folder and publish it as one vault.
 *
 * The capture goes through `openWikiSession`, not through a second private
 * walk, so what lands in the catalog is exactly what the engine answers
 * queries from. Note bytes come from the session; attachment bytes come from
 * disk, because a capture never carries them.
 */
export async function publishFolder(options: PublishFolderOptions): Promise<PublishFolderResult> {
  const connected = connect(options.connection);
  if (connected.status !== "ok") return connected;
  const catalog = connected.catalog;

  const root = resolvePath(options.root);
  try {
    const opened = await openWikiSession(root);
    if (opened.status !== "ok") return { status: "vault-unavailable", error: opened.error };
    const session = opened.session;
    const info = session.info();

    const notes: CatalogNote[] = [];
    const assets: CatalogAsset[] = [];
    for (const file of session.listFiles()) {
      if (file.kind === "note") {
        const read = session.readNote(file.path);
        if (read.status !== "ok") {
          return { status: "entry-unreadable", path: file.path, reason: read.status };
        }
        notes.push({ path: file.path, text: read.note.text });
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(join(root, file.path)));
      } catch (error) {
        return {
          status: "entry-unreadable",
          path: file.path,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      assets.push({
        path: file.path,
        contentAddress: nodeDigest.sha256Hex(bytes),
        contentType: contentTypeFor(file.path),
        bytes,
      });
    }

    const result = await publish(
      catalog.store,
      {
        vaultId: options.vaultId,
        mutationId: options.mutationId,
        baseSequence: options.baseSequence,
        notes,
        assets,
      },
      { limits: options.limits ?? DEFAULT_CATALOG_LIMITS },
    );
    if (result.status !== "ok") return result;
    return {
      status: "ok",
      receipt: result.receipt,
      coverage: {
        discoveryComplete: info.discoveryComplete,
        noteContentComplete: info.noteContentComplete,
        aliasCoverageComplete: info.aliasCoverageComplete,
        diagnostics: info.diagnostics,
      },
    };
  } finally {
    catalog.close();
  }
}

/* --------------------------------------------------------------- restore */

/**
 * Restore one vault onto a folder.
 *
 * Verification is the adapter's `restoreSource`, so a store contradicting
 * itself is refused by name before a byte is written — the restore is not a
 * privileged read. Materialization then writes exclusively, so this never
 * silently merges into an existing vault.
 */
export async function restoreFolder(options: RestoreFolderOptions): Promise<RestoreFolderResult> {
  const connected = connect(options.connection);
  if (connected.status !== "ok") return connected;
  const catalog = connected.catalog;

  try {
    const source = catalog.restoreSource({ limits: options.limits ?? DEFAULT_RESTORE_LIMITS });
    const restored = await restore(source, options.vaultId);
    if (restored.status !== "ok") return restored;

    // `materializeRestoredVault` takes the target's `realpath` as the anchor
    // every later containment check is made against, so the directory has to
    // exist before it runs — a missing one comes back as an unhelpful
    // `write-failed`. Created here, after verification and before any byte is
    // written, so a refused restore does not leave a directory behind either.
    // Existing entries are still refused: materialization opens every file
    // `O_EXCL`, so this creates a container, never a merge.
    try {
      await mkdir(options.into, { recursive: true });
    } catch (error) {
      return {
        status: "write-failed",
        root: resolvePath(options.into),
        path: error instanceof Error ? error.message : String(error),
      };
    }

    const written = await materializeRestoredVault(options.into, restored.vault);
    if (written.status !== "ok") {
      return { status: written.status, root: written.root, path: written.path };
    }
    return {
      status: "ok",
      root: written.root,
      vaultId: restored.vault.vaultId,
      sequence: restored.vault.sequence,
      noteCount: written.noteCount,
      assetCount: written.assetCount,
      totalBytes: restored.vault.totalBytes,
    };
  } finally {
    catalog.close();
  }
}
