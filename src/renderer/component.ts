/**
 * Resource-ownership primitive, mirroring Obsidian's `Component`. Anything
 * cleanable (event subscriptions, DOM listeners, intervals, child
 * components) hangs off a component tree: `unload()` reverses everything
 * registered since `load()`, in reverse order, then recurses into children.
 *
 * `Plugin` (see `plugin.ts`) extends this so a plugin's `onunload()` gets
 * automatic cleanup of everything it registered in `onload()` — the same
 * "register once, cleaned up for free" contract Obsidian plugins rely on.
 */
export class Component {
  private childComponents: Component[] = [];
  private cleanups: (() => void)[] = [];
  private isLoaded = false;
  /**
   * True once an `unload()` call has actually run its cleanup/`onunload()`
   * for the current load episode; reset by `load()`. Lets `register*()`
   * work before `load()` is ever called (matching Obsidian) while still
   * keeping `unload()` idempotent.
   */
  private hasUnloaded = false;

  /** True once `load()` has run and `unload()` has not yet reversed it. */
  get loaded(): boolean {
    return this.isLoaded;
  }

  /**
   * The value returned by the most recent `onload()`. For a component whose
   * `onload` is async (e.g. a plugin), this is the pending promise; the host
   * awaits it (see PluginManager.enable) so registrations that happen after
   * an `await` inside `onload` are complete before it's considered loaded.
   */
  onloadResult: void | Promise<unknown> = undefined;

  /** Load this component and all children currently attached to it. */
  load(): void {
    if (this.isLoaded) return;
    this.isLoaded = true;
    this.hasUnloaded = false;
    this.onloadResult = this.onload();
    for (const child of this.childComponents) child.load();
  }

  /** Override to run setup logic. Called once per `load()`. May be async. */
  onload(): void | Promise<unknown> {}

  /**
   * Unload this component: unload children first, then run every cleanup
   * registered via `register`/`registerEvent`/`registerDomEvent`/
   * `registerInterval` (most-recently-registered first), then call
   * `onunload()`. Works even if `load()` was never called — cleanups
   * registered ahead of time still need to run — and is safe to call
   * multiple times in a row.
   */
  unload(): void {
    if (this.hasUnloaded) return;
    this.hasUnloaded = true;
    this.isLoaded = false;
    for (const child of [...this.childComponents]) child.unload();
    this.childComponents = [];
    const toRun = this.cleanups.splice(0).reverse();
    for (const cleanup of toRun) {
      try {
        cleanup();
      } catch (err) {
        console.error("Error while unloading Component", err);
      }
    }
    this.onunload();
  }

  /** Override to run teardown logic not covered by `register*` helpers. */
  onunload(): void {}

  /** Attach a child component; it loads now if this component is already loaded, and unloads with this one. */
  addChild<T extends Component>(component: T): T {
    this.childComponents.push(component);
    if (this.isLoaded) component.load();
    return component;
  }

  /** Detach and unload a previously-attached child. */
  removeChild<T extends Component>(component: T): T {
    const i = this.childComponents.indexOf(component);
    if (i !== -1) this.childComponents.splice(i, 1);
    component.unload();
    return component;
  }

  /** Register an arbitrary cleanup function to run on `unload()`. */
  register(cb: () => void): void {
    this.cleanups.push(cb);
  }

  /**
   * Register an event subscription for automatic cleanup. `ref` is the
   * unsubscribe function returned by `Events.on()` (our `EventRef`).
   */
  registerEvent(ref: () => void): void {
    this.register(ref);
  }

  /** Add a DOM event listener that is automatically removed on `unload()`. */
  registerDomEvent<K extends keyof HTMLElementEventMap>(
    el: Window | Document | HTMLElement,
    type: K,
    callback: (ev: HTMLElementEventMap[K]) => any,
    options?: boolean | AddEventListenerOptions
  ): void {
    el.addEventListener(type as string, callback as EventListener, options);
    this.register(() => el.removeEventListener(type as string, callback as EventListener, options));
  }

  /** Track an interval id so it is automatically `clearInterval`'d on `unload()`. */
  registerInterval(id: ReturnType<typeof setInterval>): ReturnType<typeof setInterval> {
    this.register(() => clearInterval(id));
    return id;
  }
}
