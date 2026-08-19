import { Component } from "./component";
import type { App } from "./app";
import type { View, WorkspaceLeaf } from "./workspace";
import type { Command } from "./commands";
import type { PluginManifest } from "./plugin-manifest";

export type { PluginManifest } from "./plugin-manifest";

/** Command spec passed to `Plugin.addCommand` — same shape as `Command` minus the plugin-id prefix, which is applied automatically. */
export interface PluginCommand {
  id: string;
  name: string;
  hotkey?: string;
  callback?: () => any;
  checkCallback?: (checking: boolean) => boolean | void;
}

export type PluginErrorHandler = (boundary: string, error: unknown) => void | Promise<void>;

/**
 * Base class for a Geode plugin, analogous to Obsidian's `Plugin`. Extends
 * `Component` so anything registered via `addCommand`/`registerView`/
 * `register*` in `onload()` is automatically undone in `onunload()` —
 * plugin authors only need to write manual cleanup for resources that
 * don't go through a `register*` call.
 */
export abstract class Plugin extends Component {
  app: App;
  manifest: PluginManifest;
  /** Plugin-owned settings assigned from loadData() during onload(). */
  settings?: unknown;
  private errorHandler?: PluginErrorHandler;

  constructor(app: App, manifest: PluginManifest) {
    super();
    this.app = app;
    this.manifest = manifest;
  }

  private prefixed(id: string): string {
    // Obsidian prefixes with "<plugin-id>:" unless the caller already did.
    return id.startsWith(`${this.manifest.id}:`) ? id : `${this.manifest.id}:${id}`;
  }

  /** @internal Installed by PluginManager before onload runs. */
  setErrorHandler(handler: PluginErrorHandler): void {
    this.errorHandler = handler;
  }

  private guard<T extends (...args: any[]) => any>(boundary: string, callback: T | undefined): T | undefined {
    if (!callback) return undefined;
    return ((...args: Parameters<T>) => {
      try {
        const result = callback(...args);
        if (result && typeof result.then === "function") {
          return Promise.resolve(result).catch((error) => {
            void this.errorHandler?.(boundary, error);
            return undefined;
          });
        }
        return result;
      } catch (error) {
        void this.errorHandler?.(boundary, error);
        return undefined;
      }
    }) as T;
  }

  /**
   * Register a command. The id is auto-prefixed with this plugin's id and
   * the display name with this plugin's name (Obsidian convention), it's
   * added to the shared `app.commands` registry, and automatically removed
   * on `onunload()`.
   */
  addCommand(command: PluginCommand): Command {
    const full: Command = {
      id: this.prefixed(command.id),
      name: `${this.manifest.name}: ${command.name}`,
      hotkey: command.hotkey,
      callback: this.guard(`command:${command.id}`, command.callback),
      checkCallback: this.guard(`command-check:${command.id}`, command.checkCallback),
    };
    this.app.commands.add(full);
    this.register(() => this.app.commands.remove(full.id));
    return full;
  }

  /** Unregister a command added via `addCommand` (pass the unprefixed id). */
  removeCommand(id: string): void {
    this.app.commands.remove(this.prefixed(id));
  }

  /**
   * Register a view type: a factory that builds a `View` for a given
   * leaf. Enables `app.workspace.openViewOfType(viewType)` to open views
   * this plugin provides, e.g. from a command. Auto-unregistered (and any
   * open leaves of this type detached) on `onunload()`.
   */
  registerView(viewType: string, factory: (leaf: WorkspaceLeaf) => View): void {
    this.app.workspace.registerViewFactory(viewType, (leaf) => {
      let view: View;
      try {
        view = factory(leaf);
      } catch (error) {
        void this.errorHandler?.(`view-factory:${viewType}`, error);
        throw error;
      }
      view.onOpen = this.guard(`view-onOpen:${viewType}`, view.onOpen.bind(view))!;
      view.onClose = this.guard(`view-onClose:${viewType}`, view.onClose.bind(view))!;
      return view;
    });
    this.register(() => this.app.workspace.unregisterViewFactory(viewType));
  }

  override registerDomEvent<K extends keyof HTMLElementEventMap>(
    el: Window | Document | HTMLElement,
    type: K,
    callback: (ev: HTMLElementEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions
  ): void {
    super.registerDomEvent(el, type, this.guard(`dom-event:${String(type)}`, callback)!, options);
  }

  private dataPath(): string {
    return `${this.manifest.dir ?? `.geode/plugins/${this.manifest.id}`}/data.json`;
  }

  /** Load this plugin's persisted settings (`<plugin dir>/data.json`), or null if none saved yet. */
  async loadData(): Promise<any> {
    try {
      const raw = await window.geode.read(this.dataPath());
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Persist this plugin's settings to `<plugin dir>/data.json`. */
  async saveData(data: unknown): Promise<void> {
    await window.geode.write(this.dataPath(), JSON.stringify(data, null, 2));
  }

  /** Called once when the plugin is enabled (including on app startup, if already enabled). Register everything here. */
  onload(): void | Promise<void> {}

  /** Called on disable. Manual (non-`register*`) cleanup goes here. */
  onunload(): void {}
}
