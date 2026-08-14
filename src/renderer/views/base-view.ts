import type { App } from "../app";
import { parseBaseFile, runQuery, type BaseDefinition, type BaseViewDefinition, type QueryResult } from "../bases";
import { stringifyBaseFile } from "../bases/base-file-write";
import { enumerateFrontmatterKeys, frontmatterKeyForColumn, parseEditedValue, resolveColumns } from "../bases/columns";
import { PromptModal } from "../modals/modals";
import type { TFile } from "../types";
import { buildViewHeaderNavButtons, type View } from "../workspace";
import { openFilterEditor, type FilterEditorScope } from "./bases/filter-editor";
import { patchFrontmatter } from "../frontmatter-io";
import { openPropertiesMenu } from "./bases/properties-menu";
import { openSortGroupMenu, type SortGroupValue } from "./bases/sort-group-menu";
import { BasesTableView, type RowHeight } from "./bases/table-view";
import { BasesCardsView } from "./bases/cards-view";
import { BasesToolbar, type ToolbarHandlers } from "./bases/toolbar";

const DEFAULT_CARD_ASPECT_RATIO = 16 / 9;
const DEFAULT_CARD_SIZE = 240;

const FILE_NAMESPACE_FIELDS = [
  "file.name",
  "file.path",
  "file.folder",
  "file.ext",
  "file.size",
  "file.ctime",
  "file.mtime",
  "file.tags",
  "file.links",
  "file.backlinks",
  "file.embeds",
];

function defaultBaseYaml(): string {
  return stringifyBaseFile({
    filters: undefined,
    formulas: {},
    properties: {},
    summaries: {},
    views: [{ type: "table", name: "Table" }],
  });
}

/**
 * The Bases view: parses a `.base` file, runs its current view's query, and
 * renders the toolbar plus the active view type (Table or Cards). File-backed
 * like `MarkdownView`, mirroring its `containerEl`/`setFile`/header structure.
 */
export class BaseView implements View {
  readonly viewType = "base";
  containerEl: HTMLElement;
  file: TFile | null = null;

  private headerEl: HTMLElement;
  private titleEl: HTMLElement;
  private bodyEl: HTMLElement;
  private errorEl: HTMLElement;

  private toolbar: BasesToolbar;
  private tableView: BasesTableView;
  private cardsView: BasesCardsView;

  private def: BaseDefinition | null = null;
  private currentViewName = "";
  private searchQuery = "";
  private rowHeights = new Map<string, RowHeight>();
  private lastColumns: string[] = [];
  private lastResult: QueryResult | null = null;
  private renderScheduled = false;
  /**
   * The exact text we last knew to be on disk for this file — set both
   * right before `persist()` writes it (predicting the write's outcome)
   * and every time `reloadFromDisk()` actually reads it. Used to make the
   * "did our own file change externally?" check idempotent against content
   * rather than a single-consume flag.
   *
   * This file's writes are echoed by up to *two* "modify" events: one
   * synchronous one from `Vault.modify()` itself, and a second, later one
   * from the main-process chokidar watcher noticing the same write on disk
   * (see `src/main/main.ts`'s `startWatcher`). A single-consume "skip the
   * next reload" flag only absorbs the first of those — the later watcher
   * echo would still trigger a real `reloadFromDisk()`, which replaces
   * `this.def` with freshly parsed objects and silently orphans any view/def
   * object reference an already-open Sort/Filter/Properties panel is still
   * holding (its next edit would land on the orphaned object and never
   * reach the file — this caused a real, reproducible flake in
   * `bases.spec.ts`). Comparing content instead is immune to however many
   * duplicate/delayed echoes arrive: if the file's current text already
   * matches what we expect, there's nothing to reload.
   */
  private lastKnownText: string | null = null;

  private readonly onVaultChange = (changedFile?: TFile) => {
    if (changedFile && this.file && changedFile.path === this.file.path) {
      void this.reloadIfChangedExternally();
      return;
    }
    // Some other file changed (a row's frontmatter was edited, a note was
    // created/deleted, etc.) — re-run the query against the current
    // (unchanged) `.base` definition, no need to re-parse it from disk.
    this.scheduleRerender();
  };

  /** Re-parse from disk only if the file's current content differs from what we last wrote/read — see `lastKnownText`'s doc comment. */
  private async reloadIfChangedExternally(): Promise<void> {
    if (!this.file) return;
    const text = await this.app.vault.read(this.file);
    if (text === this.lastKnownText) return;
    await this.applyText(text);
  }

