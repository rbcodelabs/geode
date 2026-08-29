export interface CanvasTouchPoint { pointerId: number; x: number; y: number }

interface CanvasTouchCallbacks {
  hitTest(x: number, y: number): string | null;
  canDrag(id: string): boolean;
  select(id: string): void;
  beginNodeDrag(id: string): void;
  moveNode(id: string, dx: number, dy: number): void;
  commitNode(id: string): void;
  rollbackNode(id: string): void;
  pan(dx: number, dy: number): void;
  zoom(factor: number, centroidX: number, centroidY: number): void;
}

interface Tracked extends CanvasTouchPoint { startX: number; startY: number; hit: string | null }
const DRAG_THRESHOLD = 8;

export class CanvasTouchGesture {
  private readonly pointers = new Map<number, Tracked>();
  private draggingNode: string | null = null;
  private pinching = false;
  private suppressUntilClear = false;
  private pinchDistance = 0;
  private pinchCentroid = { x: 0, y: 0 };

  constructor(private readonly callbacks: CanvasTouchCallbacks) {}

  pointerIds(): number[] { return [...this.pointers.keys()]; }

  down(point: CanvasTouchPoint): void {
    this.pointers.set(point.pointerId, { ...point, startX: point.x, startY: point.y, hit: this.callbacks.hitTest(point.x, point.y) });
    if (this.pointers.size === 2) {
      if (this.draggingNode) this.callbacks.rollbackNode(this.draggingNode);
      this.draggingNode = null;
      this.pinching = true;
      this.suppressUntilClear = true;
      this.capturePinch();
    } else if (this.pointers.size > 2) {
      this.suppressUntilClear = true;
    }
  }

  move(point: CanvasTouchPoint): void {
    const tracked = this.pointers.get(point.pointerId);
    if (!tracked) return;
    tracked.x = point.x;
    tracked.y = point.y;
    if (this.pinching && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const centroid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      this.callbacks.pan(centroid.x - this.pinchCentroid.x, centroid.y - this.pinchCentroid.y);
      if (this.pinchDistance > 0 && distance > 0) this.callbacks.zoom(distance / this.pinchDistance, centroid.x, centroid.y);
      this.pinchCentroid = centroid;
      this.pinchDistance = distance;
      return;
    }
    if (this.pointers.size !== 1 || !tracked.hit || this.suppressUntilClear) return;
    const dx = point.x - tracked.startX;
    const dy = point.y - tracked.startY;
    if (!this.draggingNode && Math.hypot(dx, dy) >= DRAG_THRESHOLD && this.callbacks.canDrag(tracked.hit)) {
      this.draggingNode = tracked.hit;
      this.callbacks.beginNodeDrag(tracked.hit);
    }
    if (this.draggingNode) this.callbacks.moveNode(this.draggingNode, dx, dy);
  }

  up(point: CanvasTouchPoint): void {
    const tracked = this.pointers.get(point.pointerId);
    if (!tracked) return;
    this.pointers.delete(point.pointerId);
    if (this.pinching || this.suppressUntilClear) {
      if (this.pointers.size === 0) {
        this.pinching = false;
        this.suppressUntilClear = false;
      }
      return;
    }
    if (this.draggingNode) {
      this.callbacks.commitNode(this.draggingNode);
      this.draggingNode = null;
    } else if (tracked.hit) {
      this.callbacks.select(tracked.hit);
    }
  }

  cancel(): void { this.settle(false); }
  finish(): void { this.settle(true); }

  private settle(commit: boolean): void {
    if (this.draggingNode) {
      if (commit) this.callbacks.commitNode(this.draggingNode);
      else this.callbacks.rollbackNode(this.draggingNode);
    }
    this.draggingNode = null;
    this.pointers.clear();
    this.pinching = false;
    this.suppressUntilClear = false;
  }

  private capturePinch(): void {
    const [a, b] = [...this.pointers.values()];
    this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    this.pinchCentroid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
}
