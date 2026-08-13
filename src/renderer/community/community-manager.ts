/**
 * Renderer-side orchestration for community install-from-GitHub (Phase 1;
 * docs/adr/0001-community-install-from-github.md). Owns `.geode/community.json`
 * (provenance + update policy) and drives the main-process resolve/install IPC.
 * Networking and file writes happen in main (src/main/community.ts); this layer
 * records what was installed and makes the plugin manager aware of it.
 */

import type { App } from "../app";
import type { CommunityPreview, InstalledResult, ResolveOpts } from "../../main/github-resolve";
import {
  normalizeConfig,
  upsertItem,
  type CommunityConfig,
  type CommunityItem,
} from "./store";

const CONFIG_KEY = "community"; // <vault>/.geode/community.json

export class CommunityManager {
  constructor(private app: App) {}

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
}