  constructor(private app: App) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "base-view";

    this.headerEl = document.createElement("div");
    this.headerEl.className = "view-header";
    const left = document.createElement("div");
    left.className = "view-header-left";
    left.appendChild(buildViewHeaderNavButtons());
    this.titleEl = document.createElement("div");
    this.titleEl.className = "view-header-title";
    left.appendChild(this.titleEl);
    this.headerEl.appendChild(left);

    const handlers: ToolbarHandlers = {
      onSwitchView: (name) => this.switchView(name),
      onAddView: (type) => this.addView(type),
      onSetViewType: (type) => this.setViewType(type),
      onRenameView: (name) => this.renameView(name),
      onDeleteView: (name) => this.deleteView(name),
      onMoveView: (name, dir) => this.moveView(name, dir),
      onOpenFilter: (anchorEl) => this.openFilterPanel(anchorEl),
      onOpenSort: (anchorEl) => this.openSortPanel(anchorEl),
      onOpenProperties: (anchorEl) => this.openPropertiesPanel(anchorEl),
      onSearch: (query) => this.setSearchQuery(query),
      onNewFile: () => this.createNewFileInFolder(),
      onRowHeightChange: (height) => this.setRowHeight(height),
    };
    this.toolbar = new BasesToolbar(app, handlers);

    this.errorEl = document.createElement("div");
    this.errorEl.className = "bases-error";
    this.errorEl.style.display = "none";

    this.tableView = new BasesTableView(app, {
      onOpenFile: (file, newTab) => void this.app.openFile(file, newTab),
      onEditCell: (file, columnPath, rawText) => void this.editCell(file, columnPath, rawText),
    });

    this.cardsView = new BasesCardsView(app, {
      onOpenFile: (file, newTab) => void this.app.openFile(file, newTab),
    });

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "base-view-body";
    this.bodyEl.append(this.toolbar.containerEl, this.errorEl, this.tableView.containerEl, this.cardsView.containerEl);

