import { hubTokenKey, type HubConfig } from "../../shared/hub-sync";
import { PairingError } from "../../shared/pairing/errors";
import { PAIRING_PROVIDER_HUB, PORTABLE_CATEGORIES, portableFileName, type PairingBundle, type PairingPortable } from "../../shared/pairing/bundle";
import { projectPortableConfig, serializePortableConfig, type PortableConfigDocument } from "../../shared/portable-config";
import type { GuardedMutation, SyncSafetyService } from "../../shared/sync-safety";
import type { ConfigService } from "../host/contracts";
import { sha256Hex } from "../../sync-core/ports";
import { DEFAULT_SYNC_SCOPE } from "../sync/scope";
import type { HubSecretStore } from "../sync/hub-provider";

/** The part of HubSyncProvider pairing needs; a narrow port so the flow is testable without a host. */
export interface PairingHubPort {
  readonly canStoreToken: boolean;
  getConfig(): Promise<HubConfig | null>;
  setConfig(config: HubConfig): Promise<void>;
  clearConfig(): Promise<void>;
  setToken(url: string, token: string): Promise<void>;
}

// ---- Desktop: build what the encrypted reply carries --------------------------------------------------------------------

export interface BundleSources {
  hub: Pick<PairingHubPort, "getConfig">;
  secrets: Pick<HubSecretStore, "available" | "get">;
  config: Pick<ConfigService, "read">;
  vault: () => { id: string; name: string } | null;
}
const ALL_PORTABLE = { ...DEFAULT_SYNC_SCOPE, mainSettings: true, appearance: true, hotkeys: true, corePlugins: true } as const;
const KEY_FOR_FILE: Record<string, keyof PairingPortable> = { "editor.json": "editor", "appearance.json": "appearance", "hotkeys.json": "hotkeys", "daily-notes.json": "dailyNotes" };

/** Live desktop state to bundle. Throws PairingError("unsupported-provider") when the hub is not one a phone can reach. */
export async function buildPairingBundle(sources: BundleSources): Promise<{ bundle: PairingBundle; hasCredential: boolean }> {
  const config = await sources.hub.getConfig();
  if (!config || config.target.kind !== "http") throw new PairingError("unsupported-provider", "Pairing needs an HTTPS hub (set one up under Hub location first). Folder and SSH hubs can't be reached from a phone.");
  const url = config.target.url;
  let token: string | null = null;
  if (sources.secrets.available) { try { token = await sources.secrets.get(hubTokenKey(url)); } catch { token = null; } }
  const portable: PairingPortable = {};
  let documents: PortableConfigDocument[] = [];
  try { documents = await projectPortableConfig(sources.config, ALL_PORTABLE); } catch { documents = []; } // an unreadable local file just means that category is not offered
  for (const doc of documents) (portable as Record<string, unknown>)[KEY_FOR_FILE[doc.name]] = doc.value;
  const vault = sources.vault();
  return { hasCredential: Boolean(token), bundle: { v: 1, provider: { id: PAIRING_PROVIDER_HUB, config: { url } }, vault, portable, credential: token ? { scheme: "bearer", value: token } : null, from: "" } };
}

// ---- Phone: apply a confirmed bundle ------------------------------------------------------------------------------------

export interface ApplyPorts {
  hub: PairingHubPort;
  secrets: Pick<HubSecretStore, "available" | "get" | "remove">;
  config: Pick<ConfigService, "read">;
  syncSafety?: Pick<SyncSafetyService, "claimOwner" | "releaseOwner" | "apply">;
  /** Called after at least one portable category was written, so the live app picks it up (the sync path's `portableChanged`). */
  reloadSettings?: () => Promise<void>;
  newOperationId?: () => string;
}
export interface ApplyReport {
  credentialStored: boolean;
  configSaved: boolean;
  applied: Array<keyof PairingPortable>;
  skipped: Array<{ category: keyof PairingPortable; reason: string }>;
}

/** Fail-closed gate, run BEFORE redeeming so a device without secure storage does not spend the one-time token. */
export function assertCanStoreCredential(ports: Pick<ApplyPorts, "hub" | "secrets">): void {
  if (!ports.hub.canStoreToken || !ports.secrets.available) throw new PairingError("secure-storage-unavailable", "This device can't store the hub token securely (Keychain is unavailable), so it can't be set up from a code. The token is never kept in the vault or in app settings.");
}

export async function applyPairingBundle(bundle: PairingBundle, ports: ApplyPorts): Promise<ApplyReport> {
  assertCanStoreCredential(ports);
  const url = bundle.provider.config.url;
  const key = hubTokenKey(url);
  const previousToken = await ports.secrets.get(key).catch(() => null);
  const previousConfig = await ports.hub.getConfig().catch(() => null);
  const report: ApplyReport = { credentialStored: false, configSaved: false, applied: [], skipped: [] };
  try {
    if (bundle.credential) { await ports.hub.setToken(url, bundle.credential.value); report.credentialStored = true; }
    await ports.hub.setConfig({ schema: 1, target: { kind: "http", url }, create: false });
    report.configSaved = true;
  } catch (error) {
    // A failed pairing must not leave an orphan credential or half a configuration behind.
    if (report.credentialStored) { if (previousToken) await ports.hub.setToken(url, previousToken).catch(() => {}); else await ports.secrets.remove(key).catch(() => {}); }
    if (previousConfig) await ports.hub.setConfig(previousConfig).catch(() => {}); else await ports.hub.clearConfig().catch(() => {});
    throw error;
  }
  await applyPortable(bundle.portable, ports, report);
  return report;
}

async function applyPortable(portable: PairingPortable, ports: ApplyPorts, report: ApplyReport): Promise<void> {
  const present = PORTABLE_CATEGORIES.filter(category => portable[category] !== undefined);
  if (!present.length) return;
  const skipAll = (reason: string) => { for (const category of present) report.skipped.push({ category, reason }); };
  if (!ports.syncSafety) return skipAll("This device has no guarded settings writer.");
  let lease: string | null = null;
  try { lease = await ports.syncSafety.claimOwner(); } catch { lease = null; }
  if (!lease) return skipAll("Another window owns settings for this vault.");
  try {
    for (const category of present) {
      const name = portableFileName(category);
      try {
        const document = { name, value: portable[category] } as PortableConfigDocument;
        const data = serializePortableConfig(document);
        const scope = { ...DEFAULT_SYNC_SCOPE, mainSettings: name === "editor.json", appearance: name === "appearance.json", hotkeys: name === "hotkeys.json", corePlugins: name === "daily-notes.json" };
        const [current] = await projectPortableConfig(ports.config, scope);
        const expectedHash = await sha256Hex(serializePortableConfig(current));
        if (expectedHash === await sha256Hex(data)) { report.applied.push(category); continue; }
        const mutation: GuardedMutation = { namespace: "portable-config", operationId: (ports.newOperationId ?? (() => crypto.randomUUID()))(), path: name, expectedHash, kind: "write", data };
        await ports.syncSafety.apply(lease, mutation);
        report.applied.push(category);
      } catch (error) {
        report.skipped.push({ category, reason: /changed/i.test(error instanceof Error ? error.message : "") ? "Settings changed while pairing." : "Could not be applied safely." });
      }
    }
  } finally { await ports.syncSafety.releaseOwner(lease).catch(() => {}); }
  if (report.applied.length) await ports.reloadSettings?.().catch(() => {});
}
