/**
 * Vault packs (`.vault`): a single zip file that carries an organization's
 * starting vault — notes, a vetted slice of `.geode/` config, and bundled
 * plugins. See docs/adr/0050-vault-packs.md.
 *
 * One apply function (`applyVaultPack`) serves every seeding path: the
 * built-in starter vault (`copyStarterVault`), ADR 0014 build-time defaults
 * (`bootstrapFreshVault`) and user/organization `.vault` files. Everything is
 * validated *before* any byte is written (`inspectVaultPack` runs the same
 * validation and writes nothing, for the consent screen), staged in a temp
 * directory on the destination's volume, and moved into place at the end, so
 * a failed apply leaves no partial vault.
 *
 * Kept free of Electron imports so it is unit-testable and usable from the
 * headless CLI bundle.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parseManifest } from "../renderer/plugin-manifest";
import { isPluginBlocked, type ManagedPolicy } from "../renderer/policy";
import { FIRST_PARTY_PLUGIN_IDS, type VaultPackPluginSummary, type VaultPackSummary } from "../shared/vault-pack-types";
import { vaultNameMessage, vaultNameProblem } from "../shared/vault-name";
import { installCommunity as defaultInstallCommunity } from "./community";
import type { ResolveOpts } from "./github-resolve";
import { recordPluginLock } from "./plugin-lock";
import { isValidRange, satisfies } from "../shared/semver-range";
import { DEFAULT_ZIP_LIMITS, foldName, readZip, writeZip, ZipError, type ZipLimits, type ZipWriteEntry } from "./vault-pack-zip";

export type { VaultPackPluginSummary, VaultPackSummary } from "../shared/vault-pack-types";

export const VAULT_PACK_EXTENSION = ".vault";
export const VAULT_PACK_MANIFEST = "vault-pack.json";

/** Release-age floor for ranged GitHub plugins when neither the policy nor the entry sets one (ADR 0050). */
export const DEFAULT_MIN_RELEASE_AGE_DAYS = 3;
const MAX_MIN_RELEASE_AGE_DAYS = 365;

const PACK_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** Same shape as plugin manifest ids (src/renderer/plugin-manifest.ts, src/renderer/policy.ts). */
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const BUNDLED_PLUGIN_FILES = new Set(["manifest.json", "main.js", "styles.css"]);
const GEODE_ALLOWED_FILES = new Set(["app.json", "hotkeys.json", "plugins.json"]);
const GEODE_ALLOWED_DIRS = new Set(["themes", "snippets"]);

export class VaultPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultPackError";
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export type VaultPackPlugin =
  | {
      id: string;
      source: "bundled";
      /** sha256 of main.js. */
      sha256: string;
      /** Optional sha256 of the other bundled files ("manifest.json", "styles.css"). When present, every bundled file must be covered. */
      files?: Record<string, string>;
      enabled: boolean;
      /** Reserved by ADR 0050: validated, but not enforced anywhere. */
      locked: boolean;
    }
  | {
      id: string;
      source: "github";
      repo: string;
      /** npm-style semver range. Absent = unpinned: install whatever the repository's latest release is. */
      range?: string;
      /** With `range`: skip releases younger than this many days. The ADR 0002 policy value, when set, overrides it. */
      minReleaseAgeDays?: number;
      enabled: boolean;
      locked: boolean;
    };

export interface VaultPackManifest {
  packVersion: 1;
  id: string;
  name: string;
  version: string;
  description?: string;
  minGeodeVersion?: string;
  plugins: VaultPackPlugin[];
  /** See `computeContentSha256`. Integrity only — authenticity needs the reserved `signature` (deferred). */
  contentSha256: string;
  /** Reserved for the deferred signing work (ADR 0050 non-goals). Parsed and ignored. */
  signature?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = obj[key];
  if (typeof value !== "string" || !value.trim()) throw new VaultPackError(`${VAULT_PACK_MANIFEST}: "${key}" must be a non-empty string`);
  if (value.length > maxLength) throw new VaultPackError(`${VAULT_PACK_MANIFEST}: "${key}" is too long`);
  return value;
}

