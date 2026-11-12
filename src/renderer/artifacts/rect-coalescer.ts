/**
 * Coalesces a stream of rect reports from the guest (up to one per animation frame, driven by the page) into at most
 * one embedder update per frame: only the latest value is applied, and a value that rounds to the one already applied
 * is skipped, so a page animating the selected element cannot make Geode do a layout per message (review A3).
 * The last value is never lost: a push after a frame schedules the next one.
 */
export interface RectBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface RectCoalescer<T extends RectBox> {
  push(value: T): void;
  /** Forget the last applied value (a new selection must apply even an identical rect). */
  reset(): void;
  dispose(): void;
}

export function createRectCoalescer<T extends RectBox>(options: {
  schedule(callback: () => void): number;
  cancel(handle: number): void;
  apply(value: T): void;
}): RectCoalescer<T> {
  let latest: T | null = null;
  let handle: number | null = null;
  let lastKey = "";
  let disposed = false;
  const key = (v: RectBox) => `${Math.round(v.x)}|${Math.round(v.y)}|${Math.round(v.width)}|${Math.round(v.height)}`;
  const flush = (): void => {
    handle = null;
    const value = latest;
    latest = null;
    if (disposed || value === null) return;
    const k = key(value);
    if (k === lastKey) return;
    lastKey = k;
    options.apply(value);
  };
  return {
    push(value) {
      if (disposed) return;
      latest = value;
      if (handle === null) handle = options.schedule(flush);
    },
    reset() { lastKey = ""; },
    dispose() {
      disposed = true;
      latest = null;
      if (handle !== null) { options.cancel(handle); handle = null; }
    },
  };
}
