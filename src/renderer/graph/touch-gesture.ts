export interface GraphTouchPoint {
  pointerId: number;
  x: number;
  y: number;
  time: number;
}

interface TouchCallbacks {
  hitTest(x: number, y: number): string | null;
  select(id: string): void;
  open(id: string): void;
  pan(dx: number, dy: number): void;
  zoom(factor: number, centroidX: number, centroidY: number): void;
}

interface TrackedPoint extends GraphTouchPoint {
  startX: number;
  startY: number;
  hit: string | null;
}

const TAP_SLOP = 8;
const SECOND_TAP_MS = 500;
export const MIN_GRAPH_TOUCH_RADIUS = 22;

export interface GraphTouchTarget {
  id: string;
  x: number;
  y: number;
  visualRadius: number;
}

/**
 * Resolve a touch target in CSS pixels. Enlarged hit regions may overlap at
 * low zoom, so distance wins and stable identity breaks exact ties.
 */
export function findNearestGraphTouchTarget<T extends GraphTouchTarget>(
  targets: readonly T[],
  x: number,
  y: number,
  minimumRadius = MIN_GRAPH_TOUCH_RADIUS
): T | null {
  let nearest: { target: T; distanceSquared: number } | null = null;
  for (const target of targets) {
    const dx = x - target.x;
    const dy = y - target.y;
    const distanceSquared = dx * dx + dy * dy;
    const radius = Math.max(minimumRadius, target.visualRadius);
    if (distanceSquared > radius * radius) continue;
    if (
      !nearest ||
      distanceSquared < nearest.distanceSquared ||
      (distanceSquared === nearest.distanceSquared && target.id.localeCompare(nearest.target.id) < 0)
    ) {
      nearest = { target, distanceSquared };
    }
  }
  return nearest?.target ?? null;
}

export function clampGraphScale(scale: number, min = 0.1, max = 8): number {
  return Math.min(max, Math.max(min, scale));
}

export class GraphTouchGesture {
  private pointers = new Map<number, TrackedPoint>();
  private pinching = false;
  private suppressUntilClear = false;
  private pinchDistance = 0;
  private pinchCentroid = { x: 0, y: 0 };
  private lastTap: { id: string; time: number } | null = null;

  constructor(private readonly callbacks: TouchCallbacks) {}

  pointerIds(): number[] {
    return [...this.pointers.keys()];
  }

  down(point: GraphTouchPoint): void {
    this.pointers.set(point.pointerId, {
      ...point,
      startX: point.x,
      startY: point.y,
      hit: this.callbacks.hitTest(point.x, point.y),
    });
    if (this.pointers.size === 2) {
      this.lastTap = null;
      this.pinching = true;
      this.suppressUntilClear = true;
      this.capturePinchBaseline();
    } else if (this.pointers.size > 2) {
      this.suppressUntilClear = true;
    }
  }

  move(point: GraphTouchPoint): void {
    const tracked = this.pointers.get(point.pointerId);
    if (!tracked) return;
    const previous = { x: tracked.x, y: tracked.y };
    tracked.x = point.x;
    tracked.y = point.y;
    tracked.time = point.time;
    if (Math.hypot(point.x - tracked.startX, point.y - tracked.startY) > TAP_SLOP) {
      this.lastTap = null;
    }
    if (this.pinching && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const centroid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      this.callbacks.pan(centroid.x - this.pinchCentroid.x, centroid.y - this.pinchCentroid.y);
      if (this.pinchDistance > 0 && distance > 0) {
        this.callbacks.zoom(distance / this.pinchDistance, centroid.x, centroid.y);
      }
      this.pinchCentroid = centroid;
      this.pinchDistance = distance;
      return;
    }
    if (this.pointers.size === 1 && !tracked.hit && !this.suppressUntilClear) {
      this.callbacks.pan(point.x - previous.x, point.y - previous.y);
    }
  }

  up(point: GraphTouchPoint): void {
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
    const moved = Math.hypot(point.x - tracked.startX, point.y - tracked.startY) > TAP_SLOP;
    if (!moved && tracked.hit) {
      if (this.lastTap?.id === tracked.hit && point.time - this.lastTap.time <= SECOND_TAP_MS) {
        this.callbacks.open(tracked.hit);
        this.lastTap = null;
      } else {
        this.callbacks.select(tracked.hit);
        this.lastTap = { id: tracked.hit, time: point.time };
      }
    } else {
      this.lastTap = null;
    }
  }

  cancel(): void {
    this.pointers.clear();
    this.pinching = false;
    this.suppressUntilClear = false;
    this.lastTap = null;
  }

  private capturePinchBaseline(): void {
    const [a, b] = [...this.pointers.values()];
    this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    this.pinchCentroid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
}
