import { describe, expect, it } from "vitest";
import { compareVersions, isValidRange, parseRange, parseVersion, rangeIncludesPrerelease, satisfies } from "../../src/shared/semver-range";

describe("parseVersion / compareVersions", () => {
  it("parses release tags with a leading v and ignores build metadata", () => {
    expect(parseVersion("v1.4.2")).toMatchObject({ major: 1, minor: 4, patch: 2 });
    expect(parseVersion("1.0.0+build.5")).toMatchObject({ major: 1, prerelease: [] });
  });
  it.each(["1.2", "latest", "1.2.3.4", "", "01.2.x", "1.2.3-"])("rejects %j", (s) => {
    expect(parseVersion(s)).toBeNull();
  });
  it("orders by semver precedence including prereleases", () => {
    const order = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];
    const parsed = order.map((s) => parseVersion(s)!);
    for (let i = 0; i < parsed.length - 1; i++) expect(compareVersions(parsed[i], parsed[i + 1])).toBeLessThan(0);
  });
});

describe("satisfies", () => {
  it.each([
    ["^1.4.0", "1.4.0", true],
    ["^1.4.0", "1.9.9", true],
    ["^1.4.0", "1.3.9", false],
    ["^1.4.0", "2.0.0", false],
    ["^0.2.3", "0.2.9", true],
    ["^0.2.3", "0.3.0", false],
    ["^0.0.3", "0.0.3", true],
    ["^0.0.3", "0.0.4", false],
    ["^1", "1.99.0", true],
    ["^0", "0.9.0", true],
    ["^0", "1.0.0", false],
    ["~1.2.3", "1.2.9", true],
    ["~1.2.3", "1.3.0", false],
    ["~1.2", "1.2.0", true],
    ["~1", "1.9.0", true],
    [">=1.4.2 <2", "1.4.2", true],
    [">=1.4.2 <2", "1.4.1", false],
    [">=1.4.2 <2", "2.0.0", false],
    [">= 1.4.2 < 2", "1.5.0", true],
    ["1.2.3", "1.2.3", true],
    ["1.2.3", "1.2.4", false],
    ["=1.2.3", "1.2.3", true],
    ["1.2.x", "1.2.7", true],
    ["1.2.x", "1.3.0", false],
    ["1.x", "1.9.0", true],
    ["*", "9.9.9", true],
    ["1.2.3 - 2.3.4", "2.3.4", true],
    ["1.2.3 - 2.3.4", "2.3.5", false],
    ["1.2.3 - 2.3", "2.3.9", true],
    ["1.2.3 - 2.3", "2.4.0", false],
    ["^1.0.0 || ^3.0.0", "3.1.0", true],
    ["^1.0.0 || ^3.0.0", "2.0.0", false],
    [">1.2", "1.3.0", true],
    [">1.2", "1.2.9", false],
    ["<=1.2", "1.2.9", true],
    ["<1.2.3", "1.2.2", true],
    ["<1.2.3", "1.2.3", false],
  ])("range %j vs %s -> %s", (range, version, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it("excludes prereleases unless the range names a prerelease on that tuple", () => {
    expect(satisfies("1.5.0-beta.1", "^1.4.0")).toBe(false);
    expect(satisfies("1.5.0-beta.1", ">=1.4.0")).toBe(false);
    expect(satisfies("1.5.0-beta.1", "^1.5.0-beta.0")).toBe(true);
    expect(satisfies("1.5.0-beta.1", "^1.4.0-0")).toBe(false); // prerelease on a different tuple
    expect(satisfies("1.4.0-rc.1", "^1.4.0-rc.0")).toBe(true);
    expect(satisfies("1.5.0", "^1.5.0-beta.0")).toBe(true);
  });

  it("never matches an unparseable version", () => {
    expect(satisfies("nightly", "*")).toBe(false);
  });
});

describe("range validation", () => {
  it.each(["^1.4.0", ">=1.4.2 <2", "~1.2", "1.x", "*", "1.2.3 - 2", "^1 || ^2", ">=1.0.0-beta.1"])("accepts %j", (r) => {
    expect(isValidRange(r)).toBe(true);
  });
  it.each(["", "   ", "latest", "^", "^^1.0.0", "1.2.3.4", ">=", "1.x.3-beta", "foo || ^1", "~>1.2", 5, null, "^1.0.0 ||", "a".repeat(300)])(
    "rejects %j",
    (r) => {
      expect(isValidRange(r)).toBe(false);
    },
  );
  it("parseRange throws a readable message", () => {
    expect(() => parseRange("not a range")).toThrow(/Invalid version range/);
  });
  it("detects ranges that opt into prereleases", () => {
    expect(rangeIncludesPrerelease("^1.4.0")).toBe(false);
    expect(rangeIncludesPrerelease("^1.4.0 || >=2.0.0-rc.1")).toBe(true);
  });
});
