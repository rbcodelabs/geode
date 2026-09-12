import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { withVaultMutation } from "./path-lock";
import { removeVaultFolderAt, resolveVaultFolderPath } from "./vault-remove";

export function registerVaultRemoveIpc(ipc: Pick<IpcMain, "handle">, rootForEvent: (event: IpcMainInvokeEvent) => string): void {
  ipc.handle("vault-rmdir", async (event, relative: string, recursive: boolean) => {
    const root = rootForEvent(event);
    const target = resolveVaultFolderPath(root, relative);
    return withVaultMutation(root, [target], () => removeVaultFolderAt(target, recursive === true));
  });
}
