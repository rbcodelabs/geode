import type {
  SupportedPlugin,
  SupportedPluginCatalogIpcState,
} from "../../main/supported-plugin-catalog";
import type { InstalledResult } from "../../main/github-resolve";
import { isMinimumGeodeVersionMet } from "../../shared/semver";

export interface SupportedCatalogViewDeps {
  load(): Promise<SupportedPluginCatalogIpcState>;
  install(plugin: SupportedPlugin, release: "tested" | "latest"): Promise<InstalledResult>;
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
    try {
      const installed = await deps.install(plugin, choice);
      status.textContent = `Installed ${installed.name} ${installed.version}${choice === "latest" ? " (unverified)" : ""}`;
      deps.onInstalled();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      status.classList.add("is-error");
    } finally {
      release.disabled = false;
      updateChoice();
    }
  });
  controls.append(release, warning, install, status);
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
