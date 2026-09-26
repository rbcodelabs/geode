import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyHistoryLedgerDelta,
  deleteHistoryRecords,
  hasHistoryLedgerDelta,
  historyLedgerPath,
  openHistoryLedgerDb,
  readAllHistoryQuarantine,
  readAllHistoryRecords,
  upsertHistoryQuarantine,
  upsertHistoryRecords,
} from "../../src/main/history-ledger-store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "geode-history-ledger-"));
  roots.push(root);
  return root;
}

const record = (over: Partial<{ recordId: string; entityId: string }> = {}) => ({
  schema: 1, recordId: randomUUID(), entityId: randomUUID(), namespace: "content", kind: "file", deleted: false, ...over,
});

describe("history ledger store", () => {
  it("creates the database file (and parent directory) on first open, at the expected identity-hashed path", async () => {
    const root = await tmpRoot();
    const db = openHistoryLedgerDb(root, "sync-history/vault/binding");
    try {
      const target = historyLedgerPath(root, "sync-history/vault/binding");
      await expect(fsp.access(target)).resolves.toBeUndefined();
      expect(path.dirname(target)).toBe(path.join(root, "history"));
      expect(target.endsWith(".sqlite")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("hashes distinct identities to distinct files", async () => {
    const root = await tmpRoot();
    expect(historyLedgerPath(root, "sync-history/a")).not.toBe(historyLedgerPath(root, "sync-history/b"));
  });

  it("round-trips upserted records through readAllHistoryRecords, keyed by recordId", async () => {
    const root = await tmpRoot();
    const db = openHistoryLedgerDb(root, "identity");
    try {
      const a = record();
      upsertHistoryRecords(db, { [a.recordId]: a });
      expect(readAllHistoryRecords(db)).toEqual({ [a.recordId]: a });
    } finally {
      db.close();
    }
  });

  it("round-trips upserted quarantine entries through readAllHistoryQuarantine, keyed by recordId", async () => {
    const root = await tmpRoot();
    const db = openHistoryLedgerDb(root, "identity");
    try {
      const entry = { reason: "invalid-or-contradictory-record", variants: [{ a: 1 }] };
      upsertHistoryQuarantine(db, { "record-1": entry });
      expect(readAllHistoryQuarantine(db)).toEqual({ "record-1": entry });
    } finally {
      db.close();
    }
  });

  it("upsert overwrites an existing row for the same recordId (ON CONFLICT update, not a duplicate row)", async () => {
    const root = await tmpRoot();
    const db = openHistoryLedgerDb(root, "identity");
    try {
      const a = record({ recordId: "r1" });
      upsertHistoryRecords(db, { r1: a });
      upsertHistoryRecords(db, { r1: { ...a, kind: "folder" } });
      const all = readAllHistoryRecords(db);
      expect(Object.keys(all)).toEqual(["r1"]);
      expect((all.r1 as { kind: string }).kind).toBe("folder");
    } finally {
      db.close();
    }
  });

  it("deleteHistoryRecords removes exactly the named rows and is a no-op for an id that was never a record", async () => {
    const root = await tmpRoot();
    const db = openHistoryLedgerDb(root, "identity");
    try {
      const a = record({ recordId: "r1" });
      const b = record({ recordId: "r2" });
      upsertHistoryRecords(db, { r1: a, r2: b });
      expect(() => deleteHistoryRecords(db, ["r1", "never-existed"])).not.toThrow();
      expect(Object.keys(readAllHistoryRecords(db))).toEqual(["r2"]);
    } finally {
      db.close();
    }
  });

  it("hasHistoryLedgerDelta is false only when every field is empty", () => {
    expect(hasHistoryLedgerDelta({ upsertRecords: {}, upsertQuarantine: {}, deleteRecordIds: [] })).toBe(false);
    expect(hasHistoryLedgerDelta({ upsertRecords: { r1: { entityId: "e1" } }, upsertQuarantine: {}, deleteRecordIds: [] })).toBe(true);
    expect(hasHistoryLedgerDelta({ upsertRecords: {}, upsertQuarantine: { r1: {} }, deleteRecordIds: [] })).toBe(true);
    expect(hasHistoryLedgerDelta({ upsertRecords: {}, upsertQuarantine: {}, deleteRecordIds: ["r1"] })).toBe(true);
  });

  it("applyHistoryLedgerDelta upserts records and quarantine and deletes moved-out records in one transaction", async () => {
    const root = await tmpRoot();
    const db = openHistoryLedgerDb(root, "identity");
    try {
      const a = record({ recordId: "r1" });
      upsertHistoryRecords(db, { r1: a });
      applyHistoryLedgerDelta(db, {
        upsertRecords: { r2: record({ recordId: "r2" }) },
        upsertQuarantine: { r1: { reason: "invalid-causal-ancestry" } },
        deleteRecordIds: ["r1"],
      });
      expect(Object.keys(readAllHistoryRecords(db)).sort()).toEqual(["r2"]);
      expect(Object.keys(readAllHistoryQuarantine(db))).toEqual(["r1"]);
    } finally {
      db.close();
    }
  });

  it("applyHistoryLedgerDelta is a no-op (no transaction opened) for an empty delta", async () => {
    const root = await tmpRoot();
    const db = openHistoryLedgerDb(root, "identity");
    try {
      const before = readAllHistoryRecords(db);
      expect(() => applyHistoryLedgerDelta(db, { upsertRecords: {}, upsertQuarantine: {}, deleteRecordIds: [] })).not.toThrow();
      expect(readAllHistoryRecords(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("applyHistoryLedgerDelta rolls back the whole transaction if any statement fails", async () => {
    const root = await tmpRoot();
    const db = openHistoryLedgerDb(root, "identity");
    try {
      upsertHistoryRecords(db, { existing: record({ recordId: "existing" }) });
      // Force a failure mid-transaction by feeding a record whose entityId is not a string,
      // which the NOT NULL entity_id column rejects at the statement level.
      expect(() => applyHistoryLedgerDelta(db, {
        upsertRecords: { good: record({ recordId: "good" }), bad: { entityId: null as unknown as string } },
        upsertQuarantine: {},
        deleteRecordIds: [],
      })).toThrow();
      expect(Object.keys(readAllHistoryRecords(db))).toEqual(["existing"]);
    } finally {
      db.close();
    }
  });

  it("uses WAL journal mode and synchronous=FULL (not metadata-cache-store's NORMAL — this ledger isn't rebuildable from a rescan)", async () => {
    const root = await tmpRoot();
    const db = openHistoryLedgerDb(root, "identity");
    try {
      expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
      expect((db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous).toBe(2); // FULL = 2
    } finally {
      db.close();
    }
  });

  it("persists to disk across separate open() calls (a real file, not an in-memory-only handle)", async () => {
    const root = await tmpRoot();
    const first = openHistoryLedgerDb(root, "identity");
    upsertHistoryRecords(first, { r1: record({ recordId: "r1" }) });
    first.close();

    const second = openHistoryLedgerDb(root, "identity");
    try {
      expect(Object.keys(readAllHistoryRecords(second))).toEqual(["r1"]);
    } finally {
      second.close();
    }
  });

  it("treats a corrupt (non-SQLite) file at the DB path as an unrecoverable open failure", async () => {
    const root = await tmpRoot();
    const target = historyLedgerPath(root, "identity");
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, "not a sqlite database");
    expect(() => openHistoryLedgerDb(root, "identity")).toThrow();
  });

  it("supports a second concurrent reader connection while the first holds the database open (WAL)", async () => {
    const root = await tmpRoot();
    const writer = openHistoryLedgerDb(root, "identity");
    try {
      upsertHistoryRecords(writer, { r1: record({ recordId: "r1" }) });
      const reader = new DatabaseSync(historyLedgerPath(root, "identity"), { readOnly: true });
      try {
        expect(Object.keys(readAllHistoryRecords(reader))).toEqual(["r1"]);
      } finally {
        reader.close();
      }
    } finally {
      writer.close();
    }
  });
});
