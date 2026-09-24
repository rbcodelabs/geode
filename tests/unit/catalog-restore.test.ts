import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEFAULT_RESTORE_LIMITS,
  restore,
  verifyRestoredVault,
  type CatalogRestoreSource,
  type RawRestoredEntry,
  type RawRestoredVault,
  type RestoredVault,
} from "../../src/wiki/catalog-contract";
import { materializeRestoredVault } from "../../src/wiki/catalog-materialize";

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const otherBytes = new Uint8Array([9, 9, 9]);

const note = (overrides: Partial<RawRestoredEntry> = {}): RawRestoredEntry => ({
  path: "Index.md", kind: "note", text: "# Index\n\nSee [[Decision]].\n", ...overrides,
});
const attachment = (overrides: Partial<RawRestoredEntry> = {}): RawRestoredEntry => ({
  path: "assets/diagram.png", kind: "attachment", contentAddress: sha(pngBytes),
  contentType: "image/png", byteLength: pngBytes.byteLength, bytes: pngBytes, ...overrides,
});
const vault = (entries: RawRestoredEntry[], sequence = 7): RawRestoredVault => ({
  vaultId: "vault-a", sequence, entries,
});

describe("verifyRestoredVault — the accepting path", () => {
  it("returns notes and assets sorted by path, with measured bytes", () => {
    const result = verifyRestoredVault(vault([attachment(), note({ path: "Zeta.md" }), note()]));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.vault.notes.map((entry) => entry.path)).toEqual(["Index.md", "Zeta.md"]);
    expect(result.vault.assets.map((entry) => entry.path)).toEqual(["assets/diagram.png"]);
    expect(result.vault.sequence).toBe(7);
    expect(result.vault.totalBytes).toBe(
      Buffer.byteLength(note().text as string, "utf8") * 2 + pngBytes.byteLength,
    );
  });

  it("accepts two paths sharing one content address when the bytes agree", () => {
    // One stored object, two files. Refusing this would make attachment
    // deduplication impossible, so it has to be the accepting case.
    const result = verifyRestoredVault(vault([attachment(), attachment({ path: "assets/copy.png" })]));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.vault.assets).toHaveLength(2);
    expect(new Set(result.vault.assets.map((asset) => asset.contentAddress)).size).toBe(1);
  });

  it("ignores a recorded byte length the store did not supply", () => {
    // A store that does not track lengths is not thereby corrupt.
    expect(verifyRestoredVault(vault([attachment({ byteLength: null })])).status).toBe("ok");
  });
});

