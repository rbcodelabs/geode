import { Plugin, SyncPreconditionError } from "geode";
import { createIcloudProvider, type IcloudDiagnostics } from "./provider";

/**
 * Registers the iCloud Drive sync provider. Mac only: the "remote" is a folder
 * in iCloud Drive and the OS does the cross-device syncing, so there is nothing
 * to authenticate and no network access.
 */
export default class IcloudSyncPlugin extends Plugin {
  onload(): void {
    if (process.platform !== "darwin") {
      console.warn("[icloud-sync] iCloud Drive is only available on macOS; provider not registered.");
      return;
    }
    this.registerSyncProvider(
      createIcloudProvider({
        PreconditionError: SyncPreconditionError,
        onDiagnostics: (vaultId, diagnostics) => logDiagnostics(vaultId, diagnostics),
      }),
    );
  }
}

function logDiagnostics(vaultId: string, d: IcloudDiagnostics): void {
  if (d.unresolvedPlaceholders.length) console.warn(`[icloud-sync] ${vaultId}: ${d.unresolvedPlaceholders.length} file(s) still downloading from iCloud:`, d.unresolvedPlaceholders);
  if (d.conflictCopies.length) console.warn(`[icloud-sync] ${vaultId}: possible iCloud conflict copies withheld from sync; rename or delete them:`, d.conflictCopies);
  if (d.problems.length) console.warn(`[icloud-sync] ${vaultId}:`, d.problems);
}
