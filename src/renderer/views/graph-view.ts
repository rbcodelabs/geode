import type { App } from "../app";
import type { View } from "../workspace";
import { buildGraph, graphTopologyKey, type GraphData, type GraphNode } from "../graph/graph-data";
import { ForceSimulation } from "../graph/layout";
import {
  clampGraphScale,
  findNearestGraphTouchTarget,
  GraphTouchGesture,
} from "../graph/touch-gesture";

/** Safety cap so a graph that never fully settles doesn't spin the RAF loop forever. */
const MAX_SETTLE_TICKS = 600;
const BASE_RADIUS = 4;
const RADIUS_PER_DEGREE = 1.1;
const MAX_RADIUS = 16;
const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

/**
 * Global graph view (Compass roadmap item 2, v1 scope): one node per
 * markdown file, one edge per resolved link, canvas-rendered force layout,
 * pan/zoom/hover/click-to-open. Deliberately out of scope for v1 (see
 * plugin-api-layer/unlinked-mentions PRs for the same "documented
 * follow-up" pattern): local graph + depth, tag/attachment nodes, filters,
 * groups/coloring, link-direction arrows, and a persisted `graph.json`
 * config — all of Obsidian's graph *settings panel*, none of which this
 * view exposes yet.
 */
export class GraphView implements View {
  readonly viewType = "graph";
  containerEl: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private data: GraphData = { nodes: [], edges: [] };
  private topologyKey = "";
  private sim: ForceSimulation | null = null;
  private rafId: number | null = null;
  private tickCount = 0;
  private positionsPublished = false;
  private resizeObserver: ResizeObserver;
  private toolbarEl: HTMLElement;
  private searchPanelEl: HTMLElement | null = null;
  private selectedNode: GraphNode | null = null;
  private searchQuery = "";
  private linkedOnly = false;
  private groupByFolder = false;
  private localMode = false;
  private capturedTouchPointers = new Set<number>();
  private suppressClickUntil = 0;
  private touchGesture: GraphTouchGesture;
  private viewStateRaf: number | null = null;

  // Pan/zoom camera, in canvas pixels. World (0,0) renders at
  // (canvasWidth/2 + panX, canvasHeight/2 + panY) * scale.
  private panX = 0;
  private panY = 0;
  private scale = 1;
  private hoveredNode: GraphNode | null = null;
  private dragging = false;
  private dragMoved = false;
  private lastPointer = { x: 0, y: 0 };
  /** Disposers for the window-level listeners attached in `attachInteraction()`, run in `onClose()`. */
  private interactionCleanups: (() => void)[] = [];

  /**
   * Coalesce a burst of metadata `changed`/`resolved` events into a single
   * `rebuild()` (which reconstructs the graph and restarts the force sim).
   * A burst fires N synchronous `changed` events inside one microtask; the
   * boolean gate + queueMicrotask below collapses them to one rebuild on the
   * next microtask, mirroring base-view.ts's `scheduleRerender` pattern.
   */
  private rebuildScheduled = false;
  private closed = false;
  private readonly onDataChanged = () => this.scheduleRebuild();

  private scheduleRebuild(): void {
    if (this.rebuildScheduled) return;
    this.rebuildScheduled = true;
    queueMicrotask(() => {
      this.rebuildScheduled = false;
      // Skip if the view was closed between scheduling and this microtask —
      // rebuild() would otherwise start a RAF loop that onClose can't stop.
      if (!this.closed) this.rebuild();
    });
  }

  constructor(private app: App) {
    this.containerEl = document.createElement("div");
    this.containerEl.className = "graph-view";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "graph-view-canvas";
    this.canvas.setAttribute("aria-label", "Interactive graph");
    this.toolbarEl = this.buildToolbar();
    this.containerEl.append(this.canvas, this.toolbarEl);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;

    this.touchGesture = new GraphTouchGesture({
      hitTest: (x, y) => this.touchNodeAtCss(x, y)?.id ?? null,
      select: (id) => this.selectNode(id),
      open: (id) => this.openNode(id),
      pan: (dx, dy) => {
        this.panX += dx;
        this.panY += dy;
        this.scheduleViewStatePublish();
      },
      zoom: (factor, x, y) => this.zoomAt(factor, x, y),
    });

    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.attachInteraction();
    this.restoreViewState();
  }

