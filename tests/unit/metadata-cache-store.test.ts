import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  METADATA_DB_RELATIVE_PATH,
  deleteMetadataEntries,
  deleteMetadataEntry,
  openMetadataDb,
  readAllMetadataEntries,
  readMetadataStats,
  replaceAllMetadataEntries,
  safeStringify,
  upsertMetadataEntries,
} from "../../src/main/metadata-cache-store";
import {
  DebouncedMetadataCacheWriter,
  METADATA_INDEX_SCHEMA_VERSION,
  reconcileMetadataIndex,
  type MetadataDirtyOp,
  type MetadataFileStat,
  type MetadataReconcileStore,
  type PersistedMetadataIndexEntry,
} from "../../src/indexer/metadata-indexer";
import { parseMetadata } from "../../src/renderer/metadata-cache";

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

describe("safeStringify", () => {
  it("replaces a circular reference with a marker instead of throwing", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj["self"] = obj;
    expect(() => safeStringify(obj)).not.toThrow();
    expect(JSON.parse(safeStringify(obj))).toEqual({ a: 1, self: "[Circular]" });
  });

  it("stringifies BigInt values instead of throwing", () => {
    expect(() => safeStringify({ n: 10n })).not.toThrow();
    expect(JSON.parse(safeStringify({ n: 10n }))).toEqual({ n: "10" });
  });

  it("round-trips ordinary (non-circular, non-BigInt) values identically to JSON.stringify", () => {
    const value = { links: [], embeds: [], nested: { a: [1, 2, "x"] } };
    expect(safeStringify(value)).toBe(JSON.stringify(value));
  });

  it("does not falsely flag two distinct objects that merely happen to be structurally equal", () => {
    const value = { a: { x: 1 }, b: { x: 1 } };
    expect(JSON.parse(safeStringify(value))).toEqual(value);
  });

  it("preserves a YAML anchor shared by sibling aliases instead of treating the second alias as circular", () => {
    const parsed = parseMetadata(`---
shared: &shared
  label: preserved
  nested:
    count: 2
first: *shared
second: *shared
---
`);
    const frontmatter = parsed.frontmatter as Record<string, unknown>;
    expect(frontmatter.first).toBe(frontmatter.second);

    const serialized = JSON.parse(safeStringify(parsed));
    expect(serialized.frontmatter.first).toEqual({ label: "preserved", nested: { count: 2 } });
    expect(serialized.frontmatter.second).toEqual({ label: "preserved", nested: { count: 2 } });
  });
});

function injectUpsertFailure(db: DatabaseSync, failOnRun: number): { attempts: () => number; restore: () => void } {
  const originalPrepare = db.prepare.bind(db);
  let attempts = 0;
  const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    const stmt = originalPrepare(sql);
    if (!sql.includes("INSERT INTO metadata_entries")) return stmt;
    return new Proxy(stmt, {
      get(target, property) {
        if (property !== "run") return Reflect.get(target, property, target);
        return (...args: unknown[]) => {
          attempts += 1;
          if (attempts === failOnRun) {
            const error = new Error("database or disk is full") as Error & { code: string };
            error.code = "SQLITE_FULL";
            throw error;
          }
          return target.run(...args);
        };
      },
    });
  }) as typeof db.prepare);
  return { attempts: () => attempts, restore: () => spy.mockRestore() };
}

describe("metadata cache transaction failures", () => {
  it("isolates an entry that fails during serialization without hiding database failures", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pathologicalMetadata = Object.defineProperty({}, "broken", {
        enumerable: true,
        get: () => { throw new Error("pathological getter"); },
      }) as PersistedMetadataIndexEntry["metadata"];
      expect(() => upsertMetadataEntries(db, {
        "Pathological.md": entry({ metadata: pathologicalMetadata }),
        "Good.md": entry({ size: 7 }),
      })).not.toThrow();

      expect(Object.keys(readAllMetadataEntries(db).entries)).toEqual(["Good.md"]);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to serialize metadata cache entry for "Pathological.md"'),
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
      db.close();
    }
  });

  it("propagates an upsert statement failure and rolls back rows written earlier in the batch", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      upsertMetadataEntries(db, { "Existing.md": entry({ size: 9 }) });
      const failure = injectUpsertFailure(db, 2);
      expect(() => upsertMetadataEntries(db, {
        "First.md": entry({ size: 1 }),
        "Fails.md": entry({ size: 2 }),
        "Never.md": entry({ size: 3 }),
      })).toThrowError(/database or disk is full/);
      failure.restore();

      expect(failure.attempts()).toBe(2);
      expect(readAllMetadataEntries(db).entries).toEqual({ "Existing.md": entry({ size: 9 }) });
    } finally {
      db.close();
    }
  });

  it("propagates a replace-all statement failure and rolls back the preceding DELETE and partial inserts", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      upsertMetadataEntries(db, { "Existing.md": entry({ size: 9 }), "Also existing.md": entry({ size: 8 }) });
      const before = readAllMetadataEntries(db);
      const failure = injectUpsertFailure(db, 2);
      expect(() => replaceAllMetadataEntries(db, {
        schemaVersion: METADATA_INDEX_SCHEMA_VERSION,
        entries: { "First.md": entry({ size: 1 }), "Fails.md": entry({ size: 2 }) },
      })).toThrowError(/database or disk is full/);
      failure.restore();

      expect(failure.attempts()).toBe(2);
      expect(readAllMetadataEntries(db)).toEqual(before);
    } finally {
      db.close();
    }
  });
});

