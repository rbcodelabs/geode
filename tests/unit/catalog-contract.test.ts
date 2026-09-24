import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATALOG_LIMITS,
  nodeDigest,
  publish,
  validatePublication,
  type CatalogAsset,
  type CatalogLimits,
  type CatalogStore,
  type Digest,
  type PublishRequest,
  type ValidatedPublication,
} from "../../src/wiki/catalog-contract";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const otherBytes = new Uint8Array([9, 8, 7]);

const asset = (overrides: Partial<CatalogAsset> = {}): CatalogAsset => {
  const bytes = overrides.bytes ?? pngBytes;
  return {
    path: "assets/diagram.png",
    contentType: "image/png",
    contentAddress: sha(bytes),
    ...overrides,
    bytes,
  };
};

const request = (overrides: Partial<PublishRequest> = {}): PublishRequest => ({
  vaultId: "vault-a",
  mutationId: "m1",
  baseSequence: 0,
  notes: [{ path: "Index.md", text: "# Index\n\nSee [[Decision]].\n" }],
  assets: [asset()],
  ...overrides,
});

/** Records what reached the store, so "never contacted" is observed rather than assumed. */
function recordingStore(): { store: CatalogStore; seen: ValidatedPublication[] } {
  const seen: ValidatedPublication[] = [];
  return {
    seen,
    store: {
      commit: async (publication) => {
        seen.push(publication);
        return {
          status: "ok",
          receipt: {
            vaultId: publication.vaultId, mutationId: publication.mutationId, sequence: 1,
            digest: publication.digest, noteCount: publication.notes.length,
            assetCount: publication.assets.length,
          },
        };
      },
    },
  };
}

