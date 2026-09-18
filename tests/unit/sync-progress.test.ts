import { expect, it, vi } from "vitest";
import { SyncService } from "../../src/renderer/sync/sync-service";
import {
  SYNC_PROGRESS_THROTTLE_MS,
  SYNC_STALL_THRESHOLD_MS,
  SYNC_STALL_WORST_HONEST_LEG_MS,
  describeSyncProgress,
  formatSyncDuration,
  formatSyncProgressCounts,
  isSyncStalled,
  syncProgressPercent,
  syncStalledFor,
} from "../../src/renderer/sync/progress";
import type { SyncProgress, SyncStatus, SyncStatusProgress } from "../../src/renderer/sync/types";

/** A service with no host, selected so getStatus() reads the append-only status field. */
function service() {
  const instance = new SyncService({} as never, () => "/synthetic/vault");
  (instance as unknown as { selected: unknown }).selected = { id: "history" };
  const seen: SyncStatus[] = [];
  instance.on("status", status => seen.push(status));
  const internals = instance as unknown as {
    publishProgress: (progress: SyncProgress) => void;
    endProgress: () => void;
    setStatus: (status: SyncStatus) => void;
    summarize: (preview: unknown) => unknown;
  };
  return {
    instance,
    seen,
    publishProgress: internals.publishProgress.bind(internals),
    endProgress: internals.endProgress.bind(internals),
    setStatus: internals.setStatus.bind(internals),
    summarize: internals.summarize.bind(internals),
    progressEvents: () => seen.filter(status => status.progress),
  };
}

const preview = { signature: "s", requiresApproval: false, uploads: 0, downloads: 0, deletions: 0, conflicts: [], blocked: [], excluded: [], pending: 0, upToDate: true };

it("caps a 17,251-operation batch at roughly four status events per second and still delivers the terminal count", () => {
  vi.useFakeTimers();
  try {
    const s = service();
    const total = 17251;
    // One operation per millisecond, i.e. the whole batch inside ~17 seconds of
    // simulated work. Unthrottled that is 17,251 status events, each of which
    // re-scans every open leaf for conflict banners.
    for (let index = 0; index < total; index++) {
      s.publishProgress({ phase: "transferring", completed: index, total, currentPath: `note-${index}.md` });
      vi.advanceTimersByTime(1);
    }
    s.publishProgress({ phase: "finalizing", completed: total, total });
    const events = s.progressEvents();
    expect(events.length).toBeLessThan(total / 50);
    // ~17.25s of work at 4/sec is ~70 events; assert the order of magnitude
    // rather than an exact count so the test pins the policy, not the scheduler.
    expect(events.length).toBeLessThanOrEqual(Math.ceil(total / SYNC_PROGRESS_THROTTLE_MS) + 5);
    expect(events.length).toBeGreaterThan(10);
    // The regression this exists for: the last update being swallowed and the
    // panel finishing frozen short of 100%.
    expect(events.at(-1)!.progress).toMatchObject({ phase: "finalizing", completed: total, total });
    expect(s.instance.getStatus().progress).toMatchObject({ completed: total, total });
  } finally {
    vi.useRealTimers();
  }
});

it("emits every phase transition immediately regardless of the throttle", () => {
  vi.useFakeTimers();
  try {
    const s = service();
    for (const phase of ["scanning", "planning", "staging", "transferring", "finalizing"] as const) {
      s.publishProgress({ phase, completed: 0, total: 0 });
      vi.advanceTimersByTime(1);
    }
    expect(s.progressEvents().map(status => status.progress!.phase)).toEqual(["scanning", "planning", "staging", "transferring", "finalizing"]);
  } finally {
    vi.useRealTimers();
  }
});

it("delivers a held-back tick from the trailing timer instead of dropping it", () => {
  vi.useFakeTimers();
  try {
    const s = service();
    s.publishProgress({ phase: "transferring", completed: 1, total: 10, currentPath: "a.md" });
    expect(s.progressEvents()).toHaveLength(1);
    vi.advanceTimersByTime(10);
    s.publishProgress({ phase: "transferring", completed: 2, total: 10, currentPath: "b.md" });
    // Inside the throttle window, so nothing is emitted yet — but it must not be lost.
    expect(s.progressEvents()).toHaveLength(1);
    vi.advanceTimersByTime(SYNC_PROGRESS_THROTTLE_MS);
    expect(s.progressEvents()).toHaveLength(2);
    expect(s.progressEvents().at(-1)!.progress).toMatchObject({ completed: 2, currentPath: "b.md" });
  } finally {
    vi.useRealTimers();
  }
});

it("stamps startedAt once per run and moves lastProgressAt with each emitted tick", () => {
  vi.useFakeTimers();
  try {
    const s = service();
    s.publishProgress({ phase: "scanning", completed: 0, total: 0 });
    const first = s.progressEvents().at(-1)!.progress!;
    vi.advanceTimersByTime(4000);
    s.publishProgress({ phase: "transferring", completed: 1, total: 2, currentPath: "a.md" });
    const second = s.progressEvents().at(-1)!.progress!;
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.lastProgressAt - first.lastProgressAt).toBe(4000);
  } finally {
    vi.useRealTimers();
  }
});

