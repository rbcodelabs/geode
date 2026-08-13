/**
 * Pure state + update-policy logic for community items installed from GitHub
 * (see docs/adr/0001-community-install-from-github.md). This module models
 * `<vault>/.geode/community.json` — the provenance + update policy for each
 * GitHub-installed plugin/theme — as plain immutable transforms, with NO I/O
 * and no DOM: reading/writing the file (via config-read/config-write IPC) and
 * downloading/installing live elsewhere (community-manager.ts / main). Keeping
 * this pure makes it fully unit-testable in the node vitest env.
 *
 * Sources of truth are deliberately split to avoid duplication:
 *   - which plugins are ENABLED  → .geode/plugins.json (existing)
 *   - which theme is ACTIVE      → .geode/app.json cssTheme (existing)
 *   - provenance + update policy  → .geode/community.json (this module)
 */

import { GEODE_API_VERSION, compareVersions, isVersionAtLeast } from "../plugin-manifest";

export type ItemType = "plugin" | "theme";

export interface CommunityItem {
  /** "owner/repo" — the add key; unique within the config. */
  repo: string;
  type: ItemType;
  /** Plugin id, or theme folder name — the on-disk directory under .geode/. */
  id: string;
  /** manifest.version last written to disk. */
  installedVersion: string;
  source: "release" | "raw";
  /** Release tag, or "HEAD" for a raw default-branch install. */
  ref?: string;
  /** When set, the item is frozen at this version and never auto-updates. */
  pinnedVersion?: string;
  /** Opt-in per repo (default false): only true items are checked on launch. */
  autoUpdate: boolean;
  /** Epoch ms of the last update check (drives the auto-check cadence). */
  lastChecked?: number;
  /** ETag from the last GitHub API response, for cheap conditional requests. */
  etag?: string;
  /** filename → sha256 of the installed file (tamper-evidence / no-op detection). */
  assets?: Record<string, string>;
}

export interface CommunityConfig {
  version: 1;
  items: CommunityItem[];
}

/** Default auto-check cadence: skip auto-checks for items checked within this window. */
export const DEFAULT_CADENCE_MS = 6 * 60 * 60 * 1000; // 6h

export function emptyConfig(): CommunityConfig {
  return { version: 1, items: [] };
}

/**
 * Coerce whatever `config-read` returned (possibly null on a missing/corrupt
 * file, or a legacy shape) into a valid CommunityConfig. Never throws —
 * unusable input degrades to an empty config, so a bad file can't brick the app.
 */
export function normalizeConfig(raw: unknown): CommunityConfig {
  if (!raw || typeof raw !== "object") return emptyConfig();
  const obj = raw as { items?: unknown };
  if (!Array.isArray(obj.items)) return emptyConfig();
  const items: CommunityItem[] = [];
  for (const entry of obj.items) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.repo !== "string" ||
      (e.type !== "plugin" && e.type !== "theme") ||
      typeof e.id !== "string" ||
      typeof e.installedVersion !== "string" ||
      (e.source !== "release" && e.source !== "raw")
    ) {
      continue; // drop malformed rows rather than fail the whole file
    }
    const item: CommunityItem = {
      repo: e.repo,
      type: e.type,
      id: e.id,
      installedVersion: e.installedVersion,
      source: e.source,
      autoUpdate: e.autoUpdate === true, // default off
    };
    if (typeof e.ref === "string") item.ref = e.ref;
    if (typeof e.pinnedVersion === "string") item.pinnedVersion = e.pinnedVersion;
    if (typeof e.lastChecked === "number") item.lastChecked = e.lastChecked;
    if (typeof e.etag === "string") item.etag = e.etag;
    if (e.assets && typeof e.assets === "object" && !Array.isArray(e.assets)) {
      item.assets = e.assets as Record<string, string>;
    }
    items.push(item);
  }
  return { version: 1, items };
}

export function findItem(config: CommunityConfig, repo: string): CommunityItem | undefined {
  return config.items.find((i) => i.repo === repo);
}

/**
 * Insert or replace the item for `item.repo` (immutably). Order is preserved:
 * an existing repo keeps its slot; a new repo is appended.
 */
export function upsertItem(config: CommunityConfig, item: CommunityItem): CommunityConfig {
  const idx = config.items.findIndex((i) => i.repo === item.repo);
  const items = config.items.slice();
  if (idx === -1) items.push(item);
  else items[idx] = item;
  return { version: 1, items };
}

/** Remove the item for `repo` (immutably). No-op if absent. */
export function removeItem(config: CommunityConfig, repo: string): CommunityConfig {
  return { version: 1, items: config.items.filter((i) => i.repo !== repo) };
}

/**
 * Items eligible for an *automatic* (launch-time) update check: opt-in
 * (`autoUpdate`), not pinned, and either never checked or last checked longer
 * ago than `cadenceMs`. The manual "Check for updates" command ignores this
 * filter and checks everything.
 */
export function itemsToCheck(
  config: CommunityConfig,
  now: number,
  cadenceMs: number = DEFAULT_CADENCE_MS
): CommunityItem[] {
  return config.items.filter((i) => {
    if (!i.autoUpdate) return false;
    if (i.pinnedVersion) return false;
    if (i.lastChecked === undefined) return true;
    return now - i.lastChecked >= cadenceMs;
  });
}

export interface UpdateDecision {
  update: boolean;
  reason: "pinned" | "up-to-date" | "downgrade" | "requires-newer-app" | "update-available";
}

/**
 * Decide whether an installed item should be updated to `remoteVersion`.
 * Pure and side-effect free so it's trivially testable.
 *
 * - pinned            → never
 * - remote <= installed → never (up-to-date / would be a downgrade)
 * - remote requires a newer Geode API than we run → never (guards against
 *   an auto-update bricking a working plugin)
 * - otherwise          → update
 */
export function shouldUpdate(
  item: CommunityItem,
  remoteVersion: string,
  opts: { minAppVersion?: string; apiVersion?: string } = {}
): UpdateDecision {
  if (item.pinnedVersion) return { update: false, reason: "pinned" };

  const cmp = compareVersions(remoteVersion, item.installedVersion);
  if (cmp === 0) return { update: false, reason: "up-to-date" };
  if (cmp < 0) return { update: false, reason: "downgrade" };

  const apiVersion = opts.apiVersion ?? GEODE_API_VERSION;
  if (opts.minAppVersion && !isVersionAtLeast(apiVersion, opts.minAppVersion)) {
    return { update: false, reason: "requires-newer-app" };
  }
  return { update: true, reason: "update-available" };
}
