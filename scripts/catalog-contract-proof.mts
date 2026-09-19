import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  DEFAULT_CATALOG_LIMITS,
  DEFAULT_RESTORE_LIMITS,
  publish,
  restore,
  validatePublication,
  verifyRestoredVault,
  type CatalogAsset,
  type CatalogRestoreSource,
  type CatalogStore,
  type PublishRequest,
  type RawRestoredEntry,
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
  invalidNoteText: validatePublication({ ...base, notes: [{ path: "Index.md", text: "a\u0000b" }], assets: [] }),
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
    invalidNoteText: "invalid-note-text",
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

// --- The restore side, equally database-free --------------------------------
// The same discipline in the other direction: a store's answer is checked, not
// trusted, and every way it can be wrong has its own name. None of this needs
// a database, so none of it waits for one.
const entry = (overrides: Partial<RawRestoredEntry> = {}): RawRestoredEntry => ({
  path: "assets/diagram.png", kind: "attachment", contentAddress: sha(pngBytes),
  contentType: "image/png", byteLength: pngBytes.byteLength, bytes: pngBytes, ...overrides,
});
const noteEntry = (overrides: Partial<RawRestoredEntry> = {}): RawRestoredEntry => ({
  path: "Index.md", kind: "note", text: "# Index\n\nSee [[Decision]].\n", ...overrides,
});
const vault = (entries: RawRestoredEntry[], sequence = 4) => ({ vaultId: "vault-a", sequence, entries });

const restored = verifyRestoredVault(vault([noteEntry(), entry()]));
assert.equal(restored.status, "ok", "a well-formed restored vault must verify");
if (restored.status !== "ok") throw new Error("unreachable");
assert.equal(restored.vault.notes.length, 1);
assert.equal(restored.vault.assets.length, 1);
assert.equal(restored.vault.sequence, 4, "the restored sequence comes from the store, not from a guess");
assert.equal(
  restored.vault.totalBytes,
  Buffer.byteLength(noteEntry().text as string, "utf8") + pngBytes.byteLength,
  "restored bytes must be measured on the way out",
);

// Two paths sharing one content address is the *accepting* case: one stored
// object, two files. Refusing it would make attachment dedup impossible.
const shared = verifyRestoredVault(vault([entry(), entry({ path: "assets/copy.png" })]));
assert.equal(shared.status, "ok", "two paths may share one content address when the bytes agree");

const restoreRefusals = {
  invalidVaultId: verifyRestoredVault({ vaultId: "has space", sequence: 1, entries: [noteEntry()] }),
  absent: verifyRestoredVault(vault([], 0)),
  invalidSequence: verifyRestoredVault(vault([noteEntry()], 0)),
  entryLimit: verifyRestoredVault(
    vault(Array.from({ length: 5 }, (_unused, index) => noteEntry({ path: `N-${index}.md` }))),
    { limits: { ...DEFAULT_RESTORE_LIMITS, maxEntries: 4 } },
  ),
  unknownEntryKind: verifyRestoredVault(vault([noteEntry({ kind: "directory" })])),
  invalidPath: verifyRestoredVault(vault([noteEntry({ path: "../Escape.md" })])),
  invalidPathDotted: verifyRestoredVault(vault([noteEntry({ path: ".secret/Note.md" })])),
  notANote: verifyRestoredVault(vault([noteEntry({ path: "Image.png" })])),
  assetIsANote: verifyRestoredVault(vault([entry({ path: "Sneaky.md" })])),
  duplicatePath: verifyRestoredVault(vault([noteEntry(), noteEntry({ text: "different" })])),
  portabilityCollision: verifyRestoredVault(vault([noteEntry(), noteEntry({ path: "INDEX.md" })])),
  incompleteNote: verifyRestoredVault(vault([noteEntry({ text: null })])),
  incompleteAsset: verifyRestoredVault(vault([entry({ contentType: null })])),
  missingObject: verifyRestoredVault(vault([entry({ bytes: null })])),
  byteLengthMismatch: verifyRestoredVault(vault([entry({ byteLength: pngBytes.byteLength + 1 })])),
  oversizeNote: verifyRestoredVault(vault([noteEntry({ text: "x".repeat(DEFAULT_RESTORE_LIMITS.maxNoteBytes + 1) })])),
  oversizeAsset: verifyRestoredVault(vault([entry({
    bytes: new Uint8Array(DEFAULT_RESTORE_LIMITS.maxAssetBytes + 1), byteLength: DEFAULT_RESTORE_LIMITS.maxAssetBytes + 1,
    contentAddress: sha(new Uint8Array(DEFAULT_RESTORE_LIMITS.maxAssetBytes + 1)),
  })])),
  unsupportedContentType: verifyRestoredVault(vault([entry({ contentType: "application/x-msdownload" })])),
  invalidContentAddress: verifyRestoredVault(vault([entry({ contentAddress: sha(otherBytes) })])),
  invalidContentAddressShape: verifyRestoredVault(vault([entry({ contentAddress: "not-a-hash" })])),
  duplicateWithMismatchedBytes: verifyRestoredVault(vault([
    entry(),
    entry({ path: "assets/b.png", bytes: otherBytes, byteLength: otherBytes.byteLength }),
  ])),
};

