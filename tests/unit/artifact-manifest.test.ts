import { describe, expect, it } from "vitest";
import { parseArtifactManifest, parseArtifactManifestJson } from "../../src/artifacts/manifest";

const validManifest = {
  schemaVersion: 1,
  id: "checkout-concept",
  title: "Checkout concept",
  entry: "screens/index.html",
  runtime: "static",
  createdByThreadId: "thread-123",
  viewport: { preset: "desktop", width: 1440, height: 900 },
  permissions: { network: "none", clipboard: false },
};

describe("parseArtifactManifest", () => {
  it("accepts the complete static v1 contract", () => {
    expect(parseArtifactManifest(validManifest)).toEqual({ ok: true, manifest: validManifest });
  });

  it.each(["../index.html", "/tmp/index.html", "C:\\tmp\\index.html", "screens//index.html", "./index.html"])(
    "rejects non-portable or escaping entry %s",
    (entry) => {
      const result = parseArtifactManifest({ ...validManifest, entry });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues).toContainEqual(expect.objectContaining({ path: "entry", code: "invalid_value" }));
    },
  );

  it("rejects unknown capabilities and reports all actionable paths", () => {
    const result = parseArtifactManifest({
      ...validManifest,
      runtime: "vite",
      extra: true,
      viewport: { ...validManifest.viewport, width: 100, surprise: true },
      permissions: { network: "all", clipboard: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
        "extra",
        "runtime",
        "viewport.width",
        "viewport.surprise",
        "permissions.network",
        "permissions.clipboard",
      ]));
    }
  });

  it("rejects future schemas instead of guessing", () => {
    const result = parseArtifactManifest({ ...validManifest, schemaVersion: 2 });
    expect(result).toEqual({
      ok: false,
      issues: [expect.objectContaining({ code: "unsupported_schema", path: "schemaVersion" })],
    });
  });

  it("returns a structured issue for invalid JSON", () => {
    expect(parseArtifactManifestJson("{")).toEqual({
      ok: false,
      issues: [{ code: "invalid_value", path: "$", message: "Manifest is not valid JSON." }],
    });
  });
});
