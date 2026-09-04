/**
 * Renderer-side orchestration for community install-from-GitHub (Phase 1;
 * docs/adr/0001-community-install-from-github.md). Owns `.geode/community.json`
 * (provenance + update policy) and drives the main-process resolve/install IPC.
 * Networking and file writes happen in main (src/main/community.ts); this layer
 * records what was installed and makes the plugin manager aware of it.
 */

import type { App } from "../app";
import type { CommunityPreview, InstalledResult, ResolveOpts } from "../../main/github-resolve";
import type { ObsidianImportResult } from "../../main/obsidian-import";
import {
  findItem,
  itemsToCheck,
  normalizeConfig,
  removeItem,
  setAutoUpdate,
  setPinned,
  shouldUpdate,
  upsertItem,
  type CommunityConfig,
  type CommunityItem,
} from "./store";

export interface UpdateSummary {
  /** How many items were actually checked against GitHub. */
  checked: number;
  /** "Name x.y.z" for each item updated. */
  updated: string[];
  /** Per-item failures (network, resolve, reload). */
  failed: { repo: string; error: string }[];
}

const CONFIG_KEY = "community"; // <vault>/.geode/community.json

/** What an Obsidian import did, for surfacing as a notice. */
export interface ObsidianImportSummary extends ObsidianImportResult {
  /** Plugin ids this import actually enabled (weren't already enabled). */
  enabled: string[];
}

export class CommunityManager {
  constructor(private app: App) {}

  /**
   * Import community plugins & themes from an existing Obsidian `.obsidian/`
   * folder in the current vault into `.geode/`. Main copies the files (see
   * src/main/obsidian-import.ts); here we make them live: rescan so freshly
   * copied plugins are enable-able, enable the plugins Obsidian had enabled
   * (that aren't already), and apply the theme Obsidian had active. Returns a
   * summary for a notice. Per-plugin enable failures are logged, not thrown, so
   * one bad plugin can't abort the whole import.
   *
   * Only `pluginsToEnable` — the plugins THIS import copied in — is ever
   * enabled. `enable()` executes `main.js` and persists the id, so iterating
   * the full merged `enabledPluginIds` would silently switch back on (and run)
   * a plugin the user had installed in Geode and deliberately disabled, just
   * because their stale `.obsidian/community-plugins.json` still lists it.
   */
  async importFromObsidian(): Promise<ObsidianImportSummary> {
    const result = await window.geode.importFromObsidian();
    // Freshly-copied plugin dirs must be visible before enable() will take them.
    await this.app.pluginManager.rescan();

    const enabled: string[] = [];
    for (const id of result.pluginsToEnable) {
      if (this.app.pluginManager.isEnabled(id)) continue;
      if (!this.app.pluginManager.getManifest(id)) continue; // absent/unreadable on disk
      try {
        await this.app.pluginManager.enable(id);
        enabled.push(id);
      } catch (err) {
        console.error(`Obsidian import: failed to enable "${id}":`, err);
      }
    }

    if (result.activeTheme) {
      await this.app.applyCommunityTheme(result.activeTheme);
    }

    return { ...result, enabled };
  }

  /** Read the tracked-items config (tolerates a missing/corrupt file). */
  async load(): Promise<CommunityConfig> {
    return normalizeConfig(await window.geode.readConfig(CONFIG_KEY));
  }

  private async save(config: CommunityConfig): Promise<void> {
    await window.geode.writeConfig(CONFIG_KEY, config);
  }

  /** Resolve `owner/repo` to install metadata for a pre-install preview. */
  resolve(spec: string, opts: ResolveOpts = {}): Promise<CommunityPreview> {
    return window.geode.resolveCommunity(spec, opts);
  }

