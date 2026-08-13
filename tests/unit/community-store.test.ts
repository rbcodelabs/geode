import { describe, expect, it } from "vitest";
import {
  DEFAULT_CADENCE_MS,
  emptyConfig,
  findItem,
  itemsToCheck,
  normalizeConfig,
  removeItem,
  shouldUpdate,
  upsertItem,
  type CommunityItem,
} from "../../src/renderer/community/store";

function item(overrides: Partial<CommunityItem> = {}): CommunityItem {
  return {
    repo: "owner/repo",
    type: "plugin",
    id: "my-plugin",
    installedVersion: "1.0.0",
    source: "release",
    autoUpdate: false,
    ...overrides,
  };
}

// --- normalizeConfig --------------------------------------------------------

describe("normalizeConfig", () => {
  it("returns an empty config for null / non-object (missing or corrupt file)", () => {
    expect(normalizeConfig(null)).toEqual(emptyConfig());
    expect(normalizeConfig("garbage")).toEqual(emptyConfig());
    expect(normalizeConfig({})).toEqual(emptyConfig());
  });

  it("keeps well-formed items and drops malformed rows", () => {
    const raw = {
      version: 1,
      items: [
        {
          repo: "o/good",
          type: "plugin",
          id: "good",
          installedVersion: "1.0.0",
          source: "release",
          autoUpdate: true,
          ref: "1.0.0",
          pinnedVersion: "1.0.0",
          lastChecked: 123,
          etag: "abc",
          assets: { "main.js": "deadbeef" },
        },
        { repo: "o/bad", type: "nope", id: "bad", installedVersion: "1", source: "release" },
        { nonsense: true },
      ],
    };
    const cfg = normalizeConfig(raw);
    expect(cfg.items).toHaveLength(1);
    expect(cfg.items[0]).toEqual({
      repo: "o/good",
      type: "plugin",
      id: "good",
      installedVersion: "1.0.0",
      source: "release",
      autoUpdate: true,
      ref: "1.0.0",
      pinnedVersion: "1.0.0",
      lastChecked: 123,
      etag: "abc",
      assets: { "main.js": "deadbeef" },
    });
  });

  it("defaults autoUpdate to false when absent (opt-in policy)", () => {
    const cfg = normalizeConfig({
      items: [{ repo: "o/r", type: "theme", id: "t", installedVersion: "1.0.0", source: "raw" }],
    });
    expect(cfg.items[0].autoUpdate).toBe(false);
  });
});

// --- upsert / remove / find -------------------------------------------------

describe("upsertItem / removeItem / findItem", () => {
  it("appends a new repo and preserves order", () => {
    let cfg = emptyConfig();
    cfg = upsertItem(cfg, item({ repo: "o/a" }));
    cfg = upsertItem(cfg, item({ repo: "o/b" }));
    expect(cfg.items.map((i) => i.repo)).toEqual(["o/a", "o/b"]);
  });

  it("replaces an existing repo in place (no duplicate, keeps slot)", () => {
    let cfg = emptyConfig();
    cfg = upsertItem(cfg, item({ repo: "o/a", installedVersion: "1.0.0" }));
    cfg = upsertItem(cfg, item({ repo: "o/b" }));
    cfg = upsertItem(cfg, item({ repo: "o/a", installedVersion: "2.0.0" }));
    expect(cfg.items).toHaveLength(2);
    expect(cfg.items[0].repo).toBe("o/a");
    expect(cfg.items[0].installedVersion).toBe("2.0.0");
  });

  it("does not mutate the input config", () => {
    const cfg = emptyConfig();
    const next = upsertItem(cfg, item());
    expect(cfg.items).toHaveLength(0);
    expect(next).not.toBe(cfg);
  });

  it("removes by repo and is a no-op when absent", () => {
    let cfg = upsertItem(emptyConfig(), item({ repo: "o/a" }));
    cfg = removeItem(cfg, "o/missing");
    expect(cfg.items).toHaveLength(1);
    cfg = removeItem(cfg, "o/a");
    expect(cfg.items).toHaveLength(0);
  });

  it("finds by repo", () => {
    const cfg = upsertItem(emptyConfig(), item({ repo: "o/a", id: "aa" }));
    expect(findItem(cfg, "o/a")?.id).toBe("aa");
    expect(findItem(cfg, "o/none")).toBeUndefined();
  });
});

// --- itemsToCheck -----------------------------------------------------------

describe("itemsToCheck", () => {
  const now = 1_000_000_000;

  it("only includes opt-in (autoUpdate) items", () => {
    const cfg = {
      version: 1 as const,
      items: [item({ repo: "o/on", autoUpdate: true }), item({ repo: "o/off", autoUpdate: false })],
    };
    expect(itemsToCheck(cfg, now).map((i) => i.repo)).toEqual(["o/on"]);
  });

  it("excludes pinned items", () => {
    const cfg = {
      version: 1 as const,
      items: [item({ repo: "o/pin", autoUpdate: true, pinnedVersion: "1.0.0" })],
    };
    expect(itemsToCheck(cfg, now)).toHaveLength(0);
  });

  it("includes never-checked items and respects cadence for recently-checked ones", () => {
    const cfg = {
      version: 1 as const,
      items: [
        item({ repo: "o/never", autoUpdate: true }),
        item({ repo: "o/stale", autoUpdate: true, lastChecked: now - DEFAULT_CADENCE_MS - 1 }),
        item({ repo: "o/fresh", autoUpdate: true, lastChecked: now - 1000 }),
      ],
    };
    expect(itemsToCheck(cfg, now).map((i) => i.repo).sort()).toEqual(["o/never", "o/stale"]);
  });
});

// --- shouldUpdate -----------------------------------------------------------

describe("shouldUpdate", () => {
  it("updates when the remote version is newer", () => {
    expect(shouldUpdate(item({ installedVersion: "1.0.0" }), "1.1.0")).toEqual({
      update: true,
      reason: "update-available",
    });
  });

  it("does not update when up-to-date", () => {
    expect(shouldUpdate(item({ installedVersion: "1.2.0" }), "1.2.0").reason).toBe("up-to-date");
  });

  it("never downgrades", () => {
    const d = shouldUpdate(item({ installedVersion: "2.0.0" }), "1.9.0");
    expect(d).toEqual({ update: false, reason: "downgrade" });
  });

  it("never updates a pinned item, even to a newer version", () => {
    const d = shouldUpdate(item({ installedVersion: "1.0.0", pinnedVersion: "1.0.0" }), "3.0.0");
    expect(d).toEqual({ update: false, reason: "pinned" });
  });

  it("refuses an update that requires a newer Geode API than we run", () => {
    const d = shouldUpdate(item({ installedVersion: "1.0.0" }), "2.0.0", {
      minAppVersion: "99.0.0",
      apiVersion: "1.8.0",
    });
    expect(d).toEqual({ update: false, reason: "requires-newer-app" });
  });

  it("allows an update whose minAppVersion is satisfied", () => {
    const d = shouldUpdate(item({ installedVersion: "1.0.0" }), "2.0.0", {
      minAppVersion: "1.5.0",
      apiVersion: "1.8.0",
    });
    expect(d.update).toBe(true);
  });
});
