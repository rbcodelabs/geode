import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPluginBlocked, validatePolicy, type ManagedPolicy } from "../../src/renderer/policy";

describe("isPluginBlocked", () => {
  it("never blocks when policy is null", () => {
    expect(isPluginBlocked(null, "some-plugin")).toBe(false);
  });

  it("never blocks when policy has no plugins key", () => {
    const policy: ManagedPolicy = { policyVersion: 1 };
    expect(isPluginBlocked(policy, "some-plugin")).toBe(false);
  });

  it("blocklist mode blocks only listed ids", () => {
    const policy: ManagedPolicy = {
      policyVersion: 1,
      plugins: { mode: "blocklist", ids: ["bad-plugin"] },
    };
    expect(isPluginBlocked(policy, "bad-plugin")).toBe(true);
    expect(isPluginBlocked(policy, "good-plugin")).toBe(false);
  });

  it("blocklist mode with an empty list blocks nothing", () => {
    const policy: ManagedPolicy = { policyVersion: 1, plugins: { mode: "blocklist", ids: [] } };
    expect(isPluginBlocked(policy, "any-plugin")).toBe(false);
  });

  it("allowlist mode blocks everything not listed", () => {
    const policy: ManagedPolicy = {
      policyVersion: 1,
      plugins: { mode: "allowlist", ids: ["good-plugin"] },
    };
    expect(isPluginBlocked(policy, "good-plugin")).toBe(false);
    expect(isPluginBlocked(policy, "other-plugin")).toBe(true);
  });

  it("allowlist mode with an empty list blocks everything", () => {
    const policy: ManagedPolicy = { policyVersion: 1, plugins: { mode: "allowlist", ids: [] } };
    expect(isPluginBlocked(policy, "any-plugin")).toBe(true);
  });
});

describe("validatePolicy", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null for a non-object document", () => {
    expect(validatePolicy(null)).toBeNull();
    expect(validatePolicy("nope")).toBeNull();
    expect(validatePolicy([1, 2, 3])).toBeNull();
  });

  it("returns null when policyVersion is missing", () => {
    expect(validatePolicy({ plugins: { mode: "blocklist", ids: [] } })).toBeNull();
  });

  it("returns null when policyVersion is unrecognized", () => {
    expect(validatePolicy({ policyVersion: 2 })).toBeNull();
    expect(validatePolicy({ policyVersion: "1" })).toBeNull();
  });

  it("accepts a document with only policyVersion (plugins absent = no restriction)", () => {
    const result = validatePolicy({ policyVersion: 1 });
    expect(result).toEqual({ policyVersion: 1 });
  });

  it("parses a valid blocklist policy", () => {
    const result = validatePolicy({
      policyVersion: 1,
      plugins: { mode: "blocklist", ids: ["some-untrusted-plugin"] },
    });
    expect(result).toEqual({
      policyVersion: 1,
      plugins: { mode: "blocklist", ids: ["some-untrusted-plugin"] },
    });
  });

  it("parses a valid allowlist policy", () => {
    const result = validatePolicy({
      policyVersion: 1,
      plugins: { mode: "allowlist", ids: ["trusted-plugin"] },
    });
    expect(result?.plugins).toEqual({ mode: "allowlist", ids: ["trusted-plugin"] });
  });

  it("skips invalid ids in the list but keeps the rest (not fatal to the whole policy)", () => {
    const result = validatePolicy({
      policyVersion: 1,
      plugins: { mode: "blocklist", ids: ["good-id", "Bad ID!", "", "ANOTHER_BAD", 42, "another-good-id"] },
    });
    expect(result?.plugins?.ids).toEqual(["good-id", "another-good-id"]);
  });

  it("treats plugins.mode as absent-equivalent (whole plugins block ignored) when mode is invalid", () => {
    const result = validatePolicy({
      policyVersion: 1,
      plugins: { mode: "denylist", ids: ["x"] },
    });
    expect(result).toEqual({ policyVersion: 1 });
    expect(result?.plugins).toBeUndefined();
  });

  it("ignores plugins block when ids is not an array", () => {
    const result = validatePolicy({
      policyVersion: 1,
      plugins: { mode: "blocklist", ids: "not-an-array" },
    });
    expect(result?.plugins).toBeUndefined();
  });

  it("ignores plugins block when it is not an object", () => {
    const result = validatePolicy({ policyVersion: 1, plugins: "nope" });
    expect(result?.plugins).toBeUndefined();
  });
});
