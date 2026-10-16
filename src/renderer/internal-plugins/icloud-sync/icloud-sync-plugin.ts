import type { App } from "../../app";
import { Plugin as GeodePlugin } from "../../plugin";
import type { PluginManifest } from "../../plugin-manifest";
import { IcloudBridgeError, type IcloudAvailability, type IcloudContainerBridge } from "../../../shared/icloud-container";
import { FolderSelection, inspectFolder, type ApplyResult, type FolderState } from "./folder-selection";
import { createIcloudProvider, type IcloudDiagnostics } from "./provider";

export const ICLOUD_SYNC_PLUGIN_MANIFEST: PluginManifest = {
  id: "icloud-sync",
  name: "iCloud sync",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Sync a vault through Geode's iCloud container.",
  author: "Geode",
};

/** Device-state key for the per-vault remote folder choice (never stored in the vault). */
export const FOLDERS_STATE_KEY = "folders";

export type RemoteDescription =
  | { state: "unavailable"; message: string }
  | { state: "ready"; name: string; folder: FolderState; existing: string[] };

/**
 * iCloud sync core plugin (ADR 0030). It registers the single TypeScript iCloud provider against whatever
 * platform bridge the host supplies (`host.icloudContainer`), and owns the per-vault remote-folder choice.
 * It is constructed only where the bridge exists; the container is probed lazily, at scan/Settings time,
 * never at load.
 */
export class IcloudSyncPlugin extends GeodePlugin {
  private readonly selection: FolderSelection;

  constructor(app: App, private readonly bridge: IcloudContainerBridge) {
    super(app, ICLOUD_SYNC_PLUGIN_MANIFEST);
    this.selection = new FolderSelection({
      bridge,
      vaultId: app.vault.root,
      load: () => this.loadDeviceState<{ folders?: Record<string, string> }>(FOLDERS_STATE_KEY),
      save: (data) => this.saveDeviceState(FOLDERS_STATE_KEY, data),
      isActive: () => this.app.sync.getActiveProvider()?.id === "icloud",
    });
  }

  onload(): void {
    this.registerSyncProvider(
      createIcloudProvider({
        bridge: this.bridge,
        chosenFolder: () => this.selection.chosen(),
        onDiagnostics: (id, diagnostics) => logDiagnostics(id, diagnostics),
      }),
    );
  }

  /** Whether the container is reachable right now, with a user-facing reason when it is not. */
  availability(): Promise<IcloudAvailability> {
    return this.bridge.availability();
  }

  /** What Settings shows: the remote folder this vault will use, its state, and the marked folders another device made. */
  async describeRemote(): Promise<RemoteDescription> {
    const availability = await this.bridge.availability();
    if (availability.state !== "available") return { state: "unavailable", message: availability.message };
    try {
      const name = await this.selection.effective();
      const [folder, existing] = await Promise.all([inspectFolder(this.bridge, name), this.selection.list()]);
      return { state: "ready", name, folder, existing };
    } catch (error) {
      if (error instanceof IcloudBridgeError && error.code === "unavailable") return { state: "unavailable", message: error.message };
      throw error;
    }
  }

  applyFolder(raw: string): Promise<ApplyResult> {
    return this.selection.apply(raw);
  }
}

function logDiagnostics(vaultId: string, d: IcloudDiagnostics): void {
  if (d.unresolvedPlaceholders.length) console.warn(`[icloud-sync] ${vaultId}: ${d.unresolvedPlaceholders.length} file(s) still downloading from iCloud:`, d.unresolvedPlaceholders);
  if (d.conflictCopies.length) console.warn(`[icloud-sync] ${vaultId}: possible iCloud conflict copies withheld from sync; rename or delete them:`, d.conflictCopies);
  if (d.problems.length) console.warn(`[icloud-sync] ${vaultId}:`, d.problems);
}