describe("validatePublication — accepting path", () => {
  it("accepts a multi-note publication carrying one binary asset", () => {
    const result = validatePublication(request());
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.publication.notes).toHaveLength(1);
    expect(result.publication.assets).toHaveLength(1);
    expect(result.publication.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("measures total bytes rather than trusting a declared size", () => {
    const text = "# Index\n";
    const result = validatePublication(request({ notes: [{ path: "Index.md", text }], assets: [asset()] }));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.publication.totalBytes).toBe(Buffer.byteLength(text, "utf8") + pngBytes.byteLength);
  });

  it("counts UTF-8 bytes, not code units, against the note limit", () => {
    // Four bytes per astral character, so a note well under the limit by
    // `String.length` can still be over it by bytes.
    const limits: CatalogLimits = { ...DEFAULT_CATALOG_LIMITS, maxNoteBytes: 8 };
    const result = validatePublication(
      request({ notes: [{ path: "A.md", text: "𝄞𝄞𝄞" }], assets: [] }),
      { limits },
    );
    expect(result).toMatchObject({ status: "oversize", limit: "note-bytes", observed: 12, allowed: 8 });
  });

  it("gives entry order and key order no effect on identity", () => {
    const notes = [{ path: "B.md", text: "b" }, { path: "A.md", text: "a" }];
    const forward = validatePublication(request({ notes, assets: [] }));
    const reversed = validatePublication(request({ notes: [...notes].reverse(), assets: [] }));
    expect(forward.status).toBe("ok");
    expect(reversed.status).toBe("ok");
    if (forward.status !== "ok" || reversed.status !== "ok") return;
    expect(reversed.publication.digest).toBe(forward.publication.digest);
  });

  it("changes identity when content, the base sequence, or an asset's address changes", () => {
    const original = validatePublication(request());
    const edited = validatePublication(request({ notes: [{ path: "Index.md", text: "changed" }] }));
    const rebased = validatePublication(request({ baseSequence: 7 }));
    const reasseted = validatePublication(request({ assets: [asset({ bytes: otherBytes })] }));
    const digests = [original, edited, rebased, reasseted].map((r) => (r.status === "ok" ? r.publication.digest : r.status));
    expect(new Set(digests).size).toBe(4);
  });

  it("does not put a mutation id or vault id into the payload digest", () => {
    // The digest answers "is this the same payload?", which is what makes an
    // identical retry provably identical. Identity lives in the key, not the hash.
    const a = validatePublication(request({ mutationId: "m1", vaultId: "vault-a" }));
    const b = validatePublication(request({ mutationId: "m2", vaultId: "vault-b" }));
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    if (a.status !== "ok" || b.status !== "ok") return;
    expect(b.publication.digest).toBe(a.publication.digest);
  });

  it("uses the injected digest rather than reaching for node:crypto directly", () => {
    const calls: number[] = [];
    const digest: Digest = {
      sha256Hex: (bytes) => { calls.push(bytes.byteLength); return nodeDigest.sha256Hex(bytes); },
    };
    const result = validatePublication(request(), { digest });
    expect(result.status).toBe("ok");
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("validatePublication — refusals", () => {
  const cases: Array<[string, PublishRequest, Record<string, unknown>]> = [
    ["invalid-vault-id", request({ vaultId: "has space" }), { status: "invalid-vault-id" }],
    ["invalid-vault-id on empty", request({ vaultId: "" }), { status: "invalid-vault-id" }],
    ["invalid-mutation-id", request({ mutationId: "a/b" }), { status: "invalid-mutation-id" }],
    ["invalid-sequence on negative", request({ baseSequence: -1 }), { status: "invalid-sequence" }],
    ["invalid-sequence on fractional", request({ baseSequence: 1.5 }), { status: "invalid-sequence" }],
    ["empty-publication", request({ notes: [], assets: [] }), { status: "empty-publication" }],
    ["empty-publication when both omitted", { vaultId: "v", mutationId: "m", baseSequence: 0 }, { status: "empty-publication" }],
    ["invalid-path on traversal", request({ notes: [{ path: "../Escape.md", text: "x" }], assets: [] }), { status: "invalid-path", path: "../Escape.md" }],
    ["invalid-path on absolute", request({ notes: [{ path: "/Escape.md", text: "x" }], assets: [] }), { status: "invalid-path" }],
    ["invalid-path on drive letter", request({ notes: [{ path: "C:/Escape.md", text: "x" }], assets: [] }), { status: "invalid-path" }],
    ["invalid-path on backslash", request({ notes: [{ path: "a\\b.md", text: "x" }], assets: [] }), { status: "invalid-path" }],
    ["invalid-path on NUL", request({ notes: [{ path: "a\0b.md", text: "x" }], assets: [] }), { status: "invalid-path" }],
    ["invalid-path on dot segment", request({ notes: [{ path: ".secret/N.md", text: "x" }], assets: [] }), { status: "invalid-path" }],
    ["invalid-path on node_modules", request({ notes: [{ path: "node_modules/N.md", text: "x" }], assets: [] }), { status: "invalid-path" }],
    ["invalid-path on unnormalized", request({ notes: [{ path: "a/./N.md", text: "x" }], assets: [] }), { status: "invalid-path" }],
    ["not-a-note", request({ notes: [{ path: "Image.png", text: "x" }], assets: [] }), { status: "not-a-note", path: "Image.png" }],
    ["invalid-note-text on NUL", request({ notes: [{ path: "A.md", text: "before\0after" }], assets: [] }), { status: "invalid-note-text", path: "A.md" }],
    ["invalid-note-text on a leading NUL", request({ notes: [{ path: "A.md", text: "\0" }], assets: [] }), { status: "invalid-note-text", path: "A.md" }],
    ["asset-is-a-note", request({ notes: [], assets: [asset({ path: "Sneaky.md" })] }), { status: "asset-is-a-note", path: "Sneaky.md" }],
    ["duplicate-path", request({ notes: [{ path: "A.md", text: "1" }, { path: "A.md", text: "2" }], assets: [] }), { status: "duplicate-path", path: "A.md" }],
    ["duplicate-path across kinds", request({ notes: [{ path: "A.md", text: "1" }], assets: [asset({ path: "A.md" })] }), { status: "asset-is-a-note" }],
    ["portability-collision", request({ notes: [{ path: "A.md", text: "1" }, { path: "a.md", text: "2" }], assets: [] }), { status: "portability-collision", path: "a.md" }],
    ["unsupported-content-type", request({ notes: [], assets: [asset({ contentType: "application/x-msdownload" })] }), { status: "unsupported-content-type", contentType: "application/x-msdownload" }],
    ["invalid-content-address on shape", request({ notes: [], assets: [asset({ contentAddress: "nope" })] }), { status: "invalid-content-address" }],
    ["invalid-content-address on uppercase hex", request({ notes: [], assets: [asset({ contentAddress: sha(pngBytes).toUpperCase() })] }), { status: "invalid-content-address" }],
    ["invalid-content-address on mismatch", request({ notes: [], assets: [asset({ contentAddress: sha(otherBytes) })] }), { status: "invalid-content-address" }],
    [
      "duplicate-with-mismatched-bytes",
      request({
        notes: [],
        assets: [asset({ path: "assets/a.png" }), asset({ path: "assets/b.png", bytes: otherBytes, contentAddress: sha(pngBytes) })],
      }),
      { status: "duplicate-with-mismatched-bytes", contentAddress: sha(pngBytes) },
    ],
  ];

  it.each(cases)("refuses %s", (_label, input, expected) => {
    expect(validatePublication(input)).toMatchObject(expected);
  });

  it("names which limit an oversize refusal tripped", () => {
    const limits: CatalogLimits = {
      ...DEFAULT_CATALOG_LIMITS, maxNoteBytes: 4, maxAssetBytes: 4, maxPublicationBytes: 6,
    };
    expect(validatePublication(request({ notes: [{ path: "A.md", text: "toolong" }], assets: [] }), { limits }))
      .toMatchObject({ status: "oversize", limit: "note-bytes", path: "A.md", observed: 7, allowed: 4 });
    expect(validatePublication(request({ notes: [], assets: [asset({ bytes: new Uint8Array(5) })] }), { limits }))
      .toMatchObject({ status: "oversize", limit: "asset-bytes", observed: 5, allowed: 4 });
    expect(validatePublication(request({ notes: [{ path: "A.md", text: "abcd" }], assets: [asset({ bytes: new Uint8Array(3) })] }), { limits }))
      .toMatchObject({ status: "oversize", limit: "publication-bytes", observed: 7, allowed: 6 });
  });

  it("refuses more entries than the publication limit allows", () => {
    const limits: CatalogLimits = { ...DEFAULT_CATALOG_LIMITS, maxPublicationEntries: 2 };
    const notes = [{ path: "A.md", text: "a" }, { path: "B.md", text: "b" }, { path: "C.md", text: "c" }];
    expect(validatePublication(request({ notes, assets: [] }), { limits }))
      .toMatchObject({ status: "entry-limit", observed: 3, allowed: 2 });
  });

  it("accepts nothing when the content-type allowlist is empty", () => {
    const limits: CatalogLimits = { ...DEFAULT_CATALOG_LIMITS, allowedContentTypes: [] };
    expect(validatePublication(request({ notes: [], assets: [asset()] }), { limits }))
      .toMatchObject({ status: "unsupported-content-type" });
  });

  it("prefers duplicate-with-mismatched-bytes over invalid-content-address when one address means two byte strings", () => {
    // Both refusals are technically true of this input. The immutability
    // violation is the more useful diagnosis, so the check order is load-bearing
    // rather than incidental.
    const result = validatePublication(request({
      notes: [],
      assets: [
        asset({ path: "assets/a.png", bytes: pngBytes, contentAddress: sha(otherBytes) }),
        asset({ path: "assets/b.png", bytes: otherBytes, contentAddress: sha(otherBytes) }),
      ],
    }));
    expect(result.status).toBe("duplicate-with-mismatched-bytes");
  });

  it("treats an identical asset published at two paths as legitimate deduplication", () => {
    const result = validatePublication(request({
      notes: [],
      assets: [asset({ path: "assets/a.png" }), asset({ path: "assets/b.png" })],
    }));
    expect(result.status).toBe("ok");
  });
});

describe("publish", () => {
  it("never contacts the store when validation refuses", async () => {
    const { store, seen } = recordingStore();
    const result = await publish(store, request({ notes: [{ path: "../Escape.md", text: "x" }], assets: [] }));
    expect(result).toMatchObject({ status: "invalid-path" });
    expect(seen).toHaveLength(0);
  });

  it("never contacts the store for a note whose text carries a NUL", async () => {
    // This is the case the refusal was added for. A `.md` file containing a
    // NUL captures cleanly, so without a validation-time check it travelled all
    // the way to the `::jsonb` cast, which rejects the escape `JSON.stringify`
    // produces for it — and came back as an unnamed `store-failed` from a
    // database that had already been contacted.
    const { store, seen } = recordingStore();
    const result = await publish(store, request({ notes: [{ path: "A.md", text: "a\0b" }], assets: [] }));
    expect(result).toMatchObject({ status: "invalid-note-text", path: "A.md" });
    expect(seen).toHaveLength(0);
  });

  it("hands the store exactly one validated publication when it accepts", async () => {
    const { store, seen } = recordingStore();
    const result = await publish(store, request());
    expect(result.status).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(seen[0].vaultId).toBe("vault-a");
    expect(seen[0].totalBytes).toBeGreaterThan(0);
  });

  it("returns a store refusal unchanged rather than reclassifying it", async () => {
    const store: CatalogStore = { commit: async () => ({ status: "conflict" }) };
    expect(await publish(store, request())).toEqual({ status: "conflict" });
  });
});
