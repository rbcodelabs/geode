/**
 * Electron-free orchestration for the vault-pack entry points (ADR 0050):
 * the hub's "Create vault from pack…", drop/open of a `.vault` file, the
 * `--vault-pack` launch flag and the machine-level organization pack
 * directory. main.ts wires these to IPC; keeping the logic here makes it
 * unit-testable.
 *
 * Consent is enforced HERE, in the main process, not by the renderer:
 *  - `inspect` only accepts a pack path that main itself obtained for that
 *    window (its file picker, the organization directory, a launch argument,
 *    or a validated drop) and writes nothing; it keeps the exact bytes it
 *    validated under an opaque token bound to the requesting window.
 *  - `create` needs such a token (same window, <10 minutes old, single use)
 *    and a destination parent that main obtained (its folder picker or the
 *    default Documents location). So the renderer cannot make main write a
 *    pack it was not shown, or write it somewhere main did not offer.
 *  - The only no-prompt path is `createUnattended` (`--yes` on the FIRST
 *    process launch with an absolute local path); see `parseVaultPackLaunch`.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ManagedPolicy } from "../renderer/policy";
import type { OrganizationPackEntry, VaultPackOffer, VaultPackSummary } from "../shared/vault-pack-types";
import type { CommunityPreview, ResolveOpts } from "./github-resolve";
import {
  createVaultFromPack,
  inspectVaultPack,
  isVaultPackPath,
  listPackFiles,
  validateVaultPackManifest,
  VaultPackError,
  VAULT_PACK_MANIFEST,
  type ApplyVaultPackOptions,
} from "./vault-pack";
import { DEFAULT_ZIP_LIMITS, readZipEntry } from "./vault-pack-zip";

const RESOLVE_TIMEOUT_MS = 8000;
const MAX_PENDING_PER_SENDER = 4;
const MAX_GRANTS_PER_SENDER = 64;
export const CONSENT_TTL_MS = 10 * 60 * 1000;

export interface VaultPackServiceDeps {
  policy: () => ManagedPolicy | null;
  geodeVersion: string;
  installCommunity?: ApplyVaultPackOptions["installCommunity"];
  /**
   * Resolve-only (no download) lookup used to show, on the consent screen, which
   * version a GitHub plugin resolves to right now. Best effort: absent or failing
   * just leaves the version off the screen.
   */
  resolveCommunity?: (spec: string, opts: ResolveOpts) => Promise<CommunityPreview>;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface Pending {
  data: Buffer;
  fileName: string;
  senderId: number;
  expiresAt: number;
}

/** True for `/abs/path` and `C:\abs\path`; false for relative paths, UNC (`\\host`, `//host`) and URLs (`file://`, `https:`). */
export function isAbsoluteLocalPath(p: string): boolean {
  if (/^(\\\\|\/\/)/.test(p)) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(p)) return false;
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

export class VaultPackService {
  private readonly pending = new Map<string, Pending>();
  private readonly grantedPaths = new Map<number, Set<string>>();
  private readonly grantedParents = new Map<number, Set<string>>();
  private readonly listingCache = new Map<string, { mtimeMs: number; size: number; entry: OrganizationPackEntry }>();
  private readonly now: () => number;

