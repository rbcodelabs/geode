import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { DatabaseSync } from "node:sqlite";
import { extractMentionIndexKeys, parseMetadata } from "../renderer/metadata-cache";
import { deleteMetadataEntries, openMetadataDb, readMetadataStats, upsertMetadataEntries } from "../main/metadata-cache-store";
import {
  DebouncedMetadataCacheWriter,
  METADATA_INDEX_SCHEMA_VERSION,
  chunkMetadataSnapshot,
  reconcileMetadataIndex,
  type MetadataDirtyOp,
  type MetadataFileStat,
  type MetadataReconcileStore,
  type PersistedMetadataIndexEntry,
  type PersistedMetadataIndexSnapshot,
} from "./metadata-indexer";

type InitMessage = { type: "initialize"; root: string; files: MetadataFileStat[] };
type VaultMessage = { type: "vault-event"; event: "create" | "modify" | "delete"; path: string };
type ShutdownMessage = { type: "shutdown" };

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error("Metadata indexer must run as an Electron utility process with a parent port");
}

let root = "";
// A DB handle, not vault-sized data — the indexer never holds a whole-vault
// snapshot object in memory. Peak JS heap during reconcile is O(batch size).
let db: DatabaseSync | null = null;
let initializing = false;
const pendingVaultEvents: VaultMessage[] = [];
const injectedReadDelayMs = Number(process.env.GEODE_TEST_INDEXER_READ_DELAY_MS ?? 0);
const readForIndex = async (relative: string): Promise<string> => {
  if (injectedReadDelayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, injectedReadDelayMs));
  }
  return fsp.readFile(path.join(root, relative), "utf8");
};

const writer = new DebouncedMetadataCacheWriter(async (dirty) => {
  if (!db) return;
  const upserts: Record<string, PersistedMetadataIndexEntry> = {};
  const deletes: string[] = [];
  for (const [dirtyPath, op] of dirty) {
    if (op === null) deletes.push(dirtyPath);
    else upserts[dirtyPath] = op;
  }
  const writeStart = performance.now();
  if (Object.keys(upserts).length) upsertMetadataEntries(db, upserts);
  if (deletes.length) deleteMetadataEntries(db, deletes);
  parentPort.postMessage({ type: "performance", operation: "metadata-cache-disk-write", duration: performance.now() - writeStart });
}, undefined, (error, consecutiveFailures) => {
  // Non-fatal: a cache write failure must never stop indexing or rendering,
  // which don't depend on the write succeeding. Just surface a diagnostic.
  parentPort.postMessage({ type: "error", message: `metadata cache write failed (attempt ${consecutiveFailures}): ${String(error)}` });
});

async function initialize(message: InitMessage): Promise<void> {
  initializing = true;
  root = message.root;
  db = openMetadataDb(root);
  const started = performance.now();
  let reconcileStats;
  // Accumulates only the CHANGED/NEW entries found during reconcile (small on
  // a warm relaunch, same size as today's full metadata-only snapshot on a
  // cold one — metadata-only data was never the memory problem, see plan).
  // Unchanged entries are already correct in the DB and are picked up by the
  // renderer's own independent warm-start read of the same database, so they
  // never need to round-trip through this process's memory or the wire.
  const changed: Record<string, PersistedMetadataIndexEntry> = {};
  const store: MetadataReconcileStore = {
    readStats: () => readMetadataStats(db!),
    upsertBatch: (entries) => upsertMetadataEntries(db!, entries),
    deletePaths: (paths) => deleteMetadataEntries(db!, paths),
  };
  await reconcileMetadataIndex(
    message.files,
    store,
    readForIndex,
    parseMetadata,
    (batch) => { Object.assign(changed, batch); },
    (stats) => { reconcileStats = stats; },
    extractMentionIndexKeys,
  );
  parentPort.postMessage({
    type: "performance",
    operation: "metadata-worker-read-parse",
    duration: performance.now() - started,
    counters: reconcileStats,
  });
  const snapshot: PersistedMetadataIndexSnapshot = { schemaVersion: METADATA_INDEX_SCHEMA_VERSION, entries: changed };
  for (const part of chunkMetadataSnapshot(snapshot)) parentPort.postMessage(part);
  initializing = false;
  for (const event of pendingVaultEvents.splice(0)) await applyVaultEvent(event);
}

async function applyVaultEvent(message: VaultMessage): Promise<void> {
  if (!message.path.toLowerCase().endsWith(".md")) return;
  if (message.event === "delete") {
    writer.schedule(message.path, null satisfies MetadataDirtyOp);
    parentPort.postMessage({ type: "delta", path: message.path, deleted: true });
    return;
  }
  const absolute = path.join(root, message.path);
  try {
    const started = performance.now();
    const [content, stat] = await Promise.all([fsp.readFile(absolute, "utf8"), fsp.stat(absolute)]);
    const metadata = parseMetadata(content);
    const entry: PersistedMetadataIndexEntry = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      metadata,
      mentionKeys: extractMentionIndexKeys(content),
    };
    writer.schedule(message.path, entry);
    parentPort.postMessage({ type: "performance", operation: "metadata-worker-read-parse", duration: performance.now() - started });
    parentPort.postMessage({ type: "delta", path: message.path, entry });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      parentPort.postMessage({ type: "error", message: String(error) });
    }
  }
}

parentPort.on("message", (event) => {
  const message = event.data as InitMessage | VaultMessage | ShutdownMessage;
  if (message.type === "initialize") void initialize(message).catch((error) => parentPort.postMessage({ type: "error", message: String(error), fatal: true }));
  else if (message.type === "vault-event") {
    if (initializing) pendingVaultEvents.push(message);
    else void applyVaultEvent(message);
  }
  else if (message.type === "shutdown") void writer.flush().finally(() => {
    db?.close();
    parentPort.postMessage({ type: "shutdown-complete" });
    process.exit(0);
  });
});
