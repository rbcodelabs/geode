import { createHash } from "node:crypto";
import { computeContentSha256, type VaultPackManifest } from "../../../src/main/vault-pack";
import { writeZip, type ZipWriteEntry } from "../../../src/main/vault-pack-zip";

export const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

export interface FixturePlugin {
  id: string;
  mainJs?: string;
  /** Override the sha256 recorded in the manifest (to simulate tampering). */
  recordedSha256?: string;
  /** Optional stylesheet shipped with the plugin. */
  styles?: string;
  /** Override the recorded hashes for the non-main files (to simulate tampering). */
  recordedFileHashes?: Record<string, string>;
  /** Omit the per-file `files` hash map (an older pack). */
  omitFileHashes?: boolean;
  enabled?: boolean;
  locked?: boolean;
}

export interface FixtureOptions {
  /** vault-relative path -> contents */
  files?: Record<string, string | Buffer>;
  bundled?: FixturePlugin[];
  github?: Array<{ id: string; repo: string; enabled?: boolean; range?: string; minReleaseAgeDays?: number }>;
  manifest?: Record<string, unknown>;
  /** Raw extra zip entries (hostile names, symlinks, ...), written verbatim. */
  extraEntries?: ZipWriteEntry[];
  /** Don't write vault-pack.json at all. */
  omitManifest?: boolean;
}

export const pluginManifestJson = (id: string): string =>
  JSON.stringify({ id, name: `Plugin ${id}`, version: "1.2.3", minAppVersion: "0.1.0", description: "Fixture plugin", author: "Test Org" });

/** Builds a valid `.vault` zip in memory; tests mutate it through the options. */
export function buildPackZip(options: FixtureOptions = {}): Buffer {
  const vaultFiles = new Map<string, Buffer>();
  for (const [rel, data] of Object.entries(options.files ?? { "Welcome.md": "# Hello\n" })) {
    vaultFiles.set(rel, Buffer.from(data));
  }
  const pluginFiles = new Map<string, Map<string, Buffer>>();
  const plugins: VaultPackManifest["plugins"] = [];
  for (const plugin of options.bundled ?? []) {
    const main = Buffer.from(plugin.mainJs ?? `module.exports = class P${plugin.id.replace(/-/g, "")} {};\n`);
    const fileMap = new Map<string, Buffer>([
      ["manifest.json", Buffer.from(pluginManifestJson(plugin.id))],
      ["main.js", main],
    ]);
    if (plugin.styles !== undefined) fileMap.set("styles.css", Buffer.from(plugin.styles));
    pluginFiles.set(plugin.id, fileMap);
    const hashes: Record<string, string> = {};
    for (const [file, data] of fileMap) if (file !== "main.js") hashes[file] = sha256(data);
    plugins.push({
      id: plugin.id,
      source: "bundled",
      sha256: plugin.recordedSha256 ?? sha256(main),
      ...(plugin.omitFileHashes ? {} : { files: { ...hashes, ...plugin.recordedFileHashes } }),
      enabled: plugin.enabled ?? true,
      locked: plugin.locked ?? false,
    });
  }
  for (const g of options.github ?? []) {
    plugins.push({
      id: g.id, source: "github", repo: g.repo,
      ...(g.range !== undefined ? { range: g.range } : {}),
      ...(g.minReleaseAgeDays !== undefined ? { minReleaseAgeDays: g.minReleaseAgeDays } : {}),
      enabled: g.enabled ?? true, locked: false,
    });
  }
  const manifest = {
    packVersion: 1,
    id: "acme-onboarding",
    name: "Acme Onboarding",
    version: "2.0.0",
    description: "Acme starting vault",
    plugins,
    contentSha256: computeContentSha256(vaultFiles, pluginFiles),
    ...options.manifest,
  };
  const entries: ZipWriteEntry[] = [];
  if (!options.omitManifest) entries.push({ name: "vault-pack.json", data: Buffer.from(JSON.stringify(manifest)) });
  for (const [rel, data] of vaultFiles) entries.push({ name: `vault/${rel}`, data });
  for (const [id, files] of pluginFiles) for (const [file, data] of files) entries.push({ name: `plugins/${id}/${file}`, data });
  entries.push(...(options.extraEntries ?? []));
  return writeZip(entries);
}
