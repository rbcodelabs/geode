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

  it("accepts the fill viewport preset", () => {
    const manifest = { ...validManifest, viewport: { preset: "fill", width: 1440, height: 900 } };
    expect(parseArtifactManifest(manifest)).toEqual({ ok: true, manifest });
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
    const result = parseArtifactManifest({ ...validManifest, schemaVersion: 3 });
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

describe("parseArtifactManifest vault permission", () => {
  const withPermissions = (permissions: Record<string, unknown>) => ({
    ...validManifest,
    permissions: { network: "none", clipboard: false, ...permissions },
  });
  const issuePaths = (value: unknown) => {
    const result = parseArtifactManifest(value);
    return result.ok ? [] : result.issues.map((issue) => issue.path);
  };

  it("keeps legacy manifests without vault fields valid", () => {
    expect(parseArtifactManifest(validManifest).ok).toBe(true);
    expect(parseArtifactManifest(withPermissions({ vault: "none" })).ok).toBe(true);
  });

  it("accepts vault read with an allowlist", () => {
    const manifest = withPermissions({ vault: "read", vaultAllowlist: ["Tasks.base", "Projects/", "Bases/*.base"] });
    expect(parseArtifactManifest(manifest)).toEqual({ ok: true, manifest });
  });

  it("requires a non-empty allowlist when vault is read", () => {
    expect(issuePaths(withPermissions({ vault: "read" }))).toContain("permissions.vaultAllowlist");
    expect(issuePaths(withPermissions({ vault: "read", vaultAllowlist: [] }))).toContain("permissions.vaultAllowlist");
    expect(issuePaths(withPermissions({ vault: "read", vaultAllowlist: "Tasks.base" }))).toContain("permissions.vaultAllowlist");
  });

  it("rejects an allowlist without vault read", () => {
    expect(issuePaths(withPermissions({ vaultAllowlist: ["Tasks.base"] }))).toContain("permissions.vaultAllowlist");
    expect(issuePaths(withPermissions({ vault: "none", vaultAllowlist: ["Tasks.base"] }))).toContain("permissions.vaultAllowlist");
  });

  it("rejects unknown vault modes, including write", () => {
    expect(issuePaths(withPermissions({ vault: "write", vaultAllowlist: ["a.base"] }))).toContain("permissions.vault");
    expect(issuePaths(withPermissions({ vault: true }))).toContain("permissions.vault");
  });

  it.each(["../x.base", "/etc/x.base", "a/../../x.base", "C:\\x.base", "a\\b.base", "**", "**/*", 5])(
    "rejects traversal, absolute or over-broad allowlist entry %j",
    (entry) => {
      expect(issuePaths(withPermissions({ vault: "read", vaultAllowlist: [entry] })))
        .toContain("permissions.vaultAllowlist[0]");
    },
  );

  it("still rejects unknown permission fields", () => {
    expect(issuePaths(withPermissions({ vault: "read", vaultAllowlist: ["a.base"], filesystem: "all" })))
      .toContain("permissions.filesystem");
  });
});

describe("parseArtifactManifest schema v2", () => {
  const v2Static = { ...validManifest, schemaVersion: 2 };
  const v2Nextjs = {
    ...validManifest,
    schemaVersion: 2,
    entry: "app/page.tsx",
    runtime: "nextjs",
    permissions: { network: "loopback", clipboard: false },
  };
  const issuePaths = (value: unknown): string[] => {
    const result = parseArtifactManifest(value);
    return result.ok ? [] : result.issues.map((issue) => issue.path);
  };

  it("accepts a v2 static manifest", () => {
    expect(parseArtifactManifest(v2Static)).toEqual({ ok: true, manifest: v2Static });
  });

  it("accepts a v2 nextjs manifest with loopback network", () => {
    expect(parseArtifactManifest(v2Nextjs)).toEqual({ ok: true, manifest: v2Nextjs });
  });

  it("keeps v1 static-only: nextjs and loopback are rejected under schema 1", () => {
    expect(issuePaths({ ...v2Nextjs, schemaVersion: 1 })).toEqual(expect.arrayContaining(["runtime", "permissions.network"]));
    expect(issuePaths({ ...validManifest, permissions: { network: "loopback", clipboard: false } })).toEqual(["permissions.network"]);
  });

  it("still rejects unknown runtimes under v2", () => {
    expect(issuePaths({ ...v2Static, runtime: "vite" })).toContain("runtime");
  });

  it("couples runtime and network", () => {
    expect(issuePaths({ ...v2Nextjs, permissions: { network: "none", clipboard: false } })).toEqual(["permissions.network"]);
    expect(issuePaths({ ...v2Static, permissions: { network: "loopback", clipboard: false } })).toEqual(["permissions.network"]);
    expect(issuePaths({ ...v2Nextjs, permissions: { network: "any", clipboard: false } })).toEqual(["permissions.network"]);
  });

  it("rejects vault read access for nextjs and keeps clipboard false", () => {
    expect(issuePaths({
      ...v2Nextjs,
      permissions: { network: "loopback", clipboard: false, vault: "read", vaultAllowlist: ["a.base"] },
    })).toEqual(["permissions.vault"]);
    expect(issuePaths({ ...v2Nextjs, permissions: { network: "loopback", clipboard: true } })).toEqual(["permissions.clipboard"]);
  });

  it("still validates entry as a portable relative path for nextjs", () => {
    expect(issuePaths({ ...v2Nextjs, entry: "../page.tsx" })).toEqual(["entry"]);
  });
});
