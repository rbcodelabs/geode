import type { App } from "./app";
import { Plugin } from "./plugin";
import {
  GEODE_API_VERSION,
  isVersionAtLeast,
  parseManifest,
  type PluginManifest,
} from "./plugin-manifest";
import * as GeodeAPI from "./api";

type PluginConstructor = new (app: App, manifest: PluginManifest) => Plugin;

const CONFIG_KEY = "plugins"; // <vault>/.geode/plugins.json — array of enabled plugin ids

function pluginDir(id: string): string {
  return `.geode/plugins/${id}`;
}

/**
 * Compile a plugin's `main.js` (CommonJS, exactly as Obsidian plugins are
 * bundled) and return its default export, which must be a class extending
 * `Plugin`.
 *
 * Real Obsidian gives plugins `require('obsidian')`, Node builtins, and
 * `electron` because its main window runs with Node integration enabled.
 * Geode's renderer runs with `contextIsolation: true` / `nodeIntegration:
 * false` (the Electron-recommended default), so there is no `require()` to
 * hand plugin code short of a deliberate trust decision. For v1 we run
 * plugin code as a plain script in the renderer's own JS realm via
 * `Function(...)` (the CSP now allows this — see index.html) and shim
 * `require('geode')` to the public API surface below. Any other module
 * specifier throws: Node/Electron module access for plugins is explicitly
 * out of scope for this PR (see the plugin-api-layer report).
 */
function instantiatePluginClass(code: string, pluginId: string): PluginConstructor {
  const moduleObj: { exports: any } = { exports: {} };
  const requireShim = (specifier: string): unknown => {
    if (specifier === "geode") return GeodeAPI;
    throw new Error(
      `Plugin "${pluginId}" called require("${specifier}"), which isn't available yet — ` +
        `only require("geode") is supported in this version of Geode's plugin API.`
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

  constructor(private app: App) {}

  /** Discover installed plugins and enable whichever were enabled last session. */
  async initialize(): Promise<void> {
    this.manifests.clear();
    this.loadErrors.clear();
    let ids: string[] = [];
    try {
      ids = await window.geode.listPluginIds();
    } catch (err) {
      console.error("Failed to list plugins", err);
    }
    for (const id of ids) {
      try {
        this.manifests.set(id, await this.readManifest(id));
      } catch (err) {
        this.loadErrors.set(id, (err as Error).message);
        console.error(`Failed to read manifest for plugin "${id}"`, err);
      }
    }

    const enabledIds = ((await window.geode.readConfig(CONFIG_KEY)) as string[] | null) ?? [];
    for (const id of enabledIds) {
      if (!this.manifests.has(id)) continue;
      try {
        await this.enable(id, { persist: false });
      } catch (err) {
        this.loadErrors.set(id, (err as Error).message);
        console.error(`Failed to enable plugin "${id}"`, err);
      }
    }
  }

  private async readManifest(id: string): Promise<PluginManifest> {
    const raw = await window.geode.read(`${pluginDir(id)}/manifest.json`);
    return parseManifest(raw, id);
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
    if (!isVersionAtLeast(GEODE_API_VERSION, manifest.minAppVersion)) {
      throw new Error(
        `Plugin "${id}" requires Geode ${manifest.minAppVersion}+ (running ${GEODE_API_VERSION})`
      );
    }

    const code = await window.geode.read(`${pluginDir(id)}/main.js`);
    const PluginClass = instantiatePluginClass(code, id);
    const instance = new PluginClass(this.app, manifest);
    this.loadErrors.delete(id);
    this.loaded.set(id, { manifest, instance });
    try {
      instance.load(); // Component.load() -> onload(), may return a Promise we don't block on (Obsidian doesn't either)
    } catch (err) {
      this.loaded.delete(id);
      throw err;
    }
    if (persist) await this.persistEnabled();
  }

  /** Call `onunload()` (reversing everything the plugin registered) and drop the instance. */
  async disable(id: string, opts: { persist?: boolean } = {}): Promise<void> {
    const { persist = true } = opts;
    const entry = this.loaded.get(id);
    if (!entry) return;
    entry.instance.unload();
    this.loaded.delete(id);
    if (persist) await this.persistEnabled();
  }

  private async persistEnabled(): Promise<void> {
    await window.geode.writeConfig(CONFIG_KEY, [...this.loaded.keys()]);
  }
}
