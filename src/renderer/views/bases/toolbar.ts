import type { App } from "../../app";
import type { RowHeight } from "./table-view";

export interface ToolbarState {
  viewNames: string[];
  currentViewName: string;
  resultCount: number;
  rowHeight: RowHeight;
}

export interface ToolbarHandlers {
  onSwitchView(name: string): void;
  onAddView(): void;
  onRenameView(name: string): void;
  onDeleteView(name: string): void;
  onMoveView(name: string, dir: -1 | 1): void;
  onOpenFilter(anchorEl: HTMLElement): void;
  onOpenSort(anchorEl: HTMLElement): void;
  onOpenProperties(anchorEl: HTMLElement): void;
  onSearch(query: string): void;
  onNewFile(): void;
  onRowHeightChange(height: RowHeight): void;
}

const ROW_HEIGHTS: RowHeight[] = ["short", "medium", "tall", "extra tall"];

/**
 * The Bases toolbar: View menu, results count, Sort, Filter, Properties,
 * Search, New — per the spec's "Toolbar UI" section. Copy-to-clipboard and
 * Export CSV (also toolbar items in real Obsidian) are explicitly Phase C —
 * the Results button here only shows the count, with a comment marking
 * where those two actions attach later.
 */
export class BasesToolbar {
  containerEl: HTMLElement;
  private viewBtn: HTMLButtonElement;
  private resultsEl: HTMLElement;
  private filterBtn: HTMLButtonElement;
  private sortBtn: HTMLButtonElement;
  private propertiesBtn: HTMLButtonElement;
  private searchInput: HTMLInputElement;
  private rowHeightSelect: HTMLSelectElement;

  constructor(
    private app: App,
    private handlers: ToolbarHandlers
  ) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "bases-toolbar";

    this.viewBtn = document.createElement("button");
    this.viewBtn.className = "bases-toolbar-btn bases-view-btn";
    this.viewBtn.addEventListener("click", () => this.openViewMenu());

    this.resultsEl = document.createElement("span");
    this.resultsEl.className = "bases-toolbar-results";

    this.sortBtn = document.createElement("button");
    this.sortBtn.className = "bases-toolbar-btn";
    this.sortBtn.textContent = "Sort";
    this.sortBtn.addEventListener("click", () => this.handlers.onOpenSort(this.sortBtn));

    this.filterBtn = document.createElement("button");
    this.filterBtn.className = "bases-toolbar-btn";
    this.filterBtn.textContent = "Filter";
    this.filterBtn.addEventListener("click", () => this.handlers.onOpenFilter(this.filterBtn));

    this.propertiesBtn = document.createElement("button");
    this.propertiesBtn.className = "bases-toolbar-btn";
    this.propertiesBtn.textContent = "Properties";
    this.propertiesBtn.addEventListener("click", () => this.handlers.onOpenProperties(this.propertiesBtn));

    this.rowHeightSelect = document.createElement("select");
    this.rowHeightSelect.className = "bases-row-height-select";
    for (const h of ROW_HEIGHTS) {
      const opt = document.createElement("option");
      opt.value = h;
      opt.textContent = h[0].toUpperCase() + h.slice(1);
      this.rowHeightSelect.appendChild(opt);
    }
    this.rowHeightSelect.addEventListener("change", () =>
      this.handlers.onRowHeightChange(this.rowHeightSelect.value as RowHeight)
    );

    this.searchInput = document.createElement("input");
    this.searchInput.type = "text";
    this.searchInput.className = "bases-toolbar-search";
    this.searchInput.placeholder = "Search…";
    this.searchInput.addEventListener("input", () => this.handlers.onSearch(this.searchInput.value));

    const newBtn = document.createElement("button");
    newBtn.className = "bases-toolbar-btn bases-new-btn";
    newBtn.textContent = "New";
    newBtn.addEventListener("click", () => this.handlers.onNewFile());

    this.containerEl.append(
      this.viewBtn,
      this.resultsEl,
      this.sortBtn,
      this.filterBtn,
      this.propertiesBtn,
      this.rowHeightSelect,
      this.searchInput,
      newBtn
    );
  }

  private openViewMenu() {
    const { viewNames, currentViewName } = this.state;
    const items: { title: string; action: () => void }[] = viewNames.map((name) => ({
      title: name === currentViewName ? `● ${name}` : name,
      action: () => this.handlers.onSwitchView(name),
    }));
    items.push({ title: "+ New view", action: () => this.handlers.onAddView() });
    items.push({ title: "Rename current view…", action: () => this.handlers.onRenameView(currentViewName) });
    const idx = viewNames.indexOf(currentViewName);
    if (idx > 0) items.push({ title: "Move view up", action: () => this.handlers.onMoveView(currentViewName, -1) });
    if (idx >= 0 && idx < viewNames.length - 1) {
      items.push({ title: "Move view down", action: () => this.handlers.onMoveView(currentViewName, 1) });
    }
    if (viewNames.length > 1) {
      items.push({ title: "Delete current view", action: () => this.handlers.onDeleteView(currentViewName) });
    }
    const rect = this.viewBtn.getBoundingClientRect();
    this.app.showMenu({ clientX: rect.left, clientY: rect.bottom } as unknown as MouseEvent, items);
  }

  private state: ToolbarState = { viewNames: [], currentViewName: "", resultCount: 0, rowHeight: "medium" };

  update(state: ToolbarState): void {
    this.state = state;
    this.viewBtn.textContent = `${state.currentViewName} ▾`;
    // Results: count only this phase — Copy-to-clipboard/Export CSV attach here in Phase C.
    this.resultsEl.textContent = `${state.resultCount} result${state.resultCount === 1 ? "" : "s"}`;
    this.rowHeightSelect.value = state.rowHeight;
  }
}
