import type { App } from "./app";
import { Plugin } from "./plugin";
import {
  GEODE_API_VERSION,
  isVersionAtLeast,
  parseManifest,
  type PluginManifest,
} from "./plugin-manifest";
import * as GeodeAPI from "./api/obsidian";
import { isPluginBlocked, type ManagedPolicy } from "./policy";

type PluginConstructor = new (app: App, manifest: PluginManifest) => Plugin;

const CONFIG_KEY = "plugins"; // <vault>/.geode/plugins.json — array of enabled plugin ids
const QUARANTINE_KEY = "plugin-quarantine";

interface QuarantineEntry { at: number; boundary: string; message: string }

/**
 * How long `enable()` waits for a plugin's async `onload()` to settle before it
 * stops blocking and considers the plugin "started in the background". This
 * bounds the two callers that would otherwise wedge on a plugin whose onload
 * never resolves: the community install modal and `App.initialize()`'s
 * auto-enable loop (which app boot awaits). Chosen generous enough that a
 * legitimately slow onload isn't flagged, but finite so a hang can't freeze the
 * UI. See the real-world Claude Threads install-hang this guards against.
 */
export const PLUGIN_ONLOAD_TIMEOUT_MS = 10_000;

function pluginDir(id: string): string {
  return `.geode/plugins/${id}`;
}

/**
 * The real Node `require` exposed on the renderer's global scope because
 * the window runs with `nodeIntegration: true` (see main.ts). Captured once
 * so the plugin loader can delegate Node/Electron builtin specifiers
 * (`fs`, `path`, `child_process`, `electron`, …) straight through to Node —
 * exactly what Obsidian's own plugin host does. `undefined` only if Geode is
 * ever run without Node integration (e.g. a future web build), in which case
 * builtin requires from plugins will throw a clear error.
 */
const nodeRequire: ((id: string) => unknown) | undefined = (
  globalThis as unknown as { require?: (id: string) => unknown }
).require;

/**
 * Compile a plugin's `main.js` (CommonJS, exactly as Obsidian plugins are
 * bundled) and return its default export, which must be a class extending
 * `Plugin`.
 *
 * Obsidian bundles plugins against `require('obsidian')` plus Node/Electron
 * builtins. Geode mirrors that host contract:
 *  - `require('obsidian')` and `require('geode')` both resolve to Geode's
 *    Obsidian-compatible API surface (`GeodeAPI`).
 *  - every other specifier is delegated to the renderer's real Node
 *    `require` (available because the window runs with Node integration),
 *    so `fs`/`path`/`child_process`/`electron`/… work as the plugin expects.
 *
 * The plugin body runs in the renderer's own JS realm via `Function(...)`
 * (the CSP allows this — see index.html). This is a deliberate trust
 * decision consistent with Obsidian: locally-installed plugins are trusted.
 */
function instantiatePluginClass(code: string, pluginId: string): PluginConstructor {
  const moduleObj: { exports: any } = { exports: {} };
  const requireShim = (specifier: string): unknown => {
    if (specifier === "obsidian" || specifier === "geode") return GeodeAPI;
    if (nodeRequire) {
      try {
        return nodeRequire(specifier);
      } catch (err) {
        throw new Error(
          `Plugin "${pluginId}" require("${specifier}") failed: ${(err as Error).message}`
        );
      }
    }
    throw new Error(
      `Plugin "${pluginId}" called require("${specifier}"), but Geode has no Node ` +
        `integration in this build, so only require("obsidian")/require("geode") are available.`
    );
  };
  // eslint-disable-next-line no-new-func -- deliberate CJS-style plugin loader, see doc comment above
  const run = new Function("module", "exports", "require", code);
  run(moduleObj, moduleObj.exports, requireShim);
  const exported = moduleObj.exports?.default ?? moduleObj.exports;
  if (typeof exported !== "function") {
    throw new Error(
      `Plugin "${pluginId}" main.js must export a class extending Plugin as its default export`
    );
  }
  return exported as PluginConstructor;
}

interface LoadedPlugin {
  manifest: PluginManifest;
  instance: Plugin;
}

