import { describe, expect, it } from "vitest";
import { isArtifactUrlAllowed, STATIC_ARTIFACT_CSP } from "../../src/artifacts/security-policy";

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
