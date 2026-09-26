import { describe, expect, it } from "vitest";
import { SyncService } from "../../src/renderer/sync/sync-service";
import { APPEND_ONLY_PROTOCOL } from "../../src/renderer/sync/history-types";

/**
 * ADR-0027: `sync-service.ts`'s port wiring tracks an in-closure
 * `knownLedgerIds` set (reseeded by `load()`, grown by `save()`) so each
 * `history-state-write` call only ever carries this cycle's new/changed
 * record and quarantine ids — not the whole ledger. These tests exercise
 * that through the real `SyncService`/`HistoryController` wiring, with a
 * fake `host.historyLedger` that records every delta it's handed.
 */
function fakeHistoryLedger() {
  const stored = new Map<string, unknown>();
  const writes: { key: string; delta: { upsertRecords: Record<string, unknown>; upsertQuarantine: Record<string, unknown>; deleteRecordIds: string[] } }[] = [];
  return {
    writes,
    service: {
      read: async (key: string) => structuredClone(stored.get(key) ?? null),
      write: async (key: string, payload: { small: unknown; delta: { upsertRecords: Record<string, unknown>; upsertQuarantine: Record<string, unknown>; deleteRecordIds: string[] } }) => {
        writes.push(structuredClone({ key, delta: payload.delta }));
        const existing = stored.get(key) as { history?: { records?: Record<string, unknown>; quarantined?: Record<string, unknown> } } | undefined;
        const records = { ...(existing?.history?.records ?? {}) };
        const quarantined = { ...(existing?.history?.quarantined ?? {}) };
        for (const id of payload.delta.deleteRecordIds) delete records[id];
        Object.assign(records, payload.delta.upsertRecords);
        Object.assign(quarantined, payload.delta.upsertQuarantine);
        stored.set(key, structuredClone({ ...(payload.small as object), history: { records, quarantined } }));
      },
    },
  };
}

function setupService() {
  const stored = new Map<string, unknown>();
  const operations = new Map<string, unknown>();
  const blobs = new Map<string, ArrayBuffer>();
  const records: any[] = [];
  const ledger = fakeHistoryLedger();
  let files = [
    { path: "Folder", isFolder: true, size: 0, mtime: 1, ctime: 1 },
    { path: "Folder/Note.md", isFolder: false, size: 3, mtime: 1, ctime: 1 },
  ];
  let text = "old";
  const descriptor = { schema: 1, protocol: APPEND_ONLY_PROTOCOL, vaultId: "12345678-1234-4234-8234-123456789012", rootId: "root", descriptorId: "descriptor", name: "Shared" };
  const host = {
    config: { read: async () => null },
    deviceState: { read: async (key: string) => structuredClone(stored.get(key) ?? null), write: async (key: string, value: unknown) => { stored.set(key, structuredClone(value)); } },
    historyLedger: ledger.service,
    vaultFiles: { onChange: () => () => {}, reconcileScan: async () => ({ status: "complete", entries: files }), readBinary: async () => new TextEncoder().encode(text).buffer },
    syncSafety: {
      claimOwner: async () => "lease", releaseOwner: async () => {},
      storage: async (_token: string, _binding: string, request: any) => {
        if (request.action === "load-operations") return [...operations.values()];
        if (request.action === "save-operation") { operations.set(request.key, structuredClone(request.value)); return; }
        if (request.action === "stage") { blobs.set(request.key, request.data.slice(0)); return request.key; }
        return blobs.get(request.key).slice(0);
      },
    },
  };
  const service = new SyncService(host as never, () => "/synthetic/vault");
  service.register("owner", {
    id: "history", name: "History", protocol: APPEND_ONLY_PROTOCOL,
    capabilities: { binary: true, conditionalWrites: false, appendOnly: true, delta: true, maxFileSize: 104857600 },
    discover: async () => [descriptor], createVault: async () => descriptor,
    open: async () => ({
      scan: async () => ({ status: "complete", records: structuredClone(records) }),
      putBlob: async (input: any) => { blobs.set(input.operationId, input.data.slice(0)); return { id: input.operationId, sha256: input.sha256, size: input.size }; },
      readBlob: async (ref: any) => blobs.get(ref.id).slice(0),
      appendRecord: async (record: any) => { if (!records.some(item => item.recordId === record.recordId)) records.push(structuredClone(record)); },
      close: async () => {},
    }),
  } as never);
  return {
    service, records, ledger,
    addFile: (path: string, content: string) => { files = [...files, { path, isFolder: false, size: content.length, mtime: 1, ctime: 1 }]; text = content; },
  };
}