  constructor(private readonly deps: VaultPackServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private opts(): ApplyVaultPackOptions {
    return { policy: this.deps.policy(), geodeVersion: this.deps.geodeVersion, installCommunity: this.deps.installCommunity };
  }

  private grant(map: Map<number, Set<string>>, senderId: number, value: string): void {
    let set = map.get(senderId);
    if (!set) map.set(senderId, (set = new Set()));
    set.add(path.resolve(value));
    while (set.size > MAX_GRANTS_PER_SENDER) set.delete(set.values().next().value as string);
  }

  /** Main obtained this pack path for `senderId` (its picker, organization directory or launch argument). */
  grantPath(senderId: number, packPath: string): void {
    this.grant(this.grantedPaths, senderId, packPath);
  }

  /** Main obtained this destination parent for `senderId` (its folder picker or the default location). */
  grantParent(senderId: number, parentDir: string): void {
    this.grant(this.grantedParents, senderId, parentDir);
  }

  /**
   * A file dropped on the hub. The OS drop is only visible to the renderer, so
   * main cannot observe it; it re-validates the path (absolute, local, `.vault`,
   * an existing regular file) before granting. Consent and destination rules still apply.
   */
  async grantDropped(senderId: number, packPath: unknown): Promise<void> {
    await this.checkPackPath(packPath);
    this.grantPath(senderId, packPath as string);
  }

  /** Window closed: forget everything it was granted or was waiting on. */
  closeSender(senderId: number): void {
    this.grantedPaths.delete(senderId);
    this.grantedParents.delete(senderId);
    for (const [token, p] of this.pending) if (p.senderId === senderId) this.pending.delete(token);
  }

  private async checkPackPath(packPath: unknown): Promise<void> {
    if (typeof packPath !== "string" || !isAbsoluteLocalPath(packPath)) throw new VaultPackError("Choose a vault pack file on this computer.");
    if (!isVaultPackPath(packPath)) throw new VaultPackError("That is not a .vault file.");
    const stat = await fsp.stat(packPath).catch(() => null);
    if (!stat?.isFile()) throw new VaultPackError(`Vault pack not found: ${packPath}`);
    if (stat.size > DEFAULT_ZIP_LIMITS.maxTotalBytes) throw new VaultPackError("Vault pack file is too large");
  }

  private async readPack(packPath: unknown): Promise<{ data: Buffer; fileName: string }> {
    await this.checkPackPath(packPath);
    return { data: await fsp.readFile(packPath as string), fileName: path.basename(packPath as string) };
  }

  /** Fills `resolvedVersion` / `resolveError` on GitHub plugins. Never throws and never blocks consent for long. */
  private async annotateGithubPlugins(summary: VaultPackSummary): Promise<void> {
    const resolve = this.deps.resolveCommunity;
    if (!resolve) return;
    await Promise.all(
      summary.plugins.filter((p) => p.source === "github" && p.repo).map(async (plugin) => {
        const opts: ResolveOpts = { type: "plugin", ...(plugin.range ? { range: plugin.range, minReleaseAgeDays: plugin.minReleaseAgeDays } : {}) };
        let timer: NodeJS.Timeout | undefined;
        try {
          const preview = await Promise.race([
            resolve(plugin.repo!, opts),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), RESOLVE_TIMEOUT_MS); }),
          ]);
          plugin.resolvedVersion = preview.version;
        } catch (err) {
          plugin.resolveError = err instanceof Error ? err.message : String(err);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }),
    );
  }

  private prune(): void {
    const t = this.now();
    for (const [token, p] of this.pending) if (p.expiresAt <= t) this.pending.delete(token);
  }

  /** Validates a pack main granted to this window and returns the contents summary for the consent screen. Writes nothing. */
  async inspect(senderId: number, packPath: unknown): Promise<VaultPackOffer> {
    if (typeof packPath !== "string" || !this.grantedPaths.get(senderId)?.has(path.resolve(packPath))) {
      throw new VaultPackError("That vault pack was not chosen in this window. Choose it again.");
    }
    const { data, fileName } = await this.readPack(packPath);
    const summary = await inspectVaultPack({ kind: "buffer", data }, this.opts());
    await this.annotateGithubPlugins(summary);
    this.prune();
    const token = randomBytes(16).toString("hex");
    this.pending.set(token, { data, fileName, senderId, expiresAt: this.now() + CONSENT_TTL_MS });
    const mine = [...this.pending.entries()].filter(([, p]) => p.senderId === senderId);
    while (mine.length > MAX_PENDING_PER_SENDER) this.pending.delete(mine.shift()![0]);
    return { token, fileName, summary };
  }

  /** Declining the consent screen: forget the retained bytes. Nothing was ever written. */
  discard(senderId: number, token: unknown): void {
    if (typeof token === "string" && this.pending.get(token)?.senderId === senderId) this.pending.delete(token);
  }

  /** Applies the pack behind `token` (i.e. this window's user consented) as `<parent>/<name>`. */
  async create(senderId: number, token: unknown, parent: unknown, name: unknown): Promise<string> {
    this.prune();
    const entry = typeof token === "string" ? this.pending.get(token) : undefined;
    if (!entry || entry.senderId !== senderId) {
      throw new VaultPackError("This vault pack is no longer waiting for confirmation. Choose it again.");
    }
    if (typeof parent !== "string" || !this.grantedParents.get(senderId)?.has(path.resolve(parent))) {
      throw new VaultPackError("Choose where to create the vault again.");
    }
    // Apply is atomic (a failure leaves nothing on disk), so a failed attempt such as a name collision
    // keeps the token and the user can fix the name and retry. Success consumes it (single use).
    const { path: created } = await createVaultFromPack({ kind: "buffer", data: entry.data }, parent, name, this.opts());
    this.pending.delete(token as string);
    return created;
  }

  /**
   * `--vault-pack <path> --yes` on the first process launch: no consent screen.
   * Creates a uniquely named vault in `parentDir` from the pack's own name.
   * The caller logs that an unattended apply happened.
   */
  async createUnattended(packPath: string, parentDir: string): Promise<string> {
    if (!isAbsoluteLocalPath(packPath)) throw new VaultPackError("Unattended apply needs an absolute local path.");
    const { data } = await this.readPack(packPath);
    const summary = await inspectVaultPack({ kind: "buffer", data }, this.opts());
    const base = summary.name.replace(/[/\\:\0]/g, "-").trim().slice(0, 100) || "Vault";
    for (let n = 1; n < 100; n++) {
      const name = n === 1 ? base : `${base} ${n}`;
      const exists = await fsp.lstat(path.join(parentDir, name)).then(() => true, () => false);
      if (exists) continue;
      return (await createVaultFromPack({ kind: "buffer", data }, parentDir, name, this.opts())).path;
    }
    throw new VaultPackError("Could not find a free vault folder name.");
  }

  /**
   * Lists `*.vault` files in the machine-level organization pack directory for
   * the hub. Cheap and cached by (mtime, size): only each pack's manifest entry
   * is inflated, never the rest of the archive. The full validation happens on
   * `inspect` when the user picks one. Listed paths are granted to `senderId`.
   */
  async listOrganizationPacks(senderId: number, dir: string): Promise<OrganizationPackEntry[]> {
    const out: OrganizationPackEntry[] = [];
    for (const file of listPackFiles(dir)) {
      const fileName = path.basename(file);
      this.grantPath(senderId, file);
      try {
        const stat = await fsp.stat(file);
        const cached = this.listingCache.get(file);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          out.push(cached.entry);
          continue;
        }
        if (!stat.isFile() || stat.size > DEFAULT_ZIP_LIMITS.maxTotalBytes) throw new VaultPackError("Vault pack file is unreadable or too large");
        const raw = readZipEntry(await fsp.readFile(file), VAULT_PACK_MANIFEST);
        if (!raw) throw new VaultPackError(`${VAULT_PACK_MANIFEST} is missing`);
        const manifest = validateVaultPackManifest(JSON.parse(raw.toString("utf8")));
        const entry: OrganizationPackEntry = { path: file, fileName, name: manifest.name, version: manifest.version };
        this.listingCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entry });
        out.push(entry);
      } catch (err) {
        out.push({ path: file, fileName, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return out;
  }
}

export interface VaultPackLaunchRequest {
  packPath: string;
  /** `--yes`: skip the consent prompt (CLI/MDM use). Only ever true for the first process launch. */
  yes: boolean;
}

/**
 * `--vault-pack <path>` / `--vault-pack=<path>` (+ `--yes`), or a bare `*.vault`
 * argument (OS file association).
 *
 * `--yes` is honored only when `allowYes` (the first process launch's argv),
 * only for an explicit `--vault-pack`, and only for an absolute local path;
 * UNC/network paths and URLs are refused outright, and relative paths can
 * still be offered but always with the consent screen.
 */
export function parseVaultPackLaunch(
  argv: readonly string[],
  cwd: string,
  opts: { allowYes?: boolean } = {},
): VaultPackLaunchRequest | null {
  const allowYes = opts.allowYes ?? false;
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--vault-pack") raw = argv[i + 1];
    else if (arg.startsWith("--vault-pack=")) raw = arg.slice("--vault-pack=".length);
  }
  const explicit = raw !== undefined;
  if (!raw) raw = argv.slice(1).find((a) => !a.startsWith("-") && isVaultPackPath(a));
  if (!raw) return null;
  if (/^(\\\\|\/\/)/.test(raw) || /^[A-Za-z][A-Za-z0-9+.-]+:/.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw)) return null;
  const absolute = isAbsoluteLocalPath(raw);
  return {
    packPath: absolute ? raw : path.resolve(cwd, raw),
    yes: allowYes && explicit && absolute && argv.includes("--yes"),
  };
}
