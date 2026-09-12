/**
 * Hosts a plugin-registered Bases view layout inside `BaseView`.
 *
 * Owns the lifecycle a registered `BasesView` expects: construct it once via
 * the registration's factory, keep `config`/`data`/`allProperties` current,
 * call `onDataUpdated()` after every query run, and tear it down properly when
 * the user switches away.
 */
import type { App } from "../../app";
import { BasesQueryResult, BasesViewConfig, toBasesQueryResult, type SummaryDeps } from "../../api/bases-data";
import { toPropertyId, type BasesPropertyId } from "../../api/bases-property-id";
import { QueryController, type BasesView, type BasesViewRegistration } from "../../api/bases-view";
import { createFileForView } from "./create-file-for-view";
import type { BaseDefinition, BaseViewDefinition } from "../../bases/base-file";
import type { QueryResult } from "../../bases/query-engine";
import type { Expr } from "../../bases/ast";
import type { TFile } from "../../types";

export interface PluginViewUpdate {
  def: BaseDefinition;
  view: BaseViewDefinition;
  result: QueryResult;
  /** Resolved column paths (engine form). */
  columns: string[];
  /** Every property path available in the dataset (engine form). */
  allPropertyPaths: string[];
  /** Base-level formulas, parsed. */
  formulas: Record<string, Expr>;
  thisFile: TFile | null;
}

export class BasesPluginViewHost {
  readonly containerEl: HTMLElement;

  private current: { viewType: string; viewName: string; view: BasesView } | null = null;

  constructor(
    private readonly app: App,
    /** Persist the mutated definition back to the `.base` file. */
    private readonly persist: () => void
  ) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "bases-plugin-view";
    this.containerEl.style.display = "none";
  }

  /** The registration for a view type, or undefined if no plugin provides it. */
  registrationFor(viewType: string): BasesViewRegistration | undefined {
    return this.app.basesViews.get(viewType);
  }

  /**
   * Render `update` through the plugin view registered for its view type.
   * @returns false if no plugin provides that type, so the caller can fall
   * back to a built-in layout.
   */
  render(update: PluginViewUpdate): boolean {
    const registration = this.registrationFor(update.view.type);
    if (!registration) {
      this.destroy();
      return false;
    }

    const summaryDeps: SummaryDeps = {
      vault: this.app.vault,
      metadataCache: this.app.metadataCache,
      formulas: update.formulas,
      thisFile: update.thisFile,
      now: Date.now(),
      summaries: update.def.summaries,
      anchorFile: update.thisFile ?? update.result.rows[0]?.file ?? null,
    };
    const config = new BasesViewConfig(
      update.view,
      update.def,
      () => update.columns,
      this.persist,
      summaryDeps
    );
    const data = toBasesQueryResult(update.result, update.columns, summaryDeps);
    const allProperties: BasesPropertyId[] = update.allPropertyPaths.map(toPropertyId);

    const view = this.ensureView(registration, update.view, config, data, allProperties);
    if (!view) return false;

    // `config` is rebuilt every render because `reloadFromDisk` replaces the
    // parsed definition objects wholesale — a config captured at construction
    // time would keep writing into an orphaned view object. Reassigning is
    // safe: views read `this.config` at call time, never cache it.
    view.config = config;
    view.data = data;
    view.allProperties = allProperties;

    this.containerEl.style.display = "";
    try {
      view.onDataUpdated();
    } catch (error) {
      // Report the failure rather than claiming a successful render: the
      // container is most likely empty or half-populated, and a blank pane
      // tells the user nothing.
      console.error(`Bases view "${update.view.type}" failed to render:`, error);
      return false;
    }
    return true;
  }

  /** Hide without tearing down — used when a built-in layout takes over the screen. */
  hide(): void {
    this.containerEl.style.display = "none";
  }

  /** Tear down the current view instance, running its `onunload`/`onClose`. */
  destroy(): void {
    this.containerEl.style.display = "none";
    if (!this.current) return;
    try {
      this.current.view.unload();
    } catch (error) {
      console.error("Bases view teardown failed:", error);
    }
    this.current = null;
    this.containerEl.replaceChildren();
  }

  private ensureView(
    registration: BasesViewRegistration,
    definition: BaseViewDefinition,
    config: BasesViewConfig,
    data: BasesQueryResult,
    allProperties: BasesPropertyId[]
  ): BasesView | null {
    // Reuse the instance across data updates — that is the whole point of
    // `onDataUpdated`. Rebuild only when the user switches to a different view
    // type, or to a different view of the same type (whose settings differ).
    if (this.current?.viewType === definition.type && this.current.viewName === definition.name) {
      return this.current.view;
    }
    this.destroy();

    const controller = new QueryController({
      app: this.app,
      config,
      data,
      allProperties,
      // Resolves to void, matching the public signature: the view's contract is
      // "the note now exists", and the board picks it up through the vault
      // `create` event like any other new file.
      createFileForView: async (baseFileName, frontmatterProcessor) => {
        await createFileForView(this.app.vault, definition.type, baseFileName, frontmatterProcessor);
      },
    });

    let view: BasesView;
    try {
      view = registration.factory(controller, this.containerEl);
    } catch (error) {
      console.error(`Bases view "${definition.type}" failed to construct:`, error);
      return null;
    }
    view.load();
    this.current = { viewType: definition.type, viewName: definition.name, view };
    return view;
  }
}
