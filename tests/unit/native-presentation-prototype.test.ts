import { expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { OccurrenceLedger, placeNativeRecord } from "../../src/renderer/markdown/native-presentation-prototype";
it("gives duplicate target occurrences distinct identities and maps their source intervals", () => {
  const ledger = new OccurrenceLedger(); const doc = "![[Board.canvas]]\n\n![[Board.canvas]]\n";
  const first = ledger.reconcile(doc); expect(first.active).toHaveLength(2); expect(first.active[0].id).not.toBe(first.active[1].id);
  const changes = ChangeSet.of({ from: 0, insert: "Intro\n" }, doc.length); const next = ledger.reconcile(changes.apply(Text.of(doc.split("\n"))).toString(), changes);
  expect(next.active.map(item => item.id)).toEqual(first.active.map(item => item.id)); expect(next.active[0].from).toBe(6); expect(next.removed).toEqual([]);
});
it("retargeting never assigns the unfinished old target's identity to the new target", () => {
  const ledger = new OccurrenceLedger(); const doc = "![[Board.canvas]]"; const first = ledger.reconcile(doc).active[0];
  const changes = ChangeSet.of({ from: 3, to: 8, insert: "Other" }, doc.length);
  const next = ledger.reconcile("![[Other.canvas]]", changes);
  expect(next.removed).toEqual([first]); expect(next.active[0].id).not.toBe(first.id); expect(first.target).toBe("Board.canvas");
});
it("removal and subsequent identical insertion create a fresh source occurrence", () => {
  const ledger = new OccurrenceLedger(); const doc = "![[Board.canvas]]"; const first = ledger.reconcile(doc).active[0];
  expect(ledger.reconcile("", ChangeSet.of({ from: 0, to: doc.length }, doc.length)).removed).toEqual([first]);
  const returned = ledger.reconcile(doc, ChangeSet.of({ from: 0, insert: doc }, 0)).active[0]; expect(returned.id).not.toBe(first.id);
});
it("keeps inline coordinates relative to the stable layer and shelves only offscreen anchors", () => {
  const pane = { left: 100, top: 50, width: 800, height: 600 };
  expect(placeNativeRecord(pane, { left: 160, top: 120, width: 600, height: 250 }, 0, 0, 250)).toMatchObject({ state: "inline", left: 60, top: 70, width: 600 });
  const retained = placeNativeRecord(pane, { left: 160, top: -400, width: 600, height: 250 }, 0, 0, 250);
  expect(retained.state).toBe("retained"); expect(retained.top).toBeGreaterThanOrEqual(0); expect(retained.top + 250).toBeLessThanOrEqual(pane.height);
});
it("a removed source has no returnable anchor and shelf scrolling changes only placement", () => {
  const pane = { left: 0, top: 0, width: 480, height: 600 };
  const before = placeNativeRecord(pane, null, 1, 0, 250); const after = placeNativeRecord(pane, null, 1, 180, 250);
  expect(before.state).toBe("removed"); expect(after.top).toBe(before.top - 180); expect(after.width).toBeLessThanOrEqual(480);
});

import { AnchorLeases, OwnedOccurrence } from "../../src/renderer/markdown/native-presentation-prototype";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";
it("ignores an obsolete widget's lease release after the replacement anchor attached", () => {
  const leases = new AnchorLeases<object>(); const old = {}; const current = {};
  const first = leases.attach(1, old); const second = leases.attach(1, current);
  leases.release(1, first); expect(leases.get(1)).toBe(current); leases.release(1, second); expect(leases.get(1)).toBeNull();
});
it("retains a refused native scope and retires it exactly once after the original draft finishes", async () => {
  const root = new RenderOwnership().create({}); let draft = true; let closes = 0;
  const scope = root.child({ preflightClose: () => { if (draft) throw new Error("finish original draft"); }, close: async () => { closes++; } });
  const record = new OwnedOccurrence(scope);
  expect(await record.retire()).toBe(false); expect(record.retired).toBe(false); expect(scope.admissionAllowed).toBe(true); expect(closes).toBe(0);
  draft = false; expect(await record.retire()).toBe(true); expect(await record.retire()).toBe(true); expect(closes).toBe(1);
});
it("settles a pending mount before retirement and prevents its late publication", async () => {
  const root = new RenderOwnership().create({}); const scope = root.child(); const record = new OwnedOccurrence(scope);
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; }); let published = false;
  const task = scope.run(async token => { await gate; token.check(); published = true; }); void task.catch(() => {}); await Promise.resolve();
  const retirement = record.retire(); expect(record.retired).toBe(false); finish(); expect(await retirement).toBe(true); expect(published).toBe(false);
});
