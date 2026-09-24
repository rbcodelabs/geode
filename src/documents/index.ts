import { createHash } from "node:crypto";
import { objectKeyFor, putImmutable, readVerified } from "../catalog/object-store";

/** Server-only immutable reference. It is not an authorization capability. */
export interface DocumentContentReference {
  readonly version: 1;
  readonly namespace: string;
  readonly digest: string;
  readonly byteLength: number;
}
/** Implementations must bound network time and bytes and create objects exclusively. */
export interface DocumentObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  get(key: string): Promise<Uint8Array | null>;
}
export interface DocumentStoreOptions {
  readonly namespace: string;
  readonly objects: DocumentObjectStore;
  readonly maxContentBytes: number;
}
export type PutContentResult =
  | { readonly status: "ok"; readonly reference: DocumentContentReference }
  | { readonly status: "invalid" | "oversized" | "integrity-failure" | "unavailable" };
export type ReadContentResult =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "invalid" | "namespace-mismatch" | "oversized" | "missing" | "integrity-failure" | "unavailable" };
export interface DocumentStore {
  putContent(text: string): Promise<PutContentResult>;
  readContent(reference: unknown): Promise<ReadContentResult>;
}

const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
function validReference(value: unknown): value is DocumentContentReference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Partial<DocumentContentReference>;
  return ref.version === 1 && typeof ref.namespace === "string" && NAMESPACE.test(ref.namespace)
    && typeof ref.digest === "string" && /^[a-f0-9]{64}$/.test(ref.digest)
    && Number.isSafeInteger(ref.byteLength) && ref.byteLength! >= 0;
}

/** The caller authorizes the workspace first and atomically commits this reference in its own database. */
export function createDocumentStore(options: DocumentStoreOptions): DocumentStore {
  const { namespace, objects, maxContentBytes } = options;
  if (typeof namespace !== "string" || !NAMESPACE.test(namespace) || !Number.isSafeInteger(maxContentBytes) || maxContentBytes <= 0) {
    throw new Error("Invalid document store configuration");
  }
  return {
    async putContent(text) {
      if (typeof text !== "string") return { status: "invalid" };
      if (Buffer.byteLength(text, "utf8") > maxContentBytes) return { status: "oversized" };
      const bytes = Buffer.from(text, "utf8");
      // JavaScript lone surrogates are replaced by UTF-8 encoding. Refuse lossy saves.
      if (bytes.toString("utf8") !== text) return { status: "invalid" };
      const digest = createHash("sha256").update(bytes).digest("hex");
      const key = objectKeyFor(namespace, digest);
      const stored = await putImmutable(objects, key, bytes, "text/markdown; charset=utf-8", digest);
      if (stored.status === "store-failed") return { status: "unavailable" };
      if (stored.status !== "ok" || stored.key !== key) return { status: "integrity-failure" };
      // A successful upload acknowledgement alone does not prove durable readable bytes.
      const verified = await readVerified(objects, key, digest);
      if (verified.status === "store-failed" || verified.status === "absent") return { status: "unavailable" };
      if (verified.status !== "ok" || verified.bytes.byteLength !== bytes.byteLength) return { status: "integrity-failure" };
      return { status: "ok", reference: { version: 1, namespace, digest, byteLength: bytes.byteLength } };
    },
    async readContent(reference) {
      if (!validReference(reference)) return { status: "invalid" };
      if (reference.namespace !== namespace) return { status: "namespace-mismatch" };
      if (reference.byteLength > maxContentBytes) return { status: "oversized" };
      const result = await readVerified(objects, objectKeyFor(namespace, reference.digest), reference.digest);
      if (result.status === "absent") return { status: "missing" };
      if (result.status === "store-failed") return { status: "unavailable" };
      if (result.status !== "ok" || result.bytes.byteLength !== reference.byteLength) return { status: "integrity-failure" };
      try {
        // ignoreBOM=true preserves the BOM as text instead of silently stripping it.
        return { status: "ok", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.bytes) };
      } catch { return { status: "integrity-failure" }; }
    },
  };
}
