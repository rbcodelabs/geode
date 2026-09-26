import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateKeyStore } from "../../src/main/private-key-store";
import { readHistoryLedgerState, writeHistoryLedgerState } from "../../src/main/history-ledger-service";
import { openHistoryLedgerDb, readAllHistoryRecords } from "../../src/main/history-ledger-store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "geode-history-ledger-service-"));
  roots.push(root);
  return root;
}

function setup() {
  return tmpRoot().then((deviceStateDir) => ({
    deviceStateDir,
    deviceStore: new PrivateKeyStore(deviceStateDir, "json"),
  }));
}

const record = (over: Partial<{ recordId: string; entityId: string }> = {}) => ({
  schema: 1, recordId: randomUUID(), entityId: randomUUID(), namespace: "content", kind: "file", deleted: false, parents: [], ...over,
});

describe("readHistoryLedgerState / writeHistoryLedgerState (ADR-0027)", () => {
  it("returns null when nothing is persisted for this identity yet", async () => {
    const { deviceStore, deviceStateDir } = await setup();
    expect(await readHistoryLedgerState(deviceStore, deviceStateDir, "identity")).toBeNull();
  });

  it("round-trips small state plus a written delta", async () => {
    const { deviceStore, deviceStateDir } = await setup();
    const r1 = record({ recordId: "r1" });
    await writeHistoryLedgerState(deviceStore, deviceStateDir, "identity", {
      small: { schema: 1, bindingKey: "b", cursor: "c1" },
      delta: { upsertRecords: { r1 }, upsertQuarantine: {}, deleteRecordIds: [] },
    });
    const state = await readHistoryLedgerState(deviceStore, deviceStateDir, "identity") as any;
    expect(state.cursor).toBe("c1");
    expect(state.history.records).toEqual({ r1 });
    expect(state.history.quarantined).toEqual({});
  });

  describe("delta-only save", () => {
    it("a second write's bounded delta accumulates onto the ledger rather than replacing it (the actual delta computation is sync-service.ts's — see sync-service-history-ledger-delta.test.ts)", async () => {
      const { deviceStore, deviceStateDir } = await setup();
      const r1 = record({ recordId: "r1" });
      await writeHistoryLedgerState(deviceStore, deviceStateDir, "identity", {
        small: { cursor: "c1" },
        delta: { upsertRecords: { r1 }, upsertQuarantine: {}, deleteRecordIds: [] },
      });
      const r2 = record({ recordId: "r2" });
      // Only r2 is passed here — exactly the bounded-delta contract sync-service.ts relies on.
      await writeHistoryLedgerState(deviceStore, deviceStateDir, "identity", {
        small: { cursor: "c2" },
        delta: { upsertRecords: { r2 }, upsertQuarantine: {}, deleteRecordIds: [] },
      });
      const db = openHistoryLedgerDb(deviceStateDir, "identity");
      try {
        expect(Object.keys(readAllHistoryRecords(db)).sort()).toEqual(["r1", "r2"]);
      } finally { db.close(); }
      const state = await readHistoryLedgerState(deviceStore, deviceStateDir, "identity") as any;
      expect(state.cursor).toBe("c2");
    });

    it("skips the SQLite call entirely for an empty delta — the ledger file is never even created", async () => {
      const { deviceStore, deviceStateDir } = await setup();
      await writeHistoryLedgerState(deviceStore, deviceStateDir, "identity", {
        small: { cursor: "c1" },
        delta: { upsertRecords: {}, upsertQuarantine: {}, deleteRecordIds: [] },
      });
      await expect(fsp.access(path.join(deviceStateDir, "history"))).rejects.toThrow();
      // The small state still lands even though the ledger was untouched.
      const rewritten = JSON.parse((await deviceStore.read("identity"))!.toString("utf8"));
      expect(rewritten.cursor).toBe("c1");
    });
  });

  describe("migration", () => {
    async function seedLegacyBlob(deviceStore: PrivateKeyStore, identity: string, extra: Record<string, unknown> = {}) {
      const r1 = record({ recordId: "r1" });
      const blob = {
        schema: 1, bindingKey: "b", vaultId: "v", deviceId: "d",
        history: { records: { r1 }, quarantined: { q1: { reason: "invalid-causal-ancestry" } } },
        baseline: {}, reservedEntities: {}, approved: false, conflicts: [], blocked: [],
        completedOperations: ["op-1", "op-2"],
        cursor: "old-cursor",
        ...extra,
      };
      await deviceStore.write(identity, Buffer.from(JSON.stringify(blob)));
      return { r1 };
    }

    it("moves records/quarantined into SQLite and rewrites the small JSON without history or completedOperations", async () => {
      const { deviceStore, deviceStateDir } = await setup();
      const { r1 } = await seedLegacyBlob(deviceStore, "identity");

      const state = await readHistoryLedgerState(deviceStore, deviceStateDir, "identity") as any;
      expect(state.history.records).toEqual({ r1 });
      expect(state.history.quarantined).toEqual({ q1: { reason: "invalid-causal-ancestry" } });
      expect(state.cursor).toBe("old-cursor");
      expect(state).not.toHaveProperty("completedOperations");

      // The small JSON on disk is what actually got rewritten — check it directly.
      const rewritten = JSON.parse((await deviceStore.read("identity"))!.toString("utf8"));
      expect(rewritten).not.toHaveProperty("history");
      expect(rewritten).not.toHaveProperty("completedOperations");
      expect(rewritten.cursor).toBe("old-cursor");

      const db = openHistoryLedgerDb(deviceStateDir, "identity");
      try {
        expect(readAllHistoryRecords(db)).toEqual({ r1 });
      } finally { db.close(); }
    });

    it("is idempotent — a second read after migration does not re-migrate or change state", async () => {
      const { deviceStore, deviceStateDir } = await setup();
      await seedLegacyBlob(deviceStore, "identity");
      const first = await readHistoryLedgerState(deviceStore, deviceStateDir, "identity");
      const secondRaw = await deviceStore.read("identity");
      const second = await readHistoryLedgerState(deviceStore, deviceStateDir, "identity");
      expect(second).toEqual(first);
      // The small JSON itself must be unchanged by the second (no-op) read.
      const thirdRaw = await deviceStore.read("identity");
      expect(thirdRaw?.toString("utf8")).toBe(secondRaw?.toString("utf8"));
    });

    it("an old blob with completedOperations loads without error and the field is absent afterward", async () => {
      const { deviceStore, deviceStateDir } = await setup();
      await seedLegacyBlob(deviceStore, "identity");
      const state = await readHistoryLedgerState(deviceStore, deviceStateDir, "identity") as any;
      expect(state).not.toHaveProperty("completedOperations");
    });

    it("does not migrate a blob that never had a history key (already-split or brand-new shape)", async () => {
      const { deviceStore, deviceStateDir } = await setup();
      await deviceStore.write("identity", Buffer.from(JSON.stringify({ schema: 1, cursor: "c1" })));
      const before = await deviceStore.read("identity");
      const state = await readHistoryLedgerState(deviceStore, deviceStateDir, "identity") as any;
      expect(state.cursor).toBe("c1");
      expect(state.history).toEqual({ records: {}, quarantined: {} });
      const after = await deviceStore.read("identity");
      expect(after?.toString("utf8")).toBe(before?.toString("utf8"));
    });
  });

  describe("crash-safety ordering", () => {
    it("never writes the small JSON if the SQLite commit rejects", async () => {
      const { deviceStore, deviceStateDir } = await setup();
      const writeSpy = vi.spyOn(deviceStore, "write");
      // A record with a non-string entityId violates the ledger's NOT NULL
      // entity_id column, forcing the transaction to fail.
      await expect(writeHistoryLedgerState(deviceStore, deviceStateDir, "identity", {
        small: { cursor: "should-never-land" },
        delta: { upsertRecords: { bad: { entityId: null as unknown as string } }, upsertQuarantine: {}, deleteRecordIds: [] },
      })).rejects.toThrow();
      expect(writeSpy).not.toHaveBeenCalled();
      expect(await deviceStore.read("identity")).toBeNull();
    });

    it("the ledger row is already durable by the time the small-JSON write is invoked", async () => {
      const { deviceStore, deviceStateDir } = await setup();
      const r1 = record({ recordId: "r1" });
      let recordsVisibleAtWriteTime: Record<string, unknown> | undefined;
      const writeSpy = vi.spyOn(deviceStore, "write").mockImplementation(async (identity, bytes) => {
        // Open a fresh, independent connection at the moment the small-JSON
        // write is invoked — if the SQLite commit hadn't already completed,
        // this read would see it empty.
        const db = openHistoryLedgerDb(deviceStateDir, "identity");
        try { recordsVisibleAtWriteTime = readAllHistoryRecords(db); }
        finally { db.close(); }
        return PrivateKeyStore.prototype.write.call(deviceStore, identity, bytes);
      });
      await writeHistoryLedgerState(deviceStore, deviceStateDir, "identity", {
        small: { cursor: "c1" },
        delta: { upsertRecords: { r1 }, upsertQuarantine: {}, deleteRecordIds: [] },
      });
      writeSpy.mockRestore();
      expect(recordsVisibleAtWriteTime).toEqual({ r1 });
    });
  });
});
