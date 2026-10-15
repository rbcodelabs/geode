import { expect, it } from "vitest";
import { isImageResourceRequest, isImageResourceReply } from "../../src/shared/image-resources-wire";
const id = "a".repeat(64);
const read = { version: 1, operation: "read", id, root: "/synthetic", path: "Photo.png" };
const complete = { version: 1, operation: "cancel", id, kind: "retired", outcome: "completed", failure: null };
const failure = { code: "READ_FAILED", cleanupUncertain: false,
  diagnostics: [{ phase: "read", code: "READ_FAILED", message: "Image read failed." }], omittedCount: 0 };
for (const operation of ["read", "cancel", "finish"] as const) it(`accepts the exact ${operation} request contract`, () => {
  const request = operation === "read" ? read : { version: 1, operation, id, root: "/synthetic" };
  expect(isImageResourceRequest(operation, request)).toBe(true);
});
const badRequests = [
  ["wrong version", { ...read, version: 2 }], ["wrong channel operation", { ...read, operation: "cancel" }],
  ["uppercase ID", { ...read, id: "A".repeat(64) }], ["short ID", { ...read, id: "a".repeat(63) }],
  ["extra key", { ...read, extra: true }], ["empty root", { ...read, root: "" }],
  ["NUL root", { ...read, root: "/synthetic\0" }], ["NUL path", { ...read, path: "Photo\0.png" }],
  ["oversized path", { ...read, path: "a".repeat(4097) }], ["oversized root", { ...read, root: "a".repeat(4097) }],
  ["inherited shape", Object.assign(Object.create({ foreign: true }), read)],
  ["symbol key", { ...read, [Symbol("foreign")]: true }], ["array", []],
] as const;
for (const [name, request] of badRequests) it(`rejects ${name} without wire admission`, () => {
  expect(isImageResourceRequest("read", request)).toBe(false);
});
it("rejects accessors without invoking them", () => {
  let calls = 0; const request = { ...read }; Object.defineProperty(request, "path", { enumerable: true, get: () => { calls++; return "Photo.png"; } });
  expect(isImageResourceRequest("read", request)).toBe(false); expect(calls).toBe(0);
});
it("accepts an exact completed-race cancellation reply", () => {
  expect(isImageResourceReply("cancel", id, complete)).toBe(true);
});
it("accepts exact read bytes for all six MIME families", () => {
  for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif"]) {
    expect(isImageResourceReply("read", id, { version: 1, operation: "read", id, kind: "bytes", bytes: new ArrayBuffer(8), mime })).toBe(true);
  }
});
it("accepts a bounded explicit clean failed-read envelope", () => {
  expect(isImageResourceReply("read", id, { version: 1, operation: "read", id, kind: "error", failure })).toBe(true);
});
for (const [name, reply] of [
  ["foreign ID", { ...complete, id: "b".repeat(64) }], ["wrong operation", { ...complete, operation: "finish" }],
  ["missing failure key", { version: 1, operation: "cancel", id, kind: "retired", outcome: "completed" }],
  ["completed with failure", { ...complete, failure }], ["uncertainty without diagnostics", { ...complete, outcome: "cleanup-uncertain" }],
  ["extra key", { ...complete, extra: true }], ["raw Error", new Error("private path must not cross wire")],
  ["unbounded diagnostic", { ...complete, outcome: "read-failed", failure: { ...failure, diagnostics: [{ ...failure.diagnostics[0], message: "x".repeat(257) }] } }],
  ["arbitrary message", { ...complete, outcome: "read-failed", failure: { ...failure, diagnostics: [{ ...failure.diagnostics[0], message: "raw sensitive path" }] } }],
  ["negative omissions", { ...complete, outcome: "read-failed", failure: { ...failure, omittedCount: -1 } }],
  ["uncertainty contradicts code", { ...complete, outcome: "read-failed", failure: { ...failure, cleanupUncertain: true } }],
] as const) it(`rejects ${name} reply before interpreting retirement`, () => {
  expect(isImageResourceReply("cancel", id, reply)).toBe(false);
});
for (const [name, bytes] of [["typed view", new Uint8Array(8)], ["empty bytes", new ArrayBuffer(0)]] as const) it(`rejects ${name} success`, () => {
  expect(isImageResourceReply("read", id, { version: 1, operation: "read", id, kind: "bytes", mime: "image/png", bytes })).toBe(false);
});