/**
 * Discovers, enables, and disables plugins found in the open vault's
 * `.geode/plugins/` directory (Obsidian's `.obsidian/plugins/`
 * equivalent). One `PluginManager` per open vault, owned by `App`.
 */
export class PluginManager {
  private manifests = new Map<string, PluginManifest>();
  private loadErrors = new Map<string, string>();
  private loaded = new Map<string, LoadedPlugin>();
  private policy: ManagedPolicy | null = null;
  private quarantine: Record<string, QuarantineEntry> = {};
  private recoveryMode = false;
  private containing = new Set<string>();

  constructor(
    private app: App,
    private onloadTimeoutMs: number = PLUGIN_ONLOAD_TIMEOUT_MS
  ) {}

  /**
   * Discover installed plugins and enable whichever were enabled last
   * session. Fetches the enterprise-managed plugin policy (if any) first,
   * fresh on every call — see `docs/adr/0002-enterprise-plugin-policy.md`.
   * `getPluginPolicy` is optional on the `window.geode` fake used by unit
   * tests, hence the `?.()`.
   */
  async initialize(): Promise<void> {
    this.loadErrors.clear();
    this.policy = (await window.geode.getPluginPolicy?.()) ?? null;
    await this.rescan();

    this.quarantine =
      ((await window.geode.readConfig(QUARANTINE_KEY)) as Record<string, QuarantineEntry> | null) ?? {};
    const recovery = await window.geode.getCrashRecoveryState?.();
    this.recoveryMode = recovery?.suppressPlugins === true;

    const enabledIds = ((await window.geode.readConfig(CONFIG_KEY)) as string[] | null) ?? [];
    if (this.recoveryMode) return;
    for (const id of enabledIds) {
      if (!this.manifests.has(id)) continue;
      if (this.quarantine[id]) continue;
      try {
        await this.enable(id, { persist: false });
      } catch (err) {
        this.loadErrors.set(id, (err as Error).message);
        console.error(`Failed to enable plugin "${id}"`, err);
        if (this.isBlocked(id)) {
          this.app.notify(
            `"${this.manifests.get(id)?.name ?? id}" is disabled by your organization's policy.`,
            6000
          );
        }
      }
    }
  }

  isRecoveryMode(): boolean { return this.recoveryMode; }

  listQuarantined(): Record<string, QuarantineEntry> { return { ...this.quarantine }; }

  async restoreQuarantined(id: string): Promise<void> {
    if (!this.quarantine[id]) return;
    delete this.quarantine[id];
    await window.geode.writeConfig(QUARANTINE_KEY, this.quarantine);
    await this.enable(id);
  }

  async leaveRecoveryMode(): Promise<void> {
    await window.geode.leaveCrashRecovery?.();
    this.recoveryMode = false;
  }

  /** Whether plugin `id` is currently blocked by the enterprise-managed policy. */
  isBlocked(id: string): boolean {
    return isPluginBlocked(this.policy, id);
  }

  /**
   * Re-read installed plugin ids + manifests from disk into the in-memory map
   * WITHOUT enabling anything. Adds newly-installed ids, refreshes existing
   * manifests (so a bumped version is picked up), and drops manifests for ids
   * gone from disk that aren't currently loaded. Loaded plugins are never
   * touched. This is what lets a freshly-installed plugin be enabled without
   * restarting the app — `enable()` throws for ids it hasn't seen.
   */
  async rescan(): Promise<void> {
    let ids: string[] = [];
    try {
      ids = await window.geode.listPluginIds();
    } catch (err) {
      console.error("Failed to list plugins", err);
      return;
    }
    const present = new Set(ids);
    for (const id of ids) {
      try {
        this.manifests.set(id, await this.readManifest(id));
      } catch (err) {
        this.loadErrors.set(id, (err as Error).message);
        console.error(`Failed to read manifest for plugin "${id}"`, err);
      }
    }
    for (const id of [...this.manifests.keys()]) {
      if (!present.has(id) && !this.loaded.has(id)) this.manifests.delete(id);
    }
  }