/** Validates an already `JSON.parse`d manifest. Throws `VaultPackError`; never returns a partially valid object. */
export function validateVaultPackManifest(raw: unknown): VaultPackManifest {
  if (!isRecord(raw)) throw new VaultPackError(`${VAULT_PACK_MANIFEST} must contain a JSON object`);
  if (raw.packVersion !== 1) {
    throw new VaultPackError(`Unsupported packVersion ${JSON.stringify(raw.packVersion)} (this Geode reads packVersion 1)`);
  }
  const id = requireString(raw, "id", 100);
  if (!PACK_ID_RE.test(id)) throw new VaultPackError(`${VAULT_PACK_MANIFEST}: "id" must be lowercase letters, digits, ".", "_" or "-"`);
  const name = requireString(raw, "name");
  const version = requireString(raw, "version", 64);
  const manifest: VaultPackManifest = { packVersion: 1, id, name, version, plugins: [], contentSha256: "" };

  if (raw.description !== undefined) {
    if (typeof raw.description !== "string" || raw.description.length > 2000) {
      throw new VaultPackError(`${VAULT_PACK_MANIFEST}: "description" must be a string of at most 2000 characters`);
    }
    manifest.description = raw.description;
  }
  if (raw.minGeodeVersion !== undefined) {
    if (typeof raw.minGeodeVersion !== "string" || !parseSemver(raw.minGeodeVersion)) {
      throw new VaultPackError(`${VAULT_PACK_MANIFEST}: "minGeodeVersion" must be a semver string like "0.30.0"`);
    }
    manifest.minGeodeVersion = raw.minGeodeVersion;
  }
  if (raw.signature !== undefined) {
    if (typeof raw.signature !== "string") throw new VaultPackError(`${VAULT_PACK_MANIFEST}: "signature" must be a string`);
    manifest.signature = raw.signature;
  }

  const contentSha256 = raw.contentSha256;
  if (typeof contentSha256 !== "string" || !SHA256_RE.test(contentSha256)) {
    throw new VaultPackError(`${VAULT_PACK_MANIFEST}: "contentSha256" must be a lowercase 64-character hex SHA-256`);
  }
  manifest.contentSha256 = contentSha256;

  if (!Array.isArray(raw.plugins)) throw new VaultPackError(`${VAULT_PACK_MANIFEST}: "plugins" must be an array`);
  if (raw.plugins.length > 100) throw new VaultPackError(`${VAULT_PACK_MANIFEST}: too many plugins`);
  const seen = new Set<string>();
  for (const entry of raw.plugins) {
    if (!isRecord(entry)) throw new VaultPackError(`${VAULT_PACK_MANIFEST}: each plugin entry must be an object`);
    const pluginId = entry.id;
    if (typeof pluginId !== "string" || !PLUGIN_ID_RE.test(pluginId)) {
      throw new VaultPackError(`${VAULT_PACK_MANIFEST}: invalid plugin id ${JSON.stringify(pluginId)}`);
    }
    if (seen.has(pluginId)) throw new VaultPackError(`${VAULT_PACK_MANIFEST}: duplicate plugin id "${pluginId}"`);
    seen.add(pluginId);
    const enabled = entry.enabled === undefined ? true : entry.enabled;
    const locked = entry.locked === undefined ? false : entry.locked;
    if (typeof enabled !== "boolean" || typeof locked !== "boolean") {
      throw new VaultPackError(`${VAULT_PACK_MANIFEST}: plugin "${pluginId}" enabled/locked must be booleans`);
    }
    if (entry.source === "bundled") {
      if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
        throw new VaultPackError(`${VAULT_PACK_MANIFEST}: bundled plugin "${pluginId}" needs a lowercase 64-character hex "sha256"`);
      }
      let files: Record<string, string> | undefined;
      if (entry.files !== undefined) {
        if (!isRecord(entry.files)) throw new VaultPackError(`${VAULT_PACK_MANIFEST}: plugin "${pluginId}" "files" must be an object`);
        files = {};
        for (const [file, hash] of Object.entries(entry.files)) {
          if (!BUNDLED_PLUGIN_FILES.has(file) || typeof hash !== "string" || !SHA256_RE.test(hash)) {
            throw new VaultPackError(`${VAULT_PACK_MANIFEST}: plugin "${pluginId}" has an invalid "files" entry "${file}"`);
          }
          files[file] = hash;
        }
      }
      manifest.plugins.push({ id: pluginId, source: "bundled", sha256: entry.sha256, ...(files ? { files } : {}), enabled, locked });
    } else if (entry.source === "github") {
      if (typeof entry.repo !== "string" || !REPO_RE.test(entry.repo)) {
        throw new VaultPackError(`${VAULT_PACK_MANIFEST}: github plugin "${pluginId}" needs a "repo" of the form owner/repo`);
      }
      let range: string | undefined;
      if (entry.range !== undefined) {
        if (!isValidRange(entry.range)) {
          throw new VaultPackError(`${VAULT_PACK_MANIFEST}: github plugin "${pluginId}" has a malformed "range" ${JSON.stringify(entry.range)} (use an npm-style range such as "^1.4.0" or ">=1.4.2 <2")`);
        }
        range = entry.range;
      }
      let minReleaseAgeDays: number | undefined;
      if (entry.minReleaseAgeDays !== undefined) {
        const n = entry.minReleaseAgeDays;
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > MAX_MIN_RELEASE_AGE_DAYS) {
          throw new VaultPackError(`${VAULT_PACK_MANIFEST}: github plugin "${pluginId}" "minReleaseAgeDays" must be a number from 0 to ${MAX_MIN_RELEASE_AGE_DAYS}`);
        }
        if (range === undefined) throw new VaultPackError(`${VAULT_PACK_MANIFEST}: github plugin "${pluginId}" sets "minReleaseAgeDays" without a "range"`);
        minReleaseAgeDays = n;
      }
      manifest.plugins.push({
        id: pluginId, source: "github", repo: entry.repo,
        ...(range !== undefined ? { range } : {}),
        ...(minReleaseAgeDays !== undefined ? { minReleaseAgeDays } : {}),
        enabled, locked,
      });
    } else {
      throw new VaultPackError(`${VAULT_PACK_MANIFEST}: plugin "${pluginId}" has unknown source ${JSON.stringify(entry.source)}`);
    }
  }
  return manifest;
}

/**
 * The release-age floor for a ranged GitHub entry. The ADR 0002 policy value is
 * authoritative when set (an administrator can require a wait, or waive it with
 * 0); otherwise the entry's own value; otherwise the default.
 */
export function effectiveMinReleaseAgeDays(entry: { minReleaseAgeDays?: number }, policy: ManagedPolicy | null | undefined): number {
  return policy?.packs?.minReleaseAgeDays ?? entry.minReleaseAgeDays ?? DEFAULT_MIN_RELEASE_AGE_DAYS;
}

function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isVersionAtLeast(actual: string, required: string): boolean {
  const a = parseSemver(actual);
  const r = parseSemver(required);
  if (!a || !r) return true;
  for (let i = 0; i < 3; i++) if (a[i] !== r[i]) return a[i] > r[i];
  return true;
}

