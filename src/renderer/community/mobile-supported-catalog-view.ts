/**
 * Mobile "Supported plugins" list (Settings → Community plugins & themes on the
 * mobile runtime). Counterpart of supported-catalog-view.ts, which stays
 * untouched so the desktop DOM contract does not change.
 *
 * Differences from desktop, all deliberate:
 *  - no release picker: only the catalog-certified *tested* release installs;
 *  - desktop-only entries are shown as "Desktop only" with no install control,
 *    rather than hidden;
 *  - there is no "enable after installing" shortcut. Installing writes files;
 *    enabling executes code and remains the explicit Enable (and, for unknown
 *    plugins, "Allow on mobile") action on the installed-plugin row.
 */

import type {
  SupportedPlugin,
  SupportedPluginCatalog,
  SupportedPluginCatalogIpcState,
} from "../../shared/supported-plugin-catalog";
import { listMobileSupportedPlugins, type MobileSupportedAvailability } from "../../shared/supported-plugin-catalog";
import type { InstalledResult } from "../../main/github-resolve";
import { supportedCatalogStateLabel } from "./supported-catalog-view";

export interface MobileSupportedCatalogViewDeps {
  load(): Promise<SupportedPluginCatalogIpcState>;
  install(catalog: SupportedPluginCatalog, pluginId: string): Promise<InstalledResult>;
  /** Installed version of this plugin id, if its files are on disk. */
  getInstalledVersion(pluginId: string): string | undefined;
  onInstalled(): void;
}

function renderRow(
  catalog: SupportedPluginCatalog,
  plugin: SupportedPlugin,
  availability: MobileSupportedAvailability,
  deps: MobileSupportedCatalogViewDeps,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "supported-plugin-item";
  row.dataset.pluginId = plugin.id;
  row.dataset.availability = availability.kind;

  const info = document.createElement("div");
  info.className = "supported-plugin-info";
  const heading = document.createElement("div");
  heading.className = "supported-plugin-heading";
  const name = document.createElement("strong");
  name.textContent = plugin.name;
  const badge = document.createElement("span");
  badge.className = "community-item-badge supported-release-badge";
  badge.textContent = availability.kind === "desktop-only" ? "Desktop only" : "Supported";
  heading.append(name, badge);
  const description = document.createElement("div");
  description.className = "community-item-sub";
  description.textContent = plugin.description;
  const version = document.createElement("div");
  version.className = "community-item-sub supported-plugin-version";
  version.textContent = availability.kind === "desktop-only"
    ? `Tested ${plugin.manifest.version} on desktop only — not available on mobile`
    : availability.kind === "requires-newer-geode"
      ? `Requires Geode ${availability.minimumGeodeVersion} or newer`
      : `Tested ${plugin.manifest.version} · ${plugin.github.owner}/${plugin.github.repo}`;
  info.append(heading, description, version);
  row.append(info);
  if (availability.kind !== "installable") return row;

  const controls = document.createElement("div");
  controls.className = "supported-plugin-controls";
  const installed = deps.getInstalledVersion(plugin.id);
  const install = document.createElement("button");
  install.className = "supported-plugin-install mod-cta";
  install.textContent = installed === undefined ? "Install"
    : installed === plugin.manifest.version ? "Reinstall"
    : `Install ${plugin.manifest.version}`;
  const status = document.createElement("div");
  status.className = "supported-plugin-status";
  status.setAttribute("role", "status");
  if (installed !== undefined) status.textContent = `Installed ${installed}`;

  install.addEventListener("click", async () => {
    install.disabled = true;
    status.textContent = "Installing…";
    status.classList.remove("is-error");
    try {
      const result = await deps.install(catalog, plugin.id);
      status.textContent = `Installed ${result.name} ${result.version}. Enable it from the plugin list when you are ready.`;
      deps.onInstalled();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      status.classList.add("is-error");
    } finally {
      install.disabled = false;
    }
  });
  controls.append(install, status);
  row.append(controls);
  return row;
}

export async function renderMobileSupportedPluginCatalog(
  container: HTMLElement,
  deps: MobileSupportedCatalogViewDeps,
): Promise<void> {
  container.innerHTML = "";
  container.dataset.platform = "mobile";
  const heading = document.createElement("h3");
  heading.textContent = "Supported plugins";
  const state = document.createElement("div");
  state.className = "community-item-sub supported-catalog-state";
  state.textContent = "Loading supported plugins…";
  container.append(heading, state);

  const result = await deps.load();
  if (result.status === "unavailable") {
    state.textContent = `Supported plugins are temporarily unavailable. Check your connection and reopen Settings to try again.${result.error ? ` (${result.error})` : ""}`;
    return;
  }
  state.textContent = supportedCatalogStateLabel(result.status, result.fetchedAt);
  const entries = listMobileSupportedPlugins(result.catalog, result.currentGeodeVersion);
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "community-empty";
    empty.textContent = "No supported plugins are listed right now.";
    container.appendChild(empty);
    return;
  }
  if (!entries.some((entry) => entry.availability.kind !== "desktop-only")) {
    const note = document.createElement("div");
    note.className = "community-item-sub supported-catalog-no-mobile";
    note.textContent = "None of the supported plugins have been tested on mobile yet.";
    container.appendChild(note);
  }
  for (const { plugin, availability } of entries) {
    container.appendChild(renderRow(result.catalog, plugin, availability, deps));
  }
}
