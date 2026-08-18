import type { App } from "../app";
import type { TFile } from "../types";
import { buildViewHeaderNavButtons, type View } from "../workspace";
import { parseCanvas, serializeCanvas, type CanvasDocument, type CanvasEdge, type CanvasNode, type CanvasSide, type CanvasTextNode } from "../canvas/canvas-data";

const MIN_WIDTH = 80;
const MIN_HEIGHT = 50;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

type Point = { x: number; y: number };

export class CanvasView implements View {
  readonly viewType = "canvas";
  readonly containerEl: HTMLElement;
  file: TFile | null = null;

  private readonly titleEl: HTMLElement;
  private readonly surfaceEl: HTMLElement;
  private readonly viewportEl: HTMLElement;
  private document: CanvasDocument = { nodes: [], edges: [] };
  private selectedId: string | null = null;
  private pan: Point = { x: 80, y: 80 };
  private scale = 1;
  private lastKnownText: string | null = null;

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
    this.viewportEl = document.createElement("div");
    this.viewportEl.className = "canvas-viewport";
    this.surfaceEl.appendChild(this.viewportEl);
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
  onClose(): void { this.app.vault.off("modify", this.onVaultModify); }

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
    for (const node of this.document.nodes.filter((node) => node.type === "group")) this.viewportEl.appendChild(this.renderNode(node));
    for (const node of this.document.nodes.filter((node) => node.type !== "group")) this.viewportEl.appendChild(this.renderNode(node));
  }

  private renderEdge(svg: SVGSVGElement, edge: CanvasEdge): void {
    const from = this.document.nodes.find((node) => node.id === edge.fromNode)!;
    const to = this.document.nodes.find((node) => node.id === edge.toNode)!;
    const a = this.edgePoint(from, edge.fromSide, to);
    const b = this.edgePoint(to, edge.toSide, from);
    const bend = Math.max(40, Math.abs(b.x - a.x) * 0.45);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.classList.add("canvas-edge");
    path.dataset.edgeId = edge.id;
    path.setAttribute("d", `M ${a.x} ${a.y} C ${a.x + bend} ${a.y}, ${b.x - bend} ${b.y}, ${b.x} ${b.y}`);
    if (edge.color) path.style.stroke = edge.color;
    if (edge.toEnd !== "none") path.setAttribute("marker-end", "url(#canvas-arrow)");
    svg.appendChild(path);
    if (edge.label) {
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.classList.add("canvas-edge-label");
      label.setAttribute("x", String((a.x + b.x) / 2));
      label.setAttribute("y", String((a.y + b.y) / 2 - 7));
      label.textContent = edge.label;
      svg.appendChild(label);
    }
  }

  private edgePoint(node: CanvasNode, explicit: CanvasSide | undefined, other: CanvasNode): Point {
    const side = explicit ?? (other.x > node.x + node.width ? "right" : other.x + other.width < node.x ? "left" : other.y > node.y ? "bottom" : "top");
    if (side === "left") return { x: node.x, y: node.y + node.height / 2 };
    if (side === "right") return { x: node.x + node.width, y: node.y + node.height / 2 };
    if (side === "top") return { x: node.x + node.width / 2, y: node.y };
    return { x: node.x + node.width / 2, y: node.y + node.height };
  }

  private renderNode(node: CanvasNode): HTMLElement {
    const el = document.createElement("div");
    el.className = `canvas-node canvas-node-${node.type}`;
    el.dataset.nodeId = node.id;
    el.dataset.width = String(node.width);
    el.dataset.height = String(node.height);
    el.classList.toggle("is-selected", node.id === this.selectedId);
    Object.assign(el.style, { left: `${node.x}px`, top: `${node.y}px`, width: `${node.width}px`, height: `${node.height}px` });
    if (node.color) el.style.setProperty("--canvas-node-color", node.color);
    if (node.type === "group") {
      if (node.background) el.style.backgroundImage = `url(${JSON.stringify(node.background).slice(1, -1)})`;
      const label = document.createElement("div");
      label.className = "canvas-group-label";
      label.textContent = node.label ?? "Group";
      el.appendChild(label);
    } else if (node.type === "text") {
      const text = document.createElement("div");
      text.className = "canvas-node-text";
      text.textContent = node.text;
      el.appendChild(text);
      el.addEventListener("dblclick", (event) => { event.stopPropagation(); this.editTextNode(el, node); });
    } else if (node.type === "file") {
      const type = document.createElement("div");
      type.className = "canvas-node-kind";
      type.textContent = "File";
      const name = document.createElement("div");
      name.className = "canvas-node-file";
      name.textContent = node.file + (node.subpath ?? "");
      el.append(type, name);
      el.addEventListener("dblclick", () => {
        const file = this.app.vault.getFileByPath(node.file);
        if (file) void this.app.openFile(file, true);
      });
    } else {
      const type = document.createElement("div");
      type.className = "canvas-node-kind";
      type.textContent = "Link";
      const link = document.createElement("div");
      link.className = "canvas-node-link";
      link.textContent = node.url;
      el.append(type, link);
    }
    el.addEventListener("pointerdown", (event) => this.beginNodeDrag(event, node));
    const resize = document.createElement("div");
    resize.className = "canvas-node-resize-handle";
    resize.addEventListener("pointerdown", (event) => this.beginResize(event, node));
    el.appendChild(resize);
    return el;
  }

  private editTextNode(el: HTMLElement, node: CanvasTextNode): void {
    if (el.querySelector("textarea")) return;
    const editor = document.createElement("textarea");
    editor.className = "canvas-node-text-editor";
    editor.value = node.text;
    el.querySelector(".canvas-node-text")?.replaceWith(editor);
    const finish = () => {
      node.text = editor.value;
      this.render();
      void this.persist();
    };
    editor.addEventListener("blur", finish, { once: true });
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); editor.blur(); }
      if (event.key === "Escape") { editor.value = node.text; editor.blur(); }
    });
    editor.focus();
    editor.select();
  }

  private select(node: CanvasNode): void {
    this.selectedId = node.id;
    for (const el of this.viewportEl.querySelectorAll(".canvas-node")) el.classList.toggle("is-selected", (el as HTMLElement).dataset.nodeId === node.id);
  }

  private beginNodeDrag(event: PointerEvent, node: CanvasNode): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest("textarea, .canvas-node-resize-handle")) return;
    event.stopPropagation();
    this.select(node);
    const start = { x: event.clientX, y: event.clientY, nodeX: node.x, nodeY: node.y };
    const move = (next: PointerEvent) => {
      node.x = start.nodeX + (next.clientX - start.x) / this.scale;
      node.y = start.nodeY + (next.clientY - start.y) / this.scale;
      this.render();
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); void this.persist(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private beginResize(event: PointerEvent, node: CanvasNode): void {
    event.preventDefault();
    event.stopPropagation();
    this.select(node);
    const start = { x: event.clientX, y: event.clientY, width: node.width, height: node.height };
    const move = (next: PointerEvent) => {
      node.width = Math.max(MIN_WIDTH, start.width + (next.clientX - start.x) / this.scale);
      node.height = Math.max(MIN_HEIGHT, start.height + (next.clientY - start.y) / this.scale);
      this.render();
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); void this.persist(); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private installCameraControls(): void {
    this.surfaceEl.addEventListener("pointerdown", (event) => {
      if (event.target !== this.surfaceEl && event.target !== this.viewportEl) return;
      this.selectedId = null;
      for (const el of this.viewportEl.querySelectorAll(".canvas-node")) el.classList.remove("is-selected");
      const start = { x: event.clientX, y: event.clientY, panX: this.pan.x, panY: this.pan.y };
      const move = (next: PointerEvent) => { this.pan = { x: start.panX + next.clientX - start.x, y: start.panY + next.clientY - start.y }; this.updateTransform(); };
      const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    this.surfaceEl.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = this.surfaceEl.getBoundingClientRect();
      const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const world = { x: (cursor.x - this.pan.x) / this.scale, y: (cursor.y - this.pan.y) / this.scale };
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.scale * Math.exp(-event.deltaY * 0.001)));
      this.pan = { x: cursor.x - world.x * next, y: cursor.y - world.y * next };
      this.scale = next;
      this.updateTransform();
    }, { passive: false });
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
