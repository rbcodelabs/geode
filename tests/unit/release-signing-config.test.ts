import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  build: { appId: string; forceCodeSigning?: boolean; mac: Record<string, unknown> };
};

describe("macOS release trust configuration", () => {
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
  });
});
