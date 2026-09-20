import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nodeDigest, type ContentAddress, type Digest } from "../wiki/catalog-contract";

/**
 * The content-addressed byte storage seam.
 *
 * The PostgreSQL adapter keeps object bytes in a `bytea` column, inside the
 * same transaction that writes the catalog. Aurora DSQL cannot: a write
 * transaction is held to roughly 10 MiB, while `DEFAULT_CATALOG_LIMITS` permits
 * a 64 MiB publication. So bytes move out of the database entirely, behind this
 * interface.
 *
 * The shape is Vercel Blob's, deliberately — put, get, delete, list by key —
 * so that Phase B substitutes `@vercel/blob` without the adapter noticing. It is
 * NOT `@vercel/blob` re-exported: this module has no cloud dependency, adds no
 * package, and makes no network call. Phase A ships two implementations, one in
 * memory and one on a filesystem, and Phase B adds a third.
 *
 * ## Why the interface is this narrow
 *
 * `CatalogStore` is one method and `CatalogRestoreSource` is one method, for
 * the reason `src/wiki/catalog-contract.ts` states: an implementer of one
 * should not be forced to stub the other. The same discipline applies here.
 * There is no `head`, no `copy`, no signed-URL surface and no metadata bag —
 * the adapter needs bytes in, bytes out, a key list for auditing and a delete
 * for cleaning up a store it owns. Anything more would be surface Phase B has
 * to keep working for no current caller.
 *
 * ## Verification belongs on the read, and it is not optional
 *
 * `verifyRestoredVault` re-checks attachment content addresses, which is why a
 * corrupted attachment is refused by name today. It has no equivalent check for
 * *notes*: `CatalogNote` carries `text`, not a content address, so the contract
 * has nothing to recompute. Under this adapter note bytes are content-addressed
 * too, and nothing in the portable contract will catch a note whose bytes came
 * back wrong.
 *
 * So `readVerified` exists and the adapter uses it for every object, note and
 * attachment alike. A store's answer is checked, never trusted — the same rule
 * `verifyRestoredVault` states, applied one layer lower because at this layer
 * the contract cannot reach.
 */

/** An object-store key. The spike catalog currently requires stable requested keys. */
export type ObjectKey = string;

export interface StoredObject {
  readonly key: ObjectKey;
  readonly bytes: Uint8Array;
}

/**
 * Put, get, delete, list. Shaped for Vercel Blob.
 *
 * `put` returns the key the store actually assigned, which may not be the key
 * requested. The helper propagates the assigned key, but the spike catalog
 * currently derives its keys: its Blob wrapper disables random suffixes and
 * asserts that the assigned pathname matches. Arbitrary assigned-key stores
 * are not supported by that catalog yet.
 */
export interface ObjectStore {
  put(key: ObjectKey, bytes: Uint8Array, contentType: string): Promise<ObjectKey>;
  get(key: ObjectKey): Promise<Uint8Array | null>;
  delete(key: ObjectKey): Promise<void>;
  list(prefix: string): Promise<readonly ObjectKey[]>;
}

/** Why a verified read did not produce bytes. Each cause is named; none is collapsed into "failed". */
export type ObjectReadStatus =
  /** The store has no object at that key. A dangling catalog reference. */
  | "absent"
  /** The store produced bytes whose SHA-256 is not the address they were filed under. */
  | "address-mismatch"
  /** The store threw. Unreachable, unauthorized, or failing for a reason it does not name. */
  | "store-failed";

export type ObjectReadResult =
  | { readonly status: "ok"; readonly bytes: Uint8Array }
  | { readonly status: ObjectReadStatus; readonly key: ObjectKey; readonly contentAddress: ContentAddress };

/**
 * The canonical key for an object, before the store gets a say.
 *
 * Namespaced by vault so `list` can audit one vault without scanning every
 * other, and so a Phase B blob store can be scoped per vault by prefix. The
 * vault id is already constrained to `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}` by the
 * contract and the content address to 64 hex characters, so neither can
 * introduce a path separator, a `..` segment or a leading slash.
 */
export function objectKeyFor(vaultId: string, contentAddress: ContentAddress): ObjectKey {
  return `${vaultId}/objects/${contentAddress}`;
}

/**
 * Read an object and prove it is the object that was asked for.
 *
 * The digest is recomputed from the returned bytes every time. This is the
 * check that makes "content-addressed" a guarantee rather than a naming
 * convention on the read path, and it is the only such check a note ever gets.
 */
export async function readVerified(
  store: ObjectStore,
  key: ObjectKey,
  contentAddress: ContentAddress,
  digest: Digest = nodeDigest,
): Promise<ObjectReadResult> {
  let bytes: Uint8Array | null;
  try {
    bytes = await store.get(key);
  } catch {
    return { status: "store-failed", key, contentAddress };
  }
  if (bytes === null) return { status: "absent", key, contentAddress };
  if (digest.sha256Hex(bytes) !== contentAddress) return { status: "address-mismatch", key, contentAddress };
  return { status: "ok", bytes };
}

