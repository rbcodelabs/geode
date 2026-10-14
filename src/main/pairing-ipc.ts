import * as os from "node:os";
import { webContents, type IpcMain } from "electron";
import type { PairingBundle } from "../shared/pairing/bundle";
import { PairingError } from "../shared/pairing/errors";
import { PairingService, type PairingEvent, type PairingStartResult } from "./pairing-service";

export type PairingStartReply = { ok: true; value: PairingStartResult } | { ok: false; error: { code: string; message: string } };

/** The display name phones show ("from"): the machine's host name, set here so a renderer cannot choose it. */
export function pairingDisplayName(): string {
  // eslint-disable-next-line no-control-regex
  return os.hostname().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64);
}

export async function startPairing(service: PairingService, owner: string, bundle: PairingBundle): Promise<PairingStartReply> {
  try { return { ok: true, value: await service.start(owner, { ...bundle, from: pairingDisplayName() }) }; }
  catch (error) {
    if (error instanceof PairingError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: "unreachable", message: error instanceof Error ? error.message : "Could not start pairing." } };
  }
}

/** Main-process endpoint of "Pair mobile device". The bundle (which holds the credential) crosses IPC in memory only. */
export function registerPairingIpc(ipcMain: IpcMain): PairingService {
  const service = new PairingService({
    onEvent: (owner, event: PairingEvent) => { const target = webContents.fromId(Number(owner)); if (target && !target.isDestroyed()) target.send("pairing-event", event); },
  });
  const watched = new Set<number>();
  ipcMain.handle("pairing-start", async (event, bundle: PairingBundle): Promise<PairingStartReply> => {
    if (!watched.has(event.sender.id)) { watched.add(event.sender.id); event.sender.once("destroyed", () => { watched.delete(event.sender.id); service.cancel(String(event.sender.id)); }); }
    return startPairing(service, String(event.sender.id), bundle);
  });
  ipcMain.handle("pairing-cancel", (event) => { service.cancel(String(event.sender.id)); });
  return service;
}