describe("verifyRestoredVault — refusals", () => {
  it.each<[string, RawRestoredVault, string]>([
    ["a vault id that is not a portable identifier", { vaultId: "has space", sequence: 1, entries: [note()] }, "invalid-vault-id"],
    ["a vault with no entries", vault([], 0), "absent"],
    ["a sequence of zero on a vault that has entries", vault([note()], 0), "invalid-sequence"],
    ["a non-integer sequence", vault([note()], 1.5), "invalid-sequence"],
    ["a kind the contract has never heard of", vault([note({ kind: "symlink" })]), "unknown-entry-kind"],
    ["a path that escapes the vault", vault([note({ path: "../Escape.md" })]), "invalid-path"],
    ["a dot-prefixed path the capture walk would never see", vault([note({ path: ".git/Note.md" })]), "invalid-path"],
    ["a path inside node_modules", vault([note({ path: "node_modules/Note.md" })]), "invalid-path"],
    ["a note whose path is not markdown", vault([note({ path: "Image.png" })]), "not-a-note"],
    ["an attachment whose path is markdown", vault([attachment({ path: "Sneaky.md" })]), "asset-is-a-note"],
    ["two entries at one path", vault([note(), note({ text: "different" })]), "duplicate-path"],
    ["two paths that fold onto one identity", vault([note(), note({ path: "INDEX.md" })]), "portability-collision"],
    ["a note with no text", vault([note({ text: null })]), "incomplete-entry"],
    ["an attachment with no content type", vault([attachment({ contentType: null })]), "incomplete-entry"],
    ["an attachment with no content address", vault([attachment({ contentAddress: null })]), "incomplete-entry"],
    ["an attachment whose bytes the store could not produce", vault([attachment({ bytes: null })]), "missing-object"],
    ["a recorded length that disagrees with the bytes", vault([attachment({ byteLength: 99 })]), "byte-length-mismatch"],
    ["a content type outside the allowlist", vault([attachment({ contentType: "application/x-msdownload" })]), "unsupported-content-type"],
    ["an address that is not 64 hex characters", vault([attachment({ contentAddress: "nope" })]), "invalid-content-address"],
    ["an address that does not describe the bytes", vault([attachment({ contentAddress: sha(otherBytes) })]), "invalid-content-address"],
    [
      "one address describing two byte strings",
      vault([attachment(), attachment({ path: "assets/b.png", bytes: otherBytes, byteLength: otherBytes.byteLength })]),
      "duplicate-with-mismatched-bytes",
    ],
  ])("refuses %s with its own status", (_label, raw, expected) => {
    expect(verifyRestoredVault(raw).status).toBe(expected);
  });

  it("names which ceiling an oversize restore tripped", () => {
    const big = verifyRestoredVault(vault([note({ text: "x".repeat(20) })]), {
      limits: { ...DEFAULT_RESTORE_LIMITS, maxNoteBytes: 4 },
    });
    expect(big).toMatchObject({ status: "oversize", limit: "note-bytes", path: "Index.md", observed: 20, allowed: 4 });

    const fat = verifyRestoredVault(vault([attachment()]), {
      limits: { ...DEFAULT_RESTORE_LIMITS, maxAssetBytes: 4 },
    });
    expect(fat).toMatchObject({ status: "oversize", limit: "asset-bytes", allowed: 4 });

    // The whole-vault ceiling is its own cause: a vault can be legitimately
    // larger than any single publication that built it.
    const whole = verifyRestoredVault(vault([note()]), {
      limits: { ...DEFAULT_RESTORE_LIMITS, maxVaultBytes: 1 },
    });
    expect(whole).toMatchObject({ status: "oversize", limit: "vault-bytes", allowed: 1 });
  });

  it("refuses a vault carrying more entries than the ceiling allows", () => {
    const many = Array.from({ length: 5 }, (_unused, index) => note({ path: `N-${index}.md` }));
    expect(verifyRestoredVault(vault(many), { limits: { ...DEFAULT_RESTORE_LIMITS, maxEntries: 4 } }))
      .toMatchObject({ status: "entry-limit", observed: 5, allowed: 4 });
  });

  it("diagnoses a truncated read against the store's own recorded length before the digest", () => {
    // A truncated read trips both checks. The store contradicting its own
    // metadata is the sharper diagnosis, and pinning the order here stops a
    // later refactor from silently downgrading it to `invalid-content-address`.
    const truncated = verifyRestoredVault(vault([attachment({ bytes: pngBytes.slice(0, 4) })]));
    expect(truncated.status).toBe("byte-length-mismatch");
    expect(truncated).toMatchObject({ observed: 4, allowed: pngBytes.byteLength });

    // With no recorded length to contradict, the digest is what catches it.
    expect(verifyRestoredVault(vault([attachment({ bytes: pngBytes.slice(0, 4), byteLength: 4 })])).status)
      .toBe("invalid-content-address");
  });

  it("carries the offending path and address on a refusal rather than a formatted message", () => {
    expect(verifyRestoredVault(vault([attachment({ contentAddress: sha(otherBytes) })])))
      .toMatchObject({ status: "invalid-content-address", path: "assets/diagram.png", contentAddress: sha(otherBytes) });
  });

  it("does not throw on a store that returns structurally impossible rows", () => {
    // The loose typing on `RawRestoredEntry` exists for exactly this: a store
    // returning nonsense must be refused, not crash the caller.
    const nonsense = { vaultId: "vault-a", sequence: 1, entries: [{ path: "", kind: "" }] } as RawRestoredVault;
    expect(() => verifyRestoredVault(nonsense)).not.toThrow();
    expect(verifyRestoredVault(nonsense).status).toBe("unknown-entry-kind");
  });
});

describe("restore", () => {
  const asked: string[] = [];
  const source: CatalogRestoreSource = {
    restore: async (vaultId) => { asked.push(vaultId); return verifyRestoredVault(vault([note(), attachment()])); },
  };

  it("refuses a malformed vault id without contacting the source at all", async () => {
    asked.length = 0;
    expect((await restore(source, "has space")).status).toBe("invalid-vault-id");
    expect((await restore(source, "")).status).toBe("invalid-vault-id");
    expect((await restore(source, "-leading-dash")).status).toBe("invalid-vault-id");
    expect(asked).toEqual([]);
  });

  it("reaches the source exactly once for a well-formed vault id", async () => {
    asked.length = 0;
    expect((await restore(source, "vault-a")).status).toBe("ok");
    expect(asked).toEqual(["vault-a"]);
  });
});

