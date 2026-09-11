import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as community from "../../src/main/community";

const tempDirs: string[] = [];
const originalApiBase = process.env.GEODE_GITHUB_API_BASE;

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalApiBase === undefined) delete process.env.GEODE_GITHUB_API_BASE;
  else process.env.GEODE_GITHUB_API_BASE = originalApiBase;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

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

  it("accepts only the exact catalog-certified distributable bytes", () => {
    const files = {
      "manifest.json": Buffer.from(manifest),
      "main.js": Buffer.from("module.exports = class {}"),
    };
    const hashes = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [
      name,
      createHash("sha256").update(bytes).digest("hex"),
    ]));

    expect((community as any).validateArtifactHashes(hashes, files)).toBeUndefined();
    expect(() => (community as any).validateArtifactHashes(hashes, {
      ...files,
      "main.js": Buffer.from("tampered"),
    })).toThrow(/main\.js.*SHA-256/i);
    expect(() => (community as any).validateArtifactHashes(
      { ...hashes, "styles.css": "b".repeat(64) },
      files,
    )).toThrow(/styles\.css.*missing/i);
    expect(() => (community as any).validateArtifactHashes(hashes, {
      ...files,
      "styles.css": Buffer.from("unexpected"),
    })).toThrow(/styles\.css.*not certified/i);
  });

  it("leaves the existing destination intact when a catalog artifact hash is tampered", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "geode-catalog-install-"));
    tempDirs.push(root);
    const destination = path.join(root, ".geode", "plugins", "catalog-plugin");
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(destination, "manifest.json"), '{"id":"catalog-plugin","version":"0.9.0"}');
    await fs.writeFile(path.join(destination, "main.js"), "existing trusted bytes");

    const api = "https://catalog-install.test";
    process.env.GEODE_GITHUB_API_BASE = api;
    const stagedManifest = JSON.stringify({
      id: "catalog-plugin", name: "Catalog Plugin", version: "1.0.0", minAppVersion: "0.1.0",
      description: "Catalog fixture", author: "Geode tests",
    });
    const stagedMain = "tampered bytes";
    const releases = [{
      tag_name: "1.0.0", prerelease: false, published_at: "2026-09-09T00:00:00Z",
      assets: [
        { name: "manifest.json", browser_download_url: `${api}/manifest.json` },
        { name: "main.js", browser_download_url: `${api}/main.js` },
      ],
    }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === `${api}/repos/owner/repo/releases`) return new Response(JSON.stringify(releases));
      if (url === `${api}/manifest.json`) return new Response(stagedManifest);
      if (url === `${api}/main.js`) return new Response(stagedMain);
      return new Response("not found", { status: 404 });
    }));

    await expect(community.installCommunity(root, "owner/repo", {
      type: "plugin",
      tag: "1.0.0",
      expected: {
        repo: "owner/repo", type: "plugin", id: "catalog-plugin", name: "Catalog Plugin",
        version: "1.0.0", minAppVersion: "0.1.0", source: "release", ref: "1.0.0",
        artifactHashes: {
          "manifest.json": createHash("sha256").update(stagedManifest).digest("hex"),
          "main.js": createHash("sha256").update("certified bytes").digest("hex"),
        },
      },
    })).rejects.toThrow(/main\.js.*SHA-256/i);
    expect(await fs.readFile(path.join(destination, "main.js"), "utf8")).toBe("existing trusted bytes");
    expect((await fs.readdir(path.join(root, ".geode"))).filter((name) => name.startsWith("install-"))).toEqual([]);
  });
});
