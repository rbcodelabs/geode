import { describe, expect, it } from "vitest";
import {
  assetNameFor,
  cmpVersion,
  findReleaseAsset,
  norm,
  parseArgs,
  parseHdiutilMountPoint,
  parsePsOutput,
} from "../../scripts/geode-update.mts";

describe("parseArgs", () => {
  it("defaults everything to false/undefined", () => {
    expect(parseArgs([])).toEqual({
      check: false,
      force: false,
      keep: false,
      user: false,
      help: false,
    });
  });

  it("sets each boolean flag independently", () => {
    expect(parseArgs(["--check"]).check).toBe(true);
    expect(parseArgs(["--force"]).force).toBe(true);
    expect(parseArgs(["--keep"]).keep).toBe(true);
    expect(parseArgs(["--user"]).user).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("captures --version's value and combines with other flags", () => {
    const args = parseArgs(["--force", "--version", "0.2.9", "--keep"]);
    expect(args).toEqual({
      check: false,
      force: true,
      keep: true,
      user: false,
      help: false,
      version: "0.2.9",
    });
  });

  it("throws when --version has no value", () => {
    expect(() => parseArgs(["--version"])).toThrow(/requires a value/);
  });

  it("throws on an unrecognized argument", () => {
    expect(() => parseArgs(["--nonsense"])).toThrow(/unknown argument: --nonsense/);
  });
});

describe("norm", () => {
  it("strips a leading v", () => {
    expect(norm("v0.11.1")).toBe("0.11.1");
    expect(norm("V0.11.1")).toBe("0.11.1");
  });

  it("leaves an already-bare version alone", () => {
    expect(norm("0.11.1")).toBe("0.11.1");
  });
});

describe("cmpVersion", () => {
  it("treats equal versions (with/without v prefix) as equal", () => {
    expect(cmpVersion("0.11.1", "v0.11.1")).toBe(0);
  });

  it("orders by major/minor/patch numerically, not lexically", () => {
    expect(cmpVersion("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(cmpVersion("0.10.0", "0.2.0")).toBeGreaterThan(0);
  });

  it("treats a missing trailing component as 0", () => {
    expect(cmpVersion("0.11", "0.11.0")).toBe(0);
    expect(cmpVersion("0.11.1", "0.11")).toBeGreaterThan(0);
  });
});

describe("assetNameFor", () => {
  it("names the arm64 dmg for arm64", () => {
    expect(assetNameFor("0.11.1", "arm64")).toBe("Geode-0.11.1-arm64.dmg");
  });

  it("names the plain dmg for any non-arm64 arch", () => {
    expect(assetNameFor("0.11.1", "x64")).toBe("Geode-0.11.1.dmg");
  });

  it("normalizes a v-prefixed version first", () => {
    expect(assetNameFor("v0.11.1", "arm64")).toBe("Geode-0.11.1-arm64.dmg");
  });
});

describe("findReleaseAsset", () => {
  const assets = [
    { name: "Geode-0.11.1-arm64.dmg", browser_download_url: "https://example.test/arm64.dmg" },
    { name: "Geode-0.11.1.dmg", browser_download_url: "https://example.test/x64.dmg" },
  ];

  it("matches by exact filename", () => {
    expect(findReleaseAsset(assets, "Geode-0.11.1-arm64.dmg")).toBe(
      "https://example.test/arm64.dmg",
    );
  });

  it("matches case-insensitively", () => {
    expect(findReleaseAsset(assets, "geode-0.11.1-ARM64.dmg")).toBe(
      "https://example.test/arm64.dmg",
    );
  });

  it("returns undefined when nothing matches", () => {
    expect(findReleaseAsset(assets, "Geode-9.9.9.dmg")).toBeUndefined();
  });
});

describe("parseHdiutilMountPoint", () => {
  it("extracts the /Volumes path from typical hdiutil attach output", () => {
    const stdout = [
      "/dev/disk4          \tGUID_partition_scheme",
      "/dev/disk4s1        \tApple_HFS                      \t/Volumes/Geode 0.11.1",
    ].join("\n");
    expect(parseHdiutilMountPoint(stdout)).toBe("/Volumes/Geode 0.11.1");
  });

  it("throws when no mount point line is present", () => {
    expect(() => parseHdiutilMountPoint("/dev/disk4\tGUID_partition_scheme")).toThrow(
      /Could not determine mount point/,
    );
  });
});

describe("parsePsOutput", () => {
  it("splits pid and comm on the first run of whitespace", () => {
    const stdout = [
      "  501 /Applications/Geode.app/Contents/MacOS/Geode",
      "  502 /sbin/launchd",
    ].join("\n");
    expect(parsePsOutput(stdout)).toEqual([
      { pid: 501, comm: "/Applications/Geode.app/Contents/MacOS/Geode" },
      { pid: 502, comm: "/sbin/launchd" },
    ]);
  });

  it("ignores blank lines and lines without a leading pid", () => {
    expect(parsePsOutput("\n   \nnot-a-pid comm\n")).toEqual([]);
  });
});
