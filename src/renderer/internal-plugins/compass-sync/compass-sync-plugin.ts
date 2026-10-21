import type { App } from "../../app";
import { Plugin as GeodePlugin } from "../../plugin";
import type { PluginManifest } from "../../plugin-manifest";
import { pluginFetch } from "../../plugin-fetch";
import { COMPASS_PROVIDER_ID, createCompassProvider, type CompassConnection } from "./provider";

export const COMPASS_SYNC_PLUGIN_MANIFEST: PluginManifest = {
  id: "compass-sync",
  name: "Compass sync",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Sync a vault's Markdown notes with the docs of a Compass workspace.",
  author: "Geode",
};

/** Device-state key for the per-vault connection settings (never stored in the vault). */
export const CONFIG_STATE_KEY = "config";

/** Non-secret connection settings. The token and the extra header's value live in secure storage. */
export interface CompassSyncConfig {
  baseUrl: string;
  workspaceId: string;
  /** Name (not value) of an extra request header, e.g. `x-vercel-protection-bypass`. */
  extraHeaderName: string;
  trashMode: "move" | "delete";
  useDelta: boolean;
}

export const EMPTY_COMPASS_CONFIG: CompassSyncConfig = { baseUrl: "", workspaceId: "", extraHeaderName: "", trashMode: "move", useDelta: false };

interface StoredConfigs {
  vaults?: Record<string, Partial<CompassSyncConfig>>;
}

export interface CompassSecretStore {
  readonly available: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Compass sync core plugin. It registers the Compass provider (`compass.docs`) and owns the per-vault connection
 * settings: URL, workspace and optional extra header name live in device state; the bearer token and the header's
 * value live in secure storage. Requests go through `pluginFetch`, i.e. the main process on desktop, outside the
 * renderer CSP.
 */
export class CompassSyncPlugin extends GeodePlugin {
  constructor(app: App, private readonly deps: { secrets?: CompassSecretStore; fetch?: typeof fetch } = {}) {
    super(app, COMPASS_SYNC_PLUGIN_MANIFEST);
  }

  onload(): void {
    this.registerSyncProvider(this.createProvider(true));
  }

  private createProvider(withDiagnostics: boolean) {
    return createCompassProvider({
      connection: () => this.connection(),
      fetch: this.deps.fetch ?? ((input, init) => pluginFetch(input, init)),
      ...(withDiagnostics ? { onDiagnostics: (vaultId: string, message: string) => console.warn(`[compass-sync] ${vaultId}: ${message}`) } : {}),
    });
  }

  private get vaultId(): string {
    return this.app.vault.root;
  }

  get canStoreSecrets(): boolean {
    return this.deps.secrets?.available === true;
  }

  private tokenKey(): string {
    return `compass-sync/token/${encodeURIComponent(this.vaultId)}`;
  }

  private headerKey(): string {
    return `compass-sync/header/${encodeURIComponent(this.vaultId)}`;
  }

  async getConfig(): Promise<CompassSyncConfig> {
    const stored = await this.loadDeviceState<StoredConfigs>(CONFIG_STATE_KEY);
    return { ...EMPTY_COMPASS_CONFIG, ...(stored?.vaults?.[this.vaultId] ?? {}) };
  }

  async setConfig(config: CompassSyncConfig): Promise<void> {
    if (this.app.sync.getActiveProvider()?.id === COMPASS_PROVIDER_ID) throw new Error("Disconnect Compass sync in Settings > Sync before changing its connection.");
    const stored = (await this.loadDeviceState<StoredConfigs>(CONFIG_STATE_KEY)) ?? {};
    const clean = { ...config, baseUrl: config.baseUrl.trim(), workspaceId: config.workspaceId.trim(), extraHeaderName: config.extraHeaderName.trim() };
    await this.saveDeviceState(CONFIG_STATE_KEY, { ...stored, vaults: { ...(stored.vaults ?? {}), [this.vaultId]: clean } });
  }

  /** Save the token, or clear it with an empty string. Refuses rather than fall back to weaker storage. */
  async setToken(token: string): Promise<void> {
    await this.writeSecret(this.tokenKey(), token.trim());
  }

  async setExtraHeaderValue(value: string): Promise<void> {
    await this.writeSecret(this.headerKey(), value.trim());
  }

  async hasToken(): Promise<boolean> {
    return Boolean(await this.deps.secrets?.get(this.tokenKey()));
  }

  async hasExtraHeaderValue(): Promise<boolean> {
    return Boolean(await this.deps.secrets?.get(this.headerKey()));
  }

  private async writeSecret(key: string, value: string): Promise<void> {
    const secrets = this.deps.secrets;
    if (!secrets?.available) throw new Error("Secure storage is unavailable on this device, so a Compass token cannot be kept here. Tokens are never stored in the vault or in app settings.");
    if (value) await secrets.set(key, value);
    else await secrets.remove(key);
  }

  /** The provider's connection for this vault; null until URL, workspace and token are all present. */
  async connection(): Promise<CompassConnection | null> {
    const config = await this.getConfig();
    const token = await this.deps.secrets?.get(this.tokenKey());
    if (!config.baseUrl || !config.workspaceId || !token) return null;
    const headerValue = config.extraHeaderName ? await this.deps.secrets?.get(this.headerKey()) : null;
    return {
      baseUrl: config.baseUrl,
      workspaceId: config.workspaceId,
      token,
      trashMode: config.trashMode,
      useDelta: config.useDelta,
      ...(config.extraHeaderName && headerValue ? { extraHeader: { name: config.extraHeaderName, value: headerValue } } : {}),
    };
  }

  /** Probe the server with the saved settings; resolves to a short description or rejects with the user-facing reason. */
  async testConnection(): Promise<string> {
    await this.createProvider(false).preflight?.();
    return "Connected. Compass sync is enabled for this workspace.";
  }
}
