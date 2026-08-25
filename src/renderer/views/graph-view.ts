import type { App } from "../app";
import type { View } from "../workspace";
import { buildGraph, graphTopologyKey, type GraphData, type GraphNode } from "../graph/graph-data";
import { ForceSimulation } from "../graph/layout";

/** Safety cap so a graph that never fully settles doesn't spin the RAF loop forever. */
const MAX_SETTLE_TICKS = 600;
const BASE_RADIUS = 4;
const RADIUS_PER_DEGREE = 1.1;
const MAX_RADIUS = 16;

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
    this.containerEl.appendChild(this.canvas);
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;

    this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
    this.attachInteraction();
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
    // Test hook: canvas contents aren't DOM-inspectable, so expose the
    // built graph's shape as dataset attributes for Playwright to assert
    // against without pixel-reading the canvas (see plugin-api-layer PR's
    // e2e approach for the same "expose an inspectable seam" pattern).
    this.containerEl.dataset.graphNodeCount = String(this.data.nodes.length);
    this.containerEl.dataset.graphEdgeCount = String(this.data.edges.length);
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
    for (const edge of this.data.edges) {
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
    for (const node of this.data.nodes) {
      const p = this.worldToScreen(node.x, node.y);
      const r = this.nodeRadius(node) * this.scale * dpr;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = node === this.hoveredNode ? nodeHoverColor : nodeColor;
      ctx.fill();
      if (node === this.hoveredNode) {
        ctx.font = `${12 * dpr}px sans-serif`;
        ctx.fillStyle = labelColor;
        ctx.textBaseline = "middle";
        ctx.fillText(node.label, p.x + r + 4 * dpr, p.y);
      }
    }
  }

  private nodeAt(screenX: number, screenY: number): GraphNode | null {
    for (let i = this.data.nodes.length - 1; i >= 0; i--) {
      const node = this.data.nodes[i];
      const p = this.worldToScreen(node.x, node.y);
      const dpr = window.devicePixelRatio || 1;
      const r = this.nodeRadius(node) * this.scale * dpr + 3 * dpr;
      const dx = screenX - p.x;
      const dy = screenY - p.y;
      if (dx * dx + dy * dy <= r * r) return node;
    }
    return null;
  }

  private attachInteraction(): void {
    const toCanvasPoint = (e: MouseEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      return { x: (e.clientX - rect.left) * dpr, y: (e.clientY - rect.top) * dpr };
    };

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
        const factor = Math.exp(-e.deltaY * 0.001);
        this.scale = Math.min(Math.max(this.scale * factor, 0.1), 8);
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
