/**
 * "Supported plugins" catalog list. Each row installs a main-process-admitted
 * catalog entry. Installing writes files; it never runs them. Enabling an
 * installed plugin (which executes its code) is a separate opt-in checkbox,
 * off by default — the same trust posture as the "Install from GitHub" modal
 * (see install-modal.ts). Being listed in the supported catalog is not by
 * itself consent to run the plugin.
 */

import type {
  SupportedPlugin,
  SupportedPluginCatalogIpcState,
} from "../../main/supported-plugin-catalog";
import type { InstalledResult } from "../../main/github-resolve";
import { isMinimumGeodeVersionMet } from "../../shared/semver";

export interface SupportedCatalogViewDeps {
  load(): Promise<SupportedPluginCatalogIpcState>;
  install(plugin: SupportedPlugin, release: "tested" | "latest"): Promise<InstalledResult>;
  /**
   * Enable an installed plugin — i.e. execute its code. Only ever called when
   * the user has ticked the opt-in checkbox for this row; installing alone
   * never enables (see the module header).
   */
  enable(pluginId: string): Promise<void>;
  /**
   * Soft failure from the last enable attempt, if any. `enable()` resolves even
   * when the plugin's `onload()` hasn't settled within the timeout, so this is
   * what distinguishes "enabled and running" from "enabled but still churning"
   * — same distinction install-modal.ts draws.
   */
  getLoadError(pluginId: string): string | undefined;
  onInstalled(): void;
}

export function supportedCatalogStateLabel(
  status: "fresh" | "stale",
  fetchedAt: string,
): string {
  const timestamp = new Date(fetchedAt).toLocaleString();
  return status === "stale"
    ? `Cached catalog from ${timestamp} (using cached catalog)`
    : `Updated ${timestamp}`;
}

