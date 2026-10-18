import { IcloudBridgeError, type IcloudContainerBridge } from "../../../shared/icloud-container";
import { isJunkName, MARKER_FILE, resolveFolderName, sanitizeFolderName, STATE_DIR } from "./folders";

export type FolderState = "missing" | "empty" | "marked" | "unmarked";

/** `unmarked` = has user content but no `.geode-sync/marker.json`, so it is not a Geode remote. */
export async function inspectFolder(bridge: IcloudContainerBridge, name: string, signal?: AbortSignal): Promise<FolderState> {
  const entries = await bridge.list(name, "", signal);
  if (!entries) return "missing";
  if (await bridge.stat(name, MARKER_FILE, { maxHashBytes: 0 }, signal)) return "marked";
  return entries.some((entry) => !isJunkName(entry.name) && entry.name !== STATE_DIR) ? "unmarked" : "empty";
}

/** Existing remote folders another device could bind to (only those carrying the marker). */
export async function listRemoteFolders(bridge: IcloudContainerBridge, signal?: AbortSignal): Promise<string[]> {
  const marked: string[] = [];
  for (const name of await bridge.listRoots(signal)) {
    if (await bridge.stat(name, MARKER_FILE, { maxHashBytes: 0 }, signal)) marked.push(name);
  }
  return marked;
}

export type ApplyResult = { ok: true; name: string; changed: boolean } | { ok: false; reason: "active" | "invalid-name" | "not-a-geode-folder" | "unavailable"; message: string };

export interface FolderSelectionDeps {
  bridge: IcloudContainerBridge;
  vaultId: string;
  load: () => Promise<{ folders?: Record<string, string> } | null>;
  save: (data: { folders: Record<string, string> }) => Promise<void>;
  /** True while the provider is the vault's active sync transport. */
  isActive: () => boolean;
}

/** Per-vault folder choice persisted in device state. Backs the Core plugins section; no UI code here so it is testable. */
export class FolderSelection {
  constructor(private readonly deps: FolderSelectionDeps) {}

  async chosen(): Promise<string | undefined> {
    const stored = (await this.deps.load())?.folders?.[this.deps.vaultId];
    return typeof stored === "string" && stored ? stored : undefined;
  }

  effective(): Promise<string> {
    return this.chosen().then((chosen) => resolveFolderName(this.deps.vaultId, chosen));
  }

  list(): Promise<string[]> {
    return listRemoteFolders(this.deps.bridge);
  }

  async apply(raw: string): Promise<ApplyResult> {
    if (this.deps.isActive()) {
      return { ok: false, reason: "active", message: "Disconnect iCloud sync in Settings → Sync before changing the remote folder." };
    }
    const name = sanitizeFolderName(raw);
    if (!name) return { ok: false, reason: "invalid-name", message: "Enter a folder name (no leading dots or path separators)." };
    let state: FolderState;
    try {
      state = await inspectFolder(this.deps.bridge, name);
    } catch (error) {
      if (error instanceof IcloudBridgeError && error.code === "unavailable") return { ok: false, reason: "unavailable", message: error.message };
      throw error;
    }
    if (state === "unmarked") {
      return { ok: false, reason: "not-a-geode-folder", message: `"${name}" already contains files that are not a Geode sync folder. Choose a different name.` };
    }
    const data = (await this.deps.load()) ?? {};
    await this.deps.save({ ...data, folders: { ...(data.folders ?? {}), [this.deps.vaultId]: name } });
    return { ok: true, name, changed: name !== raw.trim() };
  }
}