/**
 * Write an object, refusing to let one address come to mean two byte strings.
 *
 * The PostgreSQL schema enforces this with a primary key on
 * `(vault_id, content_address)` plus a `BEFORE UPDATE OR DELETE` trigger. A
 * blob store has neither. So the check is: read what is already at the key, and
 * if it is present and its bytes differ from the incoming bytes, refuse.
 *
 * **This is a check, not a lock, and the difference is load-bearing.** Two
 * writers racing on an absent key both observe absence and both write. That is
 * harmless *here* only because the caller has already proven, via
 * `validatePublication`, that the incoming bytes hash to the address — so two
 * racing writers are writing identical bytes by construction. The window is
 * real and the reason it is safe is a property of the caller, not of this
 * function. A caller that skipped validation would have no such guarantee, and
 * `putImmutable` cannot detect that it was skipped.
 */
export async function putImmutable(
  store: ObjectStore,
  key: ObjectKey,
  bytes: Uint8Array,
  contentType: string,
  contentAddress: ContentAddress,
  digest: Digest = nodeDigest,
): Promise<{ readonly status: "ok"; readonly key: ObjectKey } | { readonly status: "duplicate-with-mismatched-bytes" | "store-failed" }> {
  const existing = await readVerified(store, key, contentAddress, digest);
  if (existing.status === "ok") {
    // Already present and provably the same bytes. Re-uploading would be a
    // no-op at best and a window for a partial overwrite at worst.
    return bytesEqual(existing.bytes, bytes)
      ? { status: "ok", key }
      : { status: "duplicate-with-mismatched-bytes" };
  }
  // Present but hashing to something else: an address already means different
  // bytes. Refuse rather than overwrite — overwriting is the exact thing the
  // PostgreSQL trigger existed to prevent.
  if (existing.status === "address-mismatch") return { status: "duplicate-with-mismatched-bytes" };
  if (existing.status === "store-failed") return { status: "store-failed" };
  try {
    return { status: "ok", key: await store.put(key, bytes, contentType) };
  } catch {
    // An exclusive-create store can reject the losing cold upload, or the
    // response can be lost after storage succeeded. Only verified identical
    // bytes establish success; the exception alone tells us neither outcome.
    const winner = await readVerified(store, key, contentAddress, digest);
    if (winner.status === "ok") {
      return bytesEqual(winner.bytes, bytes)
        ? { status: "ok", key }
        : { status: "duplicate-with-mismatched-bytes" };
    }
    if (winner.status === "address-mismatch") return { status: "duplicate-with-mismatched-bytes" };
    return { status: "store-failed" };
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/* ------------------------------------------------------------ in memory */

/** An in-memory store. For unit tests and for a proof that wants no filesystem. */
export function createMemoryObjectStore(): ObjectStore & { readonly size: () => number } {
  const objects = new Map<ObjectKey, Uint8Array>();
  return {
    async put(key, bytes) {
      // Copied on the way in. A caller that mutates its buffer afterwards must
      // not retroactively change what the store holds — a filesystem store
      // could not be made to do that, so neither may this one.
      objects.set(key, Uint8Array.from(bytes));
      return key;
    },
    async get(key) {
      const found = objects.get(key);
      return found === undefined ? null : Uint8Array.from(found);
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
    size: () => objects.size,
  };
}

/* ------------------------------------------------------------ filesystem */

/**
 * A filesystem-backed store, rooted at one directory.
 *
 * Keys are `<vaultId>/objects/<contentAddress>` and become nested directories.
 * Both segments are already constrained by the contract's identifier and
 * content-address patterns, but this store re-checks rather than trusting its
 * caller: it is a store, and the whole discipline of this module is that a
 * store's inputs and outputs get checked at the boundary.
 */
const SAFE_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function createFilesystemObjectStore(root: string): ObjectStore {
  const resolveKey = (key: ObjectKey): string => {
    const segments = key.split("/");
    if (!segments.length || !segments.every((segment) => SAFE_KEY_SEGMENT.test(segment))) {
      throw new Error(`GEODE_CATALOG: object key ${JSON.stringify(key)} is not a safe relative key`);
    }
    return join(root, ...segments);
  };
  return {
    async put(key, bytes) {
      const file = resolveKey(key);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
      return key;
    },
    async get(key) {
      try {
        return new Uint8Array(await readFile(resolveKey(key)));
      } catch (error) {
        // Absence is a normal answer; anything else is the store failing and
        // must not be laundered into "there is nothing there".
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async delete(key) {
      await rm(resolveKey(key), { force: true });
    },
    async list(prefix) {
      const found: ObjectKey[] = [];
      const walk = async (relative: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(join(root, relative), { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        for (const entry of entries) {
          const key = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(key);
          else if (key.startsWith(prefix)) found.push(key);
        }
      };
      await walk("");
      return found.sort();
    },
  };
}