for (const [label, end] of [
  ["completion", (s: ReturnType<typeof service>) => s.summarize(preview)],
  ["error", (s: ReturnType<typeof service>) => s.setStatus({ state: "error", conflicts: 0, message: "boom" })],
  ["cancellation", (s: ReturnType<typeof service>) => s.endProgress()],
] as const) {
  it(`clears progress on ${label} and never lets a held-back tick land afterwards`, () => {
    vi.useFakeTimers();
    try {
      const s = service();
      s.publishProgress({ phase: "transferring", completed: 47, total: 100, currentPath: "a.md" });
      expect(s.instance.getStatus().progress).toBeDefined();
      vi.advanceTimersByTime(10);
      // Queued behind the throttle at the moment the run ends: the tick that
      // would otherwise repaint a stale percentage over a finished run.
      s.publishProgress({ phase: "transferring", completed: 48, total: 100, currentPath: "b.md" });
      end(s);
      expect(s.instance.getStatus().progress).toBeUndefined();
      const after = s.seen.length;
      vi.advanceTimersByTime(SYNC_PROGRESS_THROTTLE_MS * 10);
      expect(s.seen.length).toBe(after);
      expect(s.instance.getStatus().progress).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
}

it("raises a stall only after the threshold and never during steady slow progress", () => {
  const start = 1_000_000;
  const base: SyncStatusProgress = { phase: "transferring", completed: 1, total: 2, currentPath: "--clip", startedAt: start, lastProgressAt: start };
  expect(isSyncStalled(base, start + SYNC_STALL_THRESHOLD_MS - 1)).toBe(false);
  expect(isSyncStalled(base, start + SYNC_STALL_THRESHOLD_MS)).toBe(true);
  expect(syncStalledFor(base, start + 60_000)).toBe(60_000);
  expect(syncStalledFor(undefined, start)).toBe(0);

  // A genuinely slow transfer: one tick every four minutes for an hour. Checked
  // both at each tick and just before the next one, this must never be called a
  // stall — accusing a slow link is what makes a warning get ignored.
  let now = start;
  let last = start;
  for (let tick = 0; tick < 15; tick++) {
    now += 4 * 60_000 - 1;
    expect(isSyncStalled({ ...base, lastProgressAt: last }, now)).toBe(false);
    now += 1;
    last = now;
    expect(isSyncStalled({ ...base, lastProgressAt: last }, now)).toBe(false);
  }

  // The threshold's stated floor: one network leg carrying a file at the 100 MiB
  // cap on a pessimistic link. If the cap grows, this fails and re-opens the choice.
  expect(SYNC_STALL_THRESHOLD_MS).toBeGreaterThan(SYNC_STALL_WORST_HONEST_LEG_MS);
});

it("names the stuck file and how long it has been stuck", () => {
  const view = describeSyncProgress({ phase: "transferring", completed: 1234, total: 17251, currentPath: "--clip", startedAt: 0, lastProgressAt: 0 }, 42 * 60_000);
  expect(view.stalled).toBe(true);
  expect(view.stallMessage).toContain("No progress for 42m");
  expect(view.stallMessage).toContain("--clip");
  expect(view.stallMessage).toContain("has not been cancelled");
  expect(view.counts).toBe("1,234 / 17,251 (7%)");
  expect(view.percent).toBe(7);
  expect(view.elapsed).toBe("42m");
  expect(view.phaseLabel).toBe("Transferring");
  expect(view.announcement).toContain("stalled");
});

it("reports an uncountable phase as indeterminate rather than a misleading zero percent", () => {
  const view = describeSyncProgress({ phase: "scanning", completed: 0, total: 0, startedAt: 0, lastProgressAt: 0 }, 5_000);
  expect(view.percent).toBeNull();
  expect(view.counts).toBe("");
  expect(view.stalled).toBe(false);
  expect(view.phaseLabel).toBe("Scanning remote history");
  expect(view.announcement).toBe("Scanning remote history.");
  expect(syncProgressPercent({ completed: 5, total: 0 })).toBeNull();
});

it("announces coarsely so a screen reader is not given four updates a second", () => {
  const at = (completed: number) => describeSyncProgress({ phase: "transferring", completed, total: 1000, currentPath: `n${completed}.md`, startedAt: 0, lastProgressAt: 0 }, 1_000).announcement;
  // Same decile, different counters and different files: one announcement.
  expect(at(301)).toBe(at(399));
  expect(at(301)).not.toBe(at(401));
  expect(at(301)).toContain("30%");
});

it("formats durations with at most two units so the text does not jitter", () => {
  expect(formatSyncDuration(0)).toBe("0s");
  expect(formatSyncDuration(18_000)).toBe("18s");
  expect(formatSyncDuration(42 * 60_000)).toBe("42m");
  expect(formatSyncDuration(3 * 60_000 + 12_000)).toBe("3m 12s");
  expect(formatSyncDuration(63 * 60_000)).toBe("1h 3m");
  expect(formatSyncDuration(3 * 3_600_000)).toBe("3h");
  expect(formatSyncDuration(-5)).toBe("0s");
  expect(formatSyncProgressCounts({ completed: 0, total: 3 })).toBe("0 / 3 (0%)");
});
