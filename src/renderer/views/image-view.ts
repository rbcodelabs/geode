import type { App } from "../app";
import type { TFile } from "../types";
import { buildViewHeaderNavButtons, type View } from "../workspace";

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

/** A read-only, file-backed image tab. */
export class ImageView implements View {
  readonly viewType = "image";
  readonly containerEl: HTMLElement;
  file: TFile | null = null;

  private readonly titleEl: HTMLElement;
  private readonly imageEl: HTMLImageElement;
  private objectUrl: string | null = null;

  constructor(private readonly app: App) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "image-view";

    const headerEl = document.createElement("div");
    headerEl.className = "view-header";
    const leftEl = document.createElement("div");
    leftEl.className = "view-header-left";
    leftEl.appendChild(buildViewHeaderNavButtons());
    const titleContainerEl = document.createElement("div");
    titleContainerEl.className = "view-header-title-container mod-at-start mod-fade mod-at-end";
    this.titleEl = document.createElement("div");
    this.titleEl.className = "view-header-title";
    titleContainerEl.appendChild(this.titleEl);
    headerEl.append(leftEl, titleContainerEl);

    const bodyEl = document.createElement("div");
    bodyEl.className = "image-view-body";
    this.imageEl = document.createElement("img");
    this.imageEl.className = "image-view-image";
    this.imageEl.draggable = false;
    bodyEl.appendChild(this.imageEl);
    this.containerEl.append(headerEl, bodyEl);
  }

  getDisplayText(): string {
    return this.file?.basename ?? "Image";
  }

  getIcon(): string {
    return "image";
  }

  getFile(): TFile | null {
    return this.file;
  }

  async setFile(file: TFile): Promise<void> {
    const bytes = await this.app.vault.readBinary(file);
    const nextUrl = URL.createObjectURL(new Blob([bytes], {
      type: IMAGE_MIME_TYPES[file.extension] ?? "application/octet-stream",
    }));
    const previousUrl = this.objectUrl;
    this.objectUrl = nextUrl;
    this.file = file;
    this.titleEl.textContent = file.basename;
    this.imageEl.alt = file.name;
    this.imageEl.src = nextUrl;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
  }

  onOpen(): void {}

  onClose(): void {
    if (!this.objectUrl) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
    this.imageEl.removeAttribute("src");
  }
}
