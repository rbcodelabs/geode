import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  METADATA_DB_RELATIVE_PATH,
  deleteMetadataEntries,
  deleteMetadataEntry,
  openMetadataDb,
  readAllMetadataEntries,
  readMetadataStats,
  replaceAllMetadataEntries,
  upsertMetadataEntries,
} from "../../src/main/metadata-cache-store";
import { METADATA_INDEX_SCHEMA_VERSION, type PersistedMetadataIndexEntry } from "../../src/indexer/metadata-indexer";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "geode-metadata-cache-"));
  roots.push(root);
  return root;
}

const metadata = { frontmatterEndOffset: 0, links: [], embeds: [], tags: [], headings: [], aliases: [] };

function entry(overrides: Partial<PersistedMetadataIndexEntry> = {}): PersistedMetadataIndexEntry {
  return { mtimeMs: 1, size: 4, metadata, ...overrides };
}

describe("metadata cache store", () => {
  it("creates the database file (and parent directory) on first open, at the expected path", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      const target = path.join(root, METADATA_DB_RELATIVE_PATH);
      await expect(fsp.access(target)).resolves.toBeUndefined();
      expect(target).toBe(path.join(root, ".geode", "metadata-cache", "index.sqlite"));
    } finally {
      db.close();
    }
  });

  it("round-trips an upserted entry through readAllMetadataEntries", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      upsertMetadataEntries(db, { "A.md": entry({ mentionKeys: ["w:a"] }) });
      const snapshot = readAllMetadataEntries(db);
      expect(snapshot).toEqual({
        schemaVersion: METADATA_INDEX_SCHEMA_VERSION,
        entries: { "A.md": entry({ mentionKeys: ["w:a"] }) },
      });
    } finally {
      db.close();
    }
  });

  it("omits mentionKeys (rather than emitting null) for an entry that never had them", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      upsertMetadataEntries(db, { "A.md": entry() });
      const snapshot = readAllMetadataEntries(db);
      expect(snapshot.entries["A.md"]).not.toHaveProperty("mentionKeys");
    } finally {
      db.close();
    }
  });

  it("upsert overwrites an existing row for the same path (ON CONFLICT update, not a duplicate row)", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      upsertMetadataEntries(db, { "A.md": entry({ size: 4 }) });
      upsertMetadataEntries(db, { "A.md": entry({ size: 99 }) });
      const snapshot = readAllMetadataEntries(db);
      expect(Object.keys(snapshot.entries)).toEqual(["A.md"]);
      expect(snapshot.entries["A.md"].size).toBe(99);
    } finally {
      db.close();
    }
  });

  it("readMetadataStats returns only path/mtimeMs/size, without parsing metadata_json", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      upsertMetadataEntries(db, { "A.md": entry({ mtimeMs: 42, size: 7 }) });
      expect(readMetadataStats(db)).toEqual([{ path: "A.md", mtimeMs: 42, size: 7 }]);
    } finally {
      db.close();
    }
  });

  it("deleteMetadataEntry removes exactly the named row", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      upsertMetadataEntries(db, { "A.md": entry(), "B.md": entry() });
      deleteMetadataEntry(db, "A.md");
      expect(Object.keys(readAllMetadataEntries(db).entries)).toEqual(["B.md"]);
    } finally {
      db.close();
    }
  });

  it("deleteMetadataEntries removes multiple rows in one transaction and is a no-op for an empty list", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      upsertMetadataEntries(db, { "A.md": entry(), "B.md": entry(), "C.md": entry() });
      deleteMetadataEntries(db, ["A.md", "C.md"]);
      expect(Object.keys(readAllMetadataEntries(db).entries)).toEqual(["B.md"]);
      expect(() => deleteMetadataEntries(db, [])).not.toThrow();
      expect(Object.keys(readAllMetadataEntries(db).entries)).toEqual(["B.md"]);
    } finally {
      db.close();
    }
  });

  it("replaceAllMetadataEntries atomically replaces the whole table, dropping rows absent from the new snapshot", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      upsertMetadataEntries(db, { "Old.md": entry(), "Kept.md": entry({ size: 1 }) });
      replaceAllMetadataEntries(db, {
        schemaVersion: METADATA_INDEX_SCHEMA_VERSION,
        entries: { "Kept.md": entry({ size: 2 }), "New.md": entry() },
      });
      const snapshot = readAllMetadataEntries(db);
      expect(Object.keys(snapshot.entries).sort()).toEqual(["Kept.md", "New.md"]);
      expect(snapshot.entries["Kept.md"].size).toBe(2);
    } finally {
      db.close();
    }
  });

  it("treats a missing/never-created database file as a cache miss (empty entries, not an error)", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      expect(readAllMetadataEntries(db)).toEqual({ schemaVersion: METADATA_INDEX_SCHEMA_VERSION, entries: {} });
      expect(readMetadataStats(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("treats a corrupt (non-SQLite) file at the DB path as an unrecoverable open failure", async () => {
    const root = await tmpRoot();
    const target = path.join(root, METADATA_DB_RELATIVE_PATH);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, "not a sqlite database");
    expect(() => openMetadataDb(root)).toThrow();
  });

  it("persists to disk across separate open() calls (a real file, not an in-memory-only handle)", async () => {
    const root = await tmpRoot();
    const first = openMetadataDb(root);
    upsertMetadataEntries(first, { "A.md": entry() });
    first.close();

    const second = openMetadataDb(root);
    try {
      expect(Object.keys(readAllMetadataEntries(second).entries)).toEqual(["A.md"]);
    } finally {
      second.close();
    }
  });

  it("supports a second concurrent reader connection while the first holds the database open (WAL)", async () => {
    const root = await tmpRoot();
    const writer = openMetadataDb(root);
    try {
      upsertMetadataEntries(writer, { "A.md": entry() });
      const reader = new DatabaseSync(path.join(root, METADATA_DB_RELATIVE_PATH), { readOnly: true });
      try {
        expect(Object.keys(readAllMetadataEntries(reader).entries)).toEqual(["A.md"]);
      } finally {
        reader.close();
      }
    } finally {
      writer.close();
    }
  });
});
