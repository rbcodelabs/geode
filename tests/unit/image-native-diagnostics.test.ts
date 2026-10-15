import { expect, it } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), { MATRIX, validate } = require("../../scripts/check-image-native-diagnostics.cjs");
const expected = { commit: "a".repeat(40), runId: "7a925431-abcd-4000-9000-100000000000", fixtureSha256: "b".repeat(64), preloadSha256: "c".repeat(64), sourceHashes: { "entry.cjs": "d".repeat(64) }, electron: "42.10.0", platform: "linux" };
function fixture(): any {
  return { ...structuredClone(expected), kind: "raw-native-observation-only", settlementAccepted: false, completed: true, failure: null,
    runtime: { electron: "42.10.0", platform: "linux", chrome: "150.0", node: "24.18.1", processSandboxDisabled: true }, network: [],
    cases: MATRIX.map((operations: any) => {
      const url = "blob:synthetic/" + operations.id;
      const events = [{ name: "decode-call", url }, { name: "admission", admissionPending: true },
        ...["hide", "remove-src", "detach", "revoke"].filter((_, index) => [operations.hide, operations.removeSrc, operations.detach, operations.revoke][index]).map(name => ({ name, ...(name === "revoke" ? { url } : {}) })),
        { name: "native-settled", url, outcome: "fulfilled", width: 8, height: 8 }, { name: "observation-boundary", outcome: "fulfilled" }];
      return { id: operations.id, operations: structuredClone(operations), admissionPending: true, outcome: "fulfilled", width: 8, height: 8,
        hidden: operations.hide, connected: !operations.detach, srcAttribute: operations.removeSrc ? null : url, currentSrc: url,
        windowDestroyed: true, events: events.map((event, index) => ({ seq: index + 1, ...event })) };
    }) };
}
const normalize = (row: any) => { row.events.forEach((event: any, index: number) => { event.seq = index + 1; }); };
it("accepts only a complete observation record, including honest still-pending cases", () => {
  const r = fixture(); r.cases[1].outcome = "still-pending"; delete r.cases[1].width; delete r.cases[1].height;
  r.cases[1].events = r.cases[1].events.filter((e: any) => e.name !== "native-settled");
  r.cases[1].events.find((e: any) => e.name === "observation-boundary").outcome = "still-pending"; normalize(r.cases[1]);
  expect(() => validate(r, expected)).not.toThrow();
});
it.each([
  ["failure", (r: any) => { r.failure = "native error"; }], ["partial", (r: any) => { r.completed = false; }],
  ["stale", (r: any) => { r.runId = "stale"; }], ["commit", (r: any) => { r.commit = "0".repeat(40); }],
  ["fixture", (r: any) => { r.fixtureSha256 = "0".repeat(64); }], ["preload", (r: any) => { delete r.preloadSha256; }],
  ["source", (r: any) => { r.sourceHashes["entry.cjs"] = "0".repeat(64); }], ["missing case", (r: any) => { r.cases.pop(); }],
  ["duplicate", (r: any) => { r.cases[8] = r.cases[7]; }], ["wrong operation", (r: any) => { r.cases[1].operations.hide = false; }],
  ["no positive", (r: any) => { r.cases[0].outcome = "still-pending"; }], ["no admission", (r: any) => { r.cases[1].admissionPending = false; }],
  ["pending forged settled", (r: any) => { r.cases[1].outcome = "still-pending"; }],
  ["missing settlement", (r: any) => { r.cases[1].events = r.cases[1].events.filter((e: any) => e.name !== "native-settled"); }],
  ["not destroyed", (r: any) => { r.cases[1].windowDestroyed = false; }], ["success overclaim", (r: any) => { r.settlementAccepted = true; }],
  ["wrong dimensions", (r: any) => { r.cases[0].width = 0; }], ["missing boundary", (r: any) => { r.cases[1].events = []; }],
  ["wrong runtime", (r: any) => { r.runtime.electron = "0"; }], ["wrong platform", (r: any) => { r.runtime.platform = "wrong"; }],
  ["network", (r: any) => { r.network = ["https://synthetic.invalid"]; }], ["sandbox claim", (r: any) => { r.runtime.processSandboxDisabled = false; }],
  ["native outcome contradiction", (r: any) => { r.cases[1].events.find((e: any) => e.name === "native-settled").outcome = "rejected"; }],
  ["boundary contradiction", (r: any) => { r.cases[1].events.find((e: any) => e.name === "observation-boundary").outcome = "still-pending"; }],
  ["native dimensions contradiction", (r: any) => { r.cases[1].events.find((e: any) => e.name === "native-settled").width = 0; }],
  ["settled after boundary", (r: any) => { const row = r.cases[1], event = row.events.splice(row.events.findIndex((e: any) => e.name === "native-settled"), 1)[0]; row.events.push(event); normalize(row); }],
  ...["hide", "remove-src", "detach", "revoke"].map(name => ["missing " + name, (r: any) => { const row = r.cases[8]; row.events = row.events.filter((e: any) => e.name !== name); normalize(row); }]),
  ["wrong revoke URL", (r: any) => { r.cases[8].events.find((e: any) => e.name === "revoke").url = "blob:foreign"; }],
  ["duplicate URL", (r: any) => { r.cases[1].events[0].url = r.cases[0].events[0].url; r.cases[1].srcAttribute = r.cases[0].srcAttribute; }],
  ["wrong source URL", (r: any) => { r.cases[1].srcAttribute = "blob:foreign"; }],
  ["operation order", (r: any) => { const row = r.cases[8]; [row.events[2], row.events[3]] = [row.events[3], row.events[2]]; normalize(row); }],
])("rejects diagnostic %s", (_name, mutate) => { const r = fixture(); (mutate as Function)(r); expect(() => validate(r, expected)).toThrow(); });