  /**
   * Hot-reload a plugin whose files changed on disk (e.g. a community update).
   * If it's enabled: disable (runs onunload) → rescan (pick up the new
   * manifest) → enable (runs the new main.js). If it's disabled: just rescan
   * so the new manifest/version is visible. Enabled-set membership is
   * preserved (persist:false), since a reload isn't an enable/disable choice.
   *
   * Caveat: re-running main.js in the same renderer realm means any
   * module-level side effect the plugin didn't reverse in onunload() persists
   * until an app restart — callers should surface a "restart to finish" hint
   * if enable() throws here.
   */
  async reload(id: string): Promise<void> {
    const wasEnabled = this.loaded.has(id);
    if (wasEnabled) await this.disable(id, { persist: false });
    await this.rescan();
    if (wasEnabled) await this.enable(id, { persist: false });
  }

  private async readManifest(id: string): Promise<PluginManifest> {
    const raw = await window.geode.read(`${pluginDir(id)}/manifest.json`);
    const manifest = parseManifest(raw, id);
    // Stamp the plugin's own vault-relative folder onto the manifest, exactly
    // as Obsidian does at load time. `dir` is deliberately not part of the
    // on-disk manifest.json (parseManifest stays a pure parser); the loader is
    // the single place that knows where the plugin lives, so it sets it here.
    // Plugins resolve sibling files against this (e.g. Claude Threads'
    // skill-sources: `path.join(vaultRoot, manifest.dir, "skill-sources")`).
    manifest.dir = pluginDir(id);
    return manifest;
  }

  /** All discovered plugin manifests, whether enabled or not. */
  listManifests(): PluginManifest[] {
    return [...this.manifests.values()];
  }

  getManifest(id: string): PluginManifest | undefined {
    return this.manifests.get(id);
  }

  /** Error from the last failed load/enable attempt for `id`, if any. */
  getLoadError(id: string): string | undefined {
    return this.loadErrors.get(id);
  }

  isEnabled(id: string): boolean {
    return this.loaded.has(id);
  }

  getPlugin(id: string): Plugin | undefined {
    return this.loaded.get(id)?.instance;
  }

