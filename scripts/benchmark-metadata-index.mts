import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { extractMentionIndexKeys, parseMetadata, MetadataCache } from "../src/renderer/metadata-cache.ts";
import { clearMeasures, getRecentMeasures } from "../src/renderer/perf-instrumentation.ts";
import {
  reconcileMetadataIndex,
  type MetadataFileStat,
  type MetadataReconcileStats,
  type MetadataReconcileStore,
  type PersistedMetadataIndexEntry,
} from "../src/indexer/metadata-indexer.ts";
import { FakeVault } from "../tests/helpers/fake-vault.ts";
import { formatBenchmarkReport, generatedNote, type BenchmarkPhase, type MetadataBenchmarkReport } from "./large-vault-benchmark-lib.mts";

const countArg = process.argv.find((arg) => arg.startsWith("--notes="));
const noteCount = countArg ? Number(countArg.slice("--notes=".length)) : 10_000;
if (!Number.isInteger(noteCount) || noteCount < 1) throw new Error("--notes must be a positive integer");
const delayArg = process.argv.find((arg) => arg.startsWith("--io-delay-ms="));
const simulatedIoDelayMs = delayArg ? Number(delayArg.slice("--io-delay-ms=".length)) : 0;
if (!Number.isFinite(simulatedIoDelayMs) || simulatedIoDelayMs < 0) throw new Error("--io-delay-ms must be a non-negative number");
const modeArg = process.argv.find((arg) => arg.startsWith("--io-mode="));
const simulatedIoMode = (modeArg?.slice("--io-mode=".length) ?? (simulatedIoDelayMs ? "async" : "none")) as "none" | "async" | "blocking";
if (!(["none", "async", "blocking"] as const).includes(simulatedIoMode)) throw new Error("--io-mode must be none, async, or blocking");
const root = path.resolve(process.cwd(), ".benchmark-vault");
const resultDir = path.resolve(process.cwd(), ".benchmark-results");

async function generateVault(): Promise<void> {
  await fsp.rm(root, { recursive: true, force: true });
  await Promise.all(Array.from({ length: 100 }, (_, i) => fsp.mkdir(path.join(root, `Area-${String(i).padStart(2, "0")}`), { recursive: true })));
  for (let start = 0; start < noteCount; start += 250) {
    await Promise.all(Array.from({ length: Math.min(250, noteCount - start) }, (_, offset) => {
      const note = generatedNote(start + offset, noteCount);
      return fsp.writeFile(path.join(root, note.path), note.content, "utf8");
    }));
  }
}

async function simulateIoDelay(): Promise<void> {
  if (!simulatedIoDelayMs || simulatedIoMode === "none") return;
  if (simulatedIoMode === "async") {
    await new Promise((resolve) => setTimeout(resolve, simulatedIoDelayMs));
    return;
  }
  const until = performance.now() + simulatedIoDelayMs;
  while (performance.now() < until) { /* Deliberately emulate a blocking intercepted syscall. */ }
}

async function statsFor(paths: string[]): Promise<MetadataFileStat[]> {
  return Promise.all(paths.map(async (relative) => {
    await simulateIoDelay();
    const stat = await fsp.stat(path.join(root, relative));
    return { path: relative, mtimeMs: stat.mtimeMs, size: stat.size };
  }));
}

function startLagSampler() {
  let expected = performance.now() + 10;
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - expected);
    expected = now + 10;
  }, 10);
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    clearInterval(timer);
    return max;
  };
}

/**
 * Fully in-memory stand-in for the SQLite metadata store, mirroring
 * `MetadataReconcileStore`'s contract (see `src/indexer/metadata-indexer.ts`
 * and its production implementation in `src/main/metadata-cache-store.ts`).
 * Persists across the cold and warm runs below, the same way the real
 * SQLite file persists across process launches.
 */
function createInMemoryStore(): MetadataReconcileStore {
  const rows = new Map<string, PersistedMetadataIndexEntry>();
  return {
    readStats: () => [...rows.entries()].map(([p, entry]) => ({ path: p, mtimeMs: entry.mtimeMs, size: entry.size })),
    upsertBatch: (entries) => { for (const [p, entry] of Object.entries(entries)) rows.set(p, entry); },
    deletePaths: (paths) => { for (const p of paths) rows.delete(p); },
  };
}

