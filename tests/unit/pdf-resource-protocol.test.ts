import { describe, expect, it } from "vitest";
const api = await import("../../src/main/pdf-protocol").catch(() => ({})) as typeof import("../../src/main/pdf-protocol");
const resources = { "index.html": "synthetic document", "viewer.mjs": "synthetic viewer", "worker.mjs": "synthetic worker", "viewer.css": "synthetic CSS" };
describe("closed PDF application resource origin", () => {
  it("serves only the four immutable application bytes with independent restrictive CSP", async () => {
    expect(api.createPdfProtocolHandler).toBeTypeOf("function"); const handle = api.createPdfProtocolHandler(resources);
    for (const name of Object.keys(resources)) {
      const response = handle({ url: `geode-pdf://viewer/${name}`, method: "GET" }); expect(response.status).toBe(200); expect(await response.text()).toBe(resources[name as keyof typeof resources]);
      const csp = response.headers.get("Content-Security-Policy")!; expect(csp).toContain("connect-src 'none'"); expect(csp).not.toContain("'unsafe-eval'");
      expect(csp).toContain(name === "worker.mjs" ? "worker-src 'none'" : "worker-src geode-pdf://viewer/worker.mjs");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });
  it("rejects method, origin, query, fragment, traversal and extra-resource variants", async () => {
    expect(api.createPdfProtocolHandler).toBeTypeOf("function"); const handle = api.createPdfProtocolHandler({ ...resources, "extra.mjs": "unexpected" } as any);
    expect(handle({ url: "geode-pdf://viewer/extra.mjs", method: "GET" }).status).toBe(404);
    for (const url of ["file:///index.html", "geode-pdf://other/index.html", "geode-pdf://viewer/index.html?x", "geode-pdf://viewer/index.html#x", "geode-pdf://viewer/../viewer/worker.mjs", "geode-pdf://viewer/%77orker.mjs", "geode-pdf://viewer/viewer.mjs/extra", "geode-pdf://viewer/document.pdf"]) expect(handle({ url, method: "GET" }).status).toBe(404);
    expect(handle({ url: "geode-pdf://viewer/index.html", method: "POST" }).status).toBe(404);
  });
});
