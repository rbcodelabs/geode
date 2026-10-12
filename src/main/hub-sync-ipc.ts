import type { IpcMain } from "electron";
import type { HubRequest, HubResponse } from "../shared/hub-sync";
import { HubError, HubStoreManager, validateHubTarget } from "../sync-node/app-hub";

/**
 * Main-process endpoint of the desktop hub sync provider. `dispatchHubRequest` is pure over a HubStoreManager
 * (unit-tested without Electron); `registerHubSyncIpc` binds it to ipcMain and ties session lifetime to the window.
 */
export async function dispatchHubRequest(manager: HubStoreManager, owner: string, request: HubRequest, signal: AbortSignal): Promise<HubResponse> {
  try {
    switch (request.method) {
      case "discover": return { ok: true, value: await manager.discover(validateHubTarget(request.target), signal) };
      case "createVault": {
        const input = request.input;
        if (typeof input?.name !== "string" || !input.name.trim() || typeof input.operationId !== "string" || !input.operationId) throw new HubError("invalid-request", "A vault name is required");
        return { ok: true, value: await manager.createVault(validateHubTarget(request.target), { name: input.name.trim(), operationId: input.operationId }, signal) };
      }
      case "open": {
        if (typeof request.deviceId !== "string" || !request.deviceId || !request.binding || typeof request.binding.vaultId !== "string") throw new HubError("invalid-request", "Invalid open request");
        return { ok: true, value: await manager.open(owner, validateHubTarget(request.target), request.binding, request.deviceId, signal) };
      }
      case "scan": return { ok: true, value: await manager.scan(owner, request.sessionId, request.cursor, signal) };
      case "putBlob": return { ok: true, value: await manager.putBlob(owner, request.sessionId, request.input, signal) };
      case "readBlob": return { ok: true, value: await manager.readBlob(owner, request.sessionId, request.ref, signal) };
      case "appendRecord": await manager.appendRecord(owner, request.sessionId, request.record, signal); return { ok: true, value: undefined };
      case "appendRecords": return { ok: true, value: await manager.appendRecords(owner, request.sessionId, request.records, signal) };
      case "close": await manager.close(owner, request.sessionId); return { ok: true, value: undefined };
      default: throw new HubError("invalid-request", "Unknown hub request");
    }
  } catch (error) {
    if (error instanceof HubError) return { ok: false, error: error.toInfo() };
    return { ok: false, error: { code: "hub-failed", message: error instanceof Error ? error.message : String(error) } };
  }
}

export function registerHubSyncIpc(ipcMain: IpcMain, manager = new HubStoreManager()): HubStoreManager {
  const inflight = new Map<string, AbortController>();
  const watched = new Set<number>();
  ipcMain.handle("hub-sync", async (event, request: HubRequest, requestId: string) => {
    const owner = String(event.sender.id);
    if (!watched.has(event.sender.id)) {
      watched.add(event.sender.id);
      event.sender.once("destroyed", () => { watched.delete(event.sender.id); void manager.closeOwner(owner); });
    }
    const key = `${owner}:${requestId}`, abort = new AbortController();
    inflight.set(key, abort);
    try { return await dispatchHubRequest(manager, owner, request, abort.signal); }
    finally { inflight.delete(key); }
  });
  ipcMain.on("hub-sync-abort", (event, requestId: string) => { inflight.get(`${event.sender.id}:${requestId}`)?.abort(); });
  return manager;
}