assert.deepEqual(
  Object.fromEntries(Object.entries(restoreRefusals).map(([name, result]) => [name, result.status])),
  {
    invalidVaultId: "invalid-vault-id",
    absent: "absent",
    invalidSequence: "invalid-sequence",
    entryLimit: "entry-limit",
    unknownEntryKind: "unknown-entry-kind",
    invalidPath: "invalid-path",
    invalidPathDotted: "invalid-path",
    notANote: "not-a-note",
    assetIsANote: "asset-is-a-note",
    duplicatePath: "duplicate-path",
    portabilityCollision: "portability-collision",
    incompleteNote: "incomplete-entry",
    incompleteAsset: "incomplete-entry",
    missingObject: "missing-object",
    byteLengthMismatch: "byte-length-mismatch",
    oversizeNote: "oversize",
    oversizeAsset: "oversize",
    unsupportedContentType: "unsupported-content-type",
    invalidContentAddress: "invalid-content-address",
    invalidContentAddressShape: "invalid-content-address",
    duplicateWithMismatchedBytes: "duplicate-with-mismatched-bytes",
  },
  "every restore refusal must be reported by its own distinct status",
);

// A truncated read trips both the recorded length and the digest. The store
// contradicting its own metadata is the sharper diagnosis, and this pins that
// order so a refactor cannot silently downgrade it to `invalid-content-address`.
const truncated = new Uint8Array(pngBytes.slice(0, 4));
assert.equal(
  verifyRestoredVault(vault([entry({ bytes: truncated })])).status,
  "byte-length-mismatch",
  "a truncated read must be diagnosed against the store's own recorded length first",
);

assert.deepEqual(
  ["oversizeNote", "oversizeAsset"].map((name) => (restoreRefusals[name as keyof typeof restoreRefusals] as { limit?: string }).limit),
  ["note-bytes", "asset-bytes"],
  "an oversize restore must name which limit it tripped",
);
assert.equal(
  (verifyRestoredVault(vault([noteEntry()]), { limits: { ...DEFAULT_RESTORE_LIMITS, maxVaultBytes: 1 } }) as { limit?: string }).limit,
  "vault-bytes",
  "the whole-vault ceiling is its own measurable cause",
);

// --- A refused restore never reaches the source -----------------------------
const asked: string[] = [];
const recordingSource: CatalogRestoreSource = {
  restore: async (vaultId) => { asked.push(vaultId); return verifyRestoredVault(vault([noteEntry(), entry()])); },
};
assert.equal((await restore(recordingSource, "has space")).status, "invalid-vault-id");
assert.equal(asked.length, 0, "a malformed vault id must not become a query");
assert.equal((await restore(recordingSource, "vault-a")).status, "ok");
assert.deepEqual(asked, ["vault-a"], "a valid vault id must reach the source exactly once");

console.log(JSON.stringify({
  nodeOnly: true,
  databaseFree: true,
  notes: accepted.publication.notes.length,
  assets: accepted.publication.assets.length,
  totalBytes: accepted.publication.totalBytes,
  refusalsObserved: Object.keys(refusals).length,
  distinctStatuses: new Set(Object.values(refusals).map((result) => result.status)).size,
  storeContactedAfterRefusal: false,
  restoreRefusalsObserved: Object.keys(restoreRefusals).length,
  restoreDistinctStatuses: new Set(Object.values(restoreRefusals).map((result) => result.status)).size,
  restoreSourceContactedAfterRefusal: false,
}));
