/**
 * Renderer-side operation-boundary instrumentation.
 *
 * Wraps `performance.mark`/`performance.measure` to time core Geode
 * operations (tab switch, leaf create/detach, view mount). A
 * `PerformanceObserver` watches for `measure` entries under the `geode:`
 * prefix and captures each one into a capped in-memory ring buffer, which
 * the Settings -> Performance tab (`settings/performance-tab.ts`) reads for
 * display.
 *
 * The ring-buffer shape -- push, then shift the oldest entry once over
 * capacity -- mirrors the pattern used by the sibling Claude Threads
 * plugin's perf sampler (`~/projects/obsidian-claude-threads/src/telemetry.ts`,
 * its `perfRing` around lines 73-75 / 249-250). Reimplemented locally here
 * rather than imported across repos -- Geode owns its own instrumentation.
 */

const MARK_PREFIX = "geode:";
/** Ring buffer capacity. Within the 200-360 range used by the sibling telemetry sampler. */
const RING_CAPACITY = 300;

export interface PerfMeasure {
  op: string;
  durationMs: number;
  ts: number;
}

const ring: PerfMeasure[] = [];

function pushMeasure(op: string, durationMs: number): void {
  ring.push({ op, durationMs, ts: Date.now() });
  while (ring.length > RING_CAPACITY) ring.shift();
}

/** Record a duration measured outside the renderer (for example by the metadata utility process). */
export function recordMeasure(op: string, durationMs: number): void {
  if (Number.isFinite(durationMs) && durationMs >= 0) pushMeasure(op, durationMs);
}

let observer: PerformanceObserver | null = null;

/**
 * Lazily create the module-level `PerformanceObserver` singleton. Guarded
 * for environments without a `PerformanceObserver` global (older/limited
 * runtimes) or that reject the `measure` entry type -- instrumentation
 * degrades to a no-op rather than crashing the caller.
 */
function ensureObserver(): void {
  if (observer) return;
  const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  if (!PO) return;
  const instance = new PO((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.name.startsWith(MARK_PREFIX)) continue;
      pushMeasure(entry.name.slice(MARK_PREFIX.length), entry.duration);
    }
  });
  try {
    instance.observe({ entryTypes: ["measure"] });
    observer = instance;
  } catch {
    // entryTypes unsupported in this environment; leave observer unset.
  }
}

ensureObserver();

function markName(op: string, suffix: "start" | "end"): string {
  return `${MARK_PREFIX}${op}-${suffix}`;
}

/** Start timing operation `op`. Pair with a later `markEnd(op)` call. */
export function markStart(op: string): void {
  performance.mark(markName(op, "start"));
}

/**
 * Finish timing `op` started by `markStart`, recording a `geode:<op>`
 * `measure` entry (captured into the ring buffer by the `PerformanceObserver`
 * above). Safe to call even if the matching `markStart` never happened --
 * instrumentation must never be the thing that crashes a caller.
 */
export function markEnd(op: string): void {
  const start = markName(op, "start");
  const end = markName(op, "end");
  const measureName = `${MARK_PREFIX}${op}`;
  performance.mark(end);
  try {
    performance.measure(measureName, start, end);
  } catch {
    // No matching start mark (or it was already cleared) -- skip silently.
  } finally {
    performance.clearMarks(start);
    performance.clearMarks(end);
    performance.clearMeasures(measureName);
  }
}

/** Recent recorded measures, oldest first (same order as the ring buffer). */
export function getRecentMeasures(): PerfMeasure[] {
  return [...ring];
}

/** Clear all recorded measures (used by tests and available for a future "clear" UI action). */
export function clearMeasures(): void {
  ring.length = 0;
}

/**
 * Wrap a sync or async call site with `markStart`/`markEnd`. Records the
 * measure even if `fn` throws synchronously or the promise it returns
 * rejects -- the thrown error/rejection is always rethrown unchanged.
 */
export function withPerfMark<T>(op: string, fn: () => T): T {
  markStart(op);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    markEnd(op);
    throw err;
  }
  if (result instanceof Promise) {
    return result.then(
      (value) => {
        markEnd(op);
        return value;
      },
      (err) => {
        markEnd(op);
        throw err;
      }
    ) as unknown as T;
  }
  markEnd(op);
  return result;
}