function renderPluginRow(
  plugin: SupportedPlugin,
  currentGeodeVersion: string,
  deps: SupportedCatalogViewDeps,
): HTMLElement {
  const compatible = isMinimumGeodeVersionMet(currentGeodeVersion, plugin.minimumGeodeVersion);
  const row = document.createElement("div");
  row.className = "supported-plugin-item";
  row.dataset.pluginId = plugin.id;

  const info = document.createElement("div");
  info.className = "supported-plugin-info";
  const heading = document.createElement("div");
  heading.className = "supported-plugin-heading";
  const name = document.createElement("strong");
  name.textContent = plugin.name;
  const badge = document.createElement("span");
  badge.className = "community-item-badge supported-release-badge";
  badge.textContent = "Supported";
  heading.append(name, badge);
  const description = document.createElement("div");
  description.className = "community-item-sub";
  description.textContent = plugin.description;
  const version = document.createElement("div");
  version.className = "community-item-sub";
  version.textContent = compatible
    ? `Tested ${plugin.manifest.version} · ${plugin.github.owner}/${plugin.github.repo}`
    : `Requires Geode ${plugin.minimumGeodeVersion} or newer`;
  info.append(heading, description, version);

  const controls = document.createElement("div");
  controls.className = "supported-plugin-controls";
  const release = document.createElement("select");
  release.className = "dropdown supported-release-select";
  release.setAttribute("aria-label", `${plugin.name} release`);
  const tested = document.createElement("option");
  tested.value = "tested";
  tested.textContent = `Tested ${plugin.manifest.version}`;
  const latest = document.createElement("option");
  latest.value = "latest";
  latest.textContent = "Latest (unverified)";
  release.append(tested, latest);

  const warning = document.createElement("label");
  warning.className = "supported-latest-warning";
  warning.hidden = true;
  const confirm = document.createElement("input");
  confirm.type = "checkbox";
  confirm.className = "supported-latest-confirm";
  warning.append(confirm, document.createTextNode(" I understand the latest release is not verified by Geode."));

  // Opt-in, off by default: installing writes files, enabling runs them.
  const enableRow = document.createElement("label");
  enableRow.className = "community-enable-row supported-plugin-enable-row";
  const enableAfterInstall = document.createElement("input");
  enableAfterInstall.type = "checkbox";
  enableAfterInstall.className = "community-enable-checkbox supported-plugin-enable-checkbox";
  enableAfterInstall.disabled = !compatible;
  enableRow.append(
    enableAfterInstall,
    document.createTextNode(
      " Enable after installing — plugins run with full access to your files and system.",
    ),
  );

  const install = document.createElement("button");
  install.className = "supported-plugin-install mod-cta";
  install.textContent = "Install";
  install.disabled = !compatible;
  const status = document.createElement("div");
  status.className = "supported-plugin-status";
  status.setAttribute("role", "status");

  const updateChoice = () => {
    const isLatest = release.value === "latest";
    badge.textContent = isLatest ? "Unverified" : "Supported";
    badge.classList.toggle("is-unverified", isLatest);
    warning.hidden = !isLatest;
    if (!isLatest) confirm.checked = false;
    install.disabled = !compatible || (isLatest && !confirm.checked);
  };
  release.addEventListener("change", updateChoice);
  confirm.addEventListener("change", updateChoice);
  install.addEventListener("click", async () => {
    const choice = release.value === "latest" ? "latest" : "tested";
    install.disabled = true;
    release.disabled = true;
    status.textContent = "Installing…";
    status.classList.remove("is-error");
    const unverified = choice === "latest" ? " (unverified)" : "";
    try {
      let installed;
      try {
        installed = await deps.install(plugin, choice);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
        status.classList.add("is-error");
        return;
      }
      status.textContent = `Installed ${installed.name} ${installed.version}${unverified}`;
      // The install succeeded and is recorded. A failure past this point is an
      // enable failure and must not read as "install failed" — the files are
      // on disk either way, and the installed list needs to reflect that.
      if (enableAfterInstall.checked) {
        try {
          await deps.enable(installed.id);
          const loadError = deps.getLoadError(installed.id);
          status.textContent = loadError
            ? `Installed and enabled ${installed.name} ${installed.version}${unverified}, ` +
              `but it hasn't finished starting up: ${loadError}`
            : `Enabled ${installed.name} ${installed.version}${unverified}`;
        } catch (error) {
          status.textContent =
            `Installed ${installed.name} ${installed.version}${unverified}, but enabling failed: ` +
            (error instanceof Error ? error.message : String(error));
          status.classList.add("is-error");
        }
      }
      deps.onInstalled();
    } finally {
      release.disabled = false;
      updateChoice();
    }
  });
  controls.append(release, warning, enableRow, install, status);
  row.append(info, controls);
  return row;
}

export async function renderSupportedPluginCatalog(
  container: HTMLElement,
  deps: SupportedCatalogViewDeps,
): Promise<void> {
  container.innerHTML = "";
  const heading = document.createElement("h3");
  heading.textContent = "Supported plugins";
  const state = document.createElement("div");
  state.className = "community-item-sub supported-catalog-state";
  state.textContent = "Loading supported plugins…";
  container.append(heading, state);

  const result = await deps.load();
  if (result.status === "unavailable") {
    state.textContent = "Supported plugins are temporarily unavailable. You can still install from GitHub.";
    return;
  }
  state.textContent = supportedCatalogStateLabel(result.status, result.fetchedAt);
  const active = result.catalog.plugins.filter((plugin) =>
    plugin.status === "active" && plugin.platforms.includes("desktop")
  );
  if (!active.length) {
    const empty = document.createElement("div");
    empty.className = "community-empty";
    empty.textContent = "No supported desktop plugins are listed right now.";
    container.appendChild(empty);
    return;
  }
  for (const plugin of active) {
    container.appendChild(renderPluginRow(plugin, result.currentGeodeVersion, deps));
  }
}
