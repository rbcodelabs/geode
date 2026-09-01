import { Component } from "./component";
import type { App } from "./app";
import type { View, WorkspaceLeaf } from "./workspace";
import type { Command, Hotkey } from "./commands";
import type { PluginManifest } from "./plugin-manifest";
import type { EventRef } from "./events";
import type { EditorView } from "@codemirror/view";
import type { MarkdownView } from "./views/markdown-view";

export type { PluginManifest } from "./plugin-manifest";

/** Command spec passed to `Plugin.addCommand` — same shape as `Command` minus the plugin-id prefix, which is applied automatically. */
export interface PluginCommand {
  id: string;
  name: string;
  hotkey?: string;
  hotkeys?: Hotkey[];
  callback?: () => any;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCallback?: (editor: EditorView, context: MarkdownView) => any;
  editorCheckCallback?: (checking: boolean, editor: EditorView, context: MarkdownView) => boolean | void;
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
  private hostGeneration: "constructing" | "active" | "inactive" = "constructing";
  private pendingTeardowns = new Set<Promise<void>>();

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

  /** @internal Marks this instance as the manager's currently admitted generation. */
  activateHostGeneration(): void {
    if (this.hostGeneration === "inactive") throw new Error(`Plugin "${this.manifest.id}" generation is no longer active`);
    this.hostGeneration = "active";
  }

  private assertHostGeneration(): void {
    if (this.hostGeneration === "inactive") {
      throw new Error(`Plugin "${this.manifest.id}" generation is no longer active`);
    }
  }

  private trackTeardown(work: Promise<void>): void {
    this.pendingTeardowns.add(work);
    void work.then(
      () => this.pendingTeardowns.delete(work),
      () => this.pendingTeardowns.delete(work),
    );
  }

  /** @internal Synchronously revoke registrations, then await owned view closure. */
  async unloadAndWait(): Promise<void> {
    this.hostGeneration = "inactive";
    this.unload();
    while (this.pendingTeardowns.size) {
      const results = await Promise.allSettled([...this.pendingTeardowns]);
      const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failed) throw failed.reason;
    }
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
    this.assertHostGeneration();
    const executionStyleCount = [
      command.callback,
      command.checkCallback,
      command.editorCallback,
      command.editorCheckCallback,
    ].filter((style) => style !== undefined).length;
    if (executionStyleCount !== 1) {
      throw new TypeError(`Command "${command.id}" must define exactly one execution style`);
    }
    const full: Command = {
      id: this.prefixed(command.id),
      name: `${this.manifest.name}: ${command.name}`,
      hotkey: command.hotkey,
      hotkeys: command.hotkeys,
      callback: this.guard(`command:${command.id}`, command.callback),
      checkCallback: this.guard(`command-check:${command.id}`, command.checkCallback),
      editorCallback: this.guard(`command:${command.id}`, command.editorCallback),
      editorCheckCallback: this.guard(`command-check:${command.id}`, command.editorCheckCallback),
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
    this.assertHostGeneration();
    if (!this.app.workspace.isDeferrableViewType(viewType)) {
      throw new Error(`Plugin "${this.manifest.id}" cannot register reserved or built-in view type "${viewType}"`);
    }
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
    this.register(() => {
      const teardown = this.app.workspace.unregisterViewFactory(viewType);
      // Older/fake workspace hosts may still implement the historical void
      // signature; the real Workspace returns the owned closure promise.
      if (teardown && typeof (teardown as Promise<void>).then === "function") {
        this.trackTeardown(teardown as Promise<void>);
      }
    });
  }

  override register(cb: () => void): void {
    if (this.hostGeneration === "inactive") {
      cb();
      return;
    }
    super.register(cb);
  }

  override registerEvent(ref: EventRef): void {
    if (this.hostGeneration === "inactive") {
      ref();
      return;
    }
    super.registerEvent(ref);
  }

  override registerDomEvent<K extends keyof HTMLElementEventMap>(
    el: Window | Document | HTMLElement,
    type: K,
    callback: (ev: HTMLElementEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions
  ): void {
    this.assertHostGeneration();
    super.registerDomEvent(el, type, this.guard(`dom-event:${String(type)}`, callback)!, options);
  }

  override registerInterval(id: ReturnType<typeof setInterval>): ReturnType<typeof setInterval> {
    if (this.hostGeneration === "inactive") {
      clearInterval(id);
      return id;
    }
    return super.registerInterval(id);
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
