import { describe, expect, it } from "vitest";
import type { BatchSendReport } from "../../src/artifacts/feedback-contract-v2";
import {
  anchorStateFromResult,
  buildRailView,
  describeBatchReport,
  effectiveSelection,
  pinAccessibleName,
  type RailInput,
} from "../../src/renderer/artifacts/rail-model";
import { comment, idOf, snapshot } from "./helpers/pin-fixtures";

const input = (over: Partial<RailInput> = {}): RailInput => ({
  comments: [], anchorStates: {}, filter: "all", clusterIds: null, selected: null,
  notice: null, health: "ok", resultsLine: null, ...over,
});

describe("anchorStateFromResult (3.3 mapping; agrees:false is unconfirmed)", () => {
  const r = (match: string, agrees: boolean) => ({ key: "a0", match, agrees, rect: null, visible: false }) as never;
  it.each([
    ["selector", true, "exact"], ["text", true, "moved"], ["selector", false, "approximate"],
    ["text", false, "approximate"], ["landmark", false, "approximate"], ["landmark", true, "approximate"],
    ["detached", true, "detached"], ["other-route", true, "other-route"],
  ])("%s agrees=%s -> %s", (match, agrees, expected) => {
    expect(anchorStateFromResult(r(match, agrees))).toBe(expected);
  });
});

describe("effectiveSelection (defaults and pruning)", () => {
  const comments = [comment(1), comment(2, { status: "sent" }), comment(3, { provenance: "foreign" }), comment(4, { status: "pending" }), comment(5)];
  it("defaults to every open local comment", () => {
    expect([...effectiveSelection(comments, null)].sort()).toEqual([idOf(1), idOf(5)].sort());
  });
  it("an explicit selection is kept but pruned to still-sendable comments", () => {
    const explicit = new Set([idOf(1), idOf(2), idOf(3), idOf(99)]);
    expect([...effectiveSelection(comments, explicit)]).toEqual([idOf(1)]);
  });
  it("an explicitly empty selection stays empty", () => {
    expect(effectiveSelection(comments, new Set()).size).toBe(0);
  });
});

describe("buildRailView: filters, counts and ordering", () => {
  const comments = [
    comment(3, { status: "resolved" }), comment(1), comment(2, { status: "sent" }), comment(5, { status: "dismissed" }), comment(4, { status: "pending" }),
  ];
  it("orders rows by ordinal ascending and counts the heading", () => {
    const view = buildRailView(input({ comments }));
    expect(view.rows.map((r) => r.ordinal)).toEqual([1, 2, 3, 4, 5]);
    expect(view.heading).toBe("Comments (5)");
  });
  it("Open includes pending; each filter shows its own", () => {
    const rows = (filter: RailInput["filter"]) => buildRailView(input({ comments, filter })).rows.map((r) => r.ordinal);
    expect(rows("open")).toEqual([1, 4]);
    expect(rows("sent")).toEqual([2]);
    expect(rows("resolved")).toEqual([3]);
    expect(rows("dismissed")).toEqual([5]);
  });
  it("reports a count per filter", () => {
    expect(buildRailView(input({ comments })).filterCounts).toEqual({ all: 5, open: 2, sent: 1, resolved: 1, dismissed: 1 });
  });
  it("a cluster filter shows only those ids and exposes a removable chip", () => {
    const view = buildRailView(input({ comments, clusterIds: [idOf(1), idOf(2)] }));
    expect(view.rows.map((r) => r.ordinal)).toEqual([1, 2]);
    expect(view.clusterChip).toBe("2 comments at this spot");
  });
  it("singular chip wording", () => {
    expect(buildRailView(input({ comments, clusterIds: [idOf(1)] })).clusterChip).toBe("1 comment at this spot");
  });
  it("shows an empty state", () => {
    expect(buildRailView(input()).emptyText).toBe("No comments yet. Pick an element and choose Pin to add one.");
    expect(buildRailView(input({ comments, filter: "dismissed", clusterIds: [idOf(1)] })).emptyText).toMatch(/no comments/i);
  });
});

