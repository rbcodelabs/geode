import type { App } from "../app";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, type TFile } from "../types";
import { buildViewHeaderNavButtons, type View } from "../workspace";
import { parseCanvas, serializeCanvas, type CanvasDocument, type CanvasEdge, type CanvasNode, type CanvasSide, type CanvasTextNode } from "../canvas/canvas-data";
import { setIcon } from "../api/icons";
import { PromptModal, SuggestModal } from "../modals/modals";
import { loadEmbedBlobUrl, resolveEmbed, type EmbedKind } from "../markdown/embed";
import { isValidVaultFileDragPath, VAULT_FILE_DRAG_MIME } from "../file-drag";

const MIN_WIDTH = 80;
const MIN_HEIGHT = 50;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const DEFAULT_PAN: Point = { x: 80, y: 80 };
const TEXT_NODE_WIDTH = 250;
const TEXT_NODE_HEIGHT = 140;
const NOTE_NODE_WIDTH = 360;
const NOTE_NODE_HEIGHT = 280;
const LINK_NODE_WIDTH = 360;
const LINK_NODE_HEIGHT = 180;
const GROUP_PADDING = 40;
const DEFAULT_GROUP_WIDTH = 400;
const DEFAULT_GROUP_HEIGHT = 300;
const INVALID_MARKDOWN_FILE_NAME = /[\\/:#|^\[\]]/;

type Point = { x: number; y: number };
type Bounds = { left: number; top: number; right: number; bottom: number };
type ResizeDirection = CanvasSide | "southeast";
type SwappableFileKind = "note" | "image" | "audio" | "video";

function normalizeWebUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function normalizeDroppedWebUrl(transfer: DataTransfer): string | null {
  if (transfer.types.includes("text/uri-list")) {
    for (const rawLine of transfer.getData("text/uri-list").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const canonical = normalizeWebUrl(line);
      if (canonical) return canonical;
    }
  }
  if (!transfer.types.includes("text/plain")) return null;
  const plain = transfer.getData("text/plain").trim();
  return plain && !/[\r\n]/.test(plain) ? normalizeWebUrl(plain) : null;
}

function isSwappableFileKind(kind: EmbedKind): kind is SwappableFileKind {
  return kind === "note" || kind === "image" || kind === "audio" || kind === "video";
}

class CanvasFileSuggestModal extends SuggestModal<TFile> {
  constructor(
    app: App,
    private readonly files: TFile[],
    placeholder: string,
    private readonly choose: (file: TFile) => void,
  ) {
    super(app);
    this.inputEl.placeholder = placeholder;
  }

  getItems(): TFile[] { return this.files; }
  getItemText(file: TFile): string { return file.path; }
  onChooseItem(file: TFile): void { this.choose(file); }
}

export class CanvasView implements View {
  readonly viewType = "canvas";
  readonly containerEl: HTMLElement;
  file: TFile | null = null;

  private readonly titleEl: HTMLElement;
  private readonly surfaceEl: HTMLElement;
  private readonly viewportEl: HTMLElement;
  private document: CanvasDocument = { nodes: [], edges: [] };
  private readonly selectedIds = new Set<string>();
  private selectedEdgeId: string | null = null;
  private pan: Point = { ...DEFAULT_PAN };
  private scale = 1;
  private spacePressed = false;
  private lastKnownText: string | null = null;
  private readonly objectUrls = new Set<string>();
  private renderVersion = 0;
  private selectionControlsEl: HTMLElement | null = null;
  private colorPaletteEl: HTMLElement | null = null;
  private edgeLabelEditorEl: HTMLInputElement | null = null;
  private edgeLabelEditorCancel: (() => void) | null = null;

  constructor(private app: App) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "canvas-view";

    const header = document.createElement("div");
    header.className = "view-header";
    const left = document.createElement("div");
    left.className = "view-header-left";
    left.appendChild(buildViewHeaderNavButtons());
    this.titleEl = document.createElement("div");
    this.titleEl.className = "view-header-title";
    header.append(left, this.titleEl);

    this.surfaceEl = document.createElement("div");
    this.surfaceEl.className = "canvas-surface";
    this.surfaceEl.tabIndex = 0;
    this.viewportEl = document.createElement("div");
    this.viewportEl.className = "canvas-viewport";
    this.surfaceEl.appendChild(this.viewportEl);
    this.surfaceEl.appendChild(this.buildCameraControls());
    this.surfaceEl.appendChild(this.buildCanvasToolbar());
    this.installCameraControls();
    this.containerEl.append(header, this.surfaceEl);
    this.updateTransform();
  }

  getDisplayText(): string { return this.file?.basename ?? "Canvas"; }
  getIcon(): string { return "layout-dashboard"; }
  getFile(): TFile | null { return this.file; }

  async setFile(file: TFile): Promise<void> {
    this.file = file;
    this.titleEl.textContent = file.basename;
    await this.load(await this.app.vault.read(file));
  }

  onOpen(): void { this.app.vault.on("modify", this.onVaultModify); }
  onClose(): void {
    this.app.vault.off("modify", this.onVaultModify);
    this.edgeLabelEditorCancel?.();
    this.renderVersion += 1;
    this.revokeObjectUrls();
  }

  private readonly onVaultModify = async (file?: TFile) => {
    if (!file || file.path !== this.file?.path) return;
    const text = await this.app.vault.read(file);
    if (text !== this.lastKnownText) await this.load(text);
  };

  private async load(text: string): Promise<void> {
    this.lastKnownText = text;
    try {
      this.document = parseCanvas(text);
      this.containerEl.classList.remove("has-error");
      this.render();
    } catch (error) {
      this.viewportEl.innerHTML = "";
      this.containerEl.classList.add("has-error");
      const message = document.createElement("div");
      message.className = "canvas-error";
      message.textContent = `Could not open canvas: ${(error as Error).message}`;
      this.viewportEl.appendChild(message);
    }
  }

  private render(): void {
    this.edgeLabelEditorCancel?.();
    const version = ++this.renderVersion;
    this.revokeObjectUrls();
    this.viewportEl.innerHTML = "";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("canvas-edges");
    svg.setAttribute("viewBox", "-100000 -100000 200000 200000");
    const defs = document.createElementNS(svg.namespaceURI, "defs");
    const marker = document.createElementNS(svg.namespaceURI, "marker");
    marker.setAttribute("id", "canvas-arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto-start-reverse");
    const arrow = document.createElementNS(svg.namespaceURI, "path");
    arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    marker.appendChild(arrow);
    defs.appendChild(marker);
    svg.appendChild(defs);
    for (const edge of this.document.edges) this.renderEdge(svg, edge);

    this.viewportEl.appendChild(svg);
    for (const node of this.document.nodes) this.viewportEl.appendChild(this.renderNode(node, version));
    this.updateSelectionControls();
  }

  private renderEdge(svg: SVGSVGElement, edge: CanvasEdge): void {
    const from = this.document.nodes.find((node) => node.id === edge.fromNode)!;
    const to = this.document.nodes.find((node) => node.id === edge.toNode)!;
    const a = this.edgePoint(from, edge.fromSide, to);
    const b = this.edgePoint(to, edge.toSide, from);
    const d = this.edgePath(a, edge.fromSide ?? this.automaticSide(from, to), b, edge.toSide ?? this.automaticSide(to, from));
    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.classList.add("canvas-edge-hit");
    hit.dataset.edgeId = edge.id;
    hit.setAttribute("d", d);
    hit.setAttribute("tabindex", "0");
    hit.setAttribute("role", "button");
    hit.setAttribute("aria-label", `Select connection ${edge.id}`);
    hit.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    hit.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.selectEdge(edge.id);
      hit.focus();
    });
    hit.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.selectEdge(edge.id);
      this.editEdgeLabelInline(edge.id, hit);
    });
    hit.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.selectEdge(edge.id);
      this.app.showMenu(event, [
        { title: "Edit label", action: () => this.editEdgeLabel(edge.id) },
        { title: "Go to target", action: () => this.focusEdgeEndpoint(edge.id, "target") },
        { title: "Go to source", action: () => this.focusEdgeEndpoint(edge.id, "source") },
        { title: "Remove", action: () => this.removeEdge(edge.id) },
      ]);
    });
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.classList.add("canvas-edge");
    path.classList.toggle("is-selected", this.selectedEdgeId === edge.id);
    path.dataset.edgeId = edge.id;
    path.setAttribute("d", d);
    if (edge.color) path.style.stroke = this.canvasColor(edge.color);
    if (edge.toEnd !== "none") path.setAttribute("marker-end", "url(#canvas-arrow)");
    svg.append(hit, path);
    this.renderEdgeEndpointHandle(svg, edge, "source", this.outsetPoint(a, edge.fromSide ?? this.automaticSide(from, to)));
    this.renderEdgeEndpointHandle(svg, edge, "target", this.outsetPoint(b, edge.toSide ?? this.automaticSide(to, from)));
    if (edge.label) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.classList.add("canvas-edge-label");
      label.dataset.edgeId = edge.id;
      label.setAttribute("x", String((a.x + b.x) / 2));
      label.setAttribute("y", String((a.y + b.y) / 2 - 7));
      label.textContent = edge.label;
      svg.appendChild(label);
    }
  }

  private renderEdgeEndpointHandle(
    svg: SVGSVGElement,
    edge: CanvasEdge,
    endpoint: "source" | "target",
    point: Point,
  ): void {
    const handle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const selected = this.selectedEdgeId === edge.id;
    handle.classList.add("canvas-edge-endpoint-handle");
    handle.classList.toggle("is-selected", selected);
    handle.dataset.edgeId = edge.id;
    handle.dataset.endpoint = endpoint;
    handle.setAttribute("cx", String(point.x));
    handle.setAttribute("cy", String(point.y));
    handle.setAttribute("r", "8");
    handle.setAttribute("role", "button");
    handle.setAttribute("aria-label", `Reconnect ${endpoint} of ${edge.id}`);
    handle.setAttribute("aria-hidden", String(!selected));
    handle.setAttribute("tabindex", selected ? "0" : "-1");
    handle.addEventListener("pointerdown", (event) => this.beginEdgeReconnect(event, edge.id, endpoint));
    svg.appendChild(handle);
  }

  private edgePoint(node: CanvasNode, explicit: CanvasSide | undefined, other: CanvasNode): Point {
    const side = explicit ?? this.automaticSide(node, other);
    return this.sidePoint(node, side);
  }

  private automaticSide(node: CanvasNode, other: CanvasNode): CanvasSide {
    return other.x > node.x + node.width ? "right" : other.x + other.width < node.x ? "left" : other.y > node.y ? "bottom" : "top";
  }

  private outsetPoint(point: Point, side: CanvasSide): Point {
    const distance = 10;
    if (side === "left") return { x: point.x - distance, y: point.y };
    if (side === "right") return { x: point.x + distance, y: point.y };
    if (side === "top") return { x: point.x, y: point.y - distance };
    return { x: point.x, y: point.y + distance };
  }

  private sidePoint(node: CanvasNode, side: CanvasSide): Point {
    if (side === "left") return { x: node.x, y: node.y + node.height / 2 };
    if (side === "right") return { x: node.x + node.width, y: node.y + node.height / 2 };
    if (side === "top") return { x: node.x + node.width / 2, y: node.y };
    return { x: node.x + node.width / 2, y: node.y + node.height };
  }

  private oppositeSide(side: CanvasSide): CanvasSide {
    if (side === "left") return "right";
    if (side === "right") return "left";
    if (side === "top") return "bottom";
    return "top";
  }

  private edgePath(from: Point, fromSide: CanvasSide, to: Point, toSide: CanvasSide): string {
    const distance = Math.max(40, Math.hypot(to.x - from.x, to.y - from.y) * 0.35);
    const control = (point: Point, side: CanvasSide): Point => {
      if (side === "left") return { x: point.x - distance, y: point.y };
      if (side === "right") return { x: point.x + distance, y: point.y };
      if (side === "top") return { x: point.x, y: point.y - distance };
      return { x: point.x, y: point.y + distance };
    };
    const a = control(from, fromSide);
    const b = control(to, toSide);
    return `M ${from.x} ${from.y} C ${a.x} ${a.y}, ${b.x} ${b.y}, ${to.x} ${to.y}`;
  }

  private renderNode(node: CanvasNode, version: number): HTMLElement {
    const el = document.createElement("div");
    el.className = `canvas-node canvas-node-${node.type}`;
    el.dataset.nodeId = node.id;
    el.tabIndex = -1;
    el.dataset.width = String(node.width);
    el.dataset.height = String(node.height);
    el.classList.toggle("is-selected", this.selectedIds.has(node.id));
    Object.assign(el.style, {
      left: `${node.x}px`,
      top: `${node.y}px`,
      width: `${node.width}px`,
      height: `${node.height}px`,
      zIndex: String(this.document.nodes.indexOf(node) + 1),
    });
    if (node.color && /^[1-6]$/.test(node.color)) el.dataset.canvasColor = node.color;
    else if (node.color) el.style.setProperty("--canvas-node-color", node.color);
    if (node.type === "group") {
      if (node.background) el.style.backgroundImage = `url(${JSON.stringify(node.background).slice(1, -1)})`;
      const label = document.createElement("div");
      label.className = "canvas-group-label";
      label.textContent = node.label ?? "Group";
      label.addEventListener("pointerdown", (event) => event.stopPropagation());
      label.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.editGroupLabel(node.id);
      });
      el.appendChild(label);
    } else if (node.type === "text") {
      const text = document.createElement("div");
      text.className = "canvas-node-text";
      el.appendChild(text);
      void this.app.markdownRenderer.render(node.text, text, this.file?.path ?? "");
      el.addEventListener("dblclick", (event) => { event.stopPropagation(); this.editTextNode(el, node); });
    } else if (node.type === "file") {
      el.dataset.filePath = node.file;
      this.renderFileNode(el, node, version);
      el.addEventListener("dblclick", () => {
        const file = this.app.vault.getFileByPath(node.file);
        if (file) void this.app.openFile(file, true);
      });
    } else {
      this.renderWebNode(el, node);
    }
    el.addEventListener("pointerdown", (event) => this.beginNodeDrag(event, node));
    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!this.selectedIds.has(node.id)) {
        this.selectedIds.clear();
        this.selectedIds.add(node.id);
        this.selectedEdgeId = null;
        this.updateSelectionClasses();
      }
      const items = [
        { title: "Zoom to selection", action: () => this.fitToSelection() },
      ];
      if (node.type === "text") {
        items.push({ title: "Edit", action: () => this.editTextNode(el, node) });
      }
      if (node.type === "file") {
        const resolved = resolveEmbed(node.file + (node.subpath ?? ""), this.file?.path ?? "", this.app);
        if (resolved.file && isSwappableFileKind(resolved.kind)) {
          const kind = resolved.kind;
          items.push({ title: "Swap file", action: () => this.openSwapFilePicker(node.id, kind) });
        }
      }
      if (node.type === "link") {
        const canonical = normalizeWebUrl(node.url);
        if (canonical) items.push({ title: "Open in browser", action: () => { void window.geode.openExternal(canonical); } });
      }
      if (node.type === "text") {
        items.push({ title: "Convert to file…", action: () => this.openConvertTextNodePrompt(node.id) });
      }
      if (node.type !== "group") {
        items.push({ title: "Create group", action: () => this.openGroupPrompt() });
      }
      items.push({ title: "Delete", action: () => this.deleteSelection() });
      this.app.showMenu(event, items);
    });
    if (node.type !== "group") {
      for (const side of ["top", "right", "bottom", "left"] as const) {
        const handle = document.createElement("button");
        handle.type = "button";
        handle.className = "canvas-node-connection-handle";
        handle.dataset.nodeId = node.id;
        handle.dataset.side = side;
        handle.setAttribute("aria-label", `Connect from ${side}`);
        handle.addEventListener("pointerdown", (event) => this.beginConnection(event, node, side));
        el.appendChild(handle);
      }
    }
    const resize = document.createElement("div");
    resize.className = "canvas-node-resize-handle";
    resize.addEventListener("pointerdown", (event) => this.beginResize(event, node));
    el.appendChild(resize);
    for (const direction of ["top", "right", "bottom", "left"] as const) {
      const edge = document.createElement("div");
      edge.className = "canvas-node-resize-edge";
      edge.dataset.direction = direction;
      edge.addEventListener("pointerdown", (event) => this.beginResize(event, node, direction));
      el.appendChild(edge);
    }
    return el;
  }

  private renderWebNode(el: HTMLElement, node: Extract<CanvasNode, { type: "link" }>): void {
    const canonical = normalizeWebUrl(node.url);
    const action = document.createElement("button");
    action.type = "button";
    action.className = "canvas-node-link canvas-node-web-link";
    const host = document.createElement("div");
    host.className = "canvas-node-web-host";
    const url = document.createElement("div");
    url.className = "canvas-node-web-url";
    if (canonical) {
      const parsed = new URL(canonical);
      host.textContent = parsed.hostname;
      url.textContent = canonical;
      action.setAttribute("aria-label", canonical);
      action.addEventListener("pointerdown", (event) => event.stopPropagation());
      action.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.metaKey || event.ctrlKey) void window.geode.openExternal(canonical);
        else this.app.openExternalLink(canonical);
      });
    } else {
      host.textContent = "Invalid web address";
      url.textContent = node.url;
      action.disabled = true;
      action.setAttribute("aria-label", "Invalid web address");
    }
    action.append(host, url);
    el.appendChild(action);
  }

  private renderFileNode(el: HTMLElement, node: Extract<CanvasNode, { type: "file" }>, version: number): void {
    const target = node.file + (node.subpath ?? "");
    const resolved = resolveEmbed(target, this.file?.path ?? "", this.app);
    if (!resolved.file) {
      this.renderFileFallback(el, target, "Missing file");
      return;
    }
    const file = resolved.file;
    if (resolved.kind === "note") {
      const content = document.createElement("div");
      content.className = "canvas-node-file canvas-node-note";
      content.textContent = "Loading…";
      el.appendChild(content);
      void this.app.markdownRenderer
        .renderNoteEmbed(file, resolved.subpath, this.file?.path ?? "", content)
        .catch(() => {
          if (version === this.renderVersion && content.isConnected) this.renderFileFallback(el, target, "Could not load note");
        });
      return;
    }
    if (resolved.kind === "image" || resolved.kind === "audio" || resolved.kind === "video") {
      const media: HTMLImageElement | HTMLAudioElement | HTMLVideoElement = resolved.kind === "image"
        ? document.createElement("img")
        : resolved.kind === "audio"
          ? document.createElement("audio")
          : document.createElement("video");
      media.className = "canvas-node-file canvas-node-media";
      if (media instanceof HTMLImageElement) media.alt = file.name;
      else media.controls = true;
      el.appendChild(media);
      void this.loadFileMedia(file, media, version);
      return;
    }
    this.renderFileFallback(el, file.name, "File");
  }

  private renderFileFallback(el: HTMLElement, label: string, kind: string): void {
    el.querySelector(".canvas-node-file")?.remove();
    const type = document.createElement("div");
    type.className = "canvas-node-kind";
    type.textContent = kind;
    const name = document.createElement("div");
    name.className = "canvas-node-file canvas-node-file-fallback";
    name.textContent = label;
    el.append(type, name);
  }

  private async loadFileMedia(file: TFile, media: HTMLImageElement | HTMLAudioElement | HTMLVideoElement, version: number): Promise<void> {
    try {
      const url = await loadEmbedBlobUrl(this.app, file);
      if (version !== this.renderVersion || !media.isConnected) {
        URL.revokeObjectURL(url);
        return;
      }
      this.objectUrls.add(url);
      media.src = url;
    } catch {
      if (version === this.renderVersion && media.isConnected) this.renderFileFallback(media.parentElement!, file.name, "Could not load file");
    }
  }

  private revokeObjectUrls(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
  }

  private editTextNode(el: HTMLElement, node: CanvasTextNode, isNew = false, rollbackNew?: () => void): void {
    if (el.querySelector("textarea")) return;
    const originalText = node.text;
    const editor = document.createElement("textarea");
    editor.className = "canvas-node-text-editor";
    editor.value = node.text;
    el.querySelector(".canvas-node-text")?.replaceWith(editor);
    let finished = false;
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      if (!commit) {
        if (isNew) {
          this.document.nodes = this.document.nodes.filter((candidate) => candidate !== node);
          this.selectedIds.delete(node.id);
          rollbackNew?.();
        } else {
          node.text = originalText;
        }
        this.render();
        return;
      }
      node.text = editor.value;
      this.render();
      void this.persist();
    };
    editor.addEventListener("blur", () => finish(true), { once: true });
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    editor.focus();
    editor.select();
  }

  private addTextCardAt(worldPoint: Point): void {
    const node: CanvasTextNode = {
      id: this.nextTextNodeId(),
      type: "text",
      x: worldPoint.x - TEXT_NODE_WIDTH / 2,
      y: worldPoint.y - TEXT_NODE_HEIGHT / 2,
      width: TEXT_NODE_WIDTH,
      height: TEXT_NODE_HEIGHT,
      text: "",
    };
    this.document.nodes.push(node);
    this.selectedIds.clear();
    this.selectedIds.add(node.id);
    this.render();
    const el = this.viewportEl.querySelector<HTMLElement>(`.canvas-node[data-node-id="${CSS.escape(node.id)}"]`);
    if (el) this.editTextNode(el, node, true);
  }

  private nextTextNodeId(): string {
    const ids = new Set(this.document.nodes.map((node) => node.id));
    let sequence = 1;
    while (ids.has(`text-${sequence}`)) sequence += 1;
    return `text-${sequence}`;
  }

  private createFileCard(file: TFile, worldPoint: Point): CanvasNode {
    const kind = this.fileKind(file);
    const [width, height] = kind === "note"
      ? [NOTE_NODE_WIDTH, NOTE_NODE_HEIGHT]
      : kind === "audio"
        ? [320, 100]
        : kind === "other"
          ? [300, 120]
          : [360, 240];
    return {
      id: this.nextFileNodeId(),
      type: "file",
      x: worldPoint.x - width / 2,
      y: worldPoint.y - height / 2,
      width,
      height,
      file: file.path,
    };
  }

  private addFileCardsAt(files: TFile[], worldPoint: Point): void {
    if (files.length === 0) return;
    const nodes: CanvasNode[] = [];
    for (const [index, file] of files.entries()) {
      const node = this.createFileCard(file, {
        x: worldPoint.x + (index % 3) * 400,
        y: worldPoint.y + Math.floor(index / 3) * 320,
      });
      nodes.push(node);
      this.document.nodes.push(node);
    }
    this.selectedEdgeId = null;
    this.selectedIds.clear();
    for (const node of nodes) this.selectedIds.add(node.id);
    this.render();
    void this.persist();
  }

  private addFileCardAt(file: TFile, worldPoint: Point): void {
    this.addFileCardsAt([file], worldPoint);
  }

  private nextFileNodeId(): string {
    const ids = new Set(this.document.nodes.map((node) => node.id));
    let sequence = 1;
    while (ids.has(`file-${sequence}`)) sequence += 1;
    return `file-${sequence}`;
  }

  private createLinkCard(canonicalUrl: string, worldPoint: Point): CanvasNode {
    return {
      id: this.nextLinkNodeId(),
      type: "link" as const,
      x: worldPoint.x - LINK_NODE_WIDTH / 2,
      y: worldPoint.y - LINK_NODE_HEIGHT / 2,
      width: LINK_NODE_WIDTH,
      height: LINK_NODE_HEIGHT,
      url: canonicalUrl,
    };
  }

  private addLinkCardAt(canonicalUrl: string, worldPoint: Point): void {
    const node = this.createLinkCard(canonicalUrl, worldPoint);
    this.document.nodes.push(node);
    this.selectedEdgeId = null;
    this.selectedIds.clear();
    this.selectedIds.add(node.id);
    this.render();
    void this.persist();
  }

  private nextLinkNodeId(): string {
    const ids = new Set(this.document.nodes.map((node) => node.id));
    let sequence = 1;
    while (ids.has(`link-${sequence}`)) sequence += 1;
    return `link-${sequence}`;
  }

  private openWebPagePrompt(worldPoint?: Point, choose?: (canonicalUrl: string) => void): void {
    new PromptModal(this.app, {
      placeholder: "Enter web page URL…",
      allowEmptySubmit: true,
      onSubmit: (raw) => {
        const canonical = normalizeWebUrl(raw);
        if (!canonical) {
          this.app.notify("Enter a valid http:// or https:// URL.");
          return;
        }
        if (choose) choose(canonical);
        else this.addLinkCardAt(canonical, worldPoint ?? this.viewportCenter());
      },
    }).open();
  }

  private openGroupPrompt(worldPoint?: Point): void {
    const selectedCards = worldPoint
      ? []
      : this.document.nodes.filter((node) => node.type !== "group" && this.selectedIds.has(node.id));
    new PromptModal(this.app, {
      placeholder: "Group label…",
      allowEmptySubmit: true,
      onSubmit: (label) => this.addGroup(selectedCards, label, worldPoint),
    }).open();
  }

  private addGroup(selectedCards: CanvasNode[], label: string, worldPoint?: Point): void {
    let x: number;
    let y: number;
    let width: number;
    let height: number;
    if (selectedCards.length > 0) {
      const left = Math.min(...selectedCards.map((node) => node.x));
      const top = Math.min(...selectedCards.map((node) => node.y));
      const right = Math.max(...selectedCards.map((node) => node.x + node.width));
      const bottom = Math.max(...selectedCards.map((node) => node.y + node.height));
      x = left - GROUP_PADDING;
      y = top - GROUP_PADDING;
      width = right - left + GROUP_PADDING * 2;
      height = bottom - top + GROUP_PADDING * 2;
    } else {
      const center = worldPoint ?? this.viewportCenter();
      x = center.x - DEFAULT_GROUP_WIDTH / 2;
      y = center.y - DEFAULT_GROUP_HEIGHT / 2;
      width = DEFAULT_GROUP_WIDTH;
      height = DEFAULT_GROUP_HEIGHT;
    }
    const group: CanvasNode = {
      id: this.nextGroupNodeId(),
      type: "group",
      x,
      y,
      width,
      height,
      ...(label ? { label } : {}),
    };
    const firstCard = this.document.nodes.findIndex((node) => node.type !== "group");
    this.document.nodes.splice(firstCard < 0 ? this.document.nodes.length : firstCard, 0, group);
    this.selectedEdgeId = null;
    this.selectedIds.clear();
    this.selectedIds.add(group.id);
    this.render();
    void this.persist();
  }

  private nextGroupNodeId(): string {
    const ids = new Set(this.document.nodes.map((node) => node.id));
    let sequence = 1;
    while (ids.has(`group-${sequence}`)) sequence += 1;
    return `group-${sequence}`;
  }

  private editGroupLabel(groupId: string): void {
    const group = this.document.nodes.find((node) => node.id === groupId);
    if (!group || group.type !== "group") return;
    new PromptModal(this.app, {
      placeholder: "Group label…",
      initialValue: group.label ?? "",
      allowEmptySubmit: true,
      onSubmit: (label) => {
        const current = this.document.nodes.find((node) => node.id === groupId);
        if (!current || current.type !== "group") return;
        if (label) current.label = label;
        else delete current.label;
        this.render();
        void this.persist();
      },
    }).open();
  }

  private fileKind(file: TFile): EmbedKind {
    if (file.extension === "md") return "note";
    if (IMAGE_EXTENSIONS.has(file.extension)) return "image";
    if (AUDIO_EXTENSIONS.has(file.extension)) return "audio";
    if (VIDEO_EXTENSIONS.has(file.extension)) return "video";
    return "other";
  }

  private viewportCenter(): Point {
    return {
      x: (this.surfaceEl.clientWidth / 2 - this.pan.x) / this.scale,
      y: (this.surfaceEl.clientHeight / 2 - this.pan.y) / this.scale,
    };
  }

  private screenToWorld(clientX: number, clientY: number): Point {
    const rect = this.surfaceEl.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.pan.x) / this.scale,
      y: (clientY - rect.top - this.pan.y) / this.scale,
    };
  }

  private openFilePicker(kind: "note" | "media", worldPoint?: Point, choose?: (file: TFile) => void): void {
    const onChoose = choose ?? ((file: TFile) => this.addFileCardAt(file, worldPoint ?? this.viewportCenter()));
    if (kind === "note") {
      this.openNotePicker(onChoose);
      return;
    }
    new CanvasFileSuggestModal(
      this.app,
      this.app.vault.getFiles().filter((file) => file.extension !== "md"),
      "Search media…",
      onChoose,
    ).open();
  }

  private openNotePicker(choose: (file: TFile) => void): void {
    new CanvasFileSuggestModal(
      this.app,
      this.app.vault.getMarkdownFiles(),
      "Search notes…",
      choose,
    ).open();
  }

  private openSwapFilePicker(nodeId: string, kind: SwappableFileKind): void {
    const files = kind === "note"
      ? this.app.vault.getMarkdownFiles()
      : this.app.vault.getFiles().filter((file) => this.fileKind(file) === kind);
    new CanvasFileSuggestModal(
      this.app,
      files,
      kind === "note" ? "Search notes…" : `Search ${kind} files…`,
      (file) => {
        const node = this.document.nodes.find((candidate) => candidate.id === nodeId);
        if (!node || node.type !== "file") return;
        node.file = file.path;
        delete node.subpath;
        this.render();
        void this.persist();
      },
    ).open();
  }

  private openConvertTextNodePrompt(nodeId: string): void {
    new PromptModal(this.app, {
      placeholder: "File name…",
      initialValue: "Untitled",
      allowEmptySubmit: true,
      onSubmit: (name) => { void this.convertTextNodeToFile(nodeId, name); },
    }).open();
  }

  private async convertTextNodeToFile(nodeId: string, rawName: string): Promise<void> {
    const base = rawName.trim().replace(/\.md$/i, "").trim();
    if (!base || INVALID_MARKDOWN_FILE_NAME.test(base)) {
      this.app.notify("Enter a valid file name.");
      return;
    }
    const node = this.document.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.type !== "text") return;
    const filePath = this.app.vault.availablePath(this.file?.parent ?? "", base, "md");
    await this.app.vault.create(filePath, node.text);
    if (!this.document.nodes.includes(node) || node.type !== "text") return;
    const converted = node as unknown as Record<string, unknown>;
    converted.type = "file";
    converted.file = filePath;
    delete converted.text;
    delete converted.subpath;
    this.render();
    void this.persist();
  }

  private canvasColor(color: string): string {
    return /^[1-6]$/.test(color) ? `var(--canvas-color-${color})` : color;
  }

  private select(node: CanvasNode, additive = false): void {
    this.selectedEdgeId = null;
    if (additive && this.selectedIds.has(node.id)) {
      this.selectedIds.delete(node.id);
    } else {
      if (!additive) this.selectedIds.clear();
      this.selectedIds.add(node.id);
      this.promote(node);
    }
    this.updateSelectionClasses();
  }

  private promote(node: CanvasNode): void {
    const index = this.document.nodes.indexOf(node);
    if (index < 0 || index === this.document.nodes.length - 1) return;
    this.document.nodes.splice(index, 1);
    this.document.nodes.push(node);
    const selectedEl = this.viewportEl.querySelector<HTMLElement>(`.canvas-node[data-node-id="${CSS.escape(node.id)}"]`);
    if (selectedEl) this.viewportEl.appendChild(selectedEl);
    this.document.nodes.forEach((orderedNode, zIndex) => {
      const el = this.viewportEl.querySelector<HTMLElement>(`.canvas-node[data-node-id="${CSS.escape(orderedNode.id)}"]`);
      if (el) el.style.zIndex = String(zIndex + 1);
    });
    void this.persist();
  }

  private updateSelectionClasses(): void {
    for (const el of this.viewportEl.querySelectorAll<HTMLElement>(".canvas-node")) {
      el.classList.toggle("is-selected", this.selectedIds.has(el.dataset.nodeId ?? ""));
    }
    for (const el of this.viewportEl.querySelectorAll<SVGPathElement>(".canvas-edge")) {
      el.classList.toggle("is-selected", this.selectedEdgeId === el.dataset.edgeId);
    }
    for (const el of this.viewportEl.querySelectorAll<SVGCircleElement>(".canvas-edge-endpoint-handle")) {
      const selected = this.selectedEdgeId === el.dataset.edgeId;
      el.classList.toggle("is-selected", selected);
      el.setAttribute("aria-hidden", String(!selected));
      el.setAttribute("tabindex", selected ? "0" : "-1");
    }
    this.updateSelectionControls();
  }

  private updateSelectionControls(): void {
    const hasSelection = this.selectedIds.size > 0 || this.selectedEdgeId !== null;
    if (!hasSelection) {
      this.selectionControlsEl?.remove();
      this.selectionControlsEl = null;
      this.colorPaletteEl = null;
      return;
    }
    const selectionKind = this.selectedEdgeId ? "edge" : "nodes";
    if (this.selectionControlsEl?.isConnected && this.selectionControlsEl.dataset.selectionKind === selectionKind) return;
    this.selectionControlsEl?.remove();
    this.colorPaletteEl = null;
    const controls = document.createElement("div");
    controls.className = "canvas-selection-controls";
    controls.dataset.selectionKind = selectionKind;
    const setColor = document.createElement("button");
    setColor.type = "button";
    setColor.textContent = "Set color";
    setColor.setAttribute("aria-label", "Set color");
    setColor.addEventListener("click", () => this.openColorPalette());
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "canvas-selection-remove";
    remove.title = "Remove";
    remove.setAttribute("aria-label", "Remove");
    setIcon(remove, "trash-2");
    remove.addEventListener("click", () => this.deleteSelection());
    controls.appendChild(setColor);
    if (this.selectedEdgeId) {
      const edgeId = this.selectedEdgeId;
      const editLabel = document.createElement("button");
      editLabel.type = "button";
      editLabel.textContent = "Edit label";
      editLabel.setAttribute("aria-label", "Edit label");
      editLabel.addEventListener("click", () => this.editEdgeLabel(edgeId));
      controls.appendChild(editLabel);
    }
    controls.appendChild(remove);
    this.surfaceEl.appendChild(controls);
    this.selectionControlsEl = controls;
  }

  private openColorPalette(): void {
    const controls = this.selectionControlsEl;
    if (!controls) return;
    this.colorPaletteEl?.remove();
    const palette = document.createElement("div");
    palette.className = "canvas-color-palette";
    for (let index = 1; index <= 6; index += 1) {
      const color = String(index);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "canvas-color-preset";
      button.setAttribute("aria-label", `Color ${index}`);
      button.title = `Color ${index}`;
      button.style.backgroundColor = this.canvasColor(color);
      button.addEventListener("click", () => this.applySelectionColor(color));
      palette.appendChild(button);
    }
    const custom = document.createElement("button");
    custom.type = "button";
    custom.className = "canvas-color-custom";
    custom.textContent = "Custom color…";
    custom.addEventListener("click", () => this.openCustomColorPrompt());
    palette.appendChild(custom);
    controls.appendChild(palette);
    this.colorPaletteEl = palette;
  }

  private openCustomColorPrompt(): void {
    this.colorPaletteEl?.remove();
    this.colorPaletteEl = null;
    new PromptModal(this.app, {
      placeholder: "CSS color…",
      initialValue: this.commonSelectionColor(),
      allowEmptySubmit: true,
      onSubmit: (rawColor) => {
        const color = rawColor.trim();
        if (!color || !CSS.supports("color", color)) {
          this.app.notify("Enter a valid CSS color.");
          return;
        }
        this.applySelectionColor(color);
      },
    }).open();
  }

  private commonSelectionColor(): string {
    const colors = this.selectedEdgeId
      ? this.document.edges.filter((edge) => edge.id === this.selectedEdgeId).map((edge) => edge.color)
      : this.document.nodes.filter((node) => this.selectedIds.has(node.id)).map((node) => node.color);
    const first = colors[0];
    return first && colors.every((color) => color === first) ? first : "";
  }

  private applySelectionColor(color: string): void {
    if (this.selectedEdgeId) {
      const edge = this.document.edges.find((candidate) => candidate.id === this.selectedEdgeId);
      if (!edge) return;
      edge.color = color;
    } else if (this.selectedIds.size > 0) {
      for (const node of this.document.nodes) {
        if (this.selectedIds.has(node.id)) node.color = color;
      }
    } else {
      return;
    }
    this.colorPaletteEl?.remove();
    this.colorPaletteEl = null;
    this.render();
    void this.persist();
  }

  private clearSelection(): void {
    this.selectedIds.clear();
    this.selectedEdgeId = null;
    this.updateSelectionClasses();
  }

  private selectEdge(edgeId: string): void {
    this.selectedIds.clear();
    this.selectedEdgeId = edgeId;
    this.updateSelectionClasses();
  }

  private editEdgeLabel(edgeId: string): void {
    const edge = this.document.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) return;
    new PromptModal(this.app, {
      placeholder: "Edge label…",
      initialValue: edge.label ?? "",
      allowEmptySubmit: true,
      onSubmit: (label) => {
        const current = this.document.edges.find((candidate) => candidate.id === edgeId);
        if (!current) return;
        if (label) current.label = label;
        else delete current.label;
        this.render();
        void this.persist();
      },
    }).open();
  }

  private editEdgeLabelInline(edgeId: string, hit: SVGPathElement): void {
    const edge = this.document.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) return;
    this.edgeLabelEditorCancel?.();
    const point = hit.getPointAtLength(hit.getTotalLength() / 2);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "canvas-edge-label-editor";
    input.dataset.edgeId = edgeId;
    input.setAttribute("aria-label", `Edit connection label ${edgeId}`);
    input.value = edge.label ?? "";
    input.style.left = `${point.x}px`;
    input.style.top = `${point.y}px`;
    let finished = false;
    const finish = (commit: boolean) => {
      if (finished) return;
      finished = true;
      if (this.edgeLabelEditorEl === input) {
        this.edgeLabelEditorEl = null;
        this.edgeLabelEditorCancel = null;
      }
      input.remove();
      if (!commit) return;
      const current = this.document.edges.find((candidate) => candidate.id === edgeId);
      if (!current) return;
      const label = input.value.trim();
      if (label) current.label = label;
      else delete current.label;
      this.render();
      void this.persist();
    };
    this.edgeLabelEditorEl = input;
    this.edgeLabelEditorCancel = () => finish(false);
    input.addEventListener("pointerdown", (event) => event.stopPropagation());
    input.addEventListener("dblclick", (event) => event.stopPropagation());
    input.addEventListener("blur", () => finish(true), { once: true });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    });
    this.viewportEl.appendChild(input);
    input.focus();
    input.select();
  }

  private focusEdgeEndpoint(edgeId: string, endpoint: "source" | "target"): void {
    const edge = this.document.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) return;
    const nodeId = endpoint === "source" ? edge.fromNode : edge.toNode;
    const node = this.document.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return;
    this.selectedEdgeId = null;
    this.selectedIds.clear();
    this.selectedIds.add(node.id);
    this.updateSelectionClasses();
    const padding = 40;
    const fitScale = Math.min(
      (this.surfaceEl.clientWidth - padding * 2) / node.width,
      (this.surfaceEl.clientHeight - padding * 2) / node.height,
    );
    this.scale = Math.max(MIN_SCALE, Math.min(this.scale, fitScale));
    this.pan = {
      x: this.surfaceEl.clientWidth / 2 - (node.x + node.width / 2) * this.scale,
      y: this.surfaceEl.clientHeight / 2 - (node.y + node.height / 2) * this.scale,
    };
    this.updateTransform();
  }

  private removeEdge(edgeId: string): void {
    const length = this.document.edges.length;
    this.document.edges = this.document.edges.filter((edge) => edge.id !== edgeId);
    if (this.document.edges.length === length) return;
    if (this.selectedEdgeId === edgeId) this.selectedEdgeId = null;
    this.render();
    void this.persist();
  }

  private beginEdgeReconnect(event: PointerEvent, edgeId: string, endpoint: "source" | "target"): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.surfaceEl.focus({ preventScroll: true });
    this.selectEdge(edgeId);
    const edge = this.document.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) return;
    const fromNode = this.document.nodes.find((node) => node.id === edge.fromNode);
    const toNode = this.document.nodes.find((node) => node.id === edge.toNode);
    const svg = this.viewportEl.querySelector<SVGSVGElement>(".canvas-edges");
    if (!fromNode || !toNode || !svg) return;
    const fromSide = edge.fromSide ?? this.automaticSide(fromNode, toNode);
    const toSide = edge.toSide ?? this.automaticSide(toNode, fromNode);
    const from = this.sidePoint(fromNode, fromSide);
    const to = this.sidePoint(toNode, toSide);
    const preview = document.createElementNS(svg.namespaceURI, "path");
    preview.classList.add("canvas-edge-preview");
    preview.setAttribute("d", this.edgePath(from, fromSide, to, toSide));
    svg.appendChild(preview);
    const toWorld = (pointer: PointerEvent): Point => {
      const rect = this.surfaceEl.getBoundingClientRect();
      return {
        x: (pointer.clientX - rect.left - this.pan.x) / this.scale,
        y: (pointer.clientY - rect.top - this.pan.y) / this.scale,
      };
    };
    const move = (next: PointerEvent) => {
      const point = toWorld(next);
      preview.setAttribute("d", endpoint === "source"
        ? this.edgePath(point, fromSide, to, toSide)
        : this.edgePath(from, fromSide, point, toSide));
    };
    const up = (next: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      preview.remove();
      const nodeEl = [...this.viewportEl.querySelectorAll<HTMLElement>(".canvas-node")].reverse().find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return next.clientX >= rect.left && next.clientX <= rect.right && next.clientY >= rect.top && next.clientY <= rect.bottom;
      });
      if (!nodeEl) {
        this.removeEdge(edgeId);
        return;
      }
      const node = this.document.nodes.find((candidate) => candidate.id === nodeEl.dataset.nodeId);
      if (!node || node.type === "group") return;
      const otherNodeId = endpoint === "source" ? edge.toNode : edge.fromNode;
      if (node.id === otherNodeId) return;
      const side = this.closestSide(node, toWorld(next));
      if (endpoint === "source") {
        edge.fromNode = node.id;
        edge.fromSide = side;
      } else {
        edge.toNode = node.id;
        edge.toSide = side;
      }
      this.render();
      void this.persist();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private closestSide(node: CanvasNode, point: Point): CanvasSide {
    const distances: Array<[CanvasSide, number]> = [
      ["left", Math.abs(point.x - node.x)],
      ["right", Math.abs(point.x - (node.x + node.width))],
      ["top", Math.abs(point.y - node.y)],
      ["bottom", Math.abs(point.y - (node.y + node.height))],
    ];
    distances.sort((a, b) => a[1] - b[1]);
    return distances[0][0];
  }

  private beginNodeDrag(event: PointerEvent, node: CanvasNode): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest("textarea, .canvas-node-resize-handle, .canvas-node-resize-edge, .canvas-node-connection-handle")) return;
    event.stopPropagation();
    this.surfaceEl.focus({ preventScroll: true });
    if (event.altKey && node.type !== "group") {
      this.beginNodeDuplication(event, node);
      return;
    }
    const wasSelected = this.selectedIds.has(node.id);
    if (node.type === "group") {
      this.selectedEdgeId = null;
      this.selectedIds.clear();
      this.selectedIds.add(node.id);
      this.updateSelectionClasses();
    }
    const start = { x: event.clientX, y: event.clientY, nodeX: node.x, nodeY: node.y };
    const carried = node.type === "group"
      ? this.document.nodes
        .filter((candidate) => candidate.type !== "group"
          && candidate.x >= node.x
          && candidate.y >= node.y
          && candidate.x + candidate.width <= node.x + node.width
          && candidate.y + candidate.height <= node.y + node.height)
        .map((candidate) => ({ node: candidate, x: candidate.x, y: candidate.y }))
      : wasSelected
        ? this.document.nodes
          .filter((candidate) => candidate.id !== node.id && candidate.type !== "group" && this.selectedIds.has(candidate.id))
          .map((candidate) => ({ node: candidate, x: candidate.x, y: candidate.y }))
        : [];
    let didMove = false;
    const move = (next: PointerEvent) => {
      if (!didMove) {
        didMove = true;
        if (node.type !== "group" && !wasSelected) {
          this.selectedEdgeId = null;
          this.selectedIds.clear();
          this.selectedIds.add(node.id);
          this.updateSelectionClasses();
        }
      }
      let screenDx = next.clientX - start.x;
      let screenDy = next.clientY - start.y;
      if (node.type !== "group" && next.shiftKey) {
        if (Math.abs(screenDx) >= Math.abs(screenDy)) screenDy = 0;
        else screenDx = 0;
      }
      const dx = screenDx / this.scale;
      const dy = screenDy / this.scale;
      node.x = start.nodeX + dx;
      node.y = start.nodeY + dy;
      for (const member of carried) {
        member.node.x = member.x + dx;
        member.node.y = member.y + dy;
      }
      this.render();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!didMove && node.type !== "group") {
        this.select(node, event.shiftKey);
        return;
      }
      void this.persist();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private beginNodeDuplication(event: PointerEvent, draggedNode: CanvasNode): void {
    event.preventDefault();
    const sourceNodes = this.selectedIds.has(draggedNode.id)
      ? this.document.nodes.filter((node) => node.type !== "group" && this.selectedIds.has(node.id))
      : [draggedNode];
    const sourceEdges = [...this.document.edges];
    const start = { x: event.clientX, y: event.clientY };
    let clones: Array<{ node: CanvasNode; x: number; y: number }> | null = null;

    const move = (next: PointerEvent) => {
      const screenDx = next.clientX - start.x;
      const screenDy = next.clientY - start.y;
      if (!clones && Math.hypot(screenDx, screenDy) < 4) return;
      if (!clones) {
        const usedNodeIds = new Set(this.document.nodes.map((node) => node.id));
        const idMap = new Map<string, string>();
        clones = sourceNodes.map((source) => {
          const clone = structuredClone(source) as CanvasNode;
          clone.id = this.nextDuplicateNodeId(source.id, usedNodeIds);
          idMap.set(source.id, clone.id);
          return { node: clone, x: source.x, y: source.y };
        });
        this.document.nodes.push(...clones.map(({ node }) => node));
        for (const edge of sourceEdges) {
          const fromNode = idMap.get(edge.fromNode);
          const toNode = idMap.get(edge.toNode);
          if (!fromNode || !toNode) continue;
          this.document.edges.push({
            ...structuredClone(edge),
            id: this.nextEdgeId(),
            fromNode,
            toNode,
          });
        }
        this.selectedIds.clear();
        for (const { node } of clones) this.selectedIds.add(node.id);
        this.selectedEdgeId = null;
      }
      const dx = screenDx / this.scale;
      const dy = screenDy / this.scale;
      for (const clone of clones) {
        clone.node.x = clone.x + dx;
        clone.node.y = clone.y + dy;
      }
      this.render();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (clones) void this.persist();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private nextDuplicateNodeId(sourceId: string, usedIds: Set<string>): string {
    const base = `${sourceId}-copy`;
    let id = base;
    let sequence = 2;
    while (usedIds.has(id)) id = `${base}-${sequence++}`;
    usedIds.add(id);
    return id;
  }

  private beginResize(event: PointerEvent, node: CanvasNode, direction: ResizeDirection = "southeast"): void {
    event.preventDefault();
    event.stopPropagation();
    this.surfaceEl.focus({ preventScroll: true });
    this.selectedEdgeId = null;
    this.selectedIds.clear();
    this.selectedIds.add(node.id);
    this.updateSelectionClasses();
    const start = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    };
    const move = (next: PointerEvent) => {
      const dx = (next.clientX - start.pointerX) / this.scale;
      const dy = (next.clientY - start.pointerY) / this.scale;
      const minimumScale = Math.max(MIN_WIDTH / start.width, MIN_HEIGHT / start.height);
      if (direction === "southeast" && next.shiftKey) {
        const proportionalX = dx / start.width;
        const proportionalY = dy / start.height;
        const driver = Math.abs(proportionalX) >= Math.abs(proportionalY) ? proportionalX : proportionalY;
        const constrainedScale = Math.max(minimumScale, 1 + driver);
        node.width = start.width * constrainedScale;
        node.height = start.height * constrainedScale;
        node.x = start.x;
        node.y = start.y;
      } else if (direction === "southeast") {
        node.width = Math.max(MIN_WIDTH, start.width + dx);
        node.height = Math.max(MIN_HEIGHT, start.height + dy);
        node.x = start.x;
        node.y = start.y;
      } else if (direction === "left" || direction === "right") {
        const rawWidth = direction === "left" ? start.width - dx : start.width + dx;
        if (next.shiftKey) {
          const constrainedScale = Math.max(minimumScale, rawWidth / start.width);
          node.width = start.width * constrainedScale;
          node.height = start.height * constrainedScale;
          node.y = start.y + (start.height - node.height) / 2;
        } else {
          node.width = Math.max(MIN_WIDTH, rawWidth);
          node.height = start.height;
          node.y = start.y;
        }
        node.x = direction === "left" ? start.x + start.width - node.width : start.x;
      } else {
        const rawHeight = direction === "top" ? start.height - dy : start.height + dy;
        if (next.shiftKey) {
          const constrainedScale = Math.max(minimumScale, rawHeight / start.height);
          node.width = start.width * constrainedScale;
          node.height = start.height * constrainedScale;
          node.x = start.x + (start.width - node.width) / 2;
        } else {
          node.width = start.width;
          node.height = Math.max(MIN_HEIGHT, rawHeight);
          node.x = start.x;
        }
        node.y = direction === "top" ? start.y + start.height - node.height : start.y;
      }
      this.render();
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); void this.persist(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private beginConnection(event: PointerEvent, node: CanvasNode, side: CanvasSide): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.surfaceEl.focus({ preventScroll: true });
    this.selectedEdgeId = null;
    this.selectedIds.clear();
    this.selectedIds.add(node.id);
    this.updateSelectionClasses();
    this.containerEl.classList.add("is-connecting");
    const svg = this.viewportEl.querySelector<SVGSVGElement>(".canvas-edges");
    if (!svg) return;
    const preview = document.createElementNS(svg.namespaceURI, "path");
    preview.classList.add("canvas-edge-preview");
    const from = this.sidePoint(node, side);
    preview.setAttribute("d", this.edgePath(from, side, from, side));
    svg.appendChild(preview);
    const toWorld = (pointer: PointerEvent): Point => {
      const rect = this.surfaceEl.getBoundingClientRect();
      return {
        x: (pointer.clientX - rect.left - this.pan.x) / this.scale,
        y: (pointer.clientY - rect.top - this.pan.y) / this.scale,
      };
    };
    const move = (next: PointerEvent) => {
      preview.setAttribute("d", this.edgePath(from, side, toWorld(next), this.oppositeSide(side)));
    };
    const up = (next: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const target = [...this.viewportEl.querySelectorAll<HTMLElement>(".canvas-node-connection-handle")].find((handle) => {
        const rect = handle.getBoundingClientRect();
        return next.clientX >= rect.left && next.clientX <= rect.right && next.clientY >= rect.top && next.clientY <= rect.bottom;
      });
      preview.remove();
      this.containerEl.classList.remove("is-connecting");
      const targetNodeId = target?.dataset.nodeId;
      const targetSide = target?.dataset.side as CanvasSide | undefined;
      if (targetNodeId && targetSide) {
        if (targetNodeId === node.id) return;
        const targetNode = this.document.nodes.find((candidate) => candidate.id === targetNodeId);
        if (!targetNode || targetNode.type === "group") return;
        const edge: CanvasEdge = {
          id: this.nextEdgeId(),
          fromNode: node.id,
          fromSide: side,
          fromEnd: "none",
          toNode: targetNode.id,
          toSide: targetSide,
          toEnd: "arrow",
        };
        this.document.edges.push(edge);
        this.selectedIds.clear();
        this.selectedEdgeId = edge.id;
        this.render();
        void this.persist();
        return;
      }
      const nodeBody = [...this.viewportEl.querySelectorAll<HTMLElement>(".canvas-node")].reverse().find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return next.clientX >= rect.left && next.clientX <= rect.right && next.clientY >= rect.top && next.clientY <= rect.bottom;
      });
      if (nodeBody) return;
      const worldPoint = toWorld(next);
      this.app.showMenu(next, [
        { title: "Add text card", action: () => this.addConnectedTextCard(node, side, worldPoint) },
        {
          title: "Add note from vault",
          action: () => this.openFilePicker("note", worldPoint, (file) => this.addConnectedFileCard(node, side, file, worldPoint)),
        },
        {
          title: "Add media from vault",
          action: () => this.openFilePicker("media", worldPoint, (file) => this.addConnectedFileCard(node, side, file, worldPoint)),
        },
        {
          title: "Add web page",
          action: () => this.openWebPagePrompt(worldPoint, (url) => this.addConnectedLinkCard(node, side, url, worldPoint)),
        },
      ]);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private addConnectedTextCard(source: CanvasNode, sourceSide: CanvasSide, worldPoint: Point): void {
    const node: CanvasTextNode = {
      id: this.nextTextNodeId(),
      type: "text",
      x: worldPoint.x - TEXT_NODE_WIDTH / 2,
      y: worldPoint.y - TEXT_NODE_HEIGHT / 2,
      width: TEXT_NODE_WIDTH,
      height: TEXT_NODE_HEIGHT,
      text: "",
    };
    const targetSide = this.oppositeSide(sourceSide);
    const edge: CanvasEdge = {
      id: this.nextEdgeId(),
      fromNode: source.id,
      fromSide: sourceSide,
      fromEnd: "none",
      toNode: node.id,
      toSide: targetSide,
      toEnd: "arrow",
    };
    this.document.nodes.push(node);
    this.document.edges.push(edge);
    this.selectedEdgeId = null;
    this.selectedIds.clear();
    this.selectedIds.add(node.id);
    this.render();
    const el = this.viewportEl.querySelector<HTMLElement>(`.canvas-node[data-node-id="${CSS.escape(node.id)}"]`);
    if (!el) return;
    this.editTextNode(el, node, true, () => {
      this.document.edges = this.document.edges.filter((candidate) => candidate !== edge);
      this.selectedEdgeId = null;
      this.selectedIds.clear();
      if (this.document.nodes.includes(source)) this.selectedIds.add(source.id);
    });
  }

  private addConnectedFileCard(source: CanvasNode, sourceSide: CanvasSide, file: TFile, worldPoint: Point): void {
    this.addConnectedCard(source, sourceSide, this.createFileCard(file, worldPoint));
  }

  private addConnectedLinkCard(source: CanvasNode, sourceSide: CanvasSide, url: string, worldPoint: Point): void {
    this.addConnectedCard(source, sourceSide, this.createLinkCard(url, worldPoint));
  }

  private addConnectedCard(source: CanvasNode, sourceSide: CanvasSide, node: CanvasNode): void {
    if (!this.document.nodes.includes(source)) return;
    const edge: CanvasEdge = {
      id: this.nextEdgeId(),
      fromNode: source.id,
      fromSide: sourceSide,
      fromEnd: "none",
      toNode: node.id,
      toSide: this.oppositeSide(sourceSide),
      toEnd: "arrow",
    };
    this.document.nodes.push(node);
    this.document.edges.push(edge);
    this.selectedEdgeId = null;
    this.selectedIds.clear();
    this.selectedIds.add(node.id);
    this.render();
    void this.persist();
  }

  private nextEdgeId(): string {
    const ids = new Set(this.document.edges.map((edge) => edge.id));
    let sequence = 1;
    while (ids.has(`edge-${sequence}`)) sequence += 1;
    return `edge-${sequence}`;
  }

  private installCameraControls(): void {
    const isEmptyDropTarget = (target: EventTarget | null) => target === this.surfaceEl || target === this.viewportEl;
    this.surfaceEl.addEventListener("dragover", (event) => {
      const types = event.dataTransfer?.types;
      if (
        !isEmptyDropTarget(event.target)
        || !types
        || ![VAULT_FILE_DRAG_MIME, "text/uri-list", "text/plain"].some((type) => types.includes(type))
      ) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    this.surfaceEl.addEventListener("drop", (event) => {
      const transfer = event.dataTransfer;
      if (!isEmptyDropTarget(event.target) || !transfer) return;
      if (transfer.types.includes(VAULT_FILE_DRAG_MIME)) {
        event.preventDefault();
        event.stopPropagation();
        const path = transfer.getData(VAULT_FILE_DRAG_MIME);
        if (!isValidVaultFileDragPath(path)) return;
        const item = this.app.vault.getAbstractFileByPath(path);
        if (!item) return;
        const worldPoint = this.screenToWorld(event.clientX, event.clientY);
        if (item.kind === "file") {
          if (item.path === this.file?.path) return;
          this.addFileCardAt(item, worldPoint);
          return;
        }
        if (!item.path) return;
        const prefix = `${item.path}/`;
        const files = this.app.vault.getFiles()
          .filter((file) => file.path.startsWith(prefix) && file.path !== this.file?.path)
          .sort((a, b) => a.path.localeCompare(b.path));
        this.addFileCardsAt(files, worldPoint);
        return;
      }
      const canonicalUrl = normalizeDroppedWebUrl(transfer);
      if (!canonicalUrl) return;
      event.preventDefault();
      event.stopPropagation();
      this.addLinkCardAt(canonicalUrl, this.screenToWorld(event.clientX, event.clientY));
    });
    this.surfaceEl.addEventListener("dblclick", (event) => {
      if (event.target !== this.surfaceEl && event.target !== this.viewportEl) return;
      this.addTextCardAt(this.screenToWorld(event.clientX, event.clientY));
    });
    this.surfaceEl.addEventListener("contextmenu", (event) => {
      if (event.target !== this.surfaceEl && event.target !== this.viewportEl) return;
      event.preventDefault();
      event.stopPropagation();
      const worldPoint = this.screenToWorld(event.clientX, event.clientY);
      this.app.showMenu(event, [
        { title: "Add note from vault", action: () => this.openFilePicker("note", worldPoint) },
        { title: "Add media from vault", action: () => this.openFilePicker("media", worldPoint) },
        { title: "Add web page", action: () => this.openWebPagePrompt(worldPoint) },
        { title: "Create group", action: () => this.openGroupPrompt(worldPoint) },
      ]);
    });
    this.surfaceEl.addEventListener("pointerdown", (event) => {
      if (event.target !== this.surfaceEl && event.target !== this.viewportEl) return;
      this.surfaceEl.focus({ preventScroll: true });
      if (event.button !== 0 && event.button !== 1) return;
      const selectionSnapshot = new Set(this.selectedIds);
      this.clearSelection();
      const isPan = event.button === 1 || (event.button === 0 && this.spacePressed);
      if (event.button === 0 && !isPan) {
        event.preventDefault();
        const rect = this.surfaceEl.getBoundingClientRect();
        const start = { x: event.clientX, y: event.clientY };
        let marqueeEl: HTMLElement | null = null;
        const move = (next: PointerEvent) => {
          if (!marqueeEl && Math.hypot(next.clientX - start.x, next.clientY - start.y) < 4) return;
          if (!marqueeEl) {
            marqueeEl = document.createElement("div");
            marqueeEl.className = "canvas-marquee";
            this.surfaceEl.appendChild(marqueeEl);
          }
          const left = Math.min(start.x, next.clientX);
          const top = Math.min(start.y, next.clientY);
          const right = Math.max(start.x, next.clientX);
          const bottom = Math.max(start.y, next.clientY);
          Object.assign(marqueeEl.style, {
            left: `${left - rect.left}px`,
            top: `${top - rect.top}px`,
            width: `${right - left}px`,
            height: `${bottom - top}px`,
          });
          const worldLeft = (left - rect.left - this.pan.x) / this.scale;
          const worldTop = (top - rect.top - this.pan.y) / this.scale;
          const worldRight = (right - rect.left - this.pan.x) / this.scale;
          const worldBottom = (bottom - rect.top - this.pan.y) / this.scale;
          this.selectedIds.clear();
          if (event.shiftKey) {
            for (const id of selectionSnapshot) this.selectedIds.add(id);
          }
          for (const node of this.document.nodes) {
            if (
              node.x <= worldRight
              && node.x + node.width >= worldLeft
              && node.y <= worldBottom
              && node.y + node.height >= worldTop
            ) this.selectedIds.add(node.id);
          }
          this.updateSelectionClasses();
        };
        const up = () => {
          marqueeEl?.remove();
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
        return;
      }
      if (!isPan) return;
      event.preventDefault();
      const start = { x: event.clientX, y: event.clientY, panX: this.pan.x, panY: this.pan.y };
      const move = (next: PointerEvent) => { this.pan = { x: start.panX + next.clientX - start.x, y: start.panY + next.clientY - start.y }; this.updateTransform(); };
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    this.surfaceEl.addEventListener("keydown", (event) => this.handleKeyDown(event));
    this.surfaceEl.addEventListener("keyup", (event) => {
      if (event.code === "Space") this.spacePressed = false;
    });
    this.surfaceEl.addEventListener("blur", (event) => {
      if (!this.surfaceEl.contains(event.relatedTarget as Node | null)) this.spacePressed = false;
    });
    this.surfaceEl.addEventListener("wheel", (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const scrollable = target?.closest<HTMLElement>(".canvas-node-text, .canvas-node-note");
      const nodeId = scrollable?.closest<HTMLElement>(".canvas-node")?.dataset.nodeId;
      if (
        !event.ctrlKey
        && !event.metaKey
        && !event.shiftKey
        && !this.spacePressed
        && scrollable
        && nodeId
        && this.selectedIds.has(nodeId)
        && scrollable.scrollHeight > scrollable.clientHeight
      ) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey || this.spacePressed) {
        const rect = this.surfaceEl.getBoundingClientRect();
        this.zoomAt(Math.exp(-event.deltaY * 0.001), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      } else if (event.shiftKey) {
        this.pan.x -= event.deltaY || event.deltaX;
        this.updateTransform();
      } else {
        this.pan.x -= event.deltaX;
        this.pan.y -= event.deltaY;
        this.updateTransform();
      }
    }, { passive: false });
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement;
    if (target.matches("textarea, input, [contenteditable=true]")) return;
    if (event.shiftKey && (event.code === "Digit1" || event.code === "Digit2")) {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "Digit1") this.fitToContent();
      else this.fitToSelection();
      return;
    }
    if (event.code === "Space") {
      this.spacePressed = true;
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.selectedEdgeId = null;
      this.selectedIds.clear();
      for (const node of this.document.nodes) this.selectedIds.add(node.id);
      this.updateSelectionClasses();
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && (this.selectedEdgeId || this.selectedIds.size > 0)) {
      event.preventDefault();
      this.deleteSelection();
    }
  }

  private deleteSelection(): void {
    if (this.selectedEdgeId) {
      const removedEdge = this.selectedEdgeId;
      this.document.edges = this.document.edges.filter((edge) => edge.id !== removedEdge);
    } else if (this.selectedIds.size > 0) {
      const removedNodes = new Set(this.selectedIds);
      this.document.nodes = this.document.nodes.filter((node) => !removedNodes.has(node.id));
      this.document.edges = this.document.edges.filter((edge) => !removedNodes.has(edge.fromNode) && !removedNodes.has(edge.toNode));
    } else {
      return;
    }
    this.selectedIds.clear();
    this.selectedEdgeId = null;
    this.render();
    void this.persist();
  }

  private buildCameraControls(): HTMLElement {
    const controls = document.createElement("div");
    controls.className = "canvas-controls";
    const actions: Array<{ action: string; label: string; title: string; run: () => void }> = [
      { action: "zoom-in", label: "+", title: "Zoom in", run: () => this.zoomAroundCenter(1.2) },
      { action: "zoom-out", label: "−", title: "Zoom out", run: () => this.zoomAroundCenter(1 / 1.2) },
      { action: "fit", label: "Fit", title: "Zoom to fit", run: () => this.fitToContent() },
      { action: "reset", label: "100%", title: "Reset zoom", run: () => this.resetCamera() },
    ];
    for (const { action, label, title, run } of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.canvasAction = action;
      button.title = title;
      button.setAttribute("aria-label", title);
      button.textContent = label;
      button.addEventListener("click", run);
      controls.appendChild(button);
    }
    return controls;
  }

  private buildCanvasToolbar(): HTMLElement {
    const toolbar = document.createElement("div");
    toolbar.className = "canvas-toolbar";
    const action = (title: string, iconName: string, run: () => void) => {
      const button = document.createElement("button");
      button.type = "button";
      button.title = title;
      button.setAttribute("aria-label", title);
      const icon = document.createElement("span");
      setIcon(icon, iconName);
      button.appendChild(icon);
      button.addEventListener("click", run);
      toolbar.appendChild(button);
    };
    action("Add text card", "file-plus", () => this.addTextCardAt(this.viewportCenter()));
    action("Add note from vault", "file-text", () => this.openFilePicker("note"));
    action("Add media from vault", "image-plus", () => this.openFilePicker("media"));
    action("Add web page", "globe", () => this.openWebPagePrompt());
    action("Add group", "group", () => this.openGroupPrompt());
    return toolbar;
  }

  private zoomAroundCenter(factor: number): void {
    this.zoomAt(factor, { x: this.surfaceEl.clientWidth / 2, y: this.surfaceEl.clientHeight / 2 });
  }

  private zoomAt(factor: number, cursor: Point): void {
    const world = { x: (cursor.x - this.pan.x) / this.scale, y: (cursor.y - this.pan.y) / this.scale };
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * factor));
    this.pan = { x: cursor.x - world.x * next, y: cursor.y - world.y * next };
    this.scale = next;
    this.updateTransform();
  }

  private fitToContent(): void {
    if (this.document.nodes.length === 0) {
      this.resetCamera();
      return;
    }
    this.fitToNodes(this.document.nodes);
  }

  private fitToSelection(): void {
    let nodes = this.document.nodes.filter((node) => this.selectedIds.has(node.id));
    if (nodes.length === 0 && this.selectedEdgeId) {
      const edge = this.document.edges.find((candidate) => candidate.id === this.selectedEdgeId);
      if (edge) {
        const endpointIds = new Set([edge.fromNode, edge.toNode]);
        nodes = this.document.nodes.filter((node) => endpointIds.has(node.id));
      }
    }
    if (nodes.length > 0) this.fitToNodes(nodes);
  }

  private fitToNodes(nodes: CanvasNode[]): void {
    this.fitToBounds({
      left: Math.min(...nodes.map((node) => node.x)),
      top: Math.min(...nodes.map((node) => node.y)),
      right: Math.max(...nodes.map((node) => node.x + node.width)),
      bottom: Math.max(...nodes.map((node) => node.y + node.height)),
    });
  }

  private fitToBounds({ left, top, right, bottom }: Bounds): void {
    const padding = 80;
    const width = Math.max(1, right - left);
    const height = Math.max(1, bottom - top);
    this.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE,
      (this.surfaceEl.clientWidth - padding * 2) / width,
      (this.surfaceEl.clientHeight - padding * 2) / height,
    ));
    this.pan = {
      x: this.surfaceEl.clientWidth / 2 - (left + width / 2) * this.scale,
      y: this.surfaceEl.clientHeight / 2 - (top + height / 2) * this.scale,
    };
    this.updateTransform();
  }

  private resetCamera(): void {
    this.pan = { ...DEFAULT_PAN };
    this.scale = 1;
    this.updateTransform();
  }

  private updateTransform(): void {
    this.viewportEl.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.scale})`;
    this.containerEl.dataset.scale = String(this.scale);
    this.containerEl.dataset.panX = String(this.pan.x);
    this.containerEl.dataset.panY = String(this.pan.y);
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    const text = serializeCanvas(this.document);
    this.lastKnownText = text;
    await this.app.vault.modify(this.file, text);
  }
}
