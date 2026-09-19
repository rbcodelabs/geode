import { createHash } from "node:crypto";
import { normalizeWikiPath } from "./link-candidates";

/**
 * The portable catalog contract: multi-vault publish/restore semantics.
 *
 * This module is the engine's *outbound* description of a durable catalog. It
 * follows the discipline `WikiIndexSink`/`WikiEventSink` established in
 * `./contracts`, for the same reason `docs/design/headless-phase0.md` records
 * against `src/renderer/host/contracts.ts` — "narrow engine contracts must not
 * inherit the whole host interface". So:
 *
 * - Nothing here extends a host type.
 * - Nothing here imports PostgreSQL, `pg`, or any other driver. The only
 *   Node dependency is `node:crypto`, and even that is a *default* behind the
 *   injectable `Digest` seam, exactly as `nodeWikiFileSystem` is a default
 *   behind `WikiFileSystem` in `./folder-provider`.
 * - The reference adapter lives in `src/catalog/`, outside this directory, and
 *   nothing in `src/wiki/` imports it. `scripts/run-catalog-contract-proof.mjs`
 *   audits esbuild's complete input graph to keep that true.
 *
 * Validation happens here, before any adapter is touched. Every distinct
 * rejection carries its own named status, mirroring the folder provider's
 * `invalid-path` / `not-a-note` / `already-exists` pattern: a caller must be
 * able to tell "your bytes are too big" from "your hash is wrong" from "you
 * told me one content address means two different things" without parsing
 * prose.
 *
 * Restore is implemented here too, and on the same terms: a store's answer is
 * *verified*, never trusted. See `verifyRestoredVault`.
 */

/** Lowercase hex SHA-256 of an object's exact bytes. 64 characters. */
export type ContentAddress = string;

const CONTENT_ADDRESS_RE = /^[0-9a-f]{64}$/;
/** Conservative identifier shape for vault and mutation ids: safe in a path, a URL and a SQL literal. */
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** A note being published. Notes are text; their bytes are the UTF-8 encoding of `text`. */
export interface CatalogNote {
  readonly path: string;
  readonly text: string;
}

/**
 * An immutable binary attachment being published.
 *
 * `contentAddress` is supplied by the caller rather than derived, so that a
 * caller which already knows an object's address (from a previous publication,
 * a manifest, or a streaming upload) can be *checked* rather than trusted. A
 * declared address that disagrees with the bytes is refused, never corrected.
 */
