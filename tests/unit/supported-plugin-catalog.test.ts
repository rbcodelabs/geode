import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CATALOG_BYTES,
  SUPPORTED_PLUGIN_CATALOG_URL,
  SupportedPluginCatalogService,
  parseSupportedPluginCatalog,
} from "../../src/main/supported-plugin-catalog";

const HASH = "a".repeat(64);
const validCatalog = {
  schemaVersion: 1,
  plugins: [{
    id: "calendar",
    name: "Calendar",
    description: "Calendar view for daily notes.",
    github: { owner: "liamcain", repo: "obsidian-calendar-plugin" },
    manifest: { version: "1.5.10", releaseTag: "1.5.10", minAppVersion: "0.9.11" },
    platforms: ["desktop"],
    minimumGeodeVersion: "0.2.19",
    certifiedWithGeodeVersion: "0.2.19",
    artifactHashes: { "manifest.json": HASH, "main.js": HASH },
    evidenceUrl: `https://github.com/rbcodelabs/geode/blob/${"c".repeat(40)}/tests/e2e/calendar-plugin.spec.ts`,
    status: "active",
  }],
};

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("supported-plugin catalog v1 validation", () => {
  it("uses the approved permanent registry endpoint", () => {
    expect(SUPPORTED_PLUGIN_CATALOG_URL).toBe("https://geode.rbcodelabs.com/supported-plugins/v1.json");
  });

  it("accepts the complete strict v1 contract", () => {
    expect(parseSupportedPluginCatalog(validCatalog)).toEqual(validCatalog);
  });

  it.each([
    [{ ...validCatalog, schemaVersion: 2 }, /schemaVersion/],
    [{ ...validCatalog, extra: true }, /unknown field.*extra/i],
    [{ ...validCatalog, plugins: [{ ...validCatalog.plugins[0], github: { owner: "bad/owner", repo: "r" } }] }, /github\.owner/],
    [{ ...validCatalog, plugins: [{ ...validCatalog.plugins[0], artifactHashes: { "manifest.json": HASH } }] }, /main\.js/],
    [{ ...validCatalog, plugins: [{ ...validCatalog.plugins[0], artifactHashes: { ...validCatalog.plugins[0].artifactHashes, "main.js": "A".repeat(64) } }] }, /main\.js/],
    [{ ...validCatalog, plugins: [{ ...validCatalog.plugins[0], platforms: [] }] }, /platforms/],
    [{ ...validCatalog, plugins: [{ ...validCatalog.plugins[0], manifest: { ...validCatalog.plugins[0].manifest, version: "1.0.0-01" } }] }, /semantic version/],
    [{ ...validCatalog, plugins: [{ ...validCatalog.plugins[0], evidenceUrl: "https://github.com/rbcodelabs/geode/blob/main/tests/e2e/calendar-plugin.spec.ts" }] }, /full commit SHA/],
    [{ ...validCatalog, plugins: [validCatalog.plugins[0], { ...validCatalog.plugins[0] }] }, /duplicate plugin id/i],
  ])("rejects a malformed whole envelope", (input, error) => {
    expect(() => parseSupportedPluginCatalog(input)).toThrow(error);
  });
});

describe("SupportedPluginCatalogService", () => {
  it("returns validated remote data and atomically persists a last-known-good cache", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "geode-catalog-")); dirs.push(dir);
    const cachePath = path.join(dir, "supported-plugins-v1.json");
    const service = new SupportedPluginCatalogService({
      cachePath,
      fetch: vi.fn(async () => new Response(JSON.stringify(validCatalog))),
      now: () => new Date("2026-09-09T12:00:00.000Z"),
    });

    await expect(service.load()).resolves.toEqual({
      status: "fresh",
      fetchedAt: "2026-09-09T12:00:00.000Z",
      catalog: validCatalog,
    });
    expect(JSON.parse(await fs.readFile(cachePath, "utf8"))).toEqual({
      fetchedAt: "2026-09-09T12:00:00.000Z",
      catalog: validCatalog,
    });
  });

  it("keeps and returns the last-known-good cache as stale when remote validation fails", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "geode-catalog-")); dirs.push(dir);
    const cachePath = path.join(dir, "supported-plugins-v1.json");
    const cached = { fetchedAt: "2026-09-08T09:00:00.000Z", catalog: validCatalog };
    await fs.writeFile(cachePath, JSON.stringify(cached));
    const service = new SupportedPluginCatalogService({
      cachePath,
      fetch: vi.fn(async () => new Response(JSON.stringify({ ...validCatalog, schemaVersion: 99 }))),
    });

    const result = await service.load();
    expect(result).toEqual({ ...cached, status: "stale", error: expect.stringMatching(/schemaVersion/) });
    expect(JSON.parse(await fs.readFile(cachePath, "utf8"))).toEqual(cached);
  });

  it("returns unavailable without exposing unvalidated data when no valid cache exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "geode-catalog-")); dirs.push(dir);
    const service = new SupportedPluginCatalogService({
      cachePath: path.join(dir, "missing.json"),
      fetch: vi.fn(async () => new Response("{}")),
    });
    await expect(service.load()).resolves.toEqual({
      status: "unavailable",
      error: expect.any(String),
    });
  });

  it("aborts a request after the timeout bound", async () => {
    vi.useFakeTimers();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "geode-catalog-")); dirs.push(dir);
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const service = new SupportedPluginCatalogService({
      cachePath: path.join(dir, "missing.json"), fetch, timeoutMs: 25,
    });
    const result = service.load();
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toEqual({ status: "unavailable", error: expect.stringMatching(/aborted/) });
  });

  it("rejects a streamed body as soon as it exceeds the response-size bound", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "geode-catalog-")); dirs.push(dir);
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_CATALOG_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const service = new SupportedPluginCatalogService({
      cachePath: path.join(dir, "missing.json"),
      fetch: vi.fn(async () => new Response(oversized)),
    });
    await expect(service.load()).resolves.toEqual({
      status: "unavailable",
      error: expect.stringMatching(/too large/i),
    });
  });
});
