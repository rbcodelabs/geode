import type { App } from "../app";
import type { TFile } from "../types";
import { buildViewHeaderNavButtons, type View } from "../workspace";
import { parseCanvas, serializeCanvas, type CanvasDocument, type CanvasEdge, type CanvasNode, type CanvasSide, type CanvasTextNode } from "../canvas/canvas-data";
import { setIcon } from "../api/icons";

const MIN_WIDTH = 80;
const MIN_HEIGHT = 50;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;
const DEFAULT_PAN: Point = { x: 80, y: 80 };
const TEXT_NODE_WIDTH = 250;
const TEXT_NODE_HEIGHT = 140;

type Point = { x: number; y: number };

export class CanvasView implements View {
  readonly viewType = "canvas";
  readonly containerEl: HTMLElement;
  file: TFile | null = null;

  private readonly titleEl: HTMLElement;
  private readonly surfaceEl: HTMLElement;
  private readonly viewportEl: HTMLElement;
  private document: CanvasDocument = { nodes: [], edges: [] };
  private readonly selectedIds = new Set<string>();
  private pan: Point = { ...DEFAULT_PAN };
  private scale = 1;
  private spacePressed = false;
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
    for (const node of this.document.nodes) this.viewportEl.appendChild(this.renderNode(node));
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
    if (edge.color) path.style.stroke = this.canvasColor(edge.color);
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
      el.appendChild(label);
    } else if (node.type === "text") {
      const text = document.createElement("div");
      text.className = "canvas-node-text";
      el.appendChild(text);
      void this.app.markdownRenderer.render(node.text, text, this.file?.path ?? "");
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

  private editTextNode(el: HTMLElement, node: CanvasTextNode, isNew = false): void {
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

  private canvasColor(color: string): string {
    return /^[1-6]$/.test(color) ? `var(--canvas-color-${color})` : color;
  }

  private select(node: CanvasNode, additive = false): void {
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
  }

  private clearSelection(): void {
    this.selectedIds.clear();
    this.updateSelectionClasses();
  }

  private beginNodeDrag(event: PointerEvent, node: CanvasNode): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest("textarea, .canvas-node-resize-handle")) return;
    event.stopPropagation();
    this.surfaceEl.focus({ preventScroll: true });
    this.select(node, event.shiftKey);
    if (!this.selectedIds.has(node.id)) return;
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
    this.surfaceEl.focus({ preventScroll: true });
    this.select(node, event.shiftKey);
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
    this.surfaceEl.addEventListener("dblclick", (event) => {
      if (event.target !== this.surfaceEl && event.target !== this.viewportEl) return;
      const rect = this.surfaceEl.getBoundingClientRect();
      this.addTextCardAt({
        x: (event.clientX - rect.left - this.pan.x) / this.scale,
        y: (event.clientY - rect.top - this.pan.y) / this.scale,
      });
    });
    this.surfaceEl.addEventListener("pointerdown", (event) => {
      if (event.target !== this.surfaceEl && event.target !== this.viewportEl) return;
      this.surfaceEl.focus({ preventScroll: true });
      this.clearSelection();
      if (event.button !== 1 && !(event.button === 0 && this.spacePressed)) return;
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
    if (event.code === "Space") {
      this.spacePressed = true;
      event.preventDefault();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.selectedIds.clear();
      for (const node of this.document.nodes) this.selectedIds.add(node.id);
      this.updateSelectionClasses();
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && this.selectedIds.size > 0) {
      event.preventDefault();
      const removed = new Set(this.selectedIds);
      this.document.nodes = this.document.nodes.filter((node) => !removed.has(node.id));
      this.document.edges = this.document.edges.filter((edge) => !removed.has(edge.fromNode) && !removed.has(edge.toNode));
      this.selectedIds.clear();
      this.render();
      void this.persist();
    }
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
    const addText = document.createElement("button");
    addText.type = "button";
    addText.title = "Add text card";
    addText.setAttribute("aria-label", "Add text card");
    const icon = document.createElement("span");
    setIcon(icon, "file-plus");
    addText.appendChild(icon);
    addText.addEventListener("click", () => {
      this.addTextCardAt({
        x: (this.surfaceEl.clientWidth / 2 - this.pan.x) / this.scale,
        y: (this.surfaceEl.clientHeight / 2 - this.pan.y) / this.scale,
      });
    });
    toolbar.appendChild(addText);
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
    const left = Math.min(...this.document.nodes.map((node) => node.x));
    const top = Math.min(...this.document.nodes.map((node) => node.y));
    const right = Math.max(...this.document.nodes.map((node) => node.x + node.width));
    const bottom = Math.max(...this.document.nodes.map((node) => node.y + node.height));
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
