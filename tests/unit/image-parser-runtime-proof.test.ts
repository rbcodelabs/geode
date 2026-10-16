import { describe, expect, it } from "vitest";
const api = await import("../../scripts/image-parser-proof/protocol").catch(() => ({})) as typeof import("../../scripts/image-parser-proof/protocol");
const nonce = "a".repeat(64);
const init = { kind: "initialize", version: 1, build: "image-parser-proof-v1", epoch: 1, nonce };
const parse = { kind: "parse", version: 1, epoch: 1, request: 1, source: "![a](Photo.png)" };
describe("isolated image parser proof boundary", () => {
  it("admits only the three fixed GET resources with restrictive response policies", () => {
    expect(api.createProofProtocol).toBeTypeOf("function");
    const handle = api.createProofProtocol({ "index.html": "html", "broker.mjs": "broker", "worker.mjs": "worker" });
    for (const name of ["index.html", "broker.mjs", "worker.mjs"]) {
      const response = handle({ method: "GET", url: `geode-image-parser://broker/${name}` });
      expect(response.status).toBe(200); expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
      expect(response.headers.get("Content-Security-Policy")).not.toMatch(/unsafe|blob:|data:/);
    }
    for (const url of ["https://example.test/", "geode-image-parser://other/index.html", "geode-image-parser://broker/worker.mjs?x", "geode-image-parser://broker/worker.mjs#x", "geode-image-parser://broker/unknown", "geode-image-parser://broker/%77orker.mjs"]) expect(handle({ method: "GET", url }).status).toBe(404);
    expect(handle({ method: "POST", url: "geode-image-parser://broker/index.html" }).status).toBe(404);
  });
  it("requires exact version/build/nonce/epoch initialization with no extra capabilities", () => {
    expect(api.isProofInit).toBeTypeOf("function"); expect(api.isProofInit(init)).toBe(true);
    for (const value of [null, [], { ...init, nonce: "short" }, { ...init, build: "old" }, { ...init, epoch: 0 }, { ...init, version: 2 }, { ...init, url: "file:///secret" }]) expect(api.isProofInit(value)).toBe(false);
  });
  it("validates complete LF input without silently shortening it", () => {
    expect(api.isProofRequest).toBeTypeOf("function"); expect(api.isProofRequest(parse, 1)).toBe(true);
    expect(api.isProofRequest({ ...parse, epoch: 2 }, 2)).toBe(true);
    expect(api.isProofRequest({ ...parse, source: "[".repeat(150_000) + "]".repeat(150_000) }, 1)).toBe(true);
    for (const value of [{ ...parse, source: "x".repeat(300_001) }, { ...parse, source: "\r\n" }, { ...parse, epoch: 2 }, { ...parse, request: 0 }, { ...parse, source: null }, { ...parse, eval: "1" }]) expect(api.isProofRequest(value, 1)).toBe(false);
    expect(api.isProofRequest({ kind: "cancel", version: 1, epoch: 1, request: 1 }, 1)).toBe(true);
    expect(api.isProofRequest({ kind: "cancel", version: 1, epoch: 1, request: 1, source: "" }, 1)).toBe(false);
  });
});

it("rejects wrong readiness nonce/build/epoch and privileged globals", () => {
  const ready = { kind: "ready", version: 1, build: init.build, epoch: 1, nonce, proof: { realm: Object.fromEntries(["process", "require", "geode", "electron", "ipcRenderer", "Buffer"].map(key => [key, "undefined"])) } };
  expect(api.isProofReady(ready, init as any)).toBe(true);
  for (const value of [{ ...ready, nonce: "b".repeat(64) }, { ...ready, epoch: 2 }, { ...ready, build: "other" }, { ...ready, url: "private" }, { ...ready, proof: { realm: { require: "function" } } }]) expect(api.isProofReady(value, init as any)).toBe(false);
});
