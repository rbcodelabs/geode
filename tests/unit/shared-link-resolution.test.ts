import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "../../src/wiki/link-candidates";
import { createWikiSnapshot } from "../../src/wiki/snapshot";
import { MetadataCache } from "../../src/renderer/metadata-cache";
import { FakeVault } from "../helpers/fake-vault";
import { execFileSync } from "node:child_process";
import { resolutionFiles, resolutionTargets } from "../fixtures/shared-link-resolution";
import { resolveFirstLinkpathDest } from "../../src/wiki/link-resolution";

const files = {
  "folder/Source.md": "",
  "Target.md": "# Details",
  "folder/Local.md": "",
  "a/Twin.md": "",
  "b/Twin.md": "",
  "Alias.md": "---\naliases: [Other]\n---\n",
};

afterEach(() => vi.restoreAllMocks());

describe("shared link-resolution adoption", () => {
  it("reads only the first desktop alias candidate even when a bucket is large", () => {
    function* aliases() { yield "First.md"; throw Error("desktop must not enumerate the alias bucket"); }
    expect(core.selectLinkCandidates("alias", "Source.md", {
      getFileByPath: () => null, byBasename: new Map(), byAlias: new Map([["alias", aliases()]]),
    }, "desktop-compatibility")).toEqual({ candidates: ["First.md"], stage: "alias" });
  });
  it("does not introduce root-relative fallback for a desktop source with a leading slash", () => {
    const provider = { getFileByPath: (path: string) => path === "/Target.md" ? { path } : null,
      byBasename: new Map<string, string[]>(), byAlias: new Map<string, string[]>() };
    expect(resolveFirstLinkpathDest("Target", "/Source.md", provider)).toBeNull();
  });
  it("matches real MetadataCache and fresh Node under the same desktop policy", async () => {
    const proof = JSON.parse(execFileSync(process.execPath, ["scripts/run-shared-link-node-proof.mjs"], { encoding: "utf8" }));
    const cache = new MetadataCache(new FakeVault(resolutionFiles).asVault());
    await cache.initialize();
    const desktop = resolutionTargets.map(target => cache.getFirstLinkpathDest(target, "folder/Source.md")?.path ?? null);
    expect(proof.nodeOnly).toBe(true);
    expect(proof.policy).toBe("desktop-compatibility");
    expect(proof.compatibility).toEqual(desktop);
    const snapshot = createWikiSnapshot(Object.entries(resolutionFiles).map(([path, text]) => ({ path, text, kind: "note" })));
    expect(proof.strict).toEqual(resolutionTargets.map(target => snapshot.resolve("folder/Source.md", target)));
  });

  it("retains stable basename ties, alias order, and nullish exact fallback", () => {
    const provider = {
      getFileByPath: (path: string) => path === "Falsy" ? false : path === "Missing" ? null : { path },
      byBasename: new Map([["falsy", ["b/Twin.md", "a/Twin.md"]]]),
      byAlias: new Map<string, string[]>(),
    };
    expect(resolveFirstLinkpathDest("Falsy", "Source.md", provider)).toEqual({ path: "b/Twin.md" });
    expect(resolveFirstLinkpathDest("Missing", "Source.md", provider)).toEqual({ path: "Missing.md" });
    const absent = { ...provider, getFileByPath: (path: string) => path.includes("/") ? { path } : null,
      byAlias: new Map([["alias", ["z/Long.md", "a/T.md"]]]) };
    expect(resolveFirstLinkpathDest("alias", "Source.md", absent)).toEqual({ path: "z/Long.md" });
  });
  it("routes the real desktop cache and Node snapshot through one named-policy selector", async () => {
    expect(core).toHaveProperty("selectLinkCandidates", expect.any(Function));
    const select = vi.spyOn(core, "selectLinkCandidates");
    const cache = new MetadataCache(new FakeVault(files).asVault());
    await cache.initialize();
    const snapshot = createWikiSnapshot(Object.entries(files).map(([path, text]) => ({ path, text, kind: "note" })));
    select.mockClear();
    expect(cache.getFirstLinkpathDest("Other", "folder/Source.md")?.path).toBe("Alias.md");
    expect(snapshot.resolve("folder/Source.md", "Other").path).toBe("Alias.md");
    expect(select.mock.calls.map(call => call[3])).toEqual(["desktop-compatibility", "agent-strict"]);
  });

  it.each([
    ["Target#Details", "Target.md", "resolved"],
    ["Local", "folder/Local.md", "resolved"],
    ["Other", "Alias.md", "resolved"],
    ["#Details", "folder/Source.md", "resolved"],
    ["Twin", "a/Twin.md", "ambiguous"],
    ["../Target", null, "resolved"],
    ["./Twin", null, "missing"],
    ["absent", null, "missing"],
    ["Target^block", "Target.md", "missing"],
  ])("preserves intentional consumer behavior for %s", async (target, desktopPath, strictStatus) => {
    const cache = new MetadataCache(new FakeVault(files).asVault());
    await cache.initialize();
    const snapshot = createWikiSnapshot(Object.entries(files).map(([path, text]) => ({ path, text, kind: "note" })));
    expect(cache.getFirstLinkpathDest(target, "folder/Source.md")?.path ?? null).toBe(desktopPath);
    expect(snapshot.resolve("folder/Source.md", target).status).toBe(strictStatus);
  });

  it("shares candidate selection, not just matching answers", async () => {
    expect(core).toHaveProperty("selectLinkCandidates", expect.any(Function));
    const cache = new MetadataCache(new FakeVault(files).asVault());
    await cache.initialize();
    const snapshot = createWikiSnapshot(Object.entries(files).map(([path, text]) => ({ path, text, kind: "note" })));
    // A test-only substitution proves both production call sites consume the same result.
    vi.spyOn(core, "selectLinkCandidates").mockReturnValue({ candidates: ["Alias.md"], stage: "exact" });
    expect(cache.getFirstLinkpathDest("Target", "folder/Source.md")?.path).toBe("Alias.md");
    expect(snapshot.resolve("folder/Source.md", "Target").path).toBe("Alias.md");
  });
});
