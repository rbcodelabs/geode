import type { App } from "../../app";
import type { BaseDefinition } from "../../bases/base-file";
import { valueToDisplayString } from "../../bases/coerce";
import { columnDisplayName } from "../../bases/columns";
import type { QueryGroup, QueryResult, QueryRow } from "../../bases/query-engine";
import { matchesSearch } from "../../bases/search-match";
import type { BaseValue } from "../../bases/value";
import { loadEmbedBlobUrl } from "../../markdown/embed";
import { IMAGE_EXTENSIONS, type TFile } from "../../types";

export interface CardsViewOptions {
  /** Property paths to render as card fields (excludes the cover-image property). */
  columns: string[];
  def: BaseDefinition;
  /** Property path whose value supplies each card's cover image, if any. */
  imageProperty?: string;
  imageFit: "cover" | "contain";
  imageAspectRatio: number;
  /** Minimum card width in px. */
  cardSize: number;
  searchQuery: string;
}

export interface CardsViewCallbacks {
  onOpenFile(file: TFile, newTab: boolean): void;
}

function displayFor(row: QueryRow, path: string): string {
  const v = row.properties[path];
  return v ? valueToDisplayString(v) : "";
}

/**
 * The Bases "Cards" view (`type: cards`): renders each query result as a
 * card with an optional cover image, a title (the note name), and the
 * view's configured properties as label/value fields. Shares the same
 * `render(result, opts)` contract as {@link BasesTableView} so `BaseView`
 * can swap between them, and honours the same grouping/search the engine
 * produced. Cover images are loaded lazily as blob URLs (like Reading
 * view's embeds); each render revokes the previous batch to avoid leaks.
 */
export class BasesCardsView {
  containerEl: HTMLElement;
  private objectUrls: string[] = [];
  private selectedFile: TFile | null = null;
  private mobileActionsEl: HTMLElement | null = null;
  private suppressTouchClickUntil = 0;

