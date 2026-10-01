import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_THREADS_ID,
  installClaudeThreads,
  shouldRecommendClaudeThreads,
} from "../../src/renderer/internal-plugins/onboarding/claude-threads-recommendation";
import { firstPartySteps } from "../../src/renderer/internal-plugins/onboarding/first-party-steps";

const base = { installed: false, installApiAvailable: true, headless: false };

describe("shouldRecommendClaudeThreads", () => {
  it("recommends when installable and not installed", () => {
    expect(shouldRecommendClaudeThreads(base)).toBe(true);
  });
  it.each([
    ["already installed", { installed: true }],
    ["install API missing (mobile)", { installApiAvailable: false }],
    ["headless / e2e", { headless: true }],
    ["declined", { declined: true }],
  ])("does not recommend: %s", (_name, over) => {
    expect(shouldRecommendClaudeThreads({ ...base, ...over })).toBe(false);
  });
});

describe("installClaudeThreads", () => {
  it("installs the tested catalog release by id and reports progress", async () => {
    const install = vi.fn().mockResolvedValue({});
    const phases: string[] = [];
    expect(await installClaudeThreads(install, (p) => phases.push(p))).toEqual({ ok: true });
    expect(install).toHaveBeenCalledWith(CLAUDE_THREADS_ID, "tested");
    expect(phases).toEqual(["installing", "done"]);
  });

  it("returns the error instead of throwing when offline or the catalog is unavailable", async () => {
    const phases: string[] = [];
    const result = await installClaudeThreads(
      () => Promise.reject(new Error("Supported plugin catalog is unavailable")),
      (p) => phases.push(p)
    );
    expect(result).toEqual({ ok: false, error: "Supported plugin catalog is unavailable" });
    expect(phases).toEqual(["installing", "failed"]);
    expect(await installClaudeThreads(() => Promise.reject("raw"))).toEqual({ ok: false, error: "raw" });
  });
});

describe("Install Claude Threads onboarding step", () => {
  const host = (over: Record<string, unknown> = {}, manifests: string[] = [], enabled: string[] = []) => ({
    metadataCache: { resolvedLinks: {} },
    pluginManager: { enabledIds: () => enabled, getManifest: (id: string) => (manifests.includes(id) ? {} : undefined) },
    supportedInstallAvailable: true,
    headless: false,
    ...over,
  });
  const find = (h: ReturnType<typeof host>) =>
    firstPartySteps(h).find((s) => s.id === "onboarding:install-claude-threads");

  it("is an optional step with an install command", () => {
    const step = find(host())!;
    expect(step.optional).toBe(true);
    expect(step.commandId).toBe("onboarding:install-claude-threads");
  });

  it("auto-completes once the plugin is installed (manifest present) or enabled", async () => {
    expect(await find(host())!.check!()).toBe(false);
    expect(await find(host({}, [CLAUDE_THREADS_ID]))!.check!()).toBe(true);
    expect(await find(host({}, [], [CLAUDE_THREADS_ID]))!.check!()).toBe(true);
  });

  it("is not offered when headless or when the install API is unavailable", () => {
    expect(find(host({ headless: true }))).toBeUndefined();
    expect(find(host({ supportedInstallAvailable: false }))).toBeUndefined();
  });
});
