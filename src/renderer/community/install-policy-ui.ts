/**
 * Renderer-side presentation of the `pluginInstall` managed policy
 * (docs/adr/0052). ADVISORY ONLY: the renderer runs with `nodeIntegration`, so
 * hiding or disabling a control here enforces nothing. The real checks are in
 * the main-process IPC handlers (src/main/plugin-install-policy.ts); this
 * module just keeps the Settings UI honest about what will be refused, and
 * says "managed by your administrator" instead of letting controls vanish.
 */

import type { EffectivePolicy, EffectivePolicyResult } from "../policy-layering";

export interface InstallControlState {
  /** "Install from GitHub" (community-install / community-resolve). */
  github: boolean;
  /** Supported-plugin catalog list + install. */
  catalog: boolean;
  /** "Import from Obsidian". */
  importObsidian: boolean;
  /** Note to show next to a disabled control, or null when everything is allowed. */
  note: string | null;
  /** When `sources` restricts installs: the lists, for an informational note only. */
  sources: string[] | null;
}

const MANAGED = "Managed by your administrator";

/** Everything allowed: the baseline with no policy, or when it cannot be read (fail open). */
export const UNRESTRICTED: InstallControlState = {
  github: true,
  catalog: true,
  importObsidian: true,
  note: null,
  sources: null,
};

export function installControlState(effective: Pick<EffectivePolicy, "pluginInstall"> | null | undefined): InstallControlState {
  const install = effective?.pluginInstall;
  if (!install) return UNRESTRICTED;
  const sources = install.sources && install.sources.length > 0 ? [...new Set(install.sources.flat())] : null;
  if (install.mode === "disabled") {
    return {
      github: false,
      catalog: false,
      importObsidian: false,
      note: `${MANAGED}: plugin installation is turned off. Installed plugins are not affected.`,
      sources,
    };
  }
  if (install.mode === "catalog-only") {
    return {
      github: false,
      catalog: true,
      importObsidian: false,
      note: `${MANAGED}: only plugins from the supported catalog can be installed.`,
      sources,
    };
  }
  return {
    ...UNRESTRICTED,
    note: install.sources
      ? `${MANAGED}: installs are limited to approved sources${sources ? ` (${sources.join(", ")})` : ""}.`
      : null,
    sources,
  };
}

/** Read the effective policy through the preload accessor; any failure means unrestricted (fail open). */
export async function readInstallControlState(): Promise<InstallControlState> {
  try {
    const result = (await window.geode.getEffectivePolicy?.()) as EffectivePolicyResult | null | undefined;
    return installControlState(result?.effective);
  } catch {
    return UNRESTRICTED;
  }
}

/** Append a visible "managed by your administrator" note after `anchor`. */
export function appendManagedNote(parent: HTMLElement, text: string): HTMLElement {
  const note = document.createElement("div");
  note.className = "managed-policy-note setting-item-description";
  note.textContent = text;
  parent.appendChild(note);
  return note;
}

/** Disable a control and explain why, without removing it. */
export function disableManaged(button: HTMLButtonElement, note: string): void {
  button.disabled = true;
  button.title = note;
  button.setAttribute("aria-disabled", "true");
  button.classList.add("is-managed-disabled");
}
