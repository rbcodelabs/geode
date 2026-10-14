import { webContents, type IpcMain } from "electron";
import type { PairingBundle } from "../shared/pairing/bundle";
import { PairingService, type PairingEvent } from "./pairing-service";
import { startPairing, type PairingStartReply } from "./pairing-start";

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