  getDisplayText(): string {
    return "Graph view";
  }

  getIcon(): string {
    return "git-fork";
  }

  onOpen(): void {
    this.closed = false;
    this.app.metadataCache.on("changed", this.onDataChanged);
    this.app.metadataCache.on("resolved", this.onDataChanged);
    this.resizeObserver.observe(this.containerEl);
    this.resizeCanvas();
    this.rebuild();
  }

  onClose(): void {
    this.closed = true;
    this.app.metadataCache.off("changed", this.onDataChanged);
    this.app.metadataCache.off("resolved", this.onDataChanged);
    this.resizeObserver.disconnect();
    this.stopLoop();
    this.cancelTouchGesture();
    this.flushViewStatePublish();
    for (const cleanup of this.interactionCleanups.splice(0)) cleanup();
  }

  private rebuild(): void {
    const nextData = buildGraph(this.app.vault.getMarkdownFiles(), this.app.metadataCache.resolvedLinks);
    const nextTopologyKey = graphTopologyKey(nextData);
    // Metadata emits both per-file and all-resolved notifications. If link
    // topology did not change, restarting the simulation only invalidates
    // already-published click coordinates and wastes layout work.
    if (nextTopologyKey === this.topologyKey) return;
    this.data = nextData;
    this.topologyKey = nextTopologyKey;
    this.sim = new ForceSimulation(this.data.nodes, this.data.edges);
    this.tickCount = 0;
    this.positionsPublished = false;
    if (this.selectedNode) {
      this.selectedNode = this.data.nodes.find((node) => node.id === this.selectedNode?.id) ?? null;
    }
    this.toolbarEl.querySelector<HTMLButtonElement>(".graph-open-selected")!.disabled = !this.selectedNode;
    // Test hook: canvas contents aren't DOM-inspectable, so expose the
    // built graph's shape as dataset attributes for Playwright to assert
    // against without pixel-reading the canvas (see plugin-api-layer PR's
    // e2e approach for the same "expose an inspectable seam" pattern).
    this.containerEl.dataset.graphNodeCount = String(this.data.nodes.length);
    this.containerEl.dataset.graphEdgeCount = String(this.data.edges.length);
    this.publishViewState();
    // Do not publish coordinates while the force layout is still moving.
    // Consumers that click a published coordinate must be able to rely on it
    // remaining current between reading the dataset and dispatching the click.
    delete this.containerEl.dataset.graphNodePositions;
    this.startLoop();
  }

  private startLoop(): void {
    if (this.rafId !== null) return;
    const step = () => {
      const sim = this.sim;
      // Every node starts at rest (vx/vy = 0), so isSettled() is trivially
      // true before tick() has ever run once — always run at least the
      // first tick, then stop once the simulation has actually settled.
      if (sim && this.tickCount < MAX_SETTLE_TICKS && (this.tickCount === 0 || !sim.isSettled())) {
        sim.tick();
        this.tickCount++;
      }
      if (
        sim &&
        !this.positionsPublished &&
        this.tickCount > 0 &&
        (sim.isSettled() || this.tickCount >= MAX_SETTLE_TICKS)
      ) {
        this.updateNodePositionsDataset();
        this.positionsPublished = true;
      }
      this.render();
      this.rafId = requestAnimationFrame(step);
    };
    this.rafId = requestAnimationFrame(step);
  }

  private stopLoop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private updateNodePositionsDataset(): void {
    // JSON of { path: [x, y] } in world space, refreshed as the layout
    // settles — lets an e2e test compute a node's screen position (via the
    // same world-to-screen transform used by render()) to click it.
    const positions: Record<string, [number, number]> = {};
    for (const node of this.data.nodes) positions[node.id] = [node.x, node.y];
    this.containerEl.dataset.graphNodePositions = JSON.stringify(positions);
  }

  private resizeCanvas(): void {
    const rect = this.containerEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.render();
  }

  private worldToScreen(x: number, y: number): { x: number; y: number } {
    const dpr = window.devicePixelRatio || 1;
    const cx = this.canvas.width / 2 + this.panX * dpr;
    const cy = this.canvas.height / 2 + this.panY * dpr;
    return { x: cx + x * this.scale * dpr, y: cy + y * this.scale * dpr };
  }

