import { describe, expect, it } from "vitest";
import {
  isArtifactUrlAllowed,
  nextjsArtifactCsp,
  parseLoopbackDevServerUrl,
  STATIC_ARTIFACT_CSP,
} from "../../src/artifacts/security-policy";

describe("static artifact security policy", () => {
  it("allows only the artifact's own origin for documents", () => {
    expect(isArtifactUrlAllowed("geode-artifact://demo/index.html", "demo", "document")).toBe(true);
    expect(isArtifactUrlAllowed("geode-artifact://other/index.html", "demo", "document")).toBe(false);
    expect(isArtifactUrlAllowed("https://example.com", "demo", "document")).toBe(false);
    expect(isArtifactUrlAllowed("data:text/html,hello", "demo", "document")).toBe(false);
  });

  it("permits inert embedded assets but no network subresources", () => {
    expect(isArtifactUrlAllowed("data:image/png;base64,AA==", "demo", "subresource")).toBe(true);
    expect(isArtifactUrlAllowed("blob:https://example.com/id", "demo", "subresource")).toBe(true);
    expect(isArtifactUrlAllowed("https://example.com/app.js", "demo", "subresource")).toBe(false);
  });

  it("ships a deny-by-default CSP", () => {
    expect(STATIC_ARTIFACT_CSP).toContain("default-src 'none'");
    expect(STATIC_ARTIFACT_CSP).toContain("script-src geode-artifact:");
    expect(STATIC_ARTIFACT_CSP).toContain("connect-src 'none'");
    expect(STATIC_ARTIFACT_CSP).toContain("form-action 'none'");
    expect(STATIC_ARTIFACT_CSP).toContain("object-src 'none'");
  });
});

describe("parseLoopbackDevServerUrl", () => {
  it("accepts http://127.0.0.1:<port> with or without a trailing slash", () => {
    expect(parseLoopbackDevServerUrl("http://127.0.0.1:3000")).toEqual({
      ok: true, origin: "http://127.0.0.1:3000", url: "http://127.0.0.1:3000/",
    });
    expect(parseLoopbackDevServerUrl("http://127.0.0.1:65535/")).toMatchObject({ ok: true, origin: "http://127.0.0.1:65535" });
    expect(parseLoopbackDevServerUrl("http://127.0.0.1:1024")).toMatchObject({ ok: true });
  });

  it.each([
    ["localhost", "http://localhost:3000"],
    ["0.0.0.0", "http://0.0.0.0:3000"],
    ["ipv6 loopback", "http://[::1]:3000"],
    ["other host", "http://192.168.1.5:3000"],
    ["https", "https://127.0.0.1:3000"],
    ["ws scheme", "ws://127.0.0.1:3000"],
    ["no port", "http://127.0.0.1"],
    ["port below 1024", "http://127.0.0.1:1023"],
    ["port 80", "http://127.0.0.1:80"],
    ["port above range", "http://127.0.0.1:65536"],
    ["credentials", "http://user:pw@127.0.0.1:3000"],
    ["path", "http://127.0.0.1:3000/app"],
    ["query", "http://127.0.0.1:3000/?x=1"],
    ["empty query", "http://127.0.0.1:3000/?"],
    ["hash", "http://127.0.0.1:3000/#x"],
    ["alternate spelling", "http://127.1:3000"],
    ["suffix host", "http://127.0.0.1.evil.com:3000"],
    ["leading space", " http://127.0.0.1:3000"],
    ["empty", ""],
  ])("rejects %s", (_name, value) => {
    expect(parseLoopbackDevServerUrl(value).ok).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(parseLoopbackDevServerUrl(undefined).ok).toBe(false);
    expect(parseLoopbackDevServerUrl(3000).ok).toBe(false);
  });
});

describe("nextjs artifact request policy", () => {
  const origin = "http://127.0.0.1:3000";
  const allowed = (url: string, use: "document" | "subresource" = "subresource") =>
    isArtifactUrlAllowed(url, "demo", use, origin);

  it("allows only the exact http origin and its ws twin", () => {
    expect(allowed("http://127.0.0.1:3000/", "document")).toBe(true);
    expect(allowed("http://127.0.0.1:3000/_next/static/chunks/main.js")).toBe(true);
    expect(allowed("ws://127.0.0.1:3000/_next/webpack-hmr")).toBe(true);
  });

  it("denies other ports, hosts, schemes and credentials", () => {
    expect(allowed("http://127.0.0.1:3001/")).toBe(false);
    expect(allowed("ws://127.0.0.1:3001/_next/webpack-hmr")).toBe(false);
    expect(allowed("http://localhost:3000/")).toBe(false);
    expect(allowed("http://0.0.0.0:3000/")).toBe(false);
    expect(allowed("https://127.0.0.1:3000/")).toBe(false);
    expect(allowed("wss://127.0.0.1:3000/")).toBe(false);
    expect(allowed("https://example.com/")).toBe(false);
    expect(allowed("http://user:pw@127.0.0.1:3000/")).toBe(false);
    expect(allowed("http://127.0.0.1.evil.com:3000/")).toBe(false);
    expect(allowed("file:///etc/passwd", "document")).toBe(false);
  });

  it("does not serve the geode-artifact scheme for a nextjs artifact", () => {
    expect(allowed("geode-artifact://demo/index.html", "document")).toBe(false);
  });

  it("keeps data:/blob: as inert subresources only", () => {
    expect(allowed("data:image/png;base64,AA==")).toBe(true);
    expect(allowed("data:text/html,hi", "document")).toBe(false);
  });

  it("leaves static behavior unchanged when no origin is given", () => {
    expect(isArtifactUrlAllowed("http://127.0.0.1:3000/", "demo", "document")).toBe(false);
    expect(isArtifactUrlAllowed("geode-artifact://demo/index.html", "demo", "document")).toBe(true);
  });

  it("builds a CSP scoped to the one origin", () => {
    const csp = nextjsArtifactCsp(origin);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:3000");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toBe(STATIC_ARTIFACT_CSP);
  });
});