// ---------------------------------------------------------------------------
// Loaded pack (zip-independent representation)
// ---------------------------------------------------------------------------

/** What was in the archive, before the .geode allowlist/policy are applied. */
export interface LoadedVaultPack {
  manifest: VaultPackManifest;
  /** Posix paths relative to the vault root (the `vault/` prefix stripped). */
  vaultFiles: Map<string, Buffer>;
  /** Directory entries under `vault/` (so empty folders survive), vault-relative without trailing slash. */
  vaultDirs?: Set<string>;
  /** plugin id -> filename (manifest.json | main.js | styles.css) -> bytes. */
  pluginFiles: Map<string, Map<string, Buffer>>;
}

export type VaultPackSource =
  | { kind: "file"; path: string }
  | { kind: "buffer"; data: Buffer }
  | { kind: "memory"; pack: LoadedVaultPack };

const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/**
 * `contentSha256` = sha256 over, for every file entry sorted by archive path,
 * the line `<archive path>\0<sha256 hex of bytes>\n`, where archive paths are
 * `vault/<path>` and `plugins/<id>/<file>`. Catches truncation/corruption and
 * accidental edits; it is NOT a signature.
 */
export function computeContentSha256(vaultFiles: Map<string, Buffer>, pluginFiles: Map<string, Map<string, Buffer>>): string {
  const lines: string[] = [];
  for (const [rel, data] of vaultFiles) lines.push(`vault/${rel}\0${sha256Hex(data)}\n`);
  for (const [id, files] of pluginFiles) {
    for (const [file, data] of files) lines.push(`plugins/${id}/${file}\0${sha256Hex(data)}\n`);
  }
  lines.sort();
  return createHash("sha256").update(lines.join("")).digest("hex");
}

function loadZipPack(buf: Buffer, limits: ZipLimits): LoadedVaultPack {
  let entries;
  try {
    entries = readZip(buf, limits);
  } catch (err) {
    if (err instanceof ZipError) throw new VaultPackError(`Not a valid vault pack: ${err.message}`);
    throw err;
  }

  let manifestRaw: Buffer | undefined;
  const vaultFiles = new Map<string, Buffer>();
  const vaultDirs = new Set<string>();
  const pluginFiles = new Map<string, Map<string, Buffer>>();

  for (const entry of entries) {
    const { name } = entry;
    if (name === VAULT_PACK_MANIFEST) {
      manifestRaw = entry.data;
    } else if (name.startsWith("vault/")) {
      if (entry.isDirectory) {
        const dir = name.slice("vault/".length, -1);
        if (dir) vaultDirs.add(dir);
      } else {
        vaultFiles.set(name.slice("vault/".length), entry.data);
      }
    } else if (name.startsWith("plugins/")) {
      if (entry.isDirectory) continue;
      const parts = name.split("/");
      // plugins/<id>/<file> exactly — no nesting, no stray files next to plugins/.
      if (parts.length !== 3 || !PLUGIN_ID_RE.test(parts[1]) || !BUNDLED_PLUGIN_FILES.has(parts[2])) {
        throw new VaultPackError(`Unexpected file in plugins/: "${name}" (only manifest.json, main.js and styles.css per plugin)`);
      }
      let files = pluginFiles.get(parts[1]);
      if (!files) pluginFiles.set(parts[1], (files = new Map()));
      files.set(parts[2], entry.data);
    } else if (name === "vault" || name === "plugins" || name === "vault/" || name === "plugins/") {
      continue;
    } else {
      throw new VaultPackError(`Archive entry is outside vault/ and plugins/: "${name}"`);
    }
  }
  if (!manifestRaw) throw new VaultPackError(`Not a vault pack: ${VAULT_PACK_MANIFEST} is missing`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestRaw.toString("utf8"));
  } catch (err) {
    throw new VaultPackError(`${VAULT_PACK_MANIFEST} is not valid JSON: ${(err as Error).message}`);
  }
  return { manifest: validateVaultPackManifest(parsed), vaultFiles, vaultDirs, pluginFiles };
}

async function loadPack(source: VaultPackSource, limits: ZipLimits): Promise<LoadedVaultPack> {
  if (source.kind === "memory") return source.pack;
  let buf: Buffer;
  if (source.kind === "buffer") {
    buf = source.data;
  } else {
    const stat = await fsp.stat(source.path).catch(() => null);
    if (!stat?.isFile()) throw new VaultPackError(`Vault pack not found: ${source.path}`);
    // The compressed file is bounded by the same total budget as its expansion.
    if (stat.size > limits.maxTotalBytes) throw new VaultPackError("Vault pack file is too large");
    buf = await fsp.readFile(source.path);
  }
  return loadZipPack(buf, limits);
}

// ---------------------------------------------------------------------------
// Preparation (all validation; no writes)
// ---------------------------------------------------------------------------

export type VaultPathVerdict = "allow" | "skip" | "reject";

/**
 * Decides what a pack may do with a vault-relative path. Segments are compared
 * NFC-normalized and case-folded, so `.GEODE`, `.Geode` or a decomposed-Unicode
 * variant cannot reach `.geode/` on a case-insensitive or normalizing file
 * system: any such segment other than the exact root `.geode` REJECTS the whole
 * pack. Inside the real `.geode/`, only the allowlist (app.json, hotkeys.json,
 * plugins.json, themes/, snippets/) is "allow"; the rest is runtime state and is "skip".
 */
