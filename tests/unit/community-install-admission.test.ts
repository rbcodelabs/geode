import { describe, expect, it } from "vitest";
import * as community from "../../src/main/community";

const expected = {
  repo: "kepano/obsidian-minimal-settings",
  type: "plugin" as const,
  id: "obsidian-minimal-settings",
  version: "9.0.0",
  minAppVersion: "1.13.0",
  source: "release" as const,
  ref: "9.0.0",
};

const manifest = JSON.stringify({
  id: expected.id,
  name: "Minimal Theme Settings",
  version: expected.version,
  minAppVersion: expected.minAppVersion,
  description: "Fixture",
  author: "@kepano",
});

describe("staged community install admission", () => {
  it("accepts staged bytes matching the admitted resolved identity", () => {
    expect((community as any).validateInstallCandidate(expected, expected, manifest)).toBeUndefined();
  });

  it("rejects changed identity or missing minAppVersion before destination replacement", () => {
    expect(() => (community as any).validateInstallCandidate(
      expected,
      { ...expected, version: "9.0.1", ref: "9.0.1" },
      manifest,
    )).toThrow(/changed after admission/);
    expect(() => (community as any).validateInstallCandidate(
      expected,
      expected,
      JSON.stringify({ ...JSON.parse(manifest), minAppVersion: undefined }),
    )).toThrow(/minAppVersion/);
    expect(() => (community as any).validateInstallCandidate(
      expected,
      expected,
      JSON.stringify({ ...JSON.parse(manifest), id: "different-plugin" }),
    )).toThrow(/does not match/);
  });
});
