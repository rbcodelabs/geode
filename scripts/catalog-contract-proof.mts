import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  DEFAULT_CATALOG_LIMITS,
  publish,
  validatePublication,
  type CatalogAsset,
  type CatalogStore,
  type PublishRequest,
  type ValidatedPublication,
} from "../src/wiki/catalog-contract";

// Fresh Node, no host, and — the point of this particular proof — no database.
// Every refusal below is decided by the portable contract alone.
assert.ok(!("window" in globalThis), "window must not exist");
assert.ok(!("document" in globalThis), "document must not exist");
assert.equal(process.versions.electron, undefined, "must not run under Electron");

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const asset = (overrides: Partial<CatalogAsset> & { bytes: Uint8Array }): CatalogAsset => ({
  path: "assets/diagram.png",
  contentAddress: sha(overrides.bytes),
  contentType: "image/png",
  ...overrides,
});

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const base: PublishRequest = {
  vaultId: "vault-a",
  mutationId: "m1",
  baseSequence: 0,
  notes: [
    { path: "Index.md", text: "# Index\n\nSee [[Decision]] and ![[assets/diagram.png]].\n" },
    { path: "Decision.md", text: "---\naliases: [Choice]\n---\n\n# Decision\n\nBack to [[Index]].\n" },
  ],
  assets: [asset({ bytes: pngBytes })],
};

// --- The accepting path -----------------------------------------------------
const accepted = validatePublication(base);
assert.equal(accepted.status, "ok", "a well-formed multi-note publication with one asset must validate");
if (accepted.status !== "ok") throw new Error("unreachable");
assert.equal(accepted.publication.notes.length, 2);
assert.equal(accepted.publication.assets.length, 1);
assert.equal(
  accepted.publication.totalBytes,
  base.notes!.reduce((total, note) => total + Buffer.byteLength(note.text, "utf8"), 0) + pngBytes.byteLength,
  "totalBytes must be measured, not declared",
);

// The digest is an identity, so entry order and object key order must not move it.
const reordered = validatePublication({
  ...base,
  notes: [...base.notes!].reverse(),
});
assert.equal(reordered.status, "ok");
if (reordered.status !== "ok") throw new Error("unreachable");
assert.equal(reordered.publication.digest, accepted.publication.digest, "entry order must not change identity");

const changed = validatePublication({
  ...base,
  notes: [{ ...base.notes![0], text: "# Index\n\nEdited.\n" }, base.notes![1]],
});
assert.equal(changed.status, "ok");
if (changed.status !== "ok") throw new Error("unreachable");
assert.notEqual(changed.publication.digest, accepted.publication.digest, "changed content must change identity");

const differentBase = validatePublication({ ...base, baseSequence: 1 });
assert.equal(differentBase.status, "ok");
if (differentBase.status !== "ok") throw new Error("unreachable");
assert.notEqual(differentBase.publication.digest, accepted.publication.digest, "the base is part of identity");

// --- Every refusal, by its own name ----------------------------------------
const oversizeNote = "x".repeat(DEFAULT_CATALOG_LIMITS.maxNoteBytes + 1);
const otherBytes = new Uint8Array([9, 9, 9]);