export function classifyVaultPath(rel: string, isDir = false): VaultPathVerdict {
  const parts = rel.split("/");
  for (let i = 0; i < parts.length; i++) {
    if (foldName(parts[i]) === ".geode" && !(i === 0 && parts[i] === ".geode")) return "reject";
  }
  if (parts[0] !== ".geode") return "allow";
  if (parts.length === 1) return isDir ? "allow" : "skip";
  if (parts.length === 2 && !isDir) return GEODE_ALLOWED_FILES.has(parts[1]) ? "allow" : "skip";
  return GEODE_ALLOWED_DIRS.has(parts[1]) ? "allow" : "skip";
}

/** Vault-relative `.geode/...` (and ordinary) paths that a pack may carry. */
export function isAllowedGeodePath(rel: string): boolean {
  return classifyVaultPath(rel) === "allow";
}

interface PreparedVaultPack {
  summary: VaultPackSummary;
  manifest: VaultPackManifest;
  /** Every file to write, vault-relative posix path -> bytes (includes `.geode/plugins/<id>/*`). */
  writes: Map<string, Buffer>;
  /** Empty-or-not directories to create (vault-relative). */
  dirs: string[];
  /** Pack-provided `.geode/plugins.json` ids, if the pack carried one. */
  packPluginIds: string[] | null;
}

export interface VaultPackOptions {
  /** ADR 0002 policy; blocked plugins are installed but never enabled. */
  policy?: ManagedPolicy | null;
  /** Running Geode version, for `minGeodeVersion`. */
  geodeVersion?: string;
  limits?: Partial<ZipLimits>;
}

function prepare(pack: LoadedVaultPack, opts: VaultPackOptions): PreparedVaultPack {
  const { manifest } = pack;
  if (manifest.minGeodeVersion && opts.geodeVersion && !isVersionAtLeast(opts.geodeVersion, manifest.minGeodeVersion)) {
    throw new VaultPackError(`This pack needs Geode ${manifest.minGeodeVersion} or newer (running ${opts.geodeVersion})`);
  }
  if (computeContentSha256(pack.vaultFiles, pack.pluginFiles) !== manifest.contentSha256) {
    throw new VaultPackError("Vault pack contents do not match contentSha256 (the pack is corrupt or was modified)");
  }

  const writes = new Map<string, Buffer>();
  let skippedCount = 0;
  let packPluginIds: string[] | null = null;
  const dirs: string[] = [];
  for (const dir of pack.vaultDirs ?? []) {
    const verdict = classifyVaultPath(dir, true);
    if (verdict === "reject") throw new VaultPackError(`Vault pack uses a reserved folder name: "vault/${dir}"`);
    if (verdict === "allow") dirs.push(dir);
  }
  for (const [rel, data] of pack.vaultFiles) {
    const verdict = classifyVaultPath(rel);
    if (verdict === "reject") throw new VaultPackError(`Vault pack uses a reserved folder name: "vault/${rel}"`);
    if (verdict === "skip") {
      skippedCount++;
      continue;
    }
    if (rel === ".geode/plugins.json") {
      try {
        const parsed: unknown = JSON.parse(data.toString("utf8"));
        if (Array.isArray(parsed)) packPluginIds = parsed.filter((x): x is string => typeof x === "string" && PLUGIN_ID_RE.test(x));
      } catch {
        // A malformed plugins.json is dropped; plugins are enabled from the manifest instead.
      }
      continue; // rewritten by apply from the merged, policy-filtered list
    }
    writes.set(rel, data);
  }

  // Every plugins/<id>/ must be declared (no unlisted code) and every bundled plugin must be present and verified.
  const bundledIds = new Set(manifest.plugins.filter((p) => p.source === "bundled").map((p) => p.id));
  for (const id of pack.pluginFiles.keys()) {
    if (!bundledIds.has(id)) throw new VaultPackError(`plugins/${id}/ is not declared as a bundled plugin in ${VAULT_PACK_MANIFEST}`);
  }

  const plugins: VaultPackPluginSummary[] = [];
  for (const plugin of manifest.plugins) {
    const blocked = isPluginBlocked(opts.policy ?? null, plugin.id);
    const firstParty = FIRST_PARTY_PLUGIN_IDS.includes(plugin.id);
    if (plugin.source === "github") {
      if (!plugin.range && opts.policy?.packs?.requireGithubRange) {
        throw new VaultPackError(
          `GitHub plugin "${plugin.id}" (${plugin.repo}) has no version range, and this computer's managed policy requires one. Ask the pack author to add a "range" such as "^1.4.0".`,
        );
      }
      plugins.push({
        id: plugin.id, source: "github", repo: plugin.repo,
        ...(plugin.range ? { range: plugin.range, minReleaseAgeDays: effectiveMinReleaseAgeDays(plugin, opts.policy) } : {}),
        enabled: plugin.enabled, locked: plugin.locked, firstParty, blocked,
      });
      continue;
    }
    const files = pack.pluginFiles.get(plugin.id);
    const main = files?.get("main.js");
    const manifestBytes = files?.get("manifest.json");
    if (!files || !main || !manifestBytes) {
      throw new VaultPackError(`Bundled plugin "${plugin.id}" is missing manifest.json or main.js`);
    }
    const actual = sha256Hex(main);
    if (actual !== plugin.sha256) {
      throw new VaultPackError(`Bundled plugin "${plugin.id}": main.js sha256 does not match the pack manifest`);
    }
    const fileHashes: Record<string, string> = {};
    for (const [file, data] of files) fileHashes[file] = sha256Hex(data);
    if (plugin.files) {
      for (const file of Object.keys(plugin.files)) {
        if (!files.has(file)) throw new VaultPackError(`Bundled plugin "${plugin.id}": ${file} is hashed in the manifest but missing`);
      }
      for (const file of files.keys()) {
        if (file === "main.js") continue;
        if (!plugin.files[file]) throw new VaultPackError(`Bundled plugin "${plugin.id}": ${file} has no hash in the pack manifest`);
        if (plugin.files[file] !== fileHashes[file]) throw new VaultPackError(`Bundled plugin "${plugin.id}": ${file} sha256 does not match the pack manifest`);
      }
    }
    let pluginManifest;
    try {
      pluginManifest = parseManifest(manifestBytes.toString("utf8"), plugin.id);
    } catch (err) {
      throw new VaultPackError(`Bundled plugin "${plugin.id}": ${(err as Error).message}`);
    }
    for (const [file, data] of files) writes.set(`.geode/plugins/${plugin.id}/${file}`, data);
    plugins.push({
      id: plugin.id,
      source: "bundled",
      sha256: actual,
      fileHashes,
      name: pluginManifest.name,
      version: pluginManifest.version,
      enabled: plugin.enabled,
      locked: plugin.locked,
      firstParty,
      blocked,
    });
  }

  let totalBytes = 0;
  for (const data of writes.values()) totalBytes += data.length;
  return {
    manifest,
    writes,
    dirs,
    packPluginIds,
    summary: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      minGeodeVersion: manifest.minGeodeVersion,
      fileCount: writes.size,
      skippedCount,
      totalBytes,
      plugins,
    },
  };
}

