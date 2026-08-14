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

    if (result.groups) {
      for (const group of result.groups) {
        const rows = group.rows.filter(passesSearch);
        if (!rows.length) continue;
        this.containerEl.appendChild(this.buildGroupHeader(group, rows.length));
        this.containerEl.appendChild(this.buildGrid(rows, fieldColumns, opts));
      }
    } else {
      const rows = result.rows.filter(passesSearch);
      this.containerEl.appendChild(this.buildGrid(rows, fieldColumns, opts));
    }
  }

  /** Free blob URLs created for cover images on the previous render. */
  destroy(): void {
    this.revokeObjectUrls();
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
    card.addEventListener("click", (e) => this.callbacks.onOpenFile(row.file, e.metaKey || e.ctrlKey));

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