const refusals = {
  invalidVaultId: validatePublication({ ...base, vaultId: "has space" }),
  invalidMutationId: validatePublication({ ...base, mutationId: "" }),
  invalidSequence: validatePublication({ ...base, baseSequence: -1 }),
  emptyPublication: validatePublication({ ...base, notes: [], assets: [] }),
  invalidPathTraversal: validatePublication({ ...base, notes: [{ path: "../Escape.md", text: "x" }], assets: [] }),
  invalidPathAbsolute: validatePublication({ ...base, notes: [{ path: "/Escape.md", text: "x" }], assets: [] }),
  invalidPathDotted: validatePublication({ ...base, notes: [{ path: ".secret/Note.md", text: "x" }], assets: [] }),
  notANote: validatePublication({ ...base, notes: [{ path: "Image.png", text: "x" }], assets: [] }),
  assetIsANote: validatePublication({ ...base, notes: [], assets: [asset({ path: "Sneaky.md", bytes: pngBytes })] }),
  duplicatePath: validatePublication({
    ...base,
    notes: [{ path: "Index.md", text: "a" }, { path: "Index.md", text: "b" }],
    assets: [],
  }),
  portabilityCollision: validatePublication({
    ...base,
    notes: [{ path: "Index.md", text: "a" }, { path: "INDEX.md", text: "b" }],
    assets: [],
  }),
  oversizeNote: validatePublication({ ...base, notes: [{ path: "Big.md", text: oversizeNote }], assets: [] }),
  oversizeAsset: validatePublication({
    ...base, notes: [],
    assets: [asset({ bytes: new Uint8Array(DEFAULT_CATALOG_LIMITS.maxAssetBytes + 1) })],
  }),
  oversizePublication: validatePublication({
    ...base, assets: [],
    notes: Array.from({ length: 40 }, (_unused, index) => ({
      path: `Bulk-${index}.md`,
      text: "y".repeat(DEFAULT_CATALOG_LIMITS.maxNoteBytes),
    })),
  }),
  entryLimit: validatePublication({
    ...base, assets: [],
    notes: Array.from({ length: DEFAULT_CATALOG_LIMITS.maxPublicationEntries + 1 }, (_unused, index) => ({
      path: `N-${index}.md`, text: "y",
    })),
  }),
  unsupportedContentType: validatePublication({
    ...base, notes: [],
    assets: [asset({ bytes: pngBytes, contentType: "application/x-msdownload" })],
  }),
  invalidContentAddressShape: validatePublication({
    ...base, notes: [], assets: [asset({ bytes: pngBytes, contentAddress: "not-a-hash" })],
  }),
  invalidContentAddressMismatch: validatePublication({
    ...base, notes: [], assets: [asset({ bytes: pngBytes, contentAddress: sha(otherBytes) })],
  }),
  duplicateWithMismatchedBytes: validatePublication({
    ...base, notes: [],
    assets: [
      asset({ path: "assets/a.png", bytes: pngBytes }),
      asset({ path: "assets/b.png", bytes: otherBytes, contentAddress: sha(pngBytes) }),
    ],
  }),
};

assert.deepEqual(
  Object.fromEntries(Object.entries(refusals).map(([name, result]) => [name, result.status])),
  {
    invalidVaultId: "invalid-vault-id",
    invalidMutationId: "invalid-mutation-id",
    invalidSequence: "invalid-sequence",
    emptyPublication: "empty-publication",
    invalidPathTraversal: "invalid-path",
    invalidPathAbsolute: "invalid-path",
    invalidPathDotted: "invalid-path",
    notANote: "not-a-note",
    assetIsANote: "asset-is-a-note",
    duplicatePath: "duplicate-path",
    portabilityCollision: "portability-collision",
    oversizeNote: "oversize",
    oversizeAsset: "oversize",
    oversizePublication: "oversize",
    entryLimit: "entry-limit",
    unsupportedContentType: "unsupported-content-type",
    invalidContentAddressShape: "invalid-content-address",
    invalidContentAddressMismatch: "invalid-content-address",
    duplicateWithMismatchedBytes: "duplicate-with-mismatched-bytes",
  },
  "every refusal must be reported by its own distinct status",
);

// `oversize` is one status with three measurable causes; the cause is reported.
assert.deepEqual(
  ["oversizeNote", "oversizeAsset", "oversizePublication"].map(
    (name) => (refusals[name as keyof typeof refusals] as { limit?: string }).limit,
  ),
  ["note-bytes", "asset-bytes", "publication-bytes"],
  "an oversize refusal must name which limit it tripped",
);

// --- A refused publication never reaches the store --------------------------
const contacted: ValidatedPublication[] = [];
const recordingStore: CatalogStore = {
  commit: async (publication) => {
    contacted.push(publication);
    return {
      status: "ok",
      receipt: {
        vaultId: publication.vaultId, mutationId: publication.mutationId, sequence: 1,
        digest: publication.digest, noteCount: publication.notes.length, assetCount: publication.assets.length,
      },
    };
  },
};

const refused = await publish(recordingStore, { ...base, notes: [{ path: "../Escape.md", text: "x" }], assets: [] });
assert.equal(refused.status, "invalid-path", "a malformed publication must be refused before the store");
assert.equal(contacted.length, 0, "a refused publication must not contact the store at all");

const passed = await publish(recordingStore, base);
assert.equal(passed.status, "ok");
assert.equal(contacted.length, 1, "a valid publication must reach the store exactly once");
assert.equal(contacted[0].digest, accepted.publication.digest);

console.log(JSON.stringify({
  nodeOnly: true,
  databaseFree: true,
  notes: accepted.publication.notes.length,
  assets: accepted.publication.assets.length,
  totalBytes: accepted.publication.totalBytes,
  refusalsObserved: Object.keys(refusals).length,
  distinctStatuses: new Set(Object.values(refusals).map((result) => result.status)).size,
  storeContactedAfterRefusal: false,
}));
