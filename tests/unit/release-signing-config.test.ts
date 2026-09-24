import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  build: { appId: string; forceCodeSigning?: boolean; mac: Record<string, unknown> };
};

describe("macOS release trust configuration", () => {
  it("executes the workflow manifest check against arm64, Intel, mixed, and incomplete releases", () => {
    const workflow = YAML.parse(readFileSync(".github/workflows/release.yml", "utf8"));
    const step = workflow.jobs["build-mac"].steps.find((item: { name?: string }) => item.name === "Verify signed artifacts and updater manifest");
    const script = step.run.split("node <<'NODE'\n")[1].split("\nNODE")[0];
    const arm = "Geode-1.0.0-arm64-mac.zip";
    const intel = "Geode-1.0.0-mac.zip";
    const check = (names: string[], missing?: string) => runInNewContext(script, {
      require: (name: string) => {
        if (name === "node:path") return path;
        if (name === "yaml") return YAML;
        if (name === "node:fs") return {
          existsSync: (file: string) => file !== missing,
          readFileSync: () => YAML.stringify({ files: names.map(url => ({ url })) }),
        };
        throw new Error(`Unexpected module ${name}`);
      },
    });
    expect(() => check([arm])).not.toThrow();
    expect(() => check([intel])).toThrow(/one arm64 ZIP/);
    expect(() => check([arm, intel])).toThrow(/one arm64 ZIP/);
    expect(() => check([])).toThrow(/one arm64 ZIP/);
    expect(() => check([arm], `release/${arm}`)).toThrow(/ZIP missing/);
    expect(() => check([arm], `release/${arm}.blockmap`)).toThrow(/blockmap missing/);
  });
  it("ships only Apple Silicon DMG and ZIP targets", () => {
    expect(pkg.build.mac.target).toEqual([
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] },
    ]);
  });
  it("requires Developer ID signing, hardened runtime, notarization, and explicit entitlements", () => {
    expect(pkg.build.appId).toBe("com.rbcodelabs.geode");
    expect(pkg.build.forceCodeSigning).toBe(true);
    expect(pkg.build.mac).toMatchObject({
      hardenedRuntime: true,
      notarize: true,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.inherit.plist",
    });
    expect(pkg.build.mac).not.toHaveProperty("identity", "-");
  });

  it.each(["build/entitlements.mac.plist", "build/entitlements.mac.inherit.plist"])(
    "%s grants only JIT",
    (path) => {
      const plist = readFileSync(path, "utf8");
      expect([...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1])).toEqual([
        "com.apple.security.cs.allow-jit",
      ]);
    },
  );

  it("keeps release credentials protected and publication draft-first", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    expect(workflow).toContain("environment: macos-release");
    for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY_BASE64", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_TEAM_ID"]) {
      expect(workflow).toContain(name);
    }
    expect(workflow).toContain("chmod 600");
    expect(workflow).toContain("codesign --verify --deep --strict");
    expect(workflow).toContain("spctl --assess --type execute");
    expect(workflow).toContain("xcrun stapler validate");
    expect(workflow.indexOf("--draft --title")).toBeLessThan(workflow.indexOf("gh release upload"));
    expect(workflow.indexOf("gh release upload")).toBeLessThan(workflow.indexOf("--draft=false"));
    expect(workflow).toContain("if: github.ref_type == 'tag'");
    const jobPrefix = workflow.slice(0, workflow.indexOf("steps:"));
    expect(jobPrefix).not.toContain("CSC_LINK:");
    expect(jobPrefix).not.toContain("APPLE_API_KEY_BASE64:");
    const installIndex = workflow.indexOf("name: Install dependencies");
    const packageIndex = workflow.indexOf("name: Package, sign, notarize, and staple");
    expect(workflow.indexOf("CSC_LINK:")).toBeGreaterThan(packageIndex);
    expect(workflow.indexOf("CSC_LINK:")).toBeGreaterThan(installIndex);
    expect(workflow).toContain("GEODE_PINNED_TEAM_ID");
  });
});
