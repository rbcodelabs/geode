import { expect, it } from "vitest";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHistoryPorts } from "../../src/sync-core/ports";
import { noPortable, openHost, rmrf, tmp } from "../helpers/node-host-harness";

const FILES = 21_000, DIRS = 300;

it(`scans a ${FILES}-file vault: cold, warm, and a warm full engine snapshot (cache hits) within budget`, async () => {
  const root = tmp("scale"), state = tmp("scale-state");
  try {
    const when = (Date.now() - 86_400_000) / 1000;
    for (let d = 0; d < DIRS; d++) {
      const dir = join(root, `folder-${String(d).padStart(3, "0")}`, d % 3 === 0 ? "nested" : ".");
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < FILES / DIRS; f++) { const file = join(dir, `note-${f}.md`); writeFileSync(file, `note ${d}/${f}`); utimesSync(file, when, when); }
    }
    const host = await openHost(root, join(state, "s"), { settleMs: 5000 });
    const time = async <T>(fn: () => Promise<T>) => { const t = performance.now(); const value = await fn(); return [value, performance.now() - t] as const; };

    const [cold, coldMs] = await time(() => host.vault.reconcileScan());
    expect(cold.status).toBe("complete");
    expect(cold.entries.filter(e => !e.isFolder)).toHaveLength(FILES);
    const [warm, warmMs] = await time(() => host.vault.reconcileScan());
    expect(warm.entries).toEqual(cold.entries);

    // the engine's snapshot: first pays hashing for every file, the second is served from the JSON hash cache
    let reads = 0; const real = host.vault.readBinary; host.vault.readBinary = async p => (reads++, real(p));
    const snapshot = () => host.run(async lease => buildHistoryPorts(host, { provider: { id: "p" }, scope: noPortable, bindingVaultId: "12345678-1234-4234-8234-123456789012", bindingKey: "a".repeat(64), stateKey: "k", lease, assertContext: () => {}, renameHints: new Map(), portableChanged: async () => {} }).ports.snapshot());
    const [first, firstMs] = await time(snapshot); expect(reads).toBe(FILES);
    const [second, secondMs] = await time(snapshot); expect(reads).toBe(FILES);
    expect(second.entries).toEqual(first.entries);
    const warmHost = await openHost(root, join(state, "s"), { settleMs: 5000 }); // new process: cache comes from disk
    reads = 0; const real2 = warmHost.vault.readBinary; warmHost.vault.readBinary = async p => (reads++, real2(p));
    const [, restartMs] = await time(() => warmHost.run(async lease => buildHistoryPorts(warmHost, { provider: { id: "p" }, scope: noPortable, bindingVaultId: "12345678-1234-4234-8234-123456789012", bindingKey: "a".repeat(64), stateKey: "k", lease, assertContext: () => {}, renameHints: new Map(), portableChanged: async () => {} }).ports.snapshot()));
    expect(reads).toBe(0);

    console.log(`[sync-node-scale] ${FILES} files: cold scan ${coldMs.toFixed(0)} ms, warm scan ${warmMs.toFixed(0)} ms, first snapshot (hash all) ${firstMs.toFixed(0)} ms, warm snapshot ${secondMs.toFixed(0)} ms, warm snapshot after restart ${restartMs.toFixed(0)} ms`);
    expect(warmMs).toBeLessThan(3000);
    expect(secondMs).toBeLessThan(3000);
    expect(restartMs).toBeLessThan(3000);
  } finally { rmrf(root); rmrf(state); }
}, 120_000);
