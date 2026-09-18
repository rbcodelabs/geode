/**
 * Row building for the desktop "Community plugins & themes" list
 * (Settings → Community). Split out of app.ts behind an injected deps
 * interface — the same seam supported-catalog-view.ts uses — so the
 * enable/disable affordance and its policy/quarantine/theme exclusions are
 * unit-testable without standing up a whole App.
 *
 * Two facts drive everything here:
 *
 * 1. Enabling a plugin executes its code, so it is always an explicit user
 *    action. Nothing in this module enables anything on its own.
 * 2. `.geode/community.json` records *provenance*, not inventory. Plugins can
 *    reach `.geode/plugins/` without passing through it ("Import from
 *    Obsidian", the default-vault bootstrap), so the list is built from the
 *    installed manifests as well, with provenance merged in where it exists.
 */

import type { PluginManifest } from "../plugin-manifest";
import type { CommunityItem } from "./store";

export interface CommunityListViewDeps {
  isMobileRuntime(): boolean;
  /** Blocked by the enterprise-managed plugin policy (docs/adr/0002). */
  isBlocked(pluginId: string): boolean;
  isEnabled(pluginId: string): boolean;
  /** Present iff the plugin's files are actually on disk. */
  getManifest(pluginId: string): PluginManifest | undefined;
  /** Message from the last failed load/enable attempt, if any. */
  getLoadError(pluginId: string): string | undefined;
  /** Ids currently quarantined after an error; those rows own their own controls. */
  quarantinedIds(): ReadonlySet<string>;
  enable(pluginId: string): Promise<void>;
  disable(pluginId: string): Promise<void>;
  notify(message: string): void;
  /** Re-render the list after a state change. */
  refresh(): void | Promise<void>;
}

/**
 * Installed plugins with no `community.json` entry — the ones that were
 * invisible in this list entirely, and so could never be disabled. Quarantined
 * ids are excluded because `renderCommunityList` already gives them a
 * dedicated row with Restore / Disable.
 */
export function selectUntrackedManifests(
  manifests: readonly PluginManifest[],
  trackedItems: readonly CommunityItem[],
  quarantined: ReadonlySet<string>,
): PluginManifest[] {
  return manifests.filter(
    (manifest) =>
      !quarantined.has(manifest.id) &&
      !trackedItems.some((item) => item.type === "plugin" && item.id === manifest.id),
  );
}

/**
 * Enable/disable toggle for one installed plugin, shared by the tracked
 * (community.json) row and the untracked-installed row.
 *
 * Returns null when another row already owns that plugin's lifecycle, so one
 * plugin never gets two competing controls:
 *   - mobile runtime → `renderMobilePluginRow` handles it (and gates on
 *     mobile admission, which this control does not model);
 *   - quarantined → the quarantine row's Restore / Disable handles it, and
 *     `enable()` would throw for it anyway;
 *   - no manifest on disk → tracked in community.json but nothing to run.
 */
export function createPluginEnableControl(
  pluginId: string,
  deps: CommunityListViewDeps,
): HTMLButtonElement | null {
  if (deps.isMobileRuntime()) return null;
  if (deps.quarantinedIds().has(pluginId)) return null;
  if (!deps.getManifest(pluginId)) return null;

  const enabled = deps.isEnabled(pluginId);
  const toggle = document.createElement("button");
  toggle.className = "community-item-enable";
  toggle.textContent = enabled ? "Disable" : "Enable";

  // Policy blocks *loading* the code, so a blocked plugin cannot be enabled.
  // Disabling one is always safe, though, and is the only way out if policy
  // arrived after the plugin was already running — so only the enable
  // direction is made inert. The control stays visible either way so the state
  // reads alongside the "blocked by admin" badge.
  if (deps.isBlocked(pluginId) && !enabled) {
    toggle.disabled = true;
    toggle.title = "Disabled by administrator policy";
    return toggle;
  }

  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    try {
      if (deps.isEnabled(pluginId)) await deps.disable(pluginId);
      else await deps.enable(pluginId);
    } catch (error) {
      // Surface it rather than throwing into the void — a plugin whose
      // onload() blew up otherwise fails silently.
      deps.notify(error instanceof Error ? error.message : String(error));
    }
    await deps.refresh();
  });
  return toggle;
}

/**
 * Enable control for a row backed by a community.json entry.
 *
 * Themes are *applied* from the Appearance theme picker, not enabled — they
 * have no enabled set to join — so they never get this control, whatever else
 * is true about them.
 */
export function createTrackedItemEnableControl(
  item: Pick<CommunityItem, "id" | "type">,
  deps: CommunityListViewDeps,
): HTMLButtonElement | null {
  if (item.type !== "plugin") return null;
  return createPluginEnableControl(item.id, deps);
}

/** Inline diagnostic for the last load/enable failure, if there was one. */
export function appendLoadErrorDiagnostic(
  info: HTMLElement,
  pluginId: string,
  deps: CommunityListViewDeps,
): void {
  const loadError = deps.getLoadError(pluginId);
  if (!loadError) return;
  const diagnostic = document.createElement("div");
  diagnostic.className = "community-plugin-diagnostic";
  diagnostic.setAttribute("role", "alert");
  diagnostic.textContent = loadError;
  info.appendChild(diagnostic);
}

/**
 * Row for a plugin installed on disk with no community.json provenance.
 * Update / pin / uninstall all need a tracked repo, so this row carries only
 * the enable/disable control — which is the part that was missing entirely.
 */
export function renderInstalledPluginRow(
  manifest: PluginManifest,
  deps: CommunityListViewDeps,
): HTMLElement {
  const blocked = deps.isBlocked(manifest.id);

  const row = document.createElement("div");
  row.className = "community-item installed-plugin-item";
  row.dataset.pluginId = manifest.id;

  const info = document.createElement("div");
  info.className = "community-item-info";
  const title = document.createElement("div");
  title.className = "community-item-title";
  // manifest.name is author-controlled: textContent, never innerHTML.
  title.textContent = manifest.name;
  const typeBadge = document.createElement("span");
  typeBadge.className = "community-item-badge";
  typeBadge.textContent = "plugin";
  title.appendChild(typeBadge);
  if (blocked) {
    const blockedBadge = document.createElement("span");
    blockedBadge.className = "community-item-badge is-blocked";
    blockedBadge.title = "Disabled by administrator policy";
    blockedBadge.textContent = "blocked by admin";
    title.appendChild(blockedBadge);
  }
  const sub = document.createElement("div");
  sub.className = "community-item-sub";
  sub.textContent = `v${manifest.version} · not tracked for updates`;
  info.append(title, sub);
  appendLoadErrorDiagnostic(info, manifest.id, deps);

  const controls = document.createElement("div");
  controls.className = "community-item-controls";
  const toggle = createPluginEnableControl(manifest.id, deps);
  if (toggle) controls.appendChild(toggle);

  row.append(info, controls);
  return row;
}