describe("buildRailView: rows", () => {
  it("offers the right actions per status (local)", () => {
    const actions = (status: "open" | "pending" | "sent" | "resolved" | "dismissed") =>
      buildRailView(input({ comments: [comment(1, { status })], anchorStates: { [idOf(1)]: "exact" } })).rows[0]!.actions;
    expect(actions("open")).toEqual(["jump", "send", "resolve", "dismiss", "delete"]);
    expect(actions("pending")).toEqual(["jump", "unqueue"]);
    expect(actions("sent")).toEqual(["jump", "resend", "resolve", "dismiss", "reopen", "delete"]);
    expect(actions("resolved")).toEqual(["jump", "reopen", "delete"]);
    expect(actions("dismissed")).toEqual(["jump", "reopen", "delete"]);
  });
  it("hides Jump for detached, other-route and unknown pins", () => {
    for (const state of ["detached", "other-route", "unknown"] as const) {
      const row = buildRailView(input({ comments: [comment(1)], anchorStates: { [idOf(1)]: state } })).rows[0]!;
      expect(row.actions).not.toContain("jump");
    }
  });
  it("foreign comments can be adopted but never sent", () => {
    const row = buildRailView(input({ comments: [comment(1, { provenance: "foreign" })], anchorStates: { [idOf(1)]: "exact" } })).rows[0]!;
    expect(row.foreign).toBe(true);
    expect(row.actions).toEqual(["jump", "adopt", "delete"]);
    expect(row.selectable).toBe(false);
  });
  it("detached rows are greyed with the reason; other-route is not greyed", () => {
    const detached = buildRailView(input({ comments: [comment(1)], anchorStates: { [idOf(1)]: "detached" } })).rows[0]!;
    expect(detached.greyed).toBe(true);
    expect(detached.anchorChip).toBe("Detached: the element was not found");
    const other = buildRailView(input({ comments: [comment(1)], anchorStates: { [idOf(1)]: "other-route" } })).rows[0]!;
    expect(other.greyed).toBe(false);
    expect(other.anchorChip).toBe("On another page");
  });
  it("chips for moved and approximate; none for exact or unknown", () => {
    const chip = (s: "exact" | "moved" | "approximate" | "unknown") =>
      buildRailView(input({ comments: [comment(1)], anchorStates: { [idOf(1)]: s } })).rows[0]!.anchorChip;
    expect(chip("exact")).toBeNull();
    expect(chip("unknown")).toBeNull();
    expect(chip("moved")).toBe("Moved");
    expect(chip("approximate")).toBe("Approximate: may not be the same element");
  });
  it("pending and maybe-sent comments get state chips and keep Send reachable for maybeSent", () => {
    const pending = buildRailView(input({ comments: [comment(1, { status: "pending" })] })).rows[0]!;
    expect(pending.stateChips).toContain("Waiting for the agent");
    const maybe = buildRailView(input({ comments: [comment(1, { send: { attempts: 1, lastOutcome: "unknown", maybeSent: true, lastMessage: null } })] })).rows[0]!;
    expect(maybe.stateChips).toContain("May have been sent");
    expect(maybe.actions).toContain("send");
  });
  it("exposes label and text as plain strings for textContent", () => {
    const row = buildRailView(input({ comments: [comment(1, { text: "<img src=x onerror=alert(1)>", label: "<b>x</b>" })] })).rows[0]!;
    expect(row.text).toBe("<img src=x onerror=alert(1)>");
    expect(row.label).toBe("<b>x</b>");
  });
  it("selection labels and defaults", () => {
    const view = buildRailView(input({ comments: [comment(1), comment(2, { status: "sent" })] }));
    expect(view.rows[0]).toMatchObject({ selectable: true, selected: true, selectLabel: "Select comment 1 for sending" });
    expect(view.rows[1]).toMatchObject({ selectable: false, selected: false });
  });
});