  private screenToWorld(x: number, y: number): { x: number; y: number } {
    const dpr = window.devicePixelRatio || 1;
    const cx = this.canvas.width / 2 + this.panX * dpr;
    const cy = this.canvas.height / 2 + this.panY * dpr;
    return { x: (x - cx) / (this.scale * dpr), y: (y - cy) / (this.scale * dpr) };
  }

  private nodeRadius(node: GraphNode): number {
    return Math.min(BASE_RADIUS + node.degree * RADIUS_PER_DEGREE, MAX_RADIUS);
  }

  private render(): void {
    const { ctx, canvas } = this;
    // Reuse the app's existing theme variables (dark/light both already
    // define these) instead of introducing a parallel --graph-* palette.
    const styles = getComputedStyle(this.containerEl);
    const edgeColor = styles.getPropertyValue("--background-modifier-border").trim() || "#3a3a3a";
    const nodeColor = styles.getPropertyValue("--interactive-accent").trim() || "#7c5cd6";
    const nodeHoverColor = styles.getPropertyValue("--interactive-accent-hover").trim() || "#8a6ce0";
    const labelColor = styles.getPropertyValue("--text-normal").trim() || "#dadada";

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = edgeColor;
    ctx.lineWidth = Math.max(1, window.devicePixelRatio || 1);
    const byId = new Map(this.data.nodes.map((n) => [n.id, n]));
    const visible = new Set(this.visibleNodes().map((node) => node.id));
    for (const edge of this.data.edges) {
      if (!visible.has(edge.source) || !visible.has(edge.target)) continue;
      const a = byId.get(edge.source);
      const b = byId.get(edge.target);
      if (!a || !b) continue;
      const pa = this.worldToScreen(a.x, a.y);
      const pb = this.worldToScreen(b.x, b.y);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    const dpr = window.devicePixelRatio || 1;
    for (const node of this.visibleNodes()) {
      const p = this.worldToScreen(node.x, node.y);
      const r = this.nodeRadius(node) * this.scale * dpr;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = node === this.hoveredNode || node === this.selectedNode
        ? nodeHoverColor
        : this.groupByFolder && node.id.includes("/") ? "#5b9bd5" : nodeColor;
      ctx.fill();
      if (node === this.hoveredNode || node === this.selectedNode) {
        ctx.font = `${12 * dpr}px sans-serif`;
        ctx.fillStyle = labelColor;
        ctx.textBaseline = "middle";
        ctx.fillText(node.label, p.x + r + 4 * dpr, p.y);
      }
    }
  }

  private nodeAt(screenX: number, screenY: number): GraphNode | null {
    const nodes = this.visibleNodes();
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const p = this.worldToScreen(node.x, node.y);
      const dpr = window.devicePixelRatio || 1;
      const r = this.nodeRadius(node) * this.scale * dpr + 3 * dpr;
      const dx = screenX - p.x;
      const dy = screenY - p.y;
      if (dx * dx + dy * dy <= r * r) return node;
    }
    return null;
  }

  private touchNodeAtCss(x: number, y: number): GraphNode | null {
    const dpr = window.devicePixelRatio || 1;
    return findNearestGraphTouchTarget(
      this.visibleNodes().map((node) => {
        const screen = this.worldToScreen(node.x, node.y);
        return {
          ...node,
          x: screen.x / dpr,
          y: screen.y / dpr,
          visualRadius: this.nodeRadius(node) * this.scale,
        };
      }),
      x,
      y
    );
  }

  private visibleNodes(): GraphNode[] {
    let nodes = this.data.nodes;
    if (this.searchQuery) {
      const query = this.searchQuery.toLowerCase();
      nodes = nodes.filter((node) => node.label.toLowerCase().includes(query) || node.id.toLowerCase().includes(query));
    }
    if (this.linkedOnly) nodes = nodes.filter((node) => node.degree > 0);
    if (this.localMode && this.selectedNode) {
      const local = new Set([this.selectedNode.id]);
      for (const edge of this.data.edges) {
        if (edge.source === this.selectedNode.id) local.add(edge.target);
        if (edge.target === this.selectedNode.id) local.add(edge.source);
      }
      nodes = nodes.filter((node) => local.has(node.id));
    }
    return nodes;
  }

