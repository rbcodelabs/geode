import { describe, expect, it } from "vitest";
import {
  ManifestError,
  compareVersions,
  isVersionAtLeast,
  parseManifest,
} from "../../src/renderer/plugin-manifest";

const valid = {
  id: "example-plugin",
  name: "Example Plugin",
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "Does example things.",
  author: "Ada Lovelace",
};

describe("parseManifest", () => {
  it("parses a valid manifest", () => {
    const manifest = parseManifest(JSON.stringify(valid));
    expect(manifest).toEqual(valid);
  });

  it("accepts optional authorUrl and isDesktopOnly", () => {
    const raw = { ...valid, authorUrl: "https://example.com", isDesktopOnly: true };
    const manifest = parseManifest(JSON.stringify(raw));
    expect(manifest.authorUrl).toBe("https://example.com");
    expect(manifest.isDesktopOnly).toBe(true);
  });

  it("drops unknown extra fields rather than passing them through", () => {
    const raw = { ...valid, somethingUnexpected: 42 };
    const manifest = parseManifest(JSON.stringify(raw));
    expect(manifest).not.toHaveProperty("somethingUnexpected");
  });

  it("enforces the manifest id matches its folder name when expectedId is given", () => {
    expect(() => parseManifest(JSON.stringify(valid), "different-folder-name")).toThrow(
      ManifestError
    );
    expect(() => parseManifest(JSON.stringify(valid), "example-plugin")).not.toThrow();
  });

  it("rejects malformed JSON", () => {
    expect(() => parseManifest("{not json")).toThrow(ManifestError);
  });

  it("rejects a JSON array or primitive as the top level", () => {
    expect(() => parseManifest("[]")).toThrow(ManifestError);
    expect(() => parseManifest("42")).toThrow(ManifestError);
  });

  it.each(["id", "name", "version", "minAppVersion", "description", "author"])(
    "rejects a manifest missing required field %s",
    (field) => {
      const raw = { ...valid } as Record<string, unknown>;
      delete raw[field];
      expect(() => parseManifest(JSON.stringify(raw))).toThrow(ManifestError);
    }
  );

  it("rejects an id with uppercase or invalid characters", () => {
    expect(() => parseManifest(JSON.stringify({ ...valid, id: "Example_Plugin" }))).toThrow(
      ManifestError
    );
  });

  it("rejects a non-semver version or minAppVersion", () => {
    expect(() => parseManifest(JSON.stringify({ ...valid, version: "v1.0" }))).toThrow(ManifestError);
    expect(() => parseManifest(JSON.stringify({ ...valid, minAppVersion: "latest" }))).toThrow(
      ManifestError
    );
  });
});

describe("compareVersions", () => {
  it("compares equal versions as 0", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("compares numerically, not lexicographically (1.10 > 1.9)", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });

  it("treats a missing patch component as 0", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
  });
});

describe("isVersionAtLeast", () => {
  it("is true when current meets the requirement exactly", () => {
    expect(isVersionAtLeast("0.1.0", "0.1.0")).toBe(true);
  });

  it("is true when current exceeds the requirement", () => {
    expect(isVersionAtLeast("0.2.0", "0.1.0")).toBe(true);
  });

  it("is false when current is below the requirement", () => {
    expect(isVersionAtLeast("0.0.9", "0.1.0")).toBe(false);
  });
});