describe("materializeRestoredVault", () => {
  const roots: string[] = [];
  const freshRoot = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "geode-materialize-"));
    roots.push(root);
    return root;
  };
  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  const restored: RestoredVault = {
    vaultId: "vault-a", sequence: 2, totalBytes: 0,
    notes: [
      { path: "Index.md", text: "# Index\n\nSee [[Deep note]].\n" },
      { path: "notes/Deep note.md", text: "Unicode: café 日本語\r\nTrailing newline kept.\n" },
    ],
    assets: [
      { path: "assets/diagram.png", contentAddress: sha(pngBytes), contentType: "image/png", bytes: pngBytes },
      { path: "assets/copy.png", contentAddress: sha(pngBytes), contentType: "image/png", bytes: pngBytes },
    ],
  };

  it("writes every entry, creating intermediate directories", async () => {
    const root = await freshRoot();
    expect(await materializeRestoredVault(root, restored))
      .toMatchObject({ status: "ok", noteCount: 2, assetCount: 2 });
    expect(await readFile(join(root, "notes/Deep note.md"), "utf8")).toBe(restored.notes[1].text);
    expect(new Uint8Array(await readFile(join(root, "assets/copy.png")))).toEqual(pngBytes);
  });

  it("round-trips note bytes exactly, including CRLF and a trailing newline", async () => {
    const root = await freshRoot();
    await materializeRestoredVault(root, restored);
    // Compared as bytes, not as a decoded string: a materializer that
    // normalized line endings or appended a newline would still produce an
    // equal string under some comparisons, and must not pass here.
    const written = new Uint8Array(await readFile(join(root, "notes/Deep note.md")));
    expect(written).toEqual(new Uint8Array(Buffer.from(restored.notes[1].text, "utf8")));
  });

  it("refuses a path that would escape the root, before writing it", async () => {
    const root = await freshRoot();
    const escaping: RestoredVault = {
      ...restored, notes: [{ path: "../escaped.md", text: "nope" }], assets: [],
    };
    expect(await materializeRestoredVault(root, escaping))
      .toMatchObject({ status: "escaping-path", path: "../escaped.md", noteCount: 0 });
  });

  it("refuses to write through a pre-existing symlinked directory", async () => {
    // The gap `O_EXCL` alone leaves open. `O_EXCL` refuses a symlink planted at
    // the *final* component, and lexical containment only inspects how the path
    // is spelled — so with a parent directory replaced by a symlink,
    // `mkdir(..., { recursive: true })` walks straight through it and
    // `assets/diagram.png` lands wherever it points.
    const root = await freshRoot();
    const outside = await freshRoot();
    await symlink(outside, join(root, "assets"), "dir");

    expect(await materializeRestoredVault(root, restored))
      .toMatchObject({ status: "escaping-path", path: "assets/diagram.png" });
    // The claim that matters is not the status but the absence of the file.
    await expect(readFile(join(outside, "diagram.png"))).rejects.toThrow();
  });

  it("refuses a symlink planted at the final component rather than following it", async () => {
    const root = await freshRoot();
    const outside = await freshRoot();
    await symlink(join(outside, "planted.md"), join(root, "Index.md"), "file");

    expect(await materializeRestoredVault(root, restored))
      .toMatchObject({ status: "write-failed", path: "Index.md" });
    await expect(readFile(join(outside, "planted.md"))).rejects.toThrow();
  });

  it("writes into a symlinked target root the caller chose, which is not an escape", async () => {
    // Containment is measured against the root's *resolved* path, so a caller
    // that legitimately hands over a symlinked directory is served rather than
    // refused. Anchoring on the unresolved string would break this.
    const real = await freshRoot();
    const link = join(await freshRoot(), "vault-link");
    await symlink(real, link, "dir");

    expect(await materializeRestoredVault(link, restored))
      .toMatchObject({ status: "ok", noteCount: 2, assetCount: 2 });
    expect(new Uint8Array(await readFile(join(real, "assets/copy.png")))).toEqual(pngBytes);
  });

  it("refuses rather than overwrites when an entry already exists", async () => {
    const root = await freshRoot();
    await writeFile(join(root, "Index.md"), "someone was here first", "utf8");
    expect(await materializeRestoredVault(root, restored))
      .toMatchObject({ status: "write-failed", path: "Index.md" });
    // The pre-existing file is untouched: materialization is exclusive-create,
    // so a target folder that is not actually empty fails loudly.
    expect(await readFile(join(root, "Index.md"), "utf8")).toBe("someone was here first");
  });
});
