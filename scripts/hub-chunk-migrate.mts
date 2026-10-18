// Converts a hub store's whole-file blobs to the chunked at-rest form (see "Chunked blobs at rest" in
// src/sync-node/fs-store.ts) and optionally sweeps orphaned chunks.
//
//   node scripts/hub-chunk-migrate.mts <store>                       dry run: counts candidates, stats only, changes nothing
//   node scripts/hub-chunk-migrate.mts <store> --apply [--limit N]   convert up to N blobs (largest first), one at a time
//   node scripts/hub-chunk-migrate.mts <store> --sweep [--apply]     list (or with --apply delete) orphan chunks older than 1 h
//
// Safe to run while the hub is serving: for each blob the verified chunks and the manifest are durable before the
// whole file is unlinked, and readers fall back from the whole file to the manifest. A blob whose bytes do not hash to
// its id is reported and left alone. Needs free space for the largest blob's new chunks until its whole file is
// removed (at most ~100 MB at a time). Run it nice'd; it reads each candidate once.
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const args = process.argv.slice(2), store = resolve(args[0] ?? "");
const flag = (name: string) => args.includes(name), value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (!args[0] || args[0].startsWith("--")) { console.error("usage: hub-chunk-migrate.mts <store> [--apply] [--limit N] [--sweep]"); process.exit(2); }

const out = mkdtempSync(join(tmpdir(), "hub-chunk-migrate-"));
try {
  buildSync({ entryPoints: [resolve(import.meta.dirname, "../src/sync-node/fs-store.ts")], outfile: join(out, "fs-store.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent" });
  const fsStore = await import(pathToFileURL(join(out, "fs-store.mjs")).href) as typeof import("../src/sync-node/fs-store");
  const gb = (n: number) => (n / 1e9).toFixed(2) + " GB";

  if (flag("--sweep")) {
    const r = await fsStore.sweepOrphanChunks(store, { apply: flag("--apply") });
    console.log(JSON.stringify(r), flag("--apply") ? "" : "(dry run: pass --apply to delete)");
    process.exit(r.refused ? 1 : 0);
  }

  const blobsDir = join(store, "blobs");
  const candidates = readdirSync(blobsDir).filter(n => /^[a-f0-9]{64}$/.test(n)).map(id => ({ id, size: statSync(join(blobsDir, id)).size })).filter(b => b.size >= fsStore.AT_REST_MIN_BYTES).sort((a, b) => b.size - a.size);
  const total = candidates.reduce((n, b) => n + b.size, 0);
  console.log(`${candidates.length} whole-file blobs >= ${fsStore.AT_REST_MIN_BYTES} bytes (${gb(total)}) are candidates`);
  if (!flag("--apply")) { console.log("dry run: nothing changed. Pass --apply to convert."); process.exit(0); }

  const provider = new fsStore.FsStoreProvider(store);
  const [descriptor] = await provider.discover(new AbortController().signal);
  if (!descriptor) throw new Error("no vault in this store");
  const session = await provider.open({ binding: descriptor, deviceId: "chunk-migrate" }, new AbortController().signal) as InstanceType<typeof fsStore.FsStoreSession>;
  const limit = Number(value("--limit") ?? Infinity);
  const tally: Record<string, number> = {}; let legacy = 0, added = 0, done = 0;
  for (const { id } of candidates) {
    if (done++ >= limit) break;
    const r = await session.chunkLegacyBlob(id);
    tally[r.status] = (tally[r.status] ?? 0) + 1;
    if (r.status === "chunked") { legacy += r.legacyBytes; added += r.newChunkBytes; }
    if (r.status === "corrupt") console.error(`corrupt (left untouched): ${id}`);
    if (done % 100 === 0) console.log(`  ${done} processed, whole-file ${gb(legacy)} -> new chunks ${gb(added)}`);
  }
  console.log(JSON.stringify({ ...tally, wholeFileBytesRemoved: legacy, newChunkBytes: added, netBytesFreed: legacy - added }));
  await session.close();
} finally { rmSync(out, { recursive: true, force: true }); }