  constructor(
    private app: App,
    private callbacks: CardsViewCallbacks
  ) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "bases-cards-container";
    this.containerEl.tabIndex = 0;
  }

  render(result: QueryResult, opts: CardsViewOptions): void {
    this.revokeObjectUrls();
    this.containerEl.innerHTML = "";
    this.containerEl.style.setProperty("--bases-card-size", `${opts.cardSize}px`);

    const fieldColumns = opts.imageProperty
      ? opts.columns.filter((c) => c !== opts.imageProperty)
      : opts.columns;

    const passesSearch = (row: QueryRow) => {
      const strings = fieldColumns.map((p) => displayFor(row, p));
      strings.push(row.file.basename);
      return matchesSearch(strings, opts.searchQuery);
    };

    const mobile = document.body.classList.contains("is-mobile");
    const renderLimit = mobile ? 200 : Number.POSITIVE_INFINITY;
    let remaining = renderLimit;
    let total = 0;
    let rendered = 0;
    if (result.groups) {
      for (const group of result.groups) {
        const rows = group.rows.filter(passesSearch);
        total += rows.length;
        if (!rows.length) continue;
        const visibleRows = rows.slice(0, remaining);
        if (!visibleRows.length) continue;
        this.containerEl.appendChild(this.buildGroupHeader(group, rows.length));
        this.containerEl.appendChild(this.buildGrid(visibleRows, fieldColumns, opts));
        remaining -= visibleRows.length;
        rendered += visibleRows.length;
      }
    } else {
      const rows = result.rows.filter(passesSearch);
      total = rows.length;
      const visibleRows = rows.slice(0, remaining);
      rendered = visibleRows.length;
      this.containerEl.appendChild(this.buildGrid(visibleRows, fieldColumns, opts));
    }
    if (mobile && rendered < total) {
      const bounded = document.createElement("div");
      bounded.className = "bases-result-limit";
      bounded.textContent = `Showing ${rendered} of ${total} results`;
      this.containerEl.appendChild(bounded);
    }
  }

  /** Free blob URLs created for cover images on the previous render. */
  destroy(): void {
    this.revokeObjectUrls();
    this.selectedFile = null;
    this.mobileActionsEl?.remove();
    this.mobileActionsEl = null;
  }

  private revokeObjectUrls(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }

  private buildGroupHeader(group: QueryGroup, count: number): HTMLElement {
    const el = document.createElement("div");
    el.className = "bases-cards-group-header";
    el.textContent = `${valueToDisplayString(group.key) || "(none)"} · ${count}`;
    return el;
  }

  private buildGrid(rows: QueryRow[], fieldColumns: string[], opts: CardsViewOptions): HTMLElement {
    const grid = document.createElement("div");
    grid.className = "bases-cards-grid";
    for (const row of rows) grid.appendChild(this.buildCard(row, fieldColumns, opts));
    return grid;
  }

  private buildCard(row: QueryRow, fieldColumns: string[], opts: CardsViewOptions): HTMLElement {
    const card = document.createElement("div");
    card.className = "bases-card";
    if (document.body.classList.contains("is-mobile")) {
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Select ${row.file.basename}`);
      card.setAttribute("aria-selected", "false");
      let touch: { id: number; x: number; y: number; moved: boolean } | null = null;
      card.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "touch") {
          this.suppressTouchClickUntil = 0;
          return;
        }
        touch = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      });
      card.addEventListener("pointermove", (event) => {
        if (!touch || touch.id !== event.pointerId) return;
        if (Math.hypot(event.clientX - touch.x, event.clientY - touch.y) >= 8) touch.moved = true;
      });
      card.addEventListener("pointerup", (event) => {
        if (!touch || touch.id !== event.pointerId) return;
        const shouldSelect = !touch.moved;
        touch = null;
        this.suppressTouchClickUntil = performance.now() + 500;
        if (shouldSelect) this.selectCard(row.file, card);
      });
      card.addEventListener("pointercancel", () => { touch = null; });
      card.addEventListener("click", (event) => {
        if (event.detail > 0 && performance.now() < this.suppressTouchClickUntil) return;
        this.selectCard(row.file, card);
      });
      card.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        this.selectCard(row.file, card);
      });
    } else {
      card.addEventListener("click", (e) => this.callbacks.onOpenFile(row.file, e.metaKey || e.ctrlKey));
    }

    if (opts.imageProperty) {
      const cover = document.createElement("div");
      cover.className = "bases-card-cover";
      cover.style.aspectRatio = String(opts.imageAspectRatio);
      const file = this.resolveCoverFile(row.properties[opts.imageProperty]);
      if (file) {
        const img = document.createElement("img");
        img.className = "bases-card-cover-img";
        img.style.objectFit = opts.imageFit;
        img.alt = row.file.basename;
        void loadEmbedBlobUrl(this.app, file).then((url) => {
          this.objectUrls.push(url);
          img.src = url;
        });
        cover.appendChild(img);
      } else {
        cover.classList.add("is-empty");
      }
      card.appendChild(cover);
    }

    const title = document.createElement("div");
    title.className = "bases-card-title";
    title.textContent = row.file.basename;
    card.appendChild(title);

    for (const path of fieldColumns) {
      const value = displayFor(row, path);
      if (!value) continue;
      const field = document.createElement("div");
      field.className = "bases-card-field";
      const label = document.createElement("span");
      label.className = "bases-card-field-label";
      label.textContent = columnDisplayName(opts.def, path);
      const val = document.createElement("span");
      val.className = "bases-card-field-value";
      val.textContent = value;
      field.append(label, val);
      card.appendChild(field);
    }

    return card;
  }

  private selectCard(file: TFile, card: HTMLElement): void {
    this.selectedFile = file;
    this.containerEl.querySelectorAll<HTMLElement>(".bases-card").forEach((candidate) => {
      const selected = candidate === card;
      candidate.classList.toggle("is-selected", selected);
      candidate.setAttribute("aria-selected", String(selected));
    });
    card.focus({ preventScroll: true });
    this.renderMobileActions();
  }

  private renderMobileActions(): void {
    this.mobileActionsEl?.remove();
    if (!this.selectedFile) return;
    const actions = document.createElement("div");
    actions.className = "bases-mobile-card-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open";
    open.setAttribute("aria-label", "Open selected card");
    open.addEventListener("click", () => this.selectedFile && this.callbacks.onOpenFile(this.selectedFile, false));
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit note";
    edit.setAttribute("aria-label", "Edit selected card");
    edit.addEventListener("click", () => this.selectedFile && this.callbacks.onOpenFile(this.selectedFile, false));
    actions.append(open, edit);
    this.containerEl.appendChild(actions);
    this.mobileActionsEl = actions;
  }

  /**
   * Resolve a property value into a vault image file for use as a cover:
   * `image`/`link`/`file` values resolve directly; a string is treated as a
   * linkpath (e.g. "cover.png" or "Folder/cover.png"). Returns null when the
   * value doesn't point at a resolvable vault image (e.g. an external URL —
   * loaded via <img src> is out of scope for the blob-URL path here).
   */
  private resolveCoverFile(value: BaseValue | undefined): TFile | null {
    if (!value) return null;
    let linkpath: string | null = null;
    if (value.type === "file") return IMAGE_EXTENSIONS.has(value.value.extension) ? value.value : null;
    if (value.type === "link") {
      if (value.value.resolved) return IMAGE_EXTENSIONS.has(value.value.resolved.extension) ? value.value.resolved : null;
      linkpath = value.value.raw;
    } else if (value.type === "image") {
      linkpath = value.value.source;
    } else if (value.type === "string") {
      linkpath = value.value;
    }
    if (!linkpath) return null;
    const file = this.app.metadataCache.getFirstLinkpathDest(linkpath, "");
    if (file && IMAGE_EXTENSIONS.has(file.extension)) return file;
    return null;
  }
}
