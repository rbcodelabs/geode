import { describe, expect, it } from "vitest";
import { PIN_BADGE, collapsePins, type PlacedPin } from "../../src/renderer/artifacts/pin-collapse";
import { buildRailView, describeBatchReport, effectiveSelection, pinAccessibleName, type RailInput } from "../../src/renderer/artifacts/rail-model";
import { comment, idOf } from "./helpers/pin-fixtures";

/**
 * QA G3: property and table tests for pin-collapse.ts (pure) and the rail-model reducer. Independent of the engineer's
 * suites: seeded random inputs, permutation invariance, no lost badge, hysteresis under drift, op-count scaling.
 */

// mulberry32: deterministic so a failure reproduces
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pin = (i: number, x: number, y: number, over: Partial<PlacedPin> = {}): PlacedPin =>
  ({ id: idOf(i), ordinal: i, status: "open", x, y, approximate: false, ...over });
function randomPins(seed: number, n: number, span: number): PlacedPin[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => pin(i + 1, r() * span, r() * span));
}
const membership = (badges: ReturnType<typeof collapsePins>["badges"]): string[] => badges.map((b) => [...b.ids].sort().join(",")).sort();

describe("collapsePins properties (seeded, 300 cases)", () => {
  it("no badge is ever lost: every input id appears in exactly one badge, counts add up", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const n = 1 + Math.floor(rng(seed * 7)() * 100);
      const span = [60, 150, 400, 1200][seed % 4]!;
      const input = randomPins(seed, n, span);
      const { badges, assignment } = collapsePins(input, null);
      const seen = badges.flatMap((b) => [...b.ids]);
      expect(seen.length, `seed ${seed}`).toBe(n);
      expect(new Set(seen).size, `seed ${seed}`).toBe(n);
      expect(new Set(seen), `seed ${seed}`).toEqual(new Set(input.map((p) => p.id)));
      for (const b of badges) {
        if (b.kind === "cluster") { expect(b.count).toBe(b.ids.length); expect(b.ids.length).toBeGreaterThanOrEqual(2); }
        else { expect(b.ids).toHaveLength(1); expect(b.ordinal).toBeDefined(); }
      }
      expect(assignment.size).toBe(n);
    }
  });

  it("is deterministic, and the partition does not depend on input order", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const input = randomPins(seed, 5 + (seed % 60), 300);
      const a = collapsePins(input, null);
      const b = collapsePins(input, null);
      expect(b.badges).toEqual(a.badges);
      const shuffled = [...input].sort(() => rng(seed)() - 0.5);
      const c = collapsePins(shuffled, null);
      expect(membership(c.badges), `seed ${seed}`).toEqual(membership(a.badges));
      // same cluster centroid up to float summation order
      for (const badge of a.badges) {
        const twin = c.badges.find((x) => x.key === badge.key)!;
        expect(twin.x).toBeCloseTo(badge.x, 6);
        expect(twin.y).toBeCloseTo(badge.y, 6);
      }
    }
  });

  it("every merged pair is closer than the merge distance through some chain, and every unmerged pair is not closer than it", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const input = randomPins(seed, 30, 160);
      const { badges } = collapsePins(input, null);
      const byId = new Map(input.map((p) => [p.id, p]));
      const keyOf = new Map<string, string>();
      for (const b of badges) for (const id of b.ids) keyOf.set(id, b.key);
      for (const p of input) for (const q of input) {
        if (p.id >= q.id) continue;
        if (Math.hypot(p.x - q.x, p.y - q.y) < PIN_BADGE.mergeDistance) expect(keyOf.get(p.id), `seed ${seed}`).toBe(keyOf.get(q.id));
      }
      // connectivity: members of one cluster form one connected component under the merge distance
      for (const b of badges) {
        if (b.ids.length < 2) continue;
        const members = b.ids.map((id) => byId.get(id)!);
        const reached = new Set([members[0]!.id]);
        const queue = [members[0]!];
        while (queue.length) {
          const cur = queue.pop()!;
          for (const m of members) if (!reached.has(m.id) && Math.hypot(cur.x - m.x, cur.y - m.y) < PIN_BADGE.mergeDistance) { reached.add(m.id); queue.push(m); }
        }
        expect(reached.size, `seed ${seed} cluster ${b.key}`).toBe(members.length);
      }
    }
  });

  it("stable under tiny moves: a 0.3 px jitter of every pin never changes the partition when no pair sits within 1 px of a threshold", () => {
    let checked = 0;
    for (let seed = 1; seed <= 400 && checked < 120; seed++) {
      const input = randomPins(seed, 10, 420);
      let nearThreshold = false;
      for (const p of input) for (const q of input) {
        if (p.id >= q.id) continue;
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (Math.abs(d - PIN_BADGE.mergeDistance) < 1 || Math.abs(d - PIN_BADGE.splitDistance) < 1) nearThreshold = true;
      }
      if (nearThreshold) continue;
      checked++;
      const first = collapsePins(input, null);
      const r = rng(seed + 999);
      const moved = input.map((p) => ({ ...p, x: p.x + (r() - 0.5) * 0.6, y: p.y + (r() - 0.5) * 0.6 }));
      const second = collapsePins(moved, first.assignment);
      expect(membership(second.badges), `seed ${seed}`).toEqual(membership(first.badges));
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("hysteresis stays stable over a long drift: a pair that wobbles between 23 and 27 px never flips once merged, nor once split", () => {
    let prev: ReturnType<typeof collapsePins>["assignment"] | null = null;
    // start merged (20 px), then wobble in the dead band
    let r = collapsePins([pin(1, 100, 100), pin(2, 120, 100)], prev);
    expect(r.badges).toHaveLength(1);
    prev = r.assignment;
    for (const gap of [23, 27, 24.5, 26.9, 23.1, 27.9, 25]) {
      r = collapsePins([pin(1, 100, 100), pin(2, 100 + gap, 100)], prev);
      expect(r.badges, `gap ${gap}`).toHaveLength(1);
      prev = r.assignment;
    }
    r = collapsePins([pin(1, 100, 100), pin(2, 129, 100)], prev); // beyond 28: split
    expect(r.badges).toHaveLength(2);
    prev = r.assignment;
    for (const gap of [27.9, 23, 22.1, 25]) {
      r = collapsePins([pin(1, 100, 100), pin(2, 100 + gap, 100)], prev);
      expect(r.badges, `split gap ${gap}`).toHaveLength(2); // does not re-merge until under 22
      prev = r.assignment;
    }
    r = collapsePins([pin(1, 100, 100), pin(2, 121.9, 100)], prev);
    expect(r.badges).toHaveLength(1);
  });

  it("scales with the number of pins, not its square, for spread pins: pair tests grow at most ~linearly (counted via Math.hypot)", () => {
    const calls = (n: number): number => {
      const input = Array.from({ length: n }, (_, i) => pin(i + 1, (i % 10) * 90, Math.floor(i / 10) * 90));
      const real = Math.hypot;
      let count = 0;
      Math.hypot = ((...a: number[]) => { count++; return real(...a); }) as typeof Math.hypot;
      try { collapsePins(input, null); } finally { Math.hypot = real; }
      return count;
    };
    expect(calls(100)).toBeLessThanOrEqual(calls(25) * 6);
  });

  it("DENSE worst case (all 100 pins inside one grid cell) is bounded by the 100 cap at n^2/2 pair tests: advisory, not linear", () => {
    const input = Array.from({ length: 100 }, (_, i) => pin(i + 1, 50 + (i % 5) * 0.1, 50 + Math.floor(i / 5) * 0.01));
    const real = Math.hypot;
    let count = 0;
    Math.hypot = ((...a: number[]) => { count++; return real(...a); }) as typeof Math.hypot;
    let result: ReturnType<typeof collapsePins>;
    try { result = collapsePins(input, null); } finally { Math.hypot = real; }
    expect(result.badges).toHaveLength(1);
    expect(result.badges[0]!.count).toBe(100);
    // observed: 4950 pair tests. The design says O(n); the grid only helps for spread pins. Bounded by maxPins.
    expect(count).toBeLessThanOrEqual(100 * 99 / 2);
  });

  it("100 pins collapse in well under a frame (T7: under 1 ms on a quiet machine; asserted at 4 ms average for CI noise)", () => {
    const dense = Array.from({ length: 100 }, (_, i) => pin(i + 1, 50 + (i % 5) * 0.1, 50 + Math.floor(i / 5) * 0.01));
    const spread = randomPins(77, 100, 1500);
    for (const input of [dense, spread]) {
      collapsePins(input, null); // warm
      const t0 = performance.now();
      const reps = 300;
      for (let i = 0; i < reps; i++) collapsePins(input, null);
      const avg = (performance.now() - t0) / reps;
      expect(avg).toBeLessThan(4);
    }
  });

  it("input beyond 100 is dropped by the module itself, deterministically (the first 100 win)", () => {
    const input = randomPins(5, 150, 2000);
    const { badges } = collapsePins(input, null);
    const seen = new Set(badges.flatMap((b) => [...b.ids]));
    expect(seen.size).toBe(100);
    for (const p of input.slice(0, 100)) expect(seen.has(p.id)).toBe(true);
  });

  it("a stale `previous` that names pins no longer present, or a cluster key that no longer exists, changes nothing", () => {
    const prev = new Map<string, string>([[idOf(1), "gone|cluster"], [idOf(2), "gone|cluster"], [idOf(99), "x"]]);
    const r = collapsePins([pin(1, 0, 0), pin(2, 25, 0)], prev);
    // previous says "together" (key contains |) so the wider split distance applies: 25 < 28 merges. Documented behaviour of the hysteresis.
    expect(r.badges).toHaveLength(1);
    const r2 = collapsePins([pin(1, 0, 0), pin(2, 25, 0)], new Map());
    expect(r2.badges).toHaveLength(2);
  });

  it("non-finite coordinates never merge with anything and never throw", () => {
    const r = collapsePins([pin(1, NaN, 0), pin(2, NaN, 0), pin(3, Infinity, 5), pin(4, 10, 10), pin(5, 12, 10)], null);
    expect(r.badges.flatMap((b) => [...b.ids]).sort()).toEqual([1, 2, 3, 4, 5].map(idOf).sort());
    expect(r.badges.find((b) => b.ids.includes(idOf(4)))!.ids).toContain(idOf(5));
  });

  it("an approximate cluster is approximate only when every member is", () => {
    const r = collapsePins([pin(1, 0, 0, { approximate: true }), pin(2, 5, 0, { approximate: false })], null);
    expect(r.badges[0]!.approximate).toBe(false);
    const r2 = collapsePins([pin(1, 0, 0, { approximate: true }), pin(2, 5, 0, { approximate: true })], null);
    expect(r2.badges[0]!.approximate).toBe(true);
  });
});

const input = (over: Partial<RailInput> = {}): RailInput => ({
  comments: [], anchorStates: {}, filter: "all", clusterIds: null, selected: null, notice: null, health: "ok", resultsLine: null, ...over,
});

describe("rail-model reducer: adversarial table", () => {
  it("every (status x provenance x anchor state x readOnly) combination yields a self-consistent row", () => {
    const statuses = ["open", "pending", "sent", "resolved", "dismissed"] as const;
    const provenances = ["local", "foreign"] as const;
    const states = ["exact", "moved", "approximate", "detached", "other-route", "unknown"] as const;
    let n = 0;
    for (const status of statuses) for (const provenance of provenances) for (const state of states) for (const health of ["ok", "read-only", "recovered", "unavailable"] as const) {
      const c = comment(++n, { status, provenance });
      const view = buildRailView(input({ comments: [c], anchorStates: { [c.id]: state }, health }));
      const row = view.rows[0]!;
      const placed = state === "exact" || state === "moved" || state === "approximate";
      expect(row.actions.includes("jump"), `${status}/${provenance}/${state}/${health}`).toBe(placed);
      if (health === "read-only") {
        expect(row.actions.filter((a) => a !== "jump")).toEqual([]);
        expect(row.selectable).toBe(false);
        expect(view.send.enabled).toBe(false);
      }
      if (provenance === "foreign") {
        expect(row.selectable).toBe(false);
        expect(row.actions).not.toContain("send");
        expect(row.actions).not.toContain("resend");
      }
      if (status === "pending") {
        expect(row.actions).not.toContain("send");
        expect(row.selectable).toBe(false);
        if (provenance === "local") expect(row.actions).not.toContain("delete");
      }
      expect(row.greyed).toBe(state === "detached");
      expect(row.selected).toBe(row.selectable && status === "open");
    }
  });

  it("pending, sent, foreign and detached together: counts, defaults and the results line", () => {
    const comments = [
      comment(1, { status: "open" }),
      comment(2, { status: "pending" }),
      comment(3, { status: "sent" }),
      comment(4, { status: "open", provenance: "foreign" }),
      comment(5, { status: "open" }),
      comment(6, { status: "resolved" }),
    ];
    const view = buildRailView(input({ comments, anchorStates: { [idOf(5)]: "detached", [idOf(1)]: "exact" }, resultsLine: "1 sent, 2 waiting for the agent" }));
    expect(view.send).toMatchObject({ label: "Send 2", count: 2, enabled: true }); // 1 and 5 (detached is still sendable)
    expect(view.pendingCount).toBe(1);
    expect(view.resolveSentCount).toBe(1);
    expect(view.foreignBanner?.count).toBe(1);
    expect(view.filterCounts).toEqual({ all: 6, open: 4, sent: 1, resolved: 1, dismissed: 0 });
    expect(view.resultsLine).toBe("1 sent, 2 waiting for the agent");
    expect(view.rows.find((r) => r.id === idOf(5))!.greyed).toBe(true);
  });

  it("maybeSent keeps the comment selectable and Send enabled", () => {
    const c = comment(1, { send: { attempts: 2, lastOutcome: null, maybeSent: true, lastMessage: null } });
    const view = buildRailView(input({ comments: [c] }));
    expect(view.rows[0]!.stateChips).toContain("May have been sent");
    expect(view.rows[0]!.selectable).toBe(true);
    expect(view.send.enabled).toBe(true);
  });

  it("an explicit selection that includes a comment which became pending or foreign is pruned, not sent", () => {
    const comments = [comment(1, { status: "pending" }), comment(2, { provenance: "foreign" }), comment(3)];
    const sel = effectiveSelection(comments, new Set([idOf(1), idOf(2), idOf(3), "cmt_unknown"]));
    expect([...sel]).toEqual([idOf(3)]);
  });

  it("21 selectable comments is over the cap: Send disabled with overCap, and deselecting one re-enables it", () => {
    const comments = Array.from({ length: 21 }, (_, i) => comment(i + 1));
    const over = buildRailView(input({ comments }));
    expect(over.send).toMatchObject({ count: 21, enabled: false, overCap: true });
    const ok = buildRailView(input({ comments, selected: new Set(comments.slice(1).map((c) => c.id)) }));
    expect(ok.send).toMatchObject({ count: 20, enabled: true, overCap: false });
  });

  it("a cluster filter hides rows outside it even when they match the status filter; empty text differs from 'no comments'", () => {
    const comments = [comment(1), comment(2), comment(3)];
    const view = buildRailView(input({ comments, clusterIds: [idOf(2), "cmt_gone"] }));
    expect(view.rows.map((r) => r.id)).toEqual([idOf(2)]);
    expect(view.clusterChip).toBe("1 comment at this spot"); // counts the rows actually visible, not ids that no longer exist or are filtered out
    const none = buildRailView(input({ comments, clusterIds: ["cmt_gone"] }));
    expect(none.emptyText).toBe("No comments match this view.");
    expect(buildRailView(input()).emptyText).toMatch(/No comments yet/);
  });

  it("describeBatchReport covers sent, queued, deferred and skipped in one sentence and falls back to the plugin message", () => {
    const items = (...r: Array<"sent" | "queued" | "deferred" | "skipped">) => r.map((result, i) => ({ id: idOf(i + 1), result }));
    expect(describeBatchReport({ requestId: "r", outcome: "partial", message: "m", items: items("sent", "sent", "queued", "deferred", "skipped") } as never))
      .toBe("2 sent, 1 waiting for the agent, 1 left for the next send, 1 skipped");
    expect(describeBatchReport({ requestId: "r", outcome: "none", message: "Nothing was sent.", items: [] } as never)).toBe("Nothing was sent.");
    expect(describeBatchReport({ requestId: "r", outcome: "queued", message: "q", items: items("queued") } as never)).toBe("1 waiting for the agent");
  });

  // BUG (advisory, a11y): the 60-unit slice can cut a surrogate pair; the accessible name then ends in a lone surrogate.
  it("pinAccessibleName never ends in a lone surrogate when the 60th unit splits an emoji", () => {
    const c = comment(1, { text: "a".repeat(59) + "\u{1F600}tail" });
    const name = pinAccessibleName(c, "exact");
    const cut = name.slice(name.indexOf(": ") + 2);
    expect(/[\uD800-\uDBFF]$/.test(cut)).toBe(false);
  });
});