// The indexer's wire format (and the store) no longer carry raw content —
// only changed/new entries ever reach the renderer over IPC, and the
// renderer independently reads a file's content on demand via
// `vault.cachedRead()`. To benchmark the renderer's own apply/resolve work
// under the same shape, FakeVault is seeded with every path's REAL on-disk
// content (read directly here, standing in for what `cachedRead()` would
// fetch), while the mocked indexer-message stream only carries the
// changed-entries snapshot, matching the real indexer's streaming behavior.
async function measureRenderer(
  paths: string[],
  changed: Record<string, PersistedMetadataIndexEntry>,
): Promise<Pick<BenchmarkPhase, "rendererApplyMs" | "rendererResolveMs" | "totalInitializeMs">> {
  const contents = Object.fromEntries(
    await Promise.all(paths.map(async (p) => [p, await fsp.readFile(path.join(root, p), "utf8")] as const))
  );
  const vault = new FakeVault(contents);
  let deliver: ((message: unknown) => void) | undefined;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { geode: {
    onMetadataIndexerMessage: (cb: (message: unknown) => void) => { deliver = cb; },
    startMetadataIndexer: async () => {
      const entries = Object.entries(changed);
      deliver?.({ type: "snapshot-start", schemaVersion: 1, totalEntries: entries.length });
      for (let i = 0; i < entries.length; i += 50) deliver?.({ type: "snapshot-chunk", sequence: i / 50, entries: Object.fromEntries(entries.slice(i, i + 50)) });
      deliver?.({ type: "snapshot-complete", totalChunks: Math.ceil(entries.length / 50) });
      return true;
    },
  } } });
  clearMeasures();
  const cache = new MetadataCache(vault.asVault());
  await cache.initialize();
  await cache.waitForBackgroundIdle();
  const measures = getRecentMeasures();
  const duration = (op: string) => measures.find((item) => item.op === op)?.durationMs ?? 0;
  delete (globalThis as { window?: unknown }).window;
  return {
    rendererApplyMs: duration("metadata-renderer-apply"),
    rendererResolveMs: duration("metadata-renderer-resolve"),
    totalInitializeMs: duration("metadata-initialize"),
  };
}

async function run(paths: string[], store: MetadataReconcileStore) {
  let counters: MetadataReconcileStats | undefined;
  const stopLag = startLagSampler();
  const discoveryStarted = performance.now();
  const files = await statsFor(paths);
  const discoveryMs = performance.now() - discoveryStarted;
  const started = performance.now();
  const changed: Record<string, PersistedMetadataIndexEntry> = {};
  await reconcileMetadataIndex(files, store,
    async (relative) => {
      await simulateIoDelay();
      return fsp.readFile(path.join(root, relative), "utf8");
    }, parseMetadata,
    (batch) => { Object.assign(changed, batch); },
    (value) => { counters = value; },
    extractMentionIndexKeys);
  const durationMs = performance.now() - started;
  const renderer = await measureRenderer(paths, changed);
  const maxEventLoopLagMs = await stopLag();
  return { phase: { discoveryMs, durationMs, ...counters!, ...renderer, maxEventLoopLagMs } satisfies BenchmarkPhase };
}

await generateVault();
const paths = Array.from({ length: noteCount }, (_, i) => generatedNote(i, noteCount).path);
const store = createInMemoryStore();
const cold = await run(paths, store);
const changedNote = generatedNote(Math.floor(noteCount / 2), noteCount);
await fsp.appendFile(path.join(root, changedNote.path), "\nWarm-run mutation.\n");
const added = { path: "Area-00/Warm-New.md", content: "# Warm new\n\n[[Note-00000]]\n" };
await fsp.writeFile(path.join(root, added.path), added.content, "utf8");
paths.push(added.path);
const warm = await run(paths, store);
const report: MetadataBenchmarkReport = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), noteCount,
  changedFiles: 1, newFiles: 1, cold: cold.phase, warm: warm.phase,
  simulatedIoDelayMs, simulatedIoMode,
};
await fsp.mkdir(resultDir, { recursive: true });
const resultSuffix = simulatedIoMode === "none" ? "" : `-${simulatedIoMode}-${simulatedIoDelayMs}ms`;
await fsp.writeFile(path.join(resultDir, `metadata-index${resultSuffix}.json`), JSON.stringify(report, null, 2) + "\n");
const markdown = formatBenchmarkReport(report);
await fsp.writeFile(path.join(resultDir, `metadata-index${resultSuffix}.md`), markdown);
console.log(markdown);