  /** Load a plugin's code, instantiate it, and call `onload()`. */
  async enable(id: string, opts: { persist?: boolean } = {}): Promise<void> {
    const { persist = true } = opts;
    if (this.loaded.has(id)) return;
    const manifest = this.manifests.get(id);
    if (!manifest) throw new Error(`Unknown plugin: "${id}"`);
    if (this.quarantine[id]) throw new Error(`Plugin "${id}" is quarantined after an error`);
    if (this.isBlocked(id)) {
      throw new Error(`Plugin "${id}" is blocked by administrator policy`);
    }
    if (!isVersionAtLeast(GEODE_API_VERSION, manifest.minAppVersion)) {
      throw new Error(
        `Plugin "${id}" requires Geode ${manifest.minAppVersion}+ (running ${GEODE_API_VERSION})`
      );
    }

    const code = await window.geode.read(`${pluginDir(id)}/main.js`);
    const PluginClass = instantiatePluginClass(code, id);
    const instance = new PluginClass(this.app, manifest);
    instance.setErrorHandler((boundary, error) => this.containPluginError(id, boundary, error));
    this.loadErrors.delete(id);
    this.loaded.set(id, { manifest, instance });
    await this.injectStyles(id);

    let onloadResult: void | Promise<unknown>;
    try {
      instance.load(); // Component.load() -> onload() (may throw synchronously)
      onloadResult = instance.onloadResult;
    } catch (err) {
      this.removeStyles(id);
      this.loaded.delete(id);
      await this.recordAndQuarantine(id, "onload", err);
      throw err;
    }

    // Await a possibly-async onload before considering the plugin fully started,
    // so registrations made after an `await` inside onload (registerView,
    // addCommand, …) are in place before startup continues to layout restore —
    // mirroring Obsidian. But BOUND the wait: a plugin whose onload() never
    // settles must not wedge the caller (the community install modal, or
    // App.initialize()'s auto-enable loop, which app boot awaits). On timeout
    // the plugin stays loaded — its synchronous registrations already ran — and
    // the slow onload keeps running in the background; the stall is surfaced via
    // getLoadError() instead of being silently swallowed.
    if (onloadResult !== undefined) {
      const onload = Promise.resolve(onloadResult);
      const TIMED_OUT = Symbol("onload-timeout");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), this.onloadTimeoutMs);
      });

      let outcome: unknown;
      try {
        outcome = await Promise.race([onload, timeout]);
      } catch (err) {
        // onload() genuinely rejected (a real load failure, not a hang) —
        // roll back exactly as before.
        clearTimeout(timer);
        this.removeStyles(id);
        this.loaded.delete(id);
        await this.recordAndQuarantine(id, "onload", err);
        throw err;
      }
      clearTimeout(timer);

      if (outcome === TIMED_OUT) {
        const note =
          `Plugin "${id}" onload() did not finish within ${this.onloadTimeoutMs}ms; ` +
          `it is enabled but may not have finished starting up.`;
        this.loadErrors.set(id, note);
        console.warn(note);
        // The onload promise is still live. Attach handlers so a later rejection
        // is logged (not an unhandledrejection), and the soft note clears if
        // onload eventually completes cleanly.
        onload.then(
          () => {
            if (this.loadErrors.get(id) === note) this.loadErrors.delete(id);
          },
          (err) => {
            console.error(`Plugin "${id}" onload() failed after enable() returned:`, err);
            void this.containPluginError(id, "onload", err);
          }
        );
      }
    }

    if (persist) await this.persistEnabled();
    await this.reportActivePlugins();
  }

  /**
   * Inject a plugin's `styles.css` into the document, mirroring Obsidian,
   * which auto-loads each enabled plugin's stylesheet. Missing/empty
   * stylesheets are ignored. Removed on disable via `removeStyles`.
   */
  private async injectStyles(id: string): Promise<void> {
    if (typeof document === "undefined") return;
    let css: string;
    try {
      css = await window.geode.read(`${pluginDir(id)}/styles.css`);
    } catch {
      return; // no stylesheet
    }
    if (!css.trim()) return;
    const styleEl = document.createElement("style");
    styleEl.dataset.pluginId = id;
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  private removeStyles(id: string): void {
    if (typeof document === "undefined") return;
    document.head.querySelector(`style[data-plugin-id="${id}"]`)?.remove();
  }

  /** Call `onunload()` (reversing everything the plugin registered) and drop the instance. */
  async disable(id: string, opts: { persist?: boolean } = {}): Promise<void> {
    const { persist = true } = opts;
    const entry = this.loaded.get(id);
    if (!entry) return;
    try {
      entry.instance.unload();
    } catch (error) {
      await this.recordAndQuarantine(id, "onunload", error);
    }
    this.removeStyles(id);
    this.loaded.delete(id);
    if (persist) await this.persistEnabled();
    await this.reportActivePlugins();
  }

  private async containPluginError(id: string, boundary: string, error: unknown): Promise<void> {
    if (this.containing.has(id)) return;
    this.containing.add(id);
    try {
      await this.recordAndQuarantine(id, boundary, error);
      await this.disable(id, { persist: false });
      this.app.notify(`Plugin "${this.manifests.get(id)?.name ?? id}" was disabled after an error.`, 6000);
    } finally {
      this.containing.delete(id);
    }
  }

  private async recordAndQuarantine(id: string, boundary: string, error: unknown): Promise<void> {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const entry = { at: Date.now(), boundary, message: normalized.message };
    this.quarantine[id] = entry;
    const results = await Promise.allSettled([
      window.geode.writeConfig(QUARANTINE_KEY, this.quarantine),
      window.geode.reportCrashDiagnostic?.({
        type: "plugin-error", at: entry.at, pluginId: id, boundary,
        message: normalized.message, stack: normalized.stack,
      }),
    ]);
    for (const result of results) {
      if (result.status === "rejected") console.error("Failed to persist plugin crash diagnostic", result.reason);
    }
  }

  private async persistEnabled(): Promise<void> {
    await window.geode.writeConfig(CONFIG_KEY, [...this.loaded.keys()]);
  }

  private async reportActivePlugins(): Promise<void> {
    await window.geode.reportActivePlugins?.([...this.loaded.keys()]);
  }
}
