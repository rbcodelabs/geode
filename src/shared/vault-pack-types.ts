/**
 * Serializable vault-pack shapes shared by the main process (src/main/vault-pack.ts)
 * and the renderer's consent screen (ADR 0050). No imports from Node or Electron.
 */
export interface VaultPackPluginSummary {
  id: string;
  source: "bundled" | "github";
  /** Verified sha256 of main.js (bundled only). */
  sha256?: string;
  repo?: string;
  /** Plugin name/version from its own manifest (bundled only). */
  name?: string;
  version?: string;
  /** sha256 of each bundled file (manifest.json, main.js, styles.css when present). */
  fileHashes?: Record<string, string>;
  enabled: boolean;
  /** Reserved by ADR 0050: validated and surfaced here, but NOT enforced and not shown in the consent UI. */
  locked: boolean;
  /** The id matches a first-party/built-in plugin of the app, so this pack plugin could impersonate it. */
  firstParty: boolean;
  /** Blocked by the ADR 0002 managed policy: installed, but never enabled. */
  blocked: boolean;
}

export interface VaultPackSummary {
  id: string;
  name: string;
  version: string;
  description?: string;
  minGeodeVersion?: string;
  /** Number of files that would be written into the vault (notes, config, and bundled plugin files). */
  fileCount: number;
  /** Files in the archive that were not extracted (e.g. `.geode/` runtime state). */
  skippedCount: number;
  totalBytes: number;
  plugins: VaultPackPluginSummary[];
}

/**
 * Plugin ids shipped with the app (internal plugins plus Claude Threads). A pack
 * bundling one of these is flagged on the consent screen. Best-effort list.
 */
export const FIRST_PARTY_PLUGIN_IDS: readonly string[] = [
  "claude-threads", "footnotes", "audio-recorder", "format-converter", "icloud-sync", "mermaid",
  "note-composer", "onboarding", "slash-commands", "slides", "daily-notes", "templates", "bases", "canvas",
  "backlinks", "graph", "outline", "bookmarks", "file-explorer", "search", "tag-pane", "properties", "sync",
  "publish", "word-count", "command-palette", "quick-switcher", "random-note", "page-preview", "zk-prefixer",
  "markdown-importer", "file-recovery", "outgoing-links", "slash-command", "workspaces", "webviewer",
];

/** A pack that has been inspected (nothing written) and is waiting for the user's consent. */
export interface VaultPackOffer {
  /** Opaque handle to the exact bytes that were inspected; pass to `create`. */
  token: string;
  fileName: string;
  summary: VaultPackSummary;
}

/**
 * Cheap hub-listing entry: read from the pack's manifest only (not fully
 * validated). Clicking it runs the full `inspect`, which is what the consent
 * screen shows.
 */
export interface OrganizationPackEntry {
  path: string;
  fileName: string;
  name?: string;
  version?: string;
  /** Why the pack could not be read (shown instead of a button). */
  error?: string;
}

/** Desktop host surface for vault packs (ADR 0050). Absent on mobile/browser hosts. */
export interface VaultPackHostSupport {
  /** Native file picker for a `.vault` file (null when cancelled). */
  choose(): Promise<string | null>;
  /** Validates a pack and returns its contents for the consent screen. Writes nothing. */
  inspect(packPath: string): Promise<VaultPackOffer>;
  /** A pack dropped on the hub; main re-validates the path before granting it. */
  inspectDropped(packPath: string): Promise<VaultPackOffer>;
  /** The user declined: forget the inspected pack. */
  discard(token: string): Promise<void>;
  /** The user consented: create `<parent>/<name>` from the inspected pack. Resolves to the vault path. */
  create(request: { token: string; parent: string; name: string }): Promise<string>;
  /** A pack handed to this window by `--vault-pack` or by opening a `.vault` file, if any (consumed once). */
  getLaunchPack(): Promise<VaultPackOffer | null>;
  listOrganizationPacks(): Promise<OrganizationPackEntry[]>;
  /** Filesystem path of a dropped `File`. */
  pathForFile(file: File): string;
  /** "Save vault as pack…" for the vault open in this window. */
  exportCurrent(): Promise<{ path: string; fileCount: number; pluginCount: number } | null>;
}