/**
 * Regression coverage for the OOM bug: a note whose YAML frontmatter
 * self-references via an anchor/alias pair (`&x` / `*x`) parses (via the real
 * `parseMetadata`, exactly as the indexer and renderer use it) into a
 * genuinely circular `CachedMetadata.frontmatter` object. Before the
 * `safeStringify` fix, writing that entry threw mid-transaction and rolled
 * back the whole batch/snapshot; on the live-edit path that same throw made
 * `DebouncedMetadataCacheWriter` retry the identical poisoned batch forever
 * at a capped backoff, repeatedly opening/rolling back a transaction against
 * the WAL for as long as the app process stayed open.
 */
describe("circular frontmatter (OOM regression)", () => {
  const CIRCULAR_FRONTMATTER = "---\na: &x\n  self: *x\n---\n# Circular\n";
  const GOOD_CONTENT = "# Good note\n\nSome body text.\n";

  function circularEntry(overrides: Partial<PersistedMetadataIndexEntry> = {}): PersistedMetadataIndexEntry {
    const parsed = parseMetadata(CIRCULAR_FRONTMATTER);
    // Sanity-check the fixture is genuinely circular before trusting it to
    // exercise the bug — if the `yaml` package ever changed alias resolution
    // to a deep copy instead of a shared reference, this fixture would stop
    // reproducing the bug silently.
    const fm = parsed.frontmatter as { a: { self: unknown } };
    if (fm.a.self !== fm.a) throw new Error("fixture is not actually circular — test no longer reproduces the bug");
    return { mtimeMs: 1, size: CIRCULAR_FRONTMATTER.length, metadata: parsed, ...overrides };
  }

  it("upsertMetadataEntries writes a circular-frontmatter entry without throwing, and does not poison the rest of the batch", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      expect(() => upsertMetadataEntries(db, {
        "Circular.md": circularEntry(),
        "Good1.md": entry({ size: 10 }),
        "Good2.md": entry({ size: 20 }),
      })).not.toThrow();

      const snapshot = readAllMetadataEntries(db);
      expect(Object.keys(snapshot.entries).sort()).toEqual(["Circular.md", "Good1.md", "Good2.md"]);
      expect(snapshot.entries["Good1.md"].size).toBe(10);
      expect(snapshot.entries["Good2.md"].size).toBe(20);
      // The self-reference degrades to a marker; every other frontmatter field
      // and every other file's row is fully intact.
      const fm = snapshot.entries["Circular.md"].metadata.frontmatter as { a: { self: unknown } };
      expect(fm.a.self).toBe("[Circular]");
    } finally {
      db.close();
    }
  });

  it("replaceAllMetadataEntries writes a circular-frontmatter entry without throwing, and preserves the rest of the snapshot", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      expect(() => replaceAllMetadataEntries(db, {
        schemaVersion: METADATA_INDEX_SCHEMA_VERSION,
        entries: {
          "Circular.md": circularEntry(),
          "Good.md": entry({ size: 7 }),
        },
      })).not.toThrow();

      const snapshot = readAllMetadataEntries(db);
      expect(Object.keys(snapshot.entries).sort()).toEqual(["Circular.md", "Good.md"]);
      expect(snapshot.entries["Good.md"].size).toBe(7);
    } finally {
      db.close();
    }
  });

  it("a full reconcile over a vault containing a circular-frontmatter note succeeds", async () => {
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      const files: MetadataFileStat[] = [
        { path: "Circular.md", mtimeMs: 1, size: CIRCULAR_FRONTMATTER.length },
        { path: "Good1.md", mtimeMs: 1, size: GOOD_CONTENT.length },
        { path: "Good2.md", mtimeMs: 1, size: GOOD_CONTENT.length },
      ];
      const contents: Record<string, string> = {
        "Circular.md": CIRCULAR_FRONTMATTER,
        "Good1.md": GOOD_CONTENT,
        "Good2.md": GOOD_CONTENT,
      };
      const store: MetadataReconcileStore = {
        readStats: () => readMetadataStats(db),
        upsertBatch: (entries) => upsertMetadataEntries(db, entries),
        deletePaths: (paths) => deleteMetadataEntries(db, paths),
      };
      const read = async (p: string) => contents[p]!;
      for (let i = 0; i < 20; i++) {
        await expect(reconcileMetadataIndex(files, store, read, parseMetadata)).resolves.toBeUndefined();
      }

      // All three files landed in the DB — the circular note never poisoned
      // the reconcile batch that contained it.
      const snapshot = readAllMetadataEntries(db);
      expect(Object.keys(snapshot.entries).sort()).toEqual(["Circular.md", "Good1.md", "Good2.md"]);
      const fm = snapshot.entries["Circular.md"].metadata.frontmatter as { a: { self: unknown } };
      expect(fm.a.self).toBe("[Circular]");

    } finally {
      db.close();
    }
  });

  it("uses the real debounced writer for repeated circular writes without retry or WAL churn", async () => {
    vi.useFakeTimers();
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      const attempts: Map<string, MetadataDirtyOp>[] = [];
      const writer = new DebouncedMetadataCacheWriter(async (dirty) => {
        attempts.push(new Map(dirty));
        upsertMetadataEntries(db, Object.fromEntries(
          [...dirty].filter((item): item is [string, PersistedMetadataIndexEntry] => item[1] !== null),
        ));
      }, 10);
      const walPath = `${path.join(root, METADATA_DB_RELATIVE_PATH)}-wal`;
      const walSizes: number[] = [];

      for (let i = 0; i < 12; i++) {
        writer.schedule("Circular.md", circularEntry({ mtimeMs: i + 1 }));
        await vi.advanceTimersByTimeAsync(10);
        walSizes.push((await fsp.stat(walPath)).size);
      }

      expect(attempts).toHaveLength(12);
      const persistedFrontmatter = readAllMetadataEntries(db).entries["Circular.md"].metadata.frontmatter as {
        a: { self: unknown };
      };
      expect(persistedFrontmatter.a.self).toBe("[Circular]");
      expect(walSizes.every((size) => size > 0)).toBe(true);
      expect(Math.max(...walSizes)).toBeLessThan(1_000_000);

      const walSizeAfterWrites = (await fsp.stat(walPath)).size;
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(attempts).toHaveLength(12);
      expect((await fsp.stat(walPath)).size).toBe(walSizeAfterWrites);
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });

  it("propagates a real store failure into debounced retry and preserves the entire dirty batch", async () => {
    vi.useFakeTimers();
    const root = await tmpRoot();
    const db = openMetadataDb(root);
    try {
      upsertMetadataEntries(db, { "Existing.md": entry({ size: 9 }) });
      const failure = injectUpsertFailure(db, 1);
      const attemptedBatches: Map<string, MetadataDirtyOp>[] = [];
      const onError = vi.fn();
      const writer = new DebouncedMetadataCacheWriter(async (dirty) => {
        attemptedBatches.push(new Map(dirty));
        upsertMetadataEntries(db, Object.fromEntries(
          [...dirty].filter((item): item is [string, PersistedMetadataIndexEntry] => item[1] !== null),
        ));
      }, 10, onError);

      writer.schedule("A.md", entry({ size: 1 }));
      writer.schedule("B.md", entry({ size: 2 }));
      await vi.advanceTimersByTimeAsync(10);

      expect(attemptedBatches).toHaveLength(1);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "SQLITE_FULL" }), 1);
      expect(readAllMetadataEntries(db).entries).toEqual({ "Existing.md": entry({ size: 9 }) });

      await vi.advanceTimersByTimeAsync(19);
      expect(attemptedBatches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(attemptedBatches).toHaveLength(2);
      expect(attemptedBatches[1]).toEqual(attemptedBatches[0]);
      expect(Object.keys(readAllMetadataEntries(db).entries).sort()).toEqual(["A.md", "B.md", "Existing.md"]);
      expect(failure.attempts()).toBe(3);
      failure.restore();
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });
});