    this.containerEl.append(this.headerEl, this.bodyEl);
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Base";
  }

  getIcon(): string {
    return "layout-grid";
  }

  getFile(): TFile | null {
    return this.file;
  }

  async setFile(file: TFile): Promise<void> {
    this.file = file;
    this.titleEl.textContent = file.basename;
    await this.reloadFromDisk();
  }

  private async reloadFromDisk(): Promise<void> {
    if (!this.file) return;
    const text = await this.app.vault.read(this.file);
    await this.applyText(text);
  }

  /** Parse `text` (freshly read from disk) into `this.def` and re-render. Records `text` as the current known-good state (see `lastKnownText`). */
  private async applyText(text: string): Promise<void> {
    this.lastKnownText = text;
    const parsed = parseBaseFile(text);
    if ("error" in parsed) {
      this.showError(`Couldn't parse base: ${parsed.error}`);
      return;
    }
    this.def = parsed.def;
    if (this.def.views.length === 0) this.def.views.push({ type: "table", name: "Table" });
    if (!this.def.views.some((v) => v.name === this.currentViewName)) {
      this.currentViewName = this.def.views[0].name;
    }
    this.runAndRender();
  }

  onOpen(): void {
    this.app.vault.on("modify", this.onVaultChange);
    this.app.vault.on("create", this.onVaultChange);
    this.app.vault.on("delete", this.onVaultChange);
    this.app.metadataCache.on("changed", this.onVaultChange);
  }

  onClose(): void {
    this.app.vault.off("modify", this.onVaultChange);
    this.app.vault.off("create", this.onVaultChange);
    this.app.vault.off("delete", this.onVaultChange);
    this.app.metadataCache.off("changed", this.onVaultChange);
    this.cardsView.destroy();
  }

  private scheduleRerender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    queueMicrotask(() => {
      this.renderScheduled = false;
      this.runAndRender();
    });
  }

  private showError(message: string): void {
    this.errorEl.textContent = message;
    this.errorEl.style.display = "";
    this.tableView.containerEl.style.display = "none";
    this.cardsView.containerEl.style.display = "none";
  }

  private clearError(): void {
    this.errorEl.style.display = "none";
    const isCards = this.currentView()?.type === "cards";
    this.tableView.containerEl.style.display = isCards ? "none" : "";
    this.cardsView.containerEl.style.display = isCards ? "" : "none";
  }

  private currentView(): BaseViewDefinition | null {
    return this.def?.views.find((v) => v.name === this.currentViewName) ?? null;
  }

  private knownPropertyKeys(): string[] {
    const files = this.app.vault.getMarkdownFiles();
    return enumerateFrontmatterKeys(files, (f) => this.app.metadataCache.getFileCache(f)?.frontmatter ?? null);
  }

  private allPropertyPaths(): string[] {
    if (!this.def) return FILE_NAMESPACE_FIELDS;
    return [
      ...FILE_NAMESPACE_FIELDS,
      ...this.knownPropertyKeys().map((k) => `note.${k}`),
      ...Object.keys(this.def.formulas).map((n) => `formula.${n}`),
    ];
  }

  private runAndRender(): void {
    if (!this.def || !this.file) return;
    const view = this.currentView();
    if (!view) return;

    const knownKeys = this.knownPropertyKeys();
    const columns = resolveColumns(view.order, knownKeys);
    this.lastColumns = columns;

    const viewForQuery: BaseViewDefinition = { ...view, order: columns };
    const defForQuery: BaseDefinition = {
      ...this.def,
      views: this.def.views.map((v) => (v === view ? viewForQuery : v)),
    };

    const files = this.app.vault.getMarkdownFiles();
    const result = runQuery(defForQuery, this.currentViewName, files, this.app.vault, this.app.metadataCache, this.file, Date.now());
    if ("error" in result) {
      this.showError(result.error);
      return;
    }
    this.clearError();
    this.lastResult = result;

    this.toolbar.update({
      viewNames: this.def.views.map((v) => v.name),
      currentViewName: this.currentViewName,
      currentViewType: view.type === "cards" ? "cards" : "table",
      resultCount: result.rows.length,
      rowHeight: this.rowHeights.get(this.currentViewName) ?? "medium",
    });

    this.renderActiveView(view, result, columns);
  }

  /** Dispatch rendering to the Table or Cards view based on `view.type`, keeping only the active one visible. */
  private renderActiveView(view: BaseViewDefinition, result: QueryResult, columns: string[]): void {
    if (!this.def) return;
    const isCards = view.type === "cards";
    this.tableView.containerEl.style.display = isCards ? "none" : "";
    this.cardsView.containerEl.style.display = isCards ? "" : "none";

    if (isCards) {
      this.cardsView.render(result, {
        columns,
        def: this.def,
        imageProperty: view.image,
        imageFit: view.imageFit ?? "cover",
        imageAspectRatio: view.imageAspectRatio ?? DEFAULT_CARD_ASPECT_RATIO,
        cardSize: view.cardSize ?? DEFAULT_CARD_SIZE,
        searchQuery: this.searchQuery,
      });
    } else {
      this.tableView.render(result, {
        columns,
        def: this.def,
        rowHeight: this.rowHeights.get(this.currentViewName) ?? "medium",
        searchQuery: this.searchQuery,
      });
    }
  }

  /**
   * Serializes concurrent `persist()` calls so two edits fired in quick
   * succession (e.g. a filter panel's property field committing, then its
   * value field committing a moment later) never race two overlapping
   * `vault.modify()` writes against each other — each queued write
   * re-reads `this.def` (already synchronously up to date by the time it
   * actually runs) rather than a stale snapshot from when it was queued.
   */
  private persistQueue: Promise<void> = Promise.resolve();

  /** Persist the in-memory definition back to the `.base` file and re-render immediately from that same in-memory state (see `lastKnownText`'s doc comment for why the resulting "modify" event(s) must not trigger a second, object-identity-breaking reload). */
  private persist(): Promise<void> {
    this.persistQueue = this.persistQueue.then(() => this.doPersist());
    return this.persistQueue;
  }

  private async doPersist(): Promise<void> {
    if (!this.def || !this.file) return;
    const text = stringifyBaseFile(this.def);
    this.lastKnownText = text;
    await this.app.vault.modify(this.file, text);
    this.runAndRender();
  }

  // --- View menu ------------------------------------------------------

  private switchView(name: string): void {
    this.currentViewName = name;
    this.runAndRender();
  }

  addView(type: "table" | "cards" = "table"): void {
    new PromptModal(this.app, {
      placeholder: "View name",
      onSubmit: (name) => {
        if (!this.def || this.def.views.some((v) => v.name === name)) return;
        this.def.views.push({ type, name });
        this.currentViewName = name;
        void this.persist();
      },
    }).open();
  }

  /** Change the current view's type (e.g. Table ↔ Cards), preserving its other settings. */
  private setViewType(type: "table" | "cards"): void {
    const view = this.currentView();
    if (!view || view.type === type) return;
    view.type = type;
    void this.persist();
  }

  private renameView(name: string): void {
    new PromptModal(this.app, {
      placeholder: "New view name",
      initialValue: name,
      onSubmit: (newName) => {
        if (!this.def || newName === name || this.def.views.some((v) => v.name === newName)) return;
        const view = this.def.views.find((v) => v.name === name);
        if (!view) return;
        view.name = newName;
        if (this.currentViewName === name) this.currentViewName = newName;
        void this.persist();
      },
    }).open();
  }

  private deleteView(name: string): void {
    if (!this.def || this.def.views.length <= 1) return;
    const idx = this.def.views.findIndex((v) => v.name === name);
    if (idx === -1) return;
    this.def.views.splice(idx, 1);
    if (this.currentViewName === name) this.currentViewName = this.def.views[0].name;
    void this.persist();
  }

  private moveView(name: string, dir: -1 | 1): void {
    if (!this.def) return;
    const idx = this.def.views.findIndex((v) => v.name === name);
    const target = idx + dir;
    if (idx === -1 || target < 0 || target >= this.def.views.length) return;
    [this.def.views[idx], this.def.views[target]] = [this.def.views[target], this.def.views[idx]];
    void this.persist();
  }

  // --- Filter panel -----------------------------------------------------

  private openFilterPanel(anchorEl: HTMLElement): void {
    if (!this.def) return;
    const view = this.currentView();
    if (!view) return;
    const scopes: FilterEditorScope[] = [
      {
        label: "All views",
        node: this.def.filters,
        onChange: (node) => {
          this.def!.filters = node;
          void this.persist();
        },
      },
      {
        label: "This view",
        node: view.filters,
        onChange: (node) => {
          view.filters = node;
          void this.persist();
        },
      },
    ];
    openFilterEditor(anchorEl, scopes, this.allPropertyPaths());
  }

  // --- Sort/group panel ---------------------------------------------------

  private openSortPanel(anchorEl: HTMLElement): void {
    const view = this.currentView();
    if (!view) return;
    const initial: SortGroupValue = { sort: view.sort ?? [], groupBy: view.groupBy ?? null };
    openSortGroupMenu(anchorEl, initial, this.allPropertyPaths(), (next) => {
      view.sort = next.sort.length ? next.sort : undefined;
      view.groupBy = next.groupBy ?? undefined;
      void this.persist();
    });
  }

  // --- Properties panel ---------------------------------------------------

  private openPropertiesPanel(anchorEl: HTMLElement): void {
    const view = this.currentView();
    if (!view || !this.def) return;
    const visible = this.lastColumns;
    const hidden = this.allPropertyPaths().filter((p) => !visible.includes(p));
    openPropertiesMenu(anchorEl, this.app, {
      visibleColumns: visible,
      hiddenColumns: hidden,
      onReorder: (next) => {
        view.order = next;
        void this.persist();
      },
      onHide: (path) => {
        view.order = visible.filter((p) => p !== path);
        void this.persist();
      },
      onShow: (path) => {
        view.order = [...visible, path];
        void this.persist();
      },
      onNewFormula: (name, expression) => {
        this.def!.formulas[name] = expression;
        view.order = [...visible, `formula.${name}`];
        void this.persist();
      },
    });
  }

  // --- Search / row height / new file --------------------------------------

  private setSearchQuery(query: string): void {
    this.searchQuery = query;
    const view = this.currentView();
    if (this.lastResult && this.def && view) {
      this.renderActiveView(view, this.lastResult, this.lastColumns);
    }
  }

  private setRowHeight(height: RowHeight): void {
    this.rowHeights.set(this.currentViewName, height);
    this.runAndRender();
  }

  private createNewFileInFolder(): void {
    if (!this.file) return;
    void this.app.createNewNote(this.file.parent);
  }

  // --- Cell editing ---------------------------------------------------------

  private async editCell(file: TFile, columnPath: string, rawText: string): Promise<void> {
    const key = frontmatterKeyForColumn(columnPath);
    if (!key) return;
    await patchFrontmatter(this.app.vault, file, (fm) => {
      const value = parseEditedValue(rawText);
      if (value === undefined) delete fm[key];
      else fm[key] = value;
    });
  }
}

export { defaultBaseYaml };
