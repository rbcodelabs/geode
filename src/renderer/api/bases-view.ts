/**
 * `BasesView` — the class a plugin subclasses to render a `.base` file with
 * its own layout, plus the registration types around it.
 *
 * The `QueryController` a view is constructed with is deliberately opaque in
 * the public API: its documented class body is empty, and views only ever pass
 * it to `super()`. Geode is therefore free to define its internals, and uses
 * it to carry the host wiring — app, config, and the live result set — into
 * the subclass constructor.
 */
import { Component } from "../component";
import type { App } from "../app";
import type { BasesQueryResult, BasesViewConfig } from "./bases-data";
import type { BasesPropertyId } from "./bases-property-id";

/** Icon id, as used by the icon registry. */
export type IconName = string;

/**
 * View option descriptors a registration may expose so the Bases toolbar can
 * render a settings UI. Note the real type is `BasesAllOptions` — there is no
 * `ViewOption` in the Obsidian API, despite some plugins importing that name
 * (it is type-only, so it erases at build time and loads fine regardless).
 *
 * Geode does not yet render a view-options UI for plugin views, so the
 * descriptors are accepted and stored, not interpreted. That is inert data,
 * not a stubbed behaviour: a view still reads its settings through
 * `config.get`, which works whether or not a UI wrote them.
 */
export interface BasesOptionBase {
  displayName: string;
  key: string;
  type: string;
  [extra: string]: unknown;
}
export type BasesOptions = BasesOptionBase;
export interface BasesOptionGroup<T> {
  displayName: string;
  type: "group";
  items: T[];
}
export type BasesAllOptions = BasesOptions | BasesOptionGroup<BasesOptions>;

/** What the host supplies to a view. Internal to Geode; not part of the plugin API. */
export interface BasesViewHost {
  app: App;
  config: BasesViewConfig;
  data: BasesQueryResult;
  allProperties: BasesPropertyId[];
  /** Backs `BasesView.createFileForView`. */
  createFileForView(baseFileName?: string, frontmatterProcessor?: (frontmatter: any) => void): Promise<void>;
}

/**
 * Construction token for a `BasesView`.
 *
 * Public API surface: none — matching Obsidian, where this class is documented
 * with an empty body. The host wiring it carries is Geode-internal.
 */
export class QueryController extends Component {
  constructor(
    /** @internal */
    readonly host: BasesViewHost
  ) {
    super();
  }
}

/**
 * Base class for a plugin-provided Bases view.
 *
 * The host constructs the subclass through the registration's `factory`,
 * then keeps `data`/`allProperties` current and calls `onDataUpdated()` after
 * every query run.
 */
export abstract class BasesView extends Component {
  abstract type: string;

  app: App;
  config: BasesViewConfig;
  allProperties: BasesPropertyId[];
  /**
   * Most recent query output. Replaced wholesale on each update — views must
   * not retain a reference to it or to the entries inside it.
   */
  data: BasesQueryResult;

  private readonly host: BasesViewHost;

  protected constructor(controller: QueryController) {
    super();
    this.host = controller.host;
    this.app = controller.host.app;
    this.config = controller.host.config;
    this.data = controller.host.data;
    this.allProperties = controller.host.allProperties;
  }

  /** Called when there is new data for the query; the view should re-render. */
  abstract onDataUpdated(): void;

  /**
   * Create a note for this view, optionally setting its frontmatter first —
   * how a view's quick-add affordance puts a new entry straight into the group
   * the user clicked.
   *
   * Obsidian describes this as displaying the "new note menu": the built-in
   * cards view creates the note and drops its title into inline rename. Geode
   * has no inline-rename surface for a plugin-hosted Bases view, so it
   * implements the half it can honour exactly — create the named note with the
   * requested frontmatter — and rejects a call that omits `baseFileName`,
   * because that is the case where the name could only have come from the menu.
   * Callers that do pass a name (`kanban-bases-view` collects one in its own
   * modal first) get the complete behaviour.
   *
   * Rejects rather than resolving quietly on any failure: a silent no-op would
   * let an "add card" button appear to work while creating nothing.
   */
  createFileForView(baseFileName?: string, frontmatterProcessor?: (frontmatter: any) => void): Promise<void> {
    return this.host.createFileForView(baseFileName, frontmatterProcessor);
  }

  /**
   * Teardown.
   *
   * `Component`'s documented hook is `onunload()`, and that is what the host
   * calls. Real Bases views in the wild nonetheless put their teardown in an
   * `onClose()` method — undocumented, but the established convention, and
   * `kanban-bases-view` cancels its debounced render and destroys its drag
   * handlers there. Forwarding is a deliberate accommodation of that
   * behaviour: it costs nothing when `onClose` is absent, and without it a
   * view leaks timers and listeners on every close.
   */
  override onunload(): void {
    (this as unknown as { onClose?: () => void }).onClose?.();
  }
}

/** Factory a registration supplies to build a view instance. */
export type BasesViewFactory = (controller: QueryController, containerEl: HTMLElement) => BasesView;

/** Everything needed to register a new Bases view type. */
export interface BasesViewRegistration {
  name: string;
  icon: IconName;
  factory: BasesViewFactory;
  options?: (config: BasesViewConfig) => BasesAllOptions[];
}

/**
 * View types the app itself renders. A plugin may not claim one, mirroring
 * `Plugin.registerView`'s guard against hijacking built-in workspace view
 * types — without it, a plugin could take over the table view and there would
 * be no way to get it back.
 */
export const BUILTIN_BASES_VIEW_TYPES: ReadonlySet<string> = new Set(["table", "cards"]);

/**
 * Registry mutations, as free functions over the map — the same shape as
 * `isDeferrableViewType` in ../workspace.ts, so the rules are unit-testable
 * without standing up an `App`. `App.registerBasesView` delegates here.
 *
 * @returns true if registered; false if the type was already claimed.
 * @throws if `viewType` is a built-in.
 */
export function registerBasesViewIn(
  registry: Map<string, BasesViewRegistration>,
  viewType: string,
  registration: BasesViewRegistration
): boolean {
  if (BUILTIN_BASES_VIEW_TYPES.has(viewType)) {
    throw new Error(`Cannot register reserved or built-in Bases view type "${viewType}"`);
  }
  if (registry.has(viewType)) return false;
  registry.set(viewType, registration);
  return true;
}

/** Remove `registration`, but only if it is still the one installed for `viewType`. */
export function unregisterBasesViewIn(
  registry: Map<string, BasesViewRegistration>,
  viewType: string,
  registration: BasesViewRegistration
): void {
  if (registry.get(viewType) === registration) registry.delete(viewType);
}