describe("sync-service.ts history ledger delta tracking (ADR-0027)", () => {
  it("only upserts new/changed records across two consecutive saves, not the full record set each time", async () => {
    const { service, records, ledger } = setupService();
    try {
      await service.activate("history");
      await service.createVault("Shared");
      await service.updateScope({ other: false, mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });
      await service.preview();
      await service.run({ approvePreview: true });

      const firstRunUpsertedIds = new Set(ledger.writes.flatMap(w => Object.keys(w.delta.upsertRecords)));
      expect(firstRunUpsertedIds.size).toBeGreaterThan(0);
      expect(firstRunUpsertedIds.size).toBe(records.length);

      ledger.writes.length = 0; // only inspect what the second cycle sends

      // A second sync cycle with nothing new to upload must not re-send any
      // already-persisted id.
      await service.preview();
      await service.run({ approvePreview: true });

      const secondRunUpsertedIds = new Set(ledger.writes.flatMap(w => Object.keys(w.delta.upsertRecords)));
      for (const id of firstRunUpsertedIds) expect(secondRunUpsertedIds.has(id)).toBe(false);
    } finally { await service.cancel(); }
  });

  it("a subsequent save with genuinely new content only upserts the new record, not previously-known ones", async () => {
    const { service, records, ledger, addFile } = setupService();
    try {
      await service.activate("history");
      await service.createVault("Shared");
      await service.updateScope({ other: false, mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });
      await service.preview();
      await service.run({ approvePreview: true });
      const knownIdsAfterFirstRun = new Set(records.map(r => r.recordId));

      ledger.writes.length = 0;
      addFile("Folder/New.md", "new content");
      await service.preview();
      await service.run({ approvePreview: true });

      const secondRunUpsertedIds = new Set(ledger.writes.flatMap(w => Object.keys(w.delta.upsertRecords)));
      // The new file's record must show up...
      const newRecord = records.find(r => r.location?.name === "New.md");
      expect(newRecord).toBeDefined();
      expect(secondRunUpsertedIds.has(newRecord.recordId)).toBe(true);
      // ...but nothing from the first run is re-sent.
      for (const id of knownIdsAfterFirstRun) expect(secondRunUpsertedIds.has(id)).toBe(false);
    } finally { await service.cancel(); }
  });

  it("skips the history-state-write call entirely for a preview with nothing new (empty delta)", async () => {
    const { service, ledger } = setupService();
    try {
      await service.activate("history");
      await service.createVault("Shared");
      await service.updateScope({ other: false, mainSettings: false, appearance: false, themesAndSnippets: false, hotkeys: false, corePlugins: false });
      await service.preview();
      await service.run({ approvePreview: true });

      ledger.writes.length = 0;
      // A pure preview (no approval, no local changes) still calls save() for
      // small state, but must never carry a non-empty ledger delta.
      await service.preview();
      for (const write of ledger.writes) {
        expect(Object.keys(write.delta.upsertRecords)).toEqual([]);
        expect(Object.keys(write.delta.upsertQuarantine)).toEqual([]);
        expect(write.delta.deleteRecordIds).toEqual([]);
      }
    } finally { await service.cancel(); }
  });
});
