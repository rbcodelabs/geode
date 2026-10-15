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

import { canAllocateNative, nativePresentationLabel } from "../../src/renderer/markdown/native-presentation-prototype";
it("refuses record allocation while its current owner is frozen or permanently closed", async () => {
  const owner = new RenderOwnership().create({}); expect(canAllocateNative(owner, false)).toBe(true);
  owner.freezeAdmission(); expect(canAllocateNative(owner, false)).toBe(false); owner.resume(); expect(canAllocateNative(owner, true)).toBe(false);
  await owner.close(); expect(canAllocateNative(owner, false)).toBe(false);
});
it("keeps a mount failure visible across repeated geometry-label projections", () => {
  const occurrence = { id: 1, from: 0, to: 17, target: "Board.canvas" };
  expect(nativePresentationLabel(occurrence, true, "read rejected", false)).toContain("read rejected");
  expect(nativePresentationLabel(occurrence, false, "read rejected", false)).toContain("read rejected");
});
it("marks partial destruction fail-closed and never retries or resumes the closed native scope", async () => {
  const root = new RenderOwnership().create({}); let calls = 0;
  const scope = root.child({ close: async () => { calls++; throw new Error("partial native close"); } }); const record = new OwnedOccurrence(scope);
  expect(await record.retire()).toBe(false); expect(record.failedClosed).toBe(true); expect(scope.admissionAllowed).toBe(false);
  expect(await record.retire()).toBe(false); expect(calls).toBe(1);
});
it("a pre-destructor refusal remains usable and can retire after the original draft finishes", async () => {
  const root = new RenderOwnership().create({}); let refuse = true;
  const scope = root.child({ preflightClose: () => { if (refuse) throw new Error("finish original edit"); } }); const record = new OwnedOccurrence(scope);
  expect(await record.retire()).toBe(false); expect(record.failedClosed).toBe(false); expect(scope.admissionAllowed).toBe(true);
  refuse = false; expect(await record.retire()).toBe(true);
});
it("classifies an already rejected external destructor as closed instead of retryable", async () => {
  const root = new RenderOwnership().create({}); const scope = root.child({ close: async () => { throw new Error("external destructor failed"); } });
  await expect(scope.close()).rejects.toThrow("external destructor failed"); const record = new OwnedOccurrence(scope);
  expect(await record.retire()).toBe(false); expect(record.failedClosed).toBe(true);
});
it("waits for an externally closing scope before deciding whether its refusal can resume", async () => {
  const root = new RenderOwnership().create({}); let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; }); let readable = false;
  const scope = root.child({ validateClose: async () => { await gate; if (!readable) throw new Error("read refused"); } });
  const closing = scope.close(); void closing.catch(() => {}); const record = new OwnedOccurrence(scope); let settled = false;
  const retirement = record.retire().finally(() => { settled = true; }); await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false);
  finish(); await expect(closing).rejects.toThrow("read refused"); expect(await retirement).toBe(false); expect(record.failedClosed).toBe(false); expect(scope.admissionAllowed).toBe(true);
  readable = true; expect(await record.retire()).toBe(true);
});

it("source reconciliation closes removed mount admission before the next geometry frame", async () => {
  const { NativePresentationPrototype } = await import("../../src/renderer/markdown/native-presentation-prototype");
  const owner = new RenderOwnership().create({}); const scope = owner.child();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let published = false;
  const mounting = scope.run(async token => { await gate; token.check(); published = true; }); void mounting.catch(() => {});
  await Promise.resolve();
  const occurrence = { id: 1, from: 0, to: 17, target: "Board.canvas" };
  const record = { occurrence, lifetime: new OwnedOccurrence(scope), retryRetirement: false, observer: { disconnect() {} }, root: { remove() {} } };
  const layer = Object.assign(Object.create(NativePresentationPrototype.prototype), {
    options: { owner }, disposed: false, sources: new Map([[1, occurrence]]), records: new Map([[1, record]]),
    anchors: new AnchorLeases(), resize: { unobserve() {} }, retirements: 0, requestGeometry() {},
  }) as InstanceType<typeof NativePresentationPrototype>;
  layer.reconcile([]); release(); await mounting.catch(() => {});
  expect(published).toBe(false);
  expect(await record.lifetime.retire()).toBe(true);
});

it("source removal preflights the original draft without closing its usable scope", async () => {
  const { NativePresentationPrototype } = await import("../../src/renderer/markdown/native-presentation-prototype");
  const owner = new RenderOwnership().create({}); let draft = true; let closes = 0;
  const scope = owner.child({ preflightClose: () => { if (draft) throw new Error("finish draft"); }, close: async () => { closes++; } });
  const occurrence = { id: 1, from: 0, to: 17, target: "Board.canvas" };
  const record = { occurrence, lifetime: new OwnedOccurrence(scope), retryRetirement: false, observer: { disconnect() {} }, root: { remove() {} } };
  const layer = Object.assign(Object.create(NativePresentationPrototype.prototype), {
    options: { owner }, disposed: false, sources: new Map([[1, occurrence]]), records: new Map([[1, record]]),
    anchors: new AnchorLeases(), resize: { unobserve() {} }, retirements: 0, requestGeometry() {},
  }) as InstanceType<typeof NativePresentationPrototype>;
  layer.reconcile([]); expect(await record.lifetime.retire()).toBe(false);
  expect(scope.admissionAllowed).toBe(true); expect(closes).toBe(0);
  draft = false; expect(await record.lifetime.retire()).toBe(true); expect(closes).toBe(1);
});
