import { describe, expect, it, vi } from "vitest";
import { ArtifactVaultBridge, type VaultBridgeVault } from "../../src/renderer/artifacts/vault-bridge";
import { MetadataCache } from "../../src/renderer/metadata-cache";
import type { TFile } from "../../src/renderer/types";
import { FakeVault } from "../helpers/fake-vault";

class ReadableFakeVault extends FakeVault {
  async read(file: TFile): Promise<string> { return this.cachedRead(file); }
}

const TASKS_BASE = `
filters:
  and:
    - 'status != "done"'
formulas:
  double: "priority * 2"
views:
  - type: table
    name: Main
    sort:
      - property: note.priority
        direction: ASC
    order:
      - file.name
      - note.status
      - note.priority
      - formula.double
  - type: table
    name: ByStatus
    groupBy:
      property: note.status
      direction: ASC
    order:
      - file.name
`;

async function setup(allowlist: string[]) {
  const fake = new ReadableFakeVault({
    "Tasks.base": TASKS_BASE,
    "Private/Secret.base": "views:\n  - type: table\n    name: Main\n    order: [file.name]\n",
    "Broken.base": "views: [\n",
    "Notes/A.md": "---\nstatus: todo\npriority: 2\n---\n",
    "Notes/B.md": "---\nstatus: active\npriority: 1\n---\n",
    "Notes/C.md": "---\nstatus: done\npriority: 3\n---\n",
    "Notes/D.md": "---\nstatus: todo\npriority: 4\n---\n",
  });
  const vault = fake.asVault();
  const metadataCache = new MetadataCache(vault);
  await metadataCache.initialize();
  const bridge = new ArtifactVaultBridge(fake as unknown as VaultBridgeVault, metadataCache, allowlist);
  return { fake, metadataCache, bridge };
}

describe("ArtifactVaultBridge.query", () => {
  it("runs an allowlisted base and returns plain JSON rows, columns and formulas", async () => {
    const { bridge } = await setup(["Tasks.base"]);
    const result = await bridge.query({ base: "Tasks.base", view: "Main" });
    if ("error" in result) throw new Error(result.error.message);
    expect(result.view).toBe("Main");
    expect(result.columns.map((c) => c.path)).toEqual(["file.name", "note.status", "note.priority", "formula.double"]);
    expect(result.rows.map((r) => r.file.path)).toEqual(["Notes/B.md", "Notes/A.md", "Notes/D.md"]);
    expect(result.rows[0].values["note.status"]).toEqual({ type: "string", value: "active", display: "active" });
    expect(result.rows[0].formulas.double.value).toBe(2);
    expect(result.totalRows).toBe(3);
    expect(result.truncated).toBe(false);
    // Must survive a structured clone / JSON round trip untouched (no TFile, functions, cycles).
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(structuredClone(result)).toEqual(result);
  });

  it("defaults to the first view and supports grouped views", async () => {
    const { bridge } = await setup(["Tasks.base"]);
    const first = await bridge.query({ base: "Tasks.base" });
    expect("error" in first ? first.error.message : first.view).toBe("Main");
    const grouped = await bridge.query({ base: "Tasks.base", view: "ByStatus" });
    if ("error" in grouped) throw new Error(grouped.error.message);
    expect(grouped.groups?.map((g) => [g.key.value, g.rows.length])).toEqual([["active", 1], ["todo", 2]]);
  });

  it("caps rows with limit and flags truncation", async () => {
    const { bridge } = await setup(["Tasks.base"]);
    const result = await bridge.query({ base: "Tasks.base", view: "Main", limit: 2 });
    if ("error" in result) throw new Error(result.error.message);
    expect(result.rows).toHaveLength(2);
    expect(result.totalRows).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("rejects a base outside the allowlist without revealing whether it exists", async () => {
    const { bridge } = await setup(["Tasks.base"]);
    const exists = await bridge.query({ base: "Private/Secret.base" });
    const missing = await bridge.query({ base: "Private/Nope.base" });
    expect(exists).toEqual({ error: { code: "not_allowed", message: expect.any(String) } });
    expect(missing).toMatchObject({ error: { code: "not_allowed" } });
  });

  it("honors folder and glob allowlist entries", async () => {
    const { bridge } = await setup(["Private/"]);
    expect("error" in (await bridge.query({ base: "Private/Secret.base" }))).toBe(false);
    expect(await bridge.query({ base: "Tasks.base" })).toMatchObject({ error: { code: "not_allowed" } });
  });

  it.each([
    "../Tasks.base", "Private/../Tasks.base", "/Tasks.base", "Tasks.base/../Private/Secret.base", "Notes/A.md",
  ])("rejects traversal or non-base path %j as bad_request", async (base) => {
    const { bridge } = await setup(["Tasks.base", "Private/", "Notes/"]);
    expect(await bridge.query({ base })).toMatchObject({ error: { code: "bad_request" } });
  });

  it("rejects inline definitions and unknown fields", async () => {
    const { bridge } = await setup(["Tasks.base"]);
    expect(await bridge.query({ base: "Tasks.base", def: { views: [] } })).toMatchObject({ error: { code: "bad_request" } });
    expect(await bridge.query({ filters: "true" })).toMatchObject({ error: { code: "bad_request" } });
  });

  it("returns errors instead of throwing for missing files, bad views, and broken bases", async () => {
    const { bridge } = await setup(["*.base", "Tasks.base"]);
    expect(await bridge.query({ base: "Nope.base" })).toMatchObject({ error: { code: "not_found" } });
    expect(await bridge.query({ base: "Tasks.base", view: "Nope" })).toMatchObject({ error: { code: "not_found" } });
    expect(await bridge.query({ base: "Broken.base" })).toMatchObject({ error: { code: "invalid_base" } });
    expect(await bridge.query(undefined)).toMatchObject({ error: { code: "bad_request" } });
  });

  it("sees note edits on the next query", async () => {
    const { bridge, fake, metadataCache } = await setup(["Tasks.base"]);
    fake.setFile("Notes/E.md", "---\nstatus: todo\npriority: 0\n---\n");
    await metadataCache.initialize();
    const result = await bridge.query({ base: "Tasks.base", view: "Main" });
    if ("error" in result) throw new Error(result.error.message);
    expect(result.rows[0].file.path).toBe("Notes/E.md");
  });
});

describe("ArtifactVaultBridge.watch", () => {
  it("debounces vault and metadata events into one payload-free callback and unsubscribes", async () => {
    vi.useFakeTimers();
    try {
      const { bridge, fake, metadataCache } = await setup(["Tasks.base"]);
      const onChange = vi.fn();
      const stop = bridge.watch(onChange, 100);
      fake.trigger("modify", {});
      metadataCache.trigger("changed", {}, "", {});
      fake.trigger("create", {});
      expect(onChange).not.toHaveBeenCalled();
      vi.advanceTimersByTime(150);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledWith();
      stop();
      fake.trigger("modify", {});
      vi.advanceTimersByTime(500);
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
