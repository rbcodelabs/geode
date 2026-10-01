import { describe, expect, it, vi } from "vitest";
import {
  AGENT_THREADS_ID,
  computeThreadsCard,
  installAgentThreads,
  shouldRecommendAgentThreads,
} from "../../src/renderer/internal-plugins/onboarding/agent-threads-recommendation";
import { firstPartySteps } from "../../src/renderer/internal-plugins/onboarding/first-party-steps";

const base = { installed: false, installApiAvailable: true, headless: false };

describe("shouldRecommendAgentThreads", () => {
  it("recommends when installable and not installed", () => {
    expect(shouldRecommendAgentThreads(base)).toBe(true);
  });
  it.each([
    ["already installed", { installed: true }],
    ["install API missing (mobile)", { installApiAvailable: false }],
    ["headless / e2e", { headless: true }],
    ["declined", { declined: true }],
  ])("does not recommend: %s", (_name, over) => {
    expect(shouldRecommendAgentThreads({ ...base, ...over })).toBe(false);
  });
});

describe("computeThreadsCard", () => {
  const input = {
    installed: false,
    enabled: false,
    installApiAvailable: true,
    headless: false,
    dismissed: false,
    phase: "idle" as const,
    installedThisSession: false,
    dismissedThisSession: false,
  };
  const kind = (over: Partial<typeof input>) => computeThreadsCard({ ...input, ...over });

  it("idle by default", () => expect(kind({})).toBe("idle"));
  it("hidden when headless, when not installed without install API, or installed AND enabled", () => {
    expect(kind({ headless: true })).toBe("hidden");
    expect(kind({ installApiAvailable: false })).toBe("hidden");
    expect(kind({ installed: true, enabled: true })).toBe("hidden");
  });
  it("installed but disabled offers Enable (even without the install API)", () => {
    expect(kind({ installed: true })).toBe("enable");
    expect(kind({ installed: true, installApiAvailable: false })).toBe("enable");
  });
  it("shows installed only for a setup done by the card this session", () => {
    expect(kind({ installed: true, enabled: true, installedThisSession: true })).toBe("installed");
  });
  it("in-flight and failed phases take priority over dismissal", () => {
    expect(kind({ phase: "installing" })).toBe("installing");
    expect(kind({ phase: "enabling", installed: true })).toBe("enabling");
    expect(kind({ phase: "failed", dismissed: true })).toBe("failed");
    expect(kind({ phase: "enable-failed", installed: true, dismissed: true })).toBe("enable-failed");
  });
  it("dismissed shows Undo note this session, hidden in later sessions", () => {
    expect(kind({ dismissed: true, dismissedThisSession: true })).toBe("dismissed");
    expect(kind({ dismissed: true })).toBe("hidden");
  });
});

describe("installAgentThreads", () => {
  it("installs the tested catalog release by id and reports progress", async () => {
    const install = vi.fn().mockResolvedValue({});
    const phases: string[] = [];
    expect(await installAgentThreads(install, (p) => phases.push(p))).toEqual({ ok: true });
    expect(install).toHaveBeenCalledWith(AGENT_THREADS_ID, "tested");
    expect(phases).toEqual(["installing", "done"]);
  });

  it("returns the error instead of throwing when offline or the catalog is unavailable", async () => {
    const phases: string[] = [];
    const result = await installAgentThreads(
      () => Promise.reject(new Error("Supported plugin catalog is unavailable")),
      (p) => phases.push(p)
    );
    expect(result).toEqual({ ok: false, error: "Supported plugin catalog is unavailable" });
    expect(phases).toEqual(["installing", "failed"]);
    expect(await installAgentThreads(() => Promise.reject("raw"))).toEqual({ ok: false, error: "raw" });
  });
});

describe("Install Agent Threads onboarding step", () => {
  const host = (over: Record<string, unknown> = {}, manifests: string[] = [], enabled: string[] = []) => ({
    metadataCache: { resolvedLinks: {} },
    pluginManager: { enabledIds: () => enabled, getManifest: (id: string) => (manifests.includes(id) ? {} : undefined) },
    supportedInstallAvailable: true,
    headless: false,
    ...over,
  });
  const find = (h: ReturnType<typeof host>) =>
    firstPartySteps(h).find((s) => s.id === "onboarding:install-agent-threads");

  it("is an optional step with an install command", () => {
    const step = find(host())!;
    expect(step.optional).toBe(true);
    expect(step.commandId).toBe("onboarding:install-agent-threads");
  });

  it("auto-completes only when installed AND enabled", async () => {
    expect(await find(host())!.check!()).toBe(false);
    expect(await find(host({}, [AGENT_THREADS_ID]))!.check!()).toBe(false); // installed, disabled
    expect(await find(host({}, [AGENT_THREADS_ID], [AGENT_THREADS_ID]))!.check!()).toBe(true);
  });

  it("is not offered when headless or when the install API is unavailable", () => {
    expect(find(host({ headless: true }))).toBeUndefined();
    expect(find(host({ supportedInstallAvailable: false }))).toBeUndefined();
  });
});