describe("buildRailView: send, bulk and notices", () => {
  it("Send N reflects the effective selection and disables at zero", () => {
    const some = buildRailView(input({ comments: [comment(1), comment(2)] }));
    expect(some.send).toMatchObject({ label: "Send 2", count: 2, enabled: true });
    const none = buildRailView(input({ comments: [comment(1), comment(2)], selected: new Set() }));
    expect(none.send).toMatchObject({ label: "Send", count: 0, enabled: false });
  });
  it("caps the batch at 20 and says so", () => {
    const many = Array.from({ length: 25 }, (_, i) => comment(i + 1));
    const view = buildRailView(input({ comments: many }));
    expect(view.send.count).toBe(25);
    expect(view.send.overCap).toBe(true);
    expect(view.send.enabled).toBe(false);
  });
  it("Resolve sent counts local sent comments", () => {
    const view = buildRailView(input({ comments: [comment(1, { status: "sent" }), comment(2, { status: "sent" }), comment(3)] }));
    expect(view.resolveSentCount).toBe(2);
  });
  it("read-only health keeps only Jump and disables send", () => {
    const view = buildRailView(input({ comments: [comment(1)], anchorStates: { [idOf(1)]: "exact" }, health: "read-only", notice: "Comments are read-only." }));
    expect(view.rows[0]!.actions).toEqual(["jump"]);
    expect(view.send.enabled).toBe(false);
    expect(view.readOnly).toBe(true);
    expect(view.notice).toBe("Comments are read-only.");
  });
  it("foreign banner offers Adopt all", () => {
    const view = buildRailView(input({ comments: [comment(1, { provenance: "foreign" }), comment(2, { provenance: "foreign" })] }));
    expect(view.foreignBanner).toEqual({ count: 2, text: "2 comments came from another install. Read them, then adopt the ones you trust." });
  });
  it("recovered health shows the notice", () => {
    const view = buildRailView(input({ health: "recovered", notice: "Comments were recovered from a backup." }));
    expect(view.notice).toBe("Comments were recovered from a backup.");
  });
  it("passes the results line through", () => {
    expect(buildRailView(input({ resultsLine: "2 sent" })).resultsLine).toBe("2 sent");
  });
});

describe("describeBatchReport (the results line)", () => {
  const report = (items: BatchSendReport["items"], over: Partial<BatchSendReport> = {}): BatchSendReport =>
    ({ requestId: "req_" + "a".repeat(32), outcome: "partial", items, message: "plugin words", ...over });
  it("counts sent and queued", () => {
    expect(describeBatchReport(report([{ id: "a", result: "sent" }, { id: "b", result: "sent" }, { id: "c", result: "queued" }])))
      .toBe("2 sent, 1 waiting for the agent");
  });
  it("mentions deferred and skipped", () => {
    expect(describeBatchReport(report([{ id: "a", result: "deferred" }, { id: "b", result: "skipped", reason: "foreign" }])))
      .toBe("1 left for the next send, 1 skipped");
  });
  it("falls back to the plugin message when there are no items", () => {
    expect(describeBatchReport(report([], { outcome: "none" }))).toBe("plugin words");
  });
});

describe("pinAccessibleName (3.7)", () => {
  it("names ordinal, status, label and the first 60 characters", () => {
    const c = comment(4, { label: "button Save", text: "x".repeat(100) });
    expect(pinAccessibleName(c, "exact")).toBe(`Comment 4, open, on button Save: ${"x".repeat(60)}`);
  });
  it("flags approximate positions", () => {
    expect(pinAccessibleName(comment(2), "approximate")).toMatch(/approximate position/);
  });
});

describe("snapshot fixture sanity", () => {
  it("builds a snapshot", () => { expect(snapshot([comment(1)]).comments).toHaveLength(1); });
});

describe("buildRailView: retry of a failed send and queued batch size", () => {
  it("exposes the retry affordance only when asked", () => {
    expect(buildRailView(input({ retry: true })).retry).toBe(true);
    expect(buildRailView(input()).retry).toBe(false);
  });
  it("counts pending comments for the unqueue confirmation", () => {
    const view = buildRailView(input({ comments: [comment(1, { status: "pending" }), comment(2, { status: "pending" }), comment(3)] }));
    expect(view.pendingCount).toBe(2);
  });
});
