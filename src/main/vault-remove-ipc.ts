import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { withVaultMutation } from "./path-lock";
import { removeVaultFolderAt, resolveVaultFolderPath } from "./vault-remove";

/** Throws if removing `target` would touch the host-owned policy file (`assertNotPolicyFile`). */
type RemovalGuard = (root: string, target: string, op: "remove") => Promise<void>;

export function registerVaultRemoveIpc(
  ipc: Pick<IpcMain, "handle">,
  rootForEvent: (event: IpcMainInvokeEvent) => string,
  guard: RemovalGuard = async () => {},
): void {
  ipc.handle("vault-rmdir", async (event, relative: string, recursive: boolean) => {
    const root = rootForEvent(event);
    const target = resolveVaultFolderPath(root, relative);
    return withVaultMutation(root, [target], async () => {
      await guard(root, target, "remove");
      return removeVaultFolderAt(target, recursive === true);
    });
  });
}
