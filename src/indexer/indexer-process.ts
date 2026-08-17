import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { parseMetadata } from "../renderer/metadata-cache";
import { readMetadataCache, writeMetadataCache } from "../main/metadata-cache-store";
import {
  DebouncedMetadataCacheWriter,
  isMetadataIndexSnapshot,
  METADATA_INDEX_SCHEMA_VERSION,
  reconcileMetadataIndex,
  type MetadataFileStat,
  type MetadataIndexSnapshot,
} from "./metadata-indexer";

type InitMessage = { type: "initialize"; root: string; files: MetadataFileStat[] };
type VaultMessage = { type: "vault-event"; event: "create" | "modify" | "delete"; path: string };
type ShutdownMessage = { type: "shutdown" };

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error("Metadata indexer must run as an Electron utility process with a parent port");
}

let root = "";
let snapshot: MetadataIndexSnapshot = { schemaVersion: METADATA_INDEX_SCHEMA_VERSION, entries: {} };
const timedWrite = async (value: MetadataIndexSnapshot) => {
  const serializeStart = performance.now();
  const serialized = JSON.stringify(value);
  parentPort.postMessage({ type: "performance", operation: "metadata-cache-serialize", duration: performance.now() - serializeStart });
  const writeStart = performance.now();
  await writeMetadataCache(root, serialized, undefined, true);
  parentPort.postMessage({ type: "performance", operation: "metadata-cache-disk-write", duration: performance.now() - writeStart });
};
const writer = new DebouncedMetadataCacheWriter(timedWrite);

async function initialize(message: InitMessage): Promise<void> {
  root = message.root;
  const stored = await readMetadataCache(root);
  const started = performance.now();
  snapshot = await reconcileMetadataIndex(
    message.files,
    isMetadataIndexSnapshot(stored) ? stored : null,
    (relative) => fsp.readFile(path.join(root, relative), "utf8"),
    parseMetadata,
  );
  parentPort.postMessage({ type: "performance", operation: "metadata-worker-read-parse", duration: performance.now() - started });
  writer.schedule(snapshot);
  parentPort.postMessage({ type: "snapshot", snapshot });
}

async function applyVaultEvent(message: VaultMessage): Promise<void> {
  if (!message.path.toLowerCase().endsWith(".md")) return;
  if (message.event === "delete") {
    delete snapshot.entries[message.path];
    writer.schedule(snapshot);
    parentPort.postMessage({ type: "delta", path: message.path, deleted: true });
    return;
  }
  const absolute = path.join(root, message.path);
  try {
    const started = performance.now();
    const [content, stat] = await Promise.all([fsp.readFile(absolute, "utf8"), fsp.stat(absolute)]);
    const metadata = parseMetadata(content);
    const entry = { mtimeMs: stat.mtimeMs, size: stat.size, content, metadata };
    snapshot.entries[message.path] = entry;
    parentPort.postMessage({ type: "performance", operation: "metadata-worker-read-parse", duration: performance.now() - started });
    writer.schedule(snapshot);
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
  else if (message.type === "vault-event") void applyVaultEvent(message);
  else if (message.type === "shutdown") void writer.flush().finally(() => {
    parentPort.postMessage({ type: "shutdown-complete" });
    process.exit(0);
  });
});