  private buildToolbar(): HTMLElement {
    const toolbar = document.createElement("div");
    toolbar.className = "graph-touch-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Graph controls");
    const button = (label: string, action: (element: HTMLButtonElement) => void) => {
      const element = document.createElement("button");
      element.type = "button";
      element.textContent = label;
      element.setAttribute("aria-label", label);
      element.addEventListener("click", () => action(element));
      toolbar.appendChild(element);
      return element;
    };
    const open = button("Open selected note", () => {
      if (this.selectedNode) this.openNode(this.selectedNode.id);
    });
    open.disabled = true;
    open.className = "graph-open-selected";
    button("Search graph", (opener) => this.toggleSearch(opener));
    button("Filter linked nodes", (element) => {
      this.linkedOnly = !this.linkedOnly;
      element.setAttribute("aria-pressed", String(this.linkedOnly));
      this.publishViewState();
    }).setAttribute("aria-pressed", "false");
    button("Group by folder", (element) => {
      this.groupByFolder = !this.groupByFolder;
      element.setAttribute("aria-pressed", String(this.groupByFolder));
      this.publishViewState();
    }).setAttribute("aria-pressed", "false");
    button("Show local graph", (element) => {
      this.localMode = !this.localMode;
      element.textContent = this.localMode ? "Show global graph" : "Show local graph";
      element.setAttribute("aria-label", element.textContent);
      element.setAttribute("aria-pressed", String(this.localMode));
      this.publishViewState();
    }).setAttribute("aria-pressed", "false");
    button("Relayout graph", () => this.relayout());
    button("Fit graph", () => this.fitGraph());
    return toolbar;
  }

  private toggleSearch(opener: HTMLButtonElement): void {
    if (this.searchPanelEl) {
      this.closeSearch(opener);
      return;
    }
    const panel = document.createElement("div");
    panel.className = "graph-search-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Search graph nodes");
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Search graph nodes";
    input.setAttribute("aria-label", "Search graph nodes");
    input.value = this.searchQuery;
    input.addEventListener("input", () => {
      this.searchQuery = input.value.trim();
      this.publishViewState();
    });
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "Close search";
    close.addEventListener("click", () => this.closeSearch(opener));
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.closeSearch(opener);
      }
    });
    panel.append(input, close);
    this.containerEl.appendChild(panel);
    this.searchPanelEl = panel;
    input.focus();
  }

  private closeSearch(opener: HTMLButtonElement): void {
    this.searchPanelEl?.remove();
    this.searchPanelEl = null;
    opener.focus();
  }

  private selectNode(id: string): void {
    this.selectedNode = this.data.nodes.find((node) => node.id === id) ?? null;
    this.toolbarEl.querySelector<HTMLButtonElement>(".graph-open-selected")!.disabled = !this.selectedNode;
    this.publishViewState();
  }

  private openNode(id: string): void {
    const file = this.app.vault.getFileByPath(id);
    if (file) void this.app.openFile(file, true);
  }

  private zoomAt(factor: number, x: number, y: number): void {
    const dpr = window.devicePixelRatio || 1;
    const world = this.screenToWorld(x * dpr, y * dpr);
    this.scale = clampGraphScale(this.scale * factor, MIN_SCALE, MAX_SCALE);
    const rect = this.canvas.getBoundingClientRect();
    this.panX = x - rect.width / 2 - world.x * this.scale;
    this.panY = y - rect.height / 2 - world.y * this.scale;
    this.scheduleViewStatePublish();
  }

  private relayout(): void {
    this.sim = new ForceSimulation(this.data.nodes, this.data.edges);
    this.tickCount = 0;
    this.positionsPublished = false;
    delete this.containerEl.dataset.graphNodePositions;
    this.publishViewState();
  }

  private fitGraph(): void {
    const nodes = this.visibleNodes();
    if (nodes.length === 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const minX = Math.min(...nodes.map((node) => node.x));
    const maxX = Math.max(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxY = Math.max(...nodes.map((node) => node.y));
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE,
      Math.min((rect.width - 48) / Math.max(1, maxX - minX), (rect.height - 96) / Math.max(1, maxY - minY))));
    this.panX = -((minX + maxX) / 2) * this.scale;
    this.panY = -((minY + maxY) / 2) * this.scale;
    this.publishViewState();
  }

  private publishViewState(): void {
    this.containerEl.dataset.graphSelected = this.selectedNode?.id ?? "";
    this.containerEl.dataset.graphPanX = String(this.panX);
    this.containerEl.dataset.graphPanY = String(this.panY);
    this.containerEl.dataset.graphScale = String(this.scale);
    this.containerEl.dataset.graphVisibleCount = String(this.visibleNodes().length);
    this.containerEl.dataset.graphGrouped = String(this.groupByFolder);
    this.containerEl.dataset.graphMode = this.localMode ? "local" : "global";
    this.persistViewState();
  }

  private scheduleViewStatePublish(): void {
    if (this.viewStateRaf !== null) return;
    this.viewStateRaf = requestAnimationFrame(() => {
      this.viewStateRaf = null;
      this.publishViewState();
    });
  }

  private flushViewStatePublish(): void {
    if (this.viewStateRaf !== null) cancelAnimationFrame(this.viewStateRaf);
    this.viewStateRaf = null;
    this.publishViewState();
  }

  private stateKey(): string {
    return `geode:graph-view:${encodeURIComponent(this.app.vault.root)}`;
  }

  private persistViewState(): void {
    if (this.app.host.runtime.runtime === "electron") return;
    try {
      localStorage.setItem(this.stateKey(), JSON.stringify({
        panX: this.panX,
        panY: this.panY,
        scale: this.scale,
        selected: this.selectedNode?.id ?? null,
        searchQuery: this.searchQuery,
        linkedOnly: this.linkedOnly,
        groupByFolder: this.groupByFolder,
        localMode: this.localMode,
      }));
    } catch {
      // Device-local graph presentation state is disposable.
    }
  }

  private restoreViewState(): void {
    if (this.app.host.runtime.runtime === "electron") return;
    try {
      const state = JSON.parse(localStorage.getItem(this.stateKey()) ?? "null") as Record<string, unknown> | null;
      if (!state) return;
      if (typeof state.panX === "number") this.panX = state.panX;
      if (typeof state.panY === "number") this.panY = state.panY;
      if (typeof state.scale === "number") this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale));
      if (typeof state.searchQuery === "string") this.searchQuery = state.searchQuery;
      this.linkedOnly = state.linkedOnly === true;
      this.groupByFolder = state.groupByFolder === true;
      this.localMode = state.localMode === true;
      if (typeof state.selected === "string") {
        this.selectedNode = { id: state.selected } as GraphNode;
      }
      this.syncToolbarState();
    } catch {
      // Presentation state is disposable; corrupt state falls back to defaults.
    }
  }

  private syncToolbarState(): void {
    this.toolbarEl.querySelector<HTMLButtonElement>('[aria-label="Filter linked nodes"]')
      ?.setAttribute("aria-pressed", String(this.linkedOnly));
    this.toolbarEl.querySelector<HTMLButtonElement>('[aria-label="Group by folder"]')
      ?.setAttribute("aria-pressed", String(this.groupByFolder));
    const local = this.toolbarEl.querySelector<HTMLButtonElement>('[aria-label="Show local graph"], [aria-label="Show global graph"]');
    if (local) {
      local.textContent = this.localMode ? "Show global graph" : "Show local graph";
      local.setAttribute("aria-label", local.textContent);
      local.setAttribute("aria-pressed", String(this.localMode));
    }
  }

  private cancelTouchGesture(): void {
    this.touchGesture.cancel();
    for (const id of this.capturedTouchPointers) {
      if (this.canvas.hasPointerCapture?.(id)) this.canvas.releasePointerCapture(id);
    }
    this.capturedTouchPointers.clear();
    this.containerEl.dataset.graphCapturedPointers = "0";
    this.containerEl.dataset.graphGesture = "idle";
    this.flushViewStatePublish();
  }

  private attachInteraction(): void {
    const toCanvasPoint = (e: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      return { x: (e.clientX - rect.left) * dpr, y: (e.clientY - rect.top) * dpr };
    };
    const toCanvasCssPoint = (e: PointerEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    this.canvas.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch") return;
      event.preventDefault();
      this.suppressClickUntil = performance.now() + 750;
      const point = toCanvasCssPoint(event);
      this.touchGesture.down({ pointerId: event.pointerId, ...point, time: event.timeStamp });
      this.capturedTouchPointers.add(event.pointerId);
      this.containerEl.dataset.graphCapturedPointers = String(this.capturedTouchPointers.size);
      try {
        this.canvas.setPointerCapture(event.pointerId);
      } catch {
        // A detached/cancelled target is handled by the state-machine cancel path.
      }
      this.containerEl.dataset.graphGesture = "active";
    }, { passive: false });
    this.canvas.addEventListener("pointermove", (event) => {
      if (event.pointerType !== "touch" || !this.capturedTouchPointers.has(event.pointerId)) return;
      event.preventDefault();
      this.touchGesture.move({ pointerId: event.pointerId, ...toCanvasCssPoint(event), time: event.timeStamp });
    }, { passive: false });
    this.canvas.addEventListener("pointerup", (event) => {
      if (event.pointerType !== "touch") return;
      event.preventDefault();
      this.touchGesture.up({ pointerId: event.pointerId, ...toCanvasCssPoint(event), time: event.timeStamp });
      if (this.canvas.hasPointerCapture?.(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      this.capturedTouchPointers.delete(event.pointerId);
      this.containerEl.dataset.graphCapturedPointers = String(this.capturedTouchPointers.size);
      if (this.capturedTouchPointers.size === 0) {
        this.containerEl.dataset.graphGesture = "idle";
        this.flushViewStatePublish();
      }
    }, { passive: false });
    this.canvas.addEventListener("pointercancel", (event) => {
      if (event.pointerType === "touch") this.cancelTouchGesture();
    });
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") this.cancelTouchGesture();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    this.interactionCleanups.push(() => document.removeEventListener("visibilitychange", onVisibilityChange));

    this.canvas.addEventListener("mousedown", (e) => {
      this.dragging = true;
      this.dragMoved = false;
      this.lastPointer = { x: e.clientX, y: e.clientY };
    });

    // Attached to `window` (not the canvas) so a drag that leaves the
    // canvas mid-gesture still tracks correctly; removed in onClose() via
    // interactionCleanups so repeated open/close of this view doesn't leak
    // listeners onto detached canvases.
    const onWindowMouseMove = (e: MouseEvent) => {
      if (this.dragging) {
        const dx = e.clientX - this.lastPointer.x;
        const dy = e.clientY - this.lastPointer.y;
        if (dx !== 0 || dy !== 0) this.dragMoved = true;
        this.panX += dx;
        this.panY += dy;
        this.lastPointer = { x: e.clientX, y: e.clientY };
        return;
      }
      if (!this.canvas.isConnected) return;
      const rect = this.canvas.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        if (this.hoveredNode) {
          this.hoveredNode = null;
          this.canvas.style.cursor = "default";
        }
        return;
      }
      const p = toCanvasPoint(e);
      const hit = this.nodeAt(p.x, p.y);
      if (hit !== this.hoveredNode) {
        this.hoveredNode = hit;
        this.canvas.style.cursor = hit ? "pointer" : "default";
      }
    };
    const onWindowMouseUp = () => {
      this.dragging = false;
    };
    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
    this.interactionCleanups.push(
      () => window.removeEventListener("mousemove", onWindowMouseMove),
      () => window.removeEventListener("mouseup", onWindowMouseUp)
    );

    this.canvas.addEventListener("click", (e) => {
      if (performance.now() < this.suppressClickUntil) return;
      if (this.dragMoved) return; // was a pan, not a click
      const p = toCanvasPoint(e);
      const hit = this.nodeAt(p.x, p.y);
      if (hit) {
        const file = this.app.vault.getFileByPath(hit.id);
        if (file) this.app.openFile(file, e.metaKey || e.ctrlKey);
      }
    });

    this.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        this.zoomAt(Math.exp(-e.deltaY * 0.001), e.clientX - rect.left, e.clientY - rect.top);
      },
      { passive: false }
    );

    // Spec: Graph tab → right-click → Bookmark. This is intentionally
    // DEGENERATE: Geode has no persistable graph config yet (see this file's
    // header comment — graph.json is out of scope), so `addGraphBookmark`
    // stores a config-less `{ type: "graph" }` and opening it just re-opens the
    // global Graph view. Graph-config fidelity (filters, groups, zoom, …) is
    // deferred until a persistable graph config exists — do not fake one here.
    this.canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.app.showMenu(e, [
        {
          title: "Bookmark graph",
          icon: "git-fork",
          action: () => void this.app.addGraphBookmark(),
        },
      ]);
    });
  }
}
