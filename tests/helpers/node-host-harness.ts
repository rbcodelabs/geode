import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HistoryController } from "../../src/sync-core/history-controller";
import type { AppendOnlySyncProvider, VaultDescriptor } from "../../src/sync-core/history-types";
import { buildHistoryPorts } from "../../src/sync-core/ports";
import { DEFAULT_SYNC_SCOPE } from "../../src/sync-core/scope";
import { NodeHost, type NodeHostOptions } from "../../src/sync-node/index";

export const never = new AbortController().signal;
export const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), `geode-${prefix}-`));
export const rmrf = (path: string) => rmSync(path, { recursive: true, force: true });
export const OLD = () => Date.now() - 60_000;

/** Writes a file (creating folders) and ages its mtime so it is settled and cache-trustworthy. */
export function put(root: string, rel: string, text = rel, ageMs = 60_000) {
  const file = join(root, rel); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text);
  const when = (Date.now() - ageMs) / 1000; utimesSync(file, when, when);
}

export const noPortable = { ...DEFAULT_SYNC_SCOPE, mainSettings: false, appearance: false, hotkeys: false, corePlugins: false, themesAndSnippets: false };
export const bindingKeyFor = (vaultId: string) => createHash("sha256").update(vaultId).digest("hex");

export async function openHost(root: string, stateDir: string, extra: Partial<NodeHostOptions> = {}) {
  return NodeHost.open({ root, stateDir, settleMs: 0, detectEvicted: false, ...extra });
}

/** A device = a NodeHost over a real directory + a HistoryController per run, against a hub provider. */
export function device(name: string, root: string, stateDir: string, provider: AppendOnlySyncProvider, binding: VaultDescriptor, extra: Partial<NodeHostOptions> = {}, deviceId: string = randomUUID()) {
  const bindingKey = bindingKeyFor(binding.vaultId);
  const hostPromise = openHost(root, stateDir, extra);
  return {
    name, root, stateDir, deviceId,
    host: () => hostPromise,
    /** One full cycle: preview then run. Returns the final preview. */
    async sync(approve = false, hostOverride?: NodeHost) {
      const host = hostOverride ?? await hostPromise;
      return host.run(async lease => {
        const { ports } = buildHistoryPorts(host, { provider: { id: provider.id }, scope: noPortable, bindingVaultId: binding.vaultId, bindingKey, stateKey: `sync-history/${binding.vaultId}/${bindingKey}`, lease, assertContext: () => {}, renameHints: new Map(), portableChanged: async () => {} });
        const session = await provider.open({ binding, deviceId }, never);
        try {
          const controller = new HistoryController({ vaultId: binding.vaultId, deviceId, bindingKey, session, ports });
          // Exactly the service's flow: a durable pending batch is resumed by run() (which recovers it), never previewed.
          if (!(await controller.getState(never)).pendingBatch?.length) await controller.preview(never);
          return await controller.run(approve ? { approvePreview: true } : {}, never);
        } finally { await session.close?.(); }
      });
    },
  };
}