  /**
   * Install `owner/repo`, record it in community.json (auto-update OFF by
   * default — opt-in per repo), and make it visible to the app. Does NOT
   * enable a plugin or apply a theme; that's a separate explicit step.
   */
  async install(spec: string, opts: ResolveOpts = {}): Promise<InstalledResult> {
    const installed = await window.geode.installCommunity(spec, opts);

    const item: CommunityItem = {
      repo: installed.repo,
      type: installed.type,
      id: installed.id,
      installedVersion: installed.version,
      source: installed.source,
      ref: installed.ref,
      autoUpdate: false,
    };
    await this.save(upsertItem(await this.load(), item));

    // Make the freshly-written plugin dir enable-able without a restart. Themes
    // need no equivalent — the theme picker re-reads .geode/themes/ on open.
    if (installed.type === "plugin") {
      await this.app.pluginManager.rescan();
    }
    return installed;
  }

  /**
   * Check tracked items for a newer version and update the ones that have one.
   * With `force`, checks every non-pinned item; otherwise only opt-in
   * (`autoUpdate`) items past the cadence (see itemsToCheck). Updating a
   * plugin re-downloads + hot-reloads it; updating the active theme re-applies
   * it. `installedVersion`/`ref`/`lastChecked` are persisted back to
   * community.json. Never throws — per-item failures are collected.
   */
  async checkForUpdates(
    opts: { force?: boolean; repos?: string[] } = {}
  ): Promise<UpdateSummary> {
    const now = Date.now();
    let config = await this.load();
    const candidates = opts.repos
      ? config.items.filter((i) => opts.repos!.includes(i.repo) && !i.pinnedVersion)
      : opts.force
        ? config.items.filter((i) => !i.pinnedVersion)
        : itemsToCheck(config, now);

    const summary: UpdateSummary = { checked: 0, updated: [], failed: [] };

    for (const item of candidates) {
      summary.checked++;
      try {
        const preview = await this.resolve(item.repo, { type: item.type });
        const decision = shouldUpdate(item, preview.version, {
          minAppVersion: preview.minAppVersion,
        });

        if (!decision.update) {
          config = upsertItem(config, { ...item, lastChecked: now });
          continue;
        }

        const installed = await window.geode.installCommunity(item.repo, { type: item.type });
        config = upsertItem(config, {
          ...item,
          installedVersion: installed.version,
          source: installed.source,
          ref: installed.ref,
          lastChecked: now,
        });

        if (installed.type === "plugin") {
          await this.app.pluginManager.reload(installed.id);
        } else if (this.app.settings.cssTheme === installed.id) {
          // Only the *active* theme needs a live re-apply; others just sit on disk.
          await this.app.themeManager.apply(installed.id);
        }
        summary.updated.push(`${installed.name} ${installed.version}`);
      } catch (err) {
        summary.failed.push({ repo: item.repo, error: (err as Error).message });
      }
    }

    await this.save(config);
    return summary;
  }

  /** Toggle an item's opt-in auto-update flag. */
  async setAutoUpdate(repo: string, on: boolean): Promise<void> {
    await this.save(setAutoUpdate(await this.load(), repo, on));
  }

  /** Pin (freeze at installed version) or unpin an item. */
  async setPinned(repo: string, pinned: boolean): Promise<void> {
    await this.save(setPinned(await this.load(), repo, pinned));
  }

  /**
   * Stop managing an item: remove it from community.json. Files stay on disk
   * and a plugin stays enabled / a theme stays applied — this only ends
   * update tracking (distinct from uninstall).
   */
  async stopUpdating(repo: string): Promise<void> {
    await this.save(removeItem(await this.load(), repo));
  }

  /**
   * Fully remove an item: disable the plugin (or revert the active theme to
   * default), delete its files, and untrack it. Files go to the OS trash,
   * matching the vault's delete behavior.
   */
  async uninstall(repo: string): Promise<void> {
    const config = await this.load();
    const item = findItem(config, repo);
    if (!item) return;

    if (item.type === "plugin") {
      if (this.app.pluginManager.isEnabled(item.id)) {
        await this.app.pluginManager.disable(item.id);
      }
      await window.geode.trash(`.geode/plugins/${item.id}`);
      await this.app.pluginManager.rescan();
    } else {
      if (this.app.settings.cssTheme === item.id) {
        await this.app.applyCommunityTheme(""); // revert to built-in default
      }
      await window.geode.trash(`.geode/themes/${item.id}`);
    }
    await this.save(removeItem(config, repo));
  }
}