function resolveLimits(opts: VaultPackOptions): ZipLimits {
  return { ...DEFAULT_ZIP_LIMITS, ...opts.limits };
}

/**
 * Validates a pack and returns what applying it would do — for the consent
 * screen. Performs every check `applyVaultPack` does (limits, paths, hashes,
 * contentSha256, policy) and writes nothing.
 */
export async function inspectVaultPack(source: VaultPackSource, opts: VaultPackOptions = {}): Promise<VaultPackSummary> {
  const pack = await loadPack(source, resolveLimits(opts));
  return prepare(pack, opts).summary;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export type InstallCommunityFn = (
  root: string,
  specInput: string,
  opts: ResolveOpts,
) => Promise<{
  id: string;
  /** Reported by the real installer; required for ranged entries, which are range-checked and locked from it. */
  version?: string;
  ref?: string;
  fileHashes?: Record<string, string>;
}>;

export interface ApplyVaultPackOptions extends VaultPackOptions {
  /** Overridable in tests to avoid real GitHub calls. */
  installCommunity?: InstallCommunityFn;
  /**
   * What a failed GitHub plugin install does. `"fail"` (default) aborts the
   * whole apply with nothing written. `"skip"` logs and continues — the ADR
   * 0014 contract, where a flaky network must never block opening a vault.
   */
  githubFailure?: "fail" | "skip";
  /** `"always"` writes `.geode/plugins.json` even when it lists nothing (ADR 0014 parity). */
  pluginsJson?: "when-needed" | "always";
  /**
   * `owner/repo` plugins whose id is only known after install (ADR 0014's
   * `default-plugins.json` entries carry no id). Installed like manifest
   * GitHub plugins and enabled by the id the install resolves to.
   */
  unresolvedGithubPlugins?: string[];
  /** Require `destRoot` to be missing or empty (default true). Bootstrap of an existing vault passes false. */
  requireEmptyDest?: boolean;
}

export interface ApplyVaultPackResult {
  summary: VaultPackSummary;
  filesWritten: number;
  /** Plugin ids written to `.geode/plugins.json`. */
  enabledPluginIds: string[];
  /** Plugins that were blocked by policy and installed disabled. */
  blockedPluginIds: string[];
  githubFailures: Array<{ repo: string; message: string }>;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

async function writeStaged(stageRoot: string, writes: Map<string, Buffer>, dirs: string[]): Promise<void> {
  for (const dir of dirs) await fsp.mkdir(path.join(stageRoot, ...dir.split("/")), { recursive: true });
  for (const [rel, data] of writes) {
    const target = path.join(stageRoot, ...rel.split("/"));
    // Defence in depth on top of the archive-level checks: nothing escapes the stage.
    const relative = path.relative(stageRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new VaultPackError(`Refusing to write outside the vault: "${rel}"`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
  }
}

/**
 * Applies a vault pack to `destRoot`. All validation happens first; files are
 * staged in a temp directory beside (or, for an existing vault, inside)
 * `destRoot` and moved into place last, so a failure leaves nothing behind.
 * Seed-once: refuses to overwrite anything that already exists.
 */
export async function applyVaultPack(
  source: VaultPackSource,
  destRoot: string,
  opts: ApplyVaultPackOptions = {},
): Promise<ApplyVaultPackResult> {
  const pack = await loadPack(source, resolveLimits(opts));
  const prepared = prepare(pack, opts);
  const { manifest, writes } = prepared;
  const root = path.resolve(destRoot);

  const destStat = await fsp.stat(root).catch((err) => (isEnoent(err) ? null : Promise.reject(err)));
  if (destStat && !destStat.isDirectory()) throw new VaultPackError(`"${root}" is not a folder`);
  if (destStat) {
    const existing = await fsp.readdir(root);
    if ((opts.requireEmptyDest ?? true) && existing.length > 0) {
      throw new VaultPackError("A vault pack can only be applied to an empty or new folder");
    }
    // Seed once: never overwrite or merge into something that is already there. Compare the
    // top-level names case-insensitively (the destination may be on a case-insensitive file system).
    const topLevel = new Set(existing.map(foldName));
    for (const rel of [...writes.keys(), ...prepared.dirs]) {
      if (topLevel.has(foldName(rel.split("/")[0]))) {
        const exact = await fsp.lstat(path.join(root, ...rel.split("/"))).then(() => true, () => false);
        if (exact || rel.indexOf("/") < 0) throw new VaultPackError(`"${rel}" already exists in the destination`);
      }
    }
  } else {
    const parent = path.dirname(root);
    const parentStat = await fsp.stat(parent).catch(() => null);
    if (!parentStat?.isDirectory()) throw new VaultPackError(`"${parent}" is not a folder`);
  }

  const stageRoot = destStat
    ? await fsp.mkdtemp(path.join(root, STAGE_PREFIX))
    : await fsp.mkdtemp(path.join(path.dirname(root), `${STAGE_PREFIX}${path.basename(root).slice(0, 40)}-`));
  const moved: string[] = [];
  try {
    await writeStaged(stageRoot, writes, prepared.dirs);

    const install = opts.installCommunity ?? defaultInstallCommunity;
    type GithubJob = { repo: string; expectedId?: string; enabled: boolean; range?: string; minReleaseAgeDays?: number };
    const githubFailures: Array<{ repo: string; message: string }> = [];
    // ADR 0014 default plugins carry no range, so a managed policy that requires one refuses them (and "skip" mode logs it).
    const unresolvedRepos = opts.unresolvedGithubPlugins ?? [];
    const refuseUnresolved = !!opts.policy?.packs?.requireGithubRange;
    if (refuseUnresolved) {
      for (const repo of unresolvedRepos) githubFailures.push({ repo, message: "has no version range, which this computer's managed policy requires" });
    }
    const jobs: GithubJob[] = [
      ...manifest.plugins
        .filter((p): p is Extract<VaultPackPlugin, { source: "github" }> => p.source === "github")
        .map((p) => ({
          repo: p.repo, expectedId: p.id, enabled: p.enabled,
          ...(p.range ? { range: p.range, minReleaseAgeDays: effectiveMinReleaseAgeDays(p, opts.policy) } : {}),
        })),
      ...(refuseUnresolved ? [] : unresolvedRepos.map((repo) => ({ repo, enabled: true }))),
    ];
    const installedGithub = new Set<string>();
    const unresolvedEnabled: string[] = [];
    const settled = await Promise.allSettled(
      jobs.map((j) =>
        install(stageRoot, j.repo, {
          type: "plugin",
          ...(j.range ? { range: j.range, minReleaseAgeDays: j.minReleaseAgeDays } : {}),
        }),
      ),
    );
    const lockWrites: Array<Promise<void>> = [];
    const discardIds: string[] = [];
    settled.forEach((result, i) => {
      const job = jobs[i];
      if (result.status === "fulfilled") {
        if (job.expectedId && result.value.id !== job.expectedId) {
          githubFailures.push({ repo: job.repo, message: `installed plugin id "${result.value.id}" does not match manifest id "${job.expectedId}"` });
        } else if (job.range && !(result.value.version && result.value.ref && result.value.fileHashes)) {
          githubFailures.push({ repo: job.repo, message: `the installer did not report the resolved version and file hashes needed to lock range "${job.range}"` });
          discardIds.push(result.value.id);
        } else if (job.range && !satisfies(result.value.version!, job.range)) {
          // Defence in depth: the resolver already enforces the range, but a result outside it is never accepted.
          githubFailures.push({ repo: job.repo, message: `resolved version ${result.value.version} is outside the pack's range "${job.range}"` });
          discardIds.push(result.value.id);
        } else {
          if (job.range) {
            lockWrites.push(
              recordPluginLock(stageRoot, result.value.id, {
                repo: job.repo,
                range: job.range,
                minReleaseAgeDays: job.minReleaseAgeDays ?? DEFAULT_MIN_RELEASE_AGE_DAYS,
                version: result.value.version!,
                ref: result.value.ref!,
                files: result.value.fileHashes!,
                lockedAt: new Date().toISOString(),
              }),
            );
          }
          installedGithub.add(result.value.id);
          if (job.enabled && !job.expectedId) unresolvedEnabled.push(result.value.id);
        }
      } else {
        githubFailures.push({ repo: job.repo, message: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      }
    });
    // Code that could not be range-checked or locked must not stay on disk, even when failures are tolerated.
    for (const id of discardIds) {
      if (PLUGIN_ID_RE.test(id)) await fsp.rm(path.join(stageRoot, ".geode", "plugins", id), { recursive: true, force: true });
    }
    try {
      await Promise.all(lockWrites);
    } catch (err) {
      githubFailures.push({ repo: "plugins.lock.json", message: err instanceof Error ? err.message : String(err) });
    }
    if (githubFailures.length) {
      if ((opts.githubFailure ?? "fail") === "fail") {
        throw new VaultPackError(`Could not install GitHub plugin ${githubFailures.map((f) => `${f.repo} (${f.message})`).join(", ")}`);
      }
      for (const f of githubFailures) console.error(`Failed to install default plugin "${f.repo}"`, f.message);
    }

    // Enabled set: the pack's own plugins.json plus manifest-enabled plugins that actually installed,
    // minus anything the manifest disables or the ADR 0002 policy blocks.
    const enabled: string[] = [];
    const blockedPluginIds: string[] = [];
    const declared = new Map(manifest.plugins.map((p) => [p.id, p]));
    const candidates = [
      // Ids in the pack's own plugins.json that the manifest does not declare are ignored: undeclared code is never enabled.
      ...(prepared.packPluginIds ?? []).filter((id) => manifest.plugins.some((p) => p.id === id)),
      ...manifest.plugins
        .filter((p) => p.enabled && (p.source === "bundled" || installedGithub.has(p.id)))
        .map((p) => p.id),
      ...unresolvedEnabled,
    ];
    for (const id of candidates) {
      if (enabled.includes(id)) continue;
      const entry = declared.get(id);
      if (entry && (!entry.enabled || (entry.source === "github" && !installedGithub.has(id)))) continue;
      if (isPluginBlocked(opts.policy ?? null, id)) {
        if (!blockedPluginIds.includes(id)) blockedPluginIds.push(id);
        continue;
      }
      enabled.push(id);
    }
    for (const p of manifest.plugins) {
      if (isPluginBlocked(opts.policy ?? null, p.id) && !blockedPluginIds.includes(p.id)) blockedPluginIds.push(p.id);
    }
    const needsPluginsJson = prepared.packPluginIds !== null || manifest.plugins.length > 0 || jobs.length > 0 || opts.pluginsJson === "always";
    if (needsPluginsJson) {
      await fsp.mkdir(path.join(stageRoot, ".geode"), { recursive: true });
      await fsp.writeFile(path.join(stageRoot, ".geode", "plugins.json"), JSON.stringify(enabled, null, 2), "utf8");
    }

    if (!destStat) {
      await fsp.rename(stageRoot, root);
    } else {
      for (const name of await fsp.readdir(stageRoot)) {
        await fsp.rename(path.join(stageRoot, name), path.join(root, name));
        moved.push(name);
      }
      await fsp.rm(stageRoot, { recursive: true, force: true });
    }
    return { summary: prepared.summary, filesWritten: writes.size, enabledPluginIds: enabled, blockedPluginIds, githubFailures };
  } catch (err) {
    for (const name of moved) await fsp.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
    await fsp.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

const STAGE_PREFIX = ".geode-pack-";

// ---------------------------------------------------------------------------
// Entry-point helpers
// ---------------------------------------------------------------------------

/** Creates `<parent>/<name>` from a pack. The folder only appears if the whole apply succeeds. */
export async function createVaultFromPack(
  source: VaultPackSource,
  parent: unknown,
  name: unknown,
  opts: ApplyVaultPackOptions = {},
): Promise<{ path: string; result: ApplyVaultPackResult }> {
  if (typeof parent !== "string" || typeof name !== "string") throw new VaultPackError("Invalid vault location or name");
  const problem = vaultNameProblem(name);
  if (problem) throw new VaultPackError(vaultNameMessage(problem));
  if (!parent || !path.isAbsolute(parent)) throw new VaultPackError("Choose a location for the vault.");
  const parentDir = path.resolve(parent);
  const target = path.join(parentDir, name.trim());
  if (path.dirname(target) !== parentDir) throw new VaultPackError("Invalid vault name");
  if (await fsp.lstat(target).then(() => true, () => false)) {
    throw new VaultPackError(`A folder named ${name.trim()} already exists in ${parentDir}`);
  }
  const result = await applyVaultPack(source, target, { ...opts, requireEmptyDest: true });
  return { path: target, result };
}

/** Builds an in-memory pack (used by the starter vault and ADR 0014 translation). */
export function buildMemoryPack(spec: {
  id: string;
  name: string;
  version?: string;
  description?: string;
  files: Map<string, Buffer>;
  /** Directories to create even if empty (vault-relative). */
  dirs?: Iterable<string>;
  /** Bundled plugins: id -> filename -> bytes. */
  bundled?: Map<string, Map<string, Buffer>>;
  github?: Array<{ id: string; repo: string; enabled?: boolean; range?: string; minReleaseAgeDays?: number }>;
}): LoadedVaultPack {
  const pluginFiles = spec.bundled ?? new Map<string, Map<string, Buffer>>();
  const plugins: VaultPackPlugin[] = [];
  for (const [id, files] of pluginFiles) {
    const main = files.get("main.js");
    const fileHashes: Record<string, string> = {};
    for (const [file, data] of files) if (file !== "main.js") fileHashes[file] = sha256Hex(data);
    plugins.push({ id, source: "bundled", sha256: main ? sha256Hex(main) : "0".repeat(64), files: fileHashes, enabled: true, locked: false });
  }
  for (const g of spec.github ?? []) plugins.push({
    id: g.id, source: "github", repo: g.repo,
    ...(g.range ? { range: g.range } : {}),
    ...(g.minReleaseAgeDays !== undefined ? { minReleaseAgeDays: g.minReleaseAgeDays } : {}),
    enabled: g.enabled ?? true, locked: false,
  });
  return {
    manifest: {
      packVersion: 1,
      id: spec.id,
      name: spec.name,
      version: spec.version ?? "1.0.0",
      description: spec.description,
      plugins,
      contentSha256: computeContentSha256(spec.files, pluginFiles),
    },
    vaultFiles: spec.files,
    vaultDirs: new Set(spec.dirs ?? []),
    pluginFiles,
  };
}

/**
 * Reads a folder into a file map using the same idiom the old starter-vault
 * copy used (`readdir`/`readFile`, Buffers, never decoded) so it works against
 * an asar-packaged `resources/`. Only regular files are read; symlinks are
 * ignored, and `.geode/` is pruned to the allowlist *before* reading so stray
 * runtime state in a maintainer's checkout is never even opened. Directories
 * are reported too so empty folders are preserved.
 *
 * `geodeFiles` narrows what is honored inside `.geode/` further (the starter
 * vault passes `["app.json"]` to stay byte-identical to its pre-pack behavior).
 */
export async function readDirectoryFiles(
  srcRoot: string,
  opts: { geodeFiles?: readonly string[] } = {},
): Promise<{ files: Map<string, Buffer>; dirs: string[] }> {
  const files = new Map<string, Buffer>();
  const dirs: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (classifyVaultPath(childRel, true) !== "allow") continue;
        if (opts.geodeFiles && childRel.startsWith(".geode/")) continue;
        dirs.push(childRel);
        await walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile() && classifyVaultPath(childRel) === "allow") {
        if (opts.geodeFiles && childRel.startsWith(".geode/") && !opts.geodeFiles.includes(childRel.slice(".geode/".length))) continue;
        files.set(childRel, await fsp.readFile(path.join(dir, entry.name)));
      }
    }
  }
  await walk(srcRoot, "");
  return { files, dirs };
}

/**
 * Removes `.geode-pack-*` staging directories older than `maxAgeMs` from
 * `parentDir` (left by a crash mid-apply). Never throws; returns how many were removed.
 */
export async function sweepStaleStaging(parentDir: string, maxAgeMs = 60 * 60 * 1000, now = Date.now()): Promise<number> {
  let removed = 0;
  try {
    for (const entry of await fsp.readdir(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(STAGE_PREFIX)) continue;
      const full = path.join(parentDir, entry.name);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat && now - stat.mtimeMs > maxAgeMs) {
        await fsp.rm(full, { recursive: true, force: true });
        removed++;
      }
    }
  } catch {
    // Best-effort housekeeping only.
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Export ("Save vault as pack…")
// ---------------------------------------------------------------------------

const EXPORT_SKIP_DIRS = new Set([".git", ".trash", "node_modules"]);
const EXPORT_SKIP_FILES = new Set([".DS_Store", "Thumbs.db"]);

export function slugifyPackId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "");
  return slug.slice(0, 80) || "vault";
}

/**
 * Writes `vaultRoot` as a `.vault` pack at `outFile`: notes and allowlisted
 * `.geode/` config, plus every installed plugin as a bundled plugin (enabled
 * per the vault's `.geode/plugins.json`). The result is re-read through the
 * importer before it is moved into place, so an export that this Geode could
 * not import is rejected instead of saved.
 */
export async function exportVaultPack(
  vaultRoot: string,
  outFile: string,
  meta: { name?: string; id?: string; version?: string; description?: string } = {},
  opts: VaultPackOptions = {},
): Promise<VaultPackSummary> {
  const root = path.resolve(vaultRoot);
  const files = new Map<string, Buffer>();
  async function walk(dir: string, rel: string): Promise<void> {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!EXPORT_SKIP_DIRS.has(entry.name) && classifyVaultPath(childRel, true) === "allow") await walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile() && !EXPORT_SKIP_FILES.has(entry.name) && classifyVaultPath(childRel) === "allow") {
        files.set(childRel, await fsp.readFile(path.join(dir, entry.name)));
      }
    }
  }
  await walk(root, "");

  let enabledIds: string[] = [];
  const pluginsJson = files.get(".geode/plugins.json");
  if (pluginsJson) {
    try {
      const parsed: unknown = JSON.parse(pluginsJson.toString("utf8"));
      if (Array.isArray(parsed)) enabledIds = parsed.filter((x): x is string => typeof x === "string");
    } catch { /* treated as none enabled */ }
  }
  // The enabled list travels in the manifest; the pack-level plugins.json would be redundant.
  files.delete(".geode/plugins.json");

  const bundled = new Map<string, Map<string, Buffer>>();
  const pluginsDir = path.join(root, ".geode", "plugins");
  for (const entry of await fsp.readdir(pluginsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !PLUGIN_ID_RE.test(entry.name)) continue;
    const pluginFiles = new Map<string, Buffer>();
    for (const file of BUNDLED_PLUGIN_FILES) {
      const data = await fsp.readFile(path.join(pluginsDir, entry.name, file)).catch(() => null);
      if (data) pluginFiles.set(file, data);
    }
    if (pluginFiles.has("manifest.json") && pluginFiles.has("main.js")) bundled.set(entry.name, pluginFiles);
  }

  const name = (meta.name ?? path.basename(root)).trim() || "Vault";
  const pack = buildMemoryPack({
    id: meta.id ?? slugifyPackId(name),
    name,
    version: meta.version,
    description: meta.description,
    files,
    bundled,
  });
  pack.manifest.plugins = pack.manifest.plugins.map((p) => ({ ...p, enabled: enabledIds.includes(p.id) }));

  const entries: ZipWriteEntry[] = [{ name: VAULT_PACK_MANIFEST, data: Buffer.from(JSON.stringify(pack.manifest, null, 2), "utf8") }];
  for (const [rel, data] of files) entries.push({ name: `vault/${rel}`, data });
  for (const [id, pluginFiles] of bundled) {
    for (const [file, data] of pluginFiles) entries.push({ name: `plugins/${id}/${file}`, data });
  }
  const zip = writeZip(entries);

  // Round-trip through the importer before committing the output.
  const summary = await inspectVaultPack({ kind: "buffer", data: zip }, opts);
  const tmp = `${outFile}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(tmp, zip);
    await fsp.rename(tmp, outFile);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return summary;
}

/** Whether `p` looks like a vault pack path (extension check only). */
export function isVaultPackPath(p: string): boolean {
  return p.toLowerCase().endsWith(VAULT_PACK_EXTENSION);
}

/** `*.vault` files directly inside `dir` (the machine-level organization pack directory). Never throws. */
export function listPackFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && isVaultPackPath(e.name))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}