export interface CatalogAsset {
  readonly path: string;
  readonly contentAddress: ContentAddress;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/** One publication: a base sequence, a set of notes, and a set of assets. */
export interface PublishRequest {
  readonly vaultId: string;
  /**
   * Caller-chosen idempotency key. Replaying the identical request returns the
   * original receipt; reusing the id with a different payload is refused.
   */
  readonly mutationId: string;
  /** The sequence the caller believes the vault is at. A stale base is a `conflict`. */
  readonly baseSequence: number;
  readonly notes?: readonly CatalogNote[];
  readonly assets?: readonly CatalogAsset[];
}

export interface CatalogLimits {
  readonly maxNoteBytes: number;
  readonly maxAssetBytes: number;
  /** Ceiling on one publication's total note + asset bytes. */
  readonly maxPublicationBytes: number;
  /** Ceiling on how many entries one publication may carry. */
  readonly maxPublicationEntries: number;
  /** Exact-match allowlist. An empty allowlist accepts nothing, which is a safe default to misconfigure. */
  readonly allowedContentTypes: readonly string[];
}

export const DEFAULT_CATALOG_LIMITS: Readonly<CatalogLimits> = Object.freeze({
  maxNoteBytes: 2 * 1024 * 1024,
  maxAssetBytes: 16 * 1024 * 1024,
  maxPublicationBytes: 64 * 1024 * 1024,
  maxPublicationEntries: 1_000,
  allowedContentTypes: Object.freeze([
    "text/markdown", "image/png", "image/jpeg", "image/gif", "image/webp",
    "image/svg+xml", "application/pdf", "application/octet-stream",
  ]),
});

/**
 * Which limit an `oversize` refusal tripped. One named status, four measurable
 * causes — three on the publish side, and `vault-bytes` on the restore side,
 * where the ceiling is the whole vault rather than one publication.
 */
export type OversizeLimit = "note-bytes" | "asset-bytes" | "publication-bytes" | "vault-bytes";

/**
 * Why a publication was refused.
 *
 * Split into the refusals a caller can determine *without* a database
 * (`ValidationStatus`) and the ones only a transactional commit can decide
 * (`CommitStatus`). The split is not cosmetic: everything in the first group
 * must be caught before an adapter is contacted, so a malformed publication
 * never reaches durable storage at all.
 */
export type ValidationStatus =
  /** `vaultId` is not a portable identifier. */
  | "invalid-vault-id"
  /** `mutationId` is not a portable identifier. */
  | "invalid-mutation-id"
  /** `baseSequence` is not a non-negative safe integer. */
  | "invalid-sequence"
  /** Nothing to publish. A no-op must not consume a sequence number. */
  | "empty-publication"
  /** Not a portable vault-relative path: absolute, drive-qualified, escaping, backslashed, NUL-bearing, dot-prefixed, or `node_modules`. */
  | "invalid-path"
  /** A note entry whose path is not `.md`. */
  | "not-a-note"
  /** A note's text contains a NUL, which no text file holds and no JSON-carrying store can represent. */
  | "invalid-note-text"
  /** An asset entry whose path *is* `.md`. Attachments must not masquerade as notes. */
  | "asset-is-a-note"
  /** Two entries in one publication claim the same path. */
  | "duplicate-path"
  /** Two entries fold onto the same NFC-lowercased identity, which a macOS or Windows filesystem would treat as one file. */
  | "portability-collision"
  /** Exceeds `maxNoteBytes`, `maxAssetBytes` or `maxPublicationBytes`. */
  | "oversize"
  /** The publication carries more entries than `maxPublicationEntries`. */
  | "entry-limit"
  /** An asset's `contentType` is not in the allowlist. */
  | "unsupported-content-type"
  /** A `contentAddress` is not 64 lowercase hex characters, or does not equal the SHA-256 of the supplied bytes. */
  | "invalid-content-address"
  /** One content address was declared for two different byte strings. Content addresses are immutable identities, not labels. */
  | "duplicate-with-mismatched-bytes";

export type CommitStatus =
  /** `baseSequence` is not the vault's current sequence. Nothing was published. */
  | "conflict"
  /** This `mutationId` already exists for this vault with a different payload digest. */
  | "mutation-id-reused"
  /** The store already holds different bytes at one of the declared content addresses. */
  | "duplicate-with-mismatched-bytes"
  /** The store rejected a content address it verified itself. */
  | "invalid-content-address"
  /** The store could not be reached, or failed for a reason it does not name. */
  | "store-failed";

export type PublishRefusal = ValidationStatus | CommitStatus;

/** Where a refusal was observed. `path` and `contentAddress` are populated when the refusal is about one entry. */
export interface RefusalDetail {
  readonly path?: string;
  readonly contentAddress?: ContentAddress;
  readonly limit?: OversizeLimit;
  /** Observed vs. allowed, for the size and count refusals. Never a formatted message. */
  readonly observed?: number;
  readonly allowed?: number;
  readonly contentType?: string;
}

export type ValidationResult =
  | { readonly status: "ok"; readonly publication: ValidatedPublication }
  | ({ readonly status: ValidationStatus } & RefusalDetail);

export type PublishResult =
  | { readonly status: "ok"; readonly receipt: PublishReceipt }
  | ({ readonly status: PublishRefusal } & RefusalDetail);

/**
 * What a committed publication acknowledges.
 *
 * `digest` covers the base sequence and the normalized payload, so an
 * identical retry is provably identical and a reused id with a changed payload
 * is provably not.
 */
export interface PublishReceipt {
  readonly vaultId: string;
  readonly mutationId: string;
  /** The vault sequence this publication produced. Strictly increasing per vault. */
  readonly sequence: number;
  readonly digest: string;
  readonly noteCount: number;
  readonly assetCount: number;
}

/**
 * A publication that has passed every check `validatePublication` can make
 * without a store. Only this type may be handed to a `CatalogStore` — the
 * adapter is not a second place to re-derive validation rules.
 */
export interface ValidatedPublication {
  readonly vaultId: string;
  readonly mutationId: string;
  readonly baseSequence: number;
  readonly notes: readonly CatalogNote[];
  readonly assets: readonly CatalogAsset[];
  /** Stable over key order and entry order; the adapter records it verbatim. */
  readonly digest: string;
  readonly totalBytes: number;
}

/**
 * The narrow outbound port for publishing. One method.
 *
 * "Transactional" is the whole contract: `commit` either advances the vault
 * sequence, stores every object, applies every catalog entry and records the
 * receipt — or it does none of those. There is no partial publication and no
 * intermediate state a reader can observe.
 */
export interface CatalogStore {
  commit(publication: ValidatedPublication): Promise<PublishResult>;
}

/**
 * The narrow outbound port for restoring.
 *
 * Deliberately separate from `CatalogStore` so that an implementer of one is
 * not forced to stub the other, the same way `WikiIndexSink` and
 * `WikiEventSink` are two interfaces rather than one.
 */
export interface CatalogRestoreSource {
  restore(vaultId: string): Promise<RestoreResult>;
}

/** A verified vault, ready to be materialized. Entries are sorted by path. */
export interface RestoredVault {
  readonly vaultId: string;
  readonly sequence: number;
  readonly notes: readonly CatalogNote[];
  readonly assets: readonly CatalogAsset[];
  /** Sum of note UTF-8 bytes and asset bytes, measured on the way out. */
  readonly totalBytes: number;
}

/**
 * One row exactly as a store hands it back, before anything has been checked.
 *
 * Every field beyond `path` is nullable and loosely typed on purpose. A store
 * that returns something impossible — an attachment with no bytes, a kind this
 * contract has never heard of, a byte length that disagrees with the bytes —
 * must be refused *by name*, not crash a destructuring assignment. This is the
 * restore-side equivalent of accepting a caller-declared content address so it
 * can be checked rather than trusted.
 */
export interface RawRestoredEntry {
  readonly path: string;
  readonly kind: string;
  readonly text?: string | null;
  readonly contentAddress?: string | null;
  readonly contentType?: string | null;
  /** The length the store *recorded*, which may disagree with the bytes it returned. */
  readonly byteLength?: number | null;
  readonly bytes?: Uint8Array | null;
}

export interface RawRestoredVault {
  readonly vaultId: string;
  readonly sequence: number;
  readonly entries: readonly RawRestoredEntry[];
}

/**
 * Ceilings applied to a restore.
 *
 * Separate from `CatalogLimits` because the quantities are different: a vault
 * accumulates across many publications, so measuring it against
 * `maxPublicationBytes` would refuse a legitimately large vault that was
 * published correctly in small pieces.
 */
export interface RestoreLimits {
  readonly maxNoteBytes: number;
  readonly maxAssetBytes: number;
  /** Ceiling on the whole restored vault's note + asset bytes. */
  readonly maxVaultBytes: number;
  readonly maxEntries: number;
  /** Exact-match allowlist, applied on the way out as well as on the way in. */
  readonly allowedContentTypes: readonly string[];
}

export const DEFAULT_RESTORE_LIMITS: Readonly<RestoreLimits> = Object.freeze({
  maxNoteBytes: 2 * 1024 * 1024,
  maxAssetBytes: 16 * 1024 * 1024,
  maxVaultBytes: 256 * 1024 * 1024,
  maxEntries: 10_000,
  allowedContentTypes: DEFAULT_CATALOG_LIMITS.allowedContentTypes,
});

/**
 * Why a restore was refused.
 *
 * The publish-side names are reused wherever the invariant is the same one,
 * because a reviewer should not have to learn two vocabularies for "this path
 * is not portable". The statuses that exist only here describe a store
 * contradicting *itself* — which is exactly the class of failure a restore that
 * trusted its store would materialize onto disk without noticing.
 */
export type RestoreStatus =
  /** `vaultId` is not a portable identifier. Refused before the store is contacted. */
  | "invalid-vault-id"
  /** No such vault, or a vault with no entries. There is nothing to restore. */
  | "absent"
  /** The stored sequence is not a positive safe integer. */
  | "invalid-sequence"
  /** The vault holds more entries than `maxEntries`. */
  | "entry-limit"
  /** A stored path is not a portable vault-relative path. */
  | "invalid-path"
  /** A stored note's path is not `.md`. */
  | "not-a-note"
  /** A stored attachment's path *is* `.md`. */
  | "asset-is-a-note"
  /** Two stored entries claim the same path. */
  | "duplicate-path"
  /** Two stored entries fold onto the same NFC-lowercased identity. */
  | "portability-collision"
  /** A stored `kind` is neither `note` nor `attachment`. */
  | "unknown-entry-kind"
  /** A note with no text, or an attachment missing its address or content type. */
  | "incomplete-entry"
  /** An attachment entry whose content address resolves to no bytes at all. */
  | "missing-object"
  /** The store's own recorded byte length disagrees with the bytes it returned. */
  | "byte-length-mismatch"
  /** A restored note or asset exceeds `maxNoteBytes`, `maxAssetBytes` or `maxVaultBytes`. */
  | "oversize"
  /** A stored content type is not in the allowlist. */
  | "unsupported-content-type"
  /** A stored address is not 64 lowercase hex characters, or is not the SHA-256 of the returned bytes. */
  | "invalid-content-address"
  /** One content address came back describing two different byte strings. */
  | "duplicate-with-mismatched-bytes"
  /** The store could not be reached, or failed for a reason it does not name. */
  | "store-failed";

export type RestoreResult =
  | { readonly status: "ok"; readonly vault: RestoredVault }
  | ({ readonly status: RestoreStatus } & RefusalDetail);

export interface RestoreOptions {
  limits?: RestoreLimits;
  digest?: Digest;
}

/** The hashing seam. `node:crypto` supplies the default; a caller may substitute one. */
export interface Digest {
  sha256Hex(bytes: Uint8Array): ContentAddress;
}

export const nodeDigest: Digest = {
  sha256Hex: (bytes) => createHash("sha256").update(bytes).digest("hex"),
};

export interface ValidateOptions {
  limits?: CatalogLimits;
  digest?: Digest;
}

const utf8 = new TextEncoder();
const identityKey = (path: string): string => path.normalize("NFC").toLowerCase();
const isNote = (path: string): boolean => /\.md$/i.test(path);

/**
 * A NUL anywhere in note text.
 *
 * Paths are already screened for this by `normalizeWikiPath`; note *text* was
 * not, and the failure was neither portable nor named. `JSON.stringify` encodes
 * a NUL as a six-character backslash-u escape, PostgreSQL's `::jsonb` cast
 * rejects that escape outright, and the adapter's `classifyFailure` has no
 * marker to match — so a `.md` file that happens to contain a NUL captured
 * cleanly, travelled all the way to the database, and came back as an unnamed
 * `store-failed`. That contradicts this module's own rule that everything
 * decidable without a store is decided before one is contacted. A NUL is not
 * text in any portable sense, so it is refused here, by name, with the path.
 */
const hasNul = (text: string): boolean => text.includes("\u0000");

/** Rejects the same paths the capture walk in `./local-filesystem` skips, so a publishable path is also a capturable one. */
function invalidPath(path: string): boolean {
  if (normalizeWikiPath(path) !== path) return true;
  return path.split("/").some((segment) => segment.startsWith(".") || segment === "node_modules");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Canonical JSON for the digest.
 *
 * Entry order and object key order must not change a publication's identity,
 * or an identical retry serialized differently would look like a reused id
 * with a changed payload. Asset bytes enter the digest as their content
 * address, which is what makes the digest cheap on large attachments.
 */
function canonicalPayload(publication: {
  baseSequence: number;
  notes: readonly CatalogNote[];
  assets: readonly CatalogAsset[];
}): string {
  const notes = [...publication.notes]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((note) => [note.path, note.text]);
  const assets = [...publication.assets]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((asset) => [asset.path, asset.contentAddress, asset.contentType]);
  return JSON.stringify({ base: publication.baseSequence, notes, assets });
}

/**
 * Check a publication completely, without contacting a store.
 *
 * Checks run in a deliberate order: identity, then shape, then per-entry
 * paths, then cross-entry identity, then sizes, then content addresses. The
 * cross-address duplicate check runs *before* per-asset digest verification,
 * because "you declared one address for two different byte strings" is a
 * sharper diagnosis than "this hash is wrong on whichever one I reached
 * first", and it is the invariant the immutable store actually depends on.
 */
export function validatePublication(request: PublishRequest, options: ValidateOptions = {}): ValidationResult {
  const limits = options.limits ?? DEFAULT_CATALOG_LIMITS;
  const digest = options.digest ?? nodeDigest;
  const notes = request.notes ?? [];
  const assets = request.assets ?? [];

  if (!IDENTIFIER_RE.test(request.vaultId)) return { status: "invalid-vault-id" };
  if (!IDENTIFIER_RE.test(request.mutationId)) return { status: "invalid-mutation-id" };
  if (!Number.isSafeInteger(request.baseSequence) || request.baseSequence < 0) return { status: "invalid-sequence" };
  if (!notes.length && !assets.length) return { status: "empty-publication" };
  if (notes.length + assets.length > limits.maxPublicationEntries) {
    return { status: "entry-limit", observed: notes.length + assets.length, allowed: limits.maxPublicationEntries };
  }

  for (const note of notes) {
    if (invalidPath(note.path)) return { status: "invalid-path", path: note.path };
    if (!isNote(note.path)) return { status: "not-a-note", path: note.path };
    if (hasNul(note.text)) return { status: "invalid-note-text", path: note.path };
  }
  for (const asset of assets) {
    if (invalidPath(asset.path)) return { status: "invalid-path", path: asset.path };
    if (isNote(asset.path)) return { status: "asset-is-a-note", path: asset.path };
  }

  const seenPaths = new Set<string>();
  const seenIdentities = new Map<string, string>();
  for (const path of [...notes.map((n) => n.path), ...assets.map((a) => a.path)]) {
    if (seenPaths.has(path)) return { status: "duplicate-path", path };
    seenPaths.add(path);
    const key = identityKey(path);
    const previous = seenIdentities.get(key);
    if (previous !== undefined) return { status: "portability-collision", path };
    seenIdentities.set(key, path);
  }

  let totalBytes = 0;
  for (const note of notes) {
    const bytes = utf8.encode(note.text).byteLength;
    if (bytes > limits.maxNoteBytes) {
      return { status: "oversize", limit: "note-bytes", path: note.path, observed: bytes, allowed: limits.maxNoteBytes };
    }
    totalBytes += bytes;
  }
  for (const asset of assets) {
    if (asset.bytes.byteLength > limits.maxAssetBytes) {
      return {
        status: "oversize", limit: "asset-bytes", path: asset.path,
        observed: asset.bytes.byteLength, allowed: limits.maxAssetBytes,
      };
    }
    totalBytes += asset.bytes.byteLength;
  }
  if (totalBytes > limits.maxPublicationBytes) {
    return { status: "oversize", limit: "publication-bytes", observed: totalBytes, allowed: limits.maxPublicationBytes };
  }

  for (const asset of assets) {
    if (!limits.allowedContentTypes.includes(asset.contentType)) {
      return { status: "unsupported-content-type", path: asset.path, contentType: asset.contentType };
    }
  }

  // One address must mean exactly one byte string, inside a publication as
  // well as across them. Checked before the per-asset digest below.
  const byAddress = new Map<ContentAddress, Uint8Array>();
  for (const asset of assets) {
    const existing = byAddress.get(asset.contentAddress);
    if (existing && !bytesEqual(existing, asset.bytes)) {
      return { status: "duplicate-with-mismatched-bytes", path: asset.path, contentAddress: asset.contentAddress };
    }
    byAddress.set(asset.contentAddress, asset.bytes);
  }
  for (const asset of assets) {
    if (!CONTENT_ADDRESS_RE.test(asset.contentAddress) || digest.sha256Hex(asset.bytes) !== asset.contentAddress) {
      return { status: "invalid-content-address", path: asset.path, contentAddress: asset.contentAddress };
    }
  }

  const payload = canonicalPayload({ baseSequence: request.baseSequence, notes, assets });
  return {
    status: "ok",
    publication: Object.freeze({
      vaultId: request.vaultId,
      mutationId: request.mutationId,
      baseSequence: request.baseSequence,
      notes: Object.freeze([...notes]),
      assets: Object.freeze([...assets]),
      digest: digest.sha256Hex(utf8.encode(payload)),
      totalBytes,
    }),
  };
}

/**
 * Validate, then commit. The only supported way to reach a `CatalogStore`.
 *
 * A validation refusal never contacts the store, so the durable catalog is
 * never asked to decide something the engine could decide itself.
 */
export async function publish(
  store: CatalogStore,
  request: PublishRequest,
  options: ValidateOptions = {},
): Promise<PublishResult> {
  const validation = validatePublication(request, options);
  if (validation.status !== "ok") return validation;
  return store.commit(validation.publication);
}

/**
 * Check everything a store handed back, before a single byte is written down.
 *
 * A restore is not a privileged read. The bytes coming *out* get the same
 * treatment as the bytes going in: the address is recomputed from the payload
 * and compared, paths are re-validated against the same portability rules, and
 * content types are re-checked against the allowlist. The publish side already
 * verified all of this — which is exactly why re-verifying is worth doing, as
 * the only failures it can catch are the ones that happened *after* a
 * successful publication: corruption, truncation, a partial read, an
 * out-of-band write, or a store bug.
 *
 * Check order mirrors `validatePublication`: identity, shape, per-entry paths,
 * cross-entry identity, sizes, then content addresses. Within the byte checks,
 * `byte-length-mismatch` is tested before the digest, because "the store's own
 * metadata disagrees with the store's own bytes" is a sharper diagnosis than
 * "this hash is wrong", and both are true of a truncated read.
 */
export function verifyRestoredVault(raw: RawRestoredVault, options: RestoreOptions = {}): RestoreResult {
  const limits = options.limits ?? DEFAULT_RESTORE_LIMITS;
  const digest = options.digest ?? nodeDigest;

  if (!IDENTIFIER_RE.test(raw.vaultId)) return { status: "invalid-vault-id" };
  if (!raw.entries.length) return { status: "absent" };
  if (!Number.isSafeInteger(raw.sequence) || raw.sequence < 1) return { status: "invalid-sequence", observed: raw.sequence };
  if (raw.entries.length > limits.maxEntries) {
    return { status: "entry-limit", observed: raw.entries.length, allowed: limits.maxEntries };
  }

  for (const entry of raw.entries) {
    if (entry.kind !== "note" && entry.kind !== "attachment") {
      return { status: "unknown-entry-kind", path: entry.path };
    }
    if (invalidPath(entry.path)) return { status: "invalid-path", path: entry.path };
    if (entry.kind === "note" && !isNote(entry.path)) return { status: "not-a-note", path: entry.path };
    if (entry.kind === "attachment" && isNote(entry.path)) return { status: "asset-is-a-note", path: entry.path };
  }

  const seenPaths = new Set<string>();
  const seenIdentities = new Set<string>();
  for (const entry of raw.entries) {
    if (seenPaths.has(entry.path)) return { status: "duplicate-path", path: entry.path };
    seenPaths.add(entry.path);
    const key = identityKey(entry.path);
    if (seenIdentities.has(key)) return { status: "portability-collision", path: entry.path };
    seenIdentities.add(key);
  }

  const notes: CatalogNote[] = [];
  const assets: CatalogAsset[] = [];
  for (const entry of raw.entries) {
    if (entry.kind === "note") {
      if (typeof entry.text !== "string") return { status: "incomplete-entry", path: entry.path };
      notes.push({ path: entry.path, text: entry.text });
      continue;
    }
    if (typeof entry.contentAddress !== "string" || typeof entry.contentType !== "string") {
      return { status: "incomplete-entry", path: entry.path };
    }
    // A catalog entry pointing at an address the store cannot produce bytes for
    // is a dangling reference, not a corrupt object — its own name.
    if (!(entry.bytes instanceof Uint8Array)) {
      return { status: "missing-object", path: entry.path, contentAddress: entry.contentAddress };
    }
    assets.push({
      path: entry.path, contentAddress: entry.contentAddress,
      contentType: entry.contentType, bytes: entry.bytes,
    });
  }

  let totalBytes = 0;
  for (const note of notes) {
    const bytes = utf8.encode(note.text).byteLength;
    if (bytes > limits.maxNoteBytes) {
      return { status: "oversize", limit: "note-bytes", path: note.path, observed: bytes, allowed: limits.maxNoteBytes };
    }
    totalBytes += bytes;
  }
  for (const asset of assets) {
    if (asset.bytes.byteLength > limits.maxAssetBytes) {
      return {
        status: "oversize", limit: "asset-bytes", path: asset.path,
        observed: asset.bytes.byteLength, allowed: limits.maxAssetBytes,
      };
    }
    totalBytes += asset.bytes.byteLength;
  }
  if (totalBytes > limits.maxVaultBytes) {
    return { status: "oversize", limit: "vault-bytes", observed: totalBytes, allowed: limits.maxVaultBytes };
  }

  for (const asset of assets) {
    if (!limits.allowedContentTypes.includes(asset.contentType)) {
      return { status: "unsupported-content-type", path: asset.path, contentType: asset.contentType };
    }
  }

  for (const entry of raw.entries) {
    if (entry.kind !== "attachment" || typeof entry.byteLength !== "number") continue;
    const actual = (entry.bytes as Uint8Array).byteLength;
    if (entry.byteLength !== actual) {
      return {
        status: "byte-length-mismatch", path: entry.path,
        contentAddress: entry.contentAddress ?? undefined, observed: actual, allowed: entry.byteLength,
      };
    }
  }

  const byAddress = new Map<ContentAddress, Uint8Array>();
  for (const asset of assets) {
    const existing = byAddress.get(asset.contentAddress);
    if (existing && !bytesEqual(existing, asset.bytes)) {
      return { status: "duplicate-with-mismatched-bytes", path: asset.path, contentAddress: asset.contentAddress };
    }
    byAddress.set(asset.contentAddress, asset.bytes);
  }
  for (const asset of assets) {
    if (!CONTENT_ADDRESS_RE.test(asset.contentAddress) || digest.sha256Hex(asset.bytes) !== asset.contentAddress) {
      return { status: "invalid-content-address", path: asset.path, contentAddress: asset.contentAddress };
    }
  }

  const byPath = (a: { path: string }, b: { path: string }): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    status: "ok",
    vault: Object.freeze({
      vaultId: raw.vaultId,
      sequence: raw.sequence,
      notes: Object.freeze([...notes].sort(byPath)),
      assets: Object.freeze([...assets].sort(byPath)),
      totalBytes,
    }),
  };
}

/**
 * Validate the request, then read. The only supported way to reach a
 * `CatalogRestoreSource`, and the mirror of `publish`: a malformed vault id is
 * refused here rather than turned into a query.
 */
export async function restore(source: CatalogRestoreSource, vaultId: string): Promise<RestoreResult> {
  if (!IDENTIFIER_RE.test(vaultId)) return { status: "invalid-vault-id" };
  return source.restore(vaultId);
}
