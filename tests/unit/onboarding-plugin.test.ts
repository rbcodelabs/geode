import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The view pulls in api/obsidian (DOM-heavy); the plugin logic under test does not need it.
vi.mock("../../src/renderer/internal-plugins/onboarding/onboarding-view", () => ({
  OnboardingView: class {},
}));

import { OnboardingPlugin } from "../../src/renderer/internal-plugins/onboarding/onboarding-plugin";
import type { PluginManifest } from "../../src/renderer/plugin-manifest";

const manifest = (id: string, steps?: { id: string; title: string }[]): PluginManifest => ({
  id,
  name: id.toUpperCase(),
  version: "1.0.0",
  minAppVersion: "0.1.0",
  description: "d",
  author: "a",
  ...(steps ? { onboarding: { steps } } : {}),
});

function makeHarness(initialData: unknown = null) {
  const files = new Map<string, string>();
  if (initialData !== null) files.set(".geode/plugins/onboarding/data.json", JSON.stringify(initialData));
  vi.stubGlobal("window", {
    geode: {
      read: async (p: string) => {
        if (!files.has(p)) throw new Error("ENOENT");
        return files.get(p)!;
      },
      write: async (p: string, c: string) => void files.set(p, c),
    },
  });
  const openLeaves: { type: string; setViewState: ReturnType<typeof vi.fn> }[] = [];
  const commands = new Map<string, unknown>();
  const executed: string[] = [];
  const app: any = {
    commands: {
      add: (c: { id: string }) => commands.set(c.id, c),
      remove: (id: string) => commands.delete(id),
      has: (id: string) => commands.has(id) || id === "new-note",
      execute: (id: string) => (executed.push(id), true),
    },
    workspace: {
      isDeferrableViewType: () => true,
      registerViewFactory: vi.fn(),
      unregisterViewFactory: vi.fn(),
      getLeavesOfType: (type: string) => openLeaves.filter((l) => l.type === type),
      getRightLeaf: () => {
        const leaf = {
          type: "",
          setViewState: vi.fn(async (s: { type: string; active?: boolean }) => {
            leaf.type = s.type;
            openLeaves.push(leaf);
          }),
        };
        return leaf;
      },
      revealLeaf: vi.fn(),
    },
    metadataCache: { resolvedLinks: {} },
    notify: vi.fn(),
  };
  const enabled = new Set<string>();
  const manifests = new Map<string, PluginManifest>();
  const listeners = new Set<() => void>();
  const host = {
    listManifests: () => [...manifests.values()],
    getManifest: (id: string) => manifests.get(id),
    isEnabled: (id: string) => enabled.has(id),
    enabledIds: () => [...enabled],
    onChange: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
  };
  const fire = () => listeners.forEach((l) => l());
  const saved = () => JSON.parse(files.get(".geode/plugins/onboarding/data.json") ?? "null");
  return { app, commands, executed, host, manifests, enabled, fire, saved, files, openLeaves };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OnboardingPlugin", () => {
  it("registers its commands and first-party steps, and cleans both up on unload", async () => {
    const h = makeHarness();
    const plugin = new OnboardingPlugin(h.app);
    plugin.load();
    await plugin.ready;
    expect([...h.commands.keys()].sort()).toEqual(["onboarding:open", "onboarding:rerun-checks", "onboarding:reset"]);
    expect(plugin.getSnapshot().items.length).toBeGreaterThan(0);
    plugin.unload();
    expect(h.commands.size).toBe(0);
    expect(plugin.registry.list()).toEqual([]);
  });

  it("accepts a registration made before onload (nothing is lost)", async () => {
    const h = makeHarness();
    const plugin = new OnboardingPlugin(h.app);
    plugin.registerStep({ id: "early:one", ownerId: "early", title: "Early" });
    plugin.load();
    await plugin.ready;
    expect(plugin.getSnapshot().items.some((i) => i.step.id === "early:one")).toBe(true);
  });

  it("persists manual toggles and reloads them in a new instance", async () => {
    const h = makeHarness();
    const a = new OnboardingPlugin(h.app);
    a.load();
    await a.ready;
    await a.toggleStep("onboarding:create-note");
    expect(h.saved().completed["onboarding:create-note"].source).toBe("manual");
    a.unload();

    const b = new OnboardingPlugin(h.app);
    b.load();
    await b.ready;
    const item = b.getSnapshot().items.find((i) => i.step.id === "onboarding:create-note")!;
    expect(item.done).toBe(true);
    await b.toggleStep("onboarding:create-note");
    expect(b.getSnapshot().items.find((i) => i.step.id === "onboarding:create-note")!.done).toBe(false);
  });

  it("does not allow manual toggling of a step with a check", async () => {
    const h = makeHarness();
    const plugin = new OnboardingPlugin(h.app);
    plugin.load();
    await plugin.ready;
    await plugin.toggleStep("onboarding:link-notes");
    expect(plugin.getSnapshot().items.find((i) => i.step.id === "onboarding:link-notes")!.done).toBe(false);
  });

  it("auto-completes from check(), and a throwing check neither throws nor completes", async () => {
    const h = makeHarness();
    const plugin = new OnboardingPlugin(h.app);
    plugin.load();
    await plugin.ready;
    plugin.registerStep({ id: "p:ok", ownerId: "p", title: "ok", check: () => true });
    plugin.registerStep({
      id: "p:bad",
      ownerId: "p",
      title: "bad",
      check: () => {
        throw new Error("boom");
      },
    });
    await expect(plugin.refresh()).resolves.toBeUndefined();
    const done = Object.fromEntries(plugin.getSnapshot().items.map((i) => [i.step.id, i.done]));
    expect(done["p:ok"]).toBe(true);
    expect(done["p:bad"]).toBe(false);
    expect(h.saved().completed["p:ok"].source).toBe("auto");
    expect(warn).toHaveBeenCalled();
  });

  it("survives corrupt persisted data and a failing save", async () => {
    const h = makeHarness("not an object");
    const plugin = new OnboardingPlugin(h.app);
    plugin.load();
    await plugin.ready;
    (globalThis as any).window.geode.write = async () => {
      throw new Error("disk full");
    };
    await expect(plugin.toggleStep("onboarding:create-note")).resolves.toBeUndefined();
    expect(plugin.getSnapshot().items.find((i) => i.step.id === "onboarding:create-note")!.done).toBe(true);
  });

  it("shows manifest steps for disabled plugins and drops runtime steps when the owner unloads", async () => {
    const h = makeHarness();
    h.manifests.set("acme", manifest("acme", [{ id: "setup", title: "Set up Acme" }]));
    const plugin = new OnboardingPlugin(h.app);
    plugin.load();
    await plugin.ready;
    plugin.attachPluginManager(h.host);

    let step = plugin.getSnapshot().items.find((i) => i.step.id === "acme:setup")!;
    expect(step.step.ownerEnabled).toBe(false);

    h.enabled.add("acme");
    plugin.registerStep({ id: "acme:setup", ownerId: "acme", title: "Set up Acme", check: () => false });
    plugin.registerStep({ id: "acme:extra", ownerId: "acme", title: "Extra" });
    h.fire();
    step = plugin.getSnapshot().items.find((i) => i.step.id === "acme:setup")!;
    expect(step.step.origin).toBe("runtime");
    expect(step.step.ownerEnabled).toBe(true);
    expect(plugin.getSnapshot().items.some((i) => i.step.id === "acme:extra")).toBe(true);

    h.enabled.delete("acme"); // plugin disabled without disposing its steps
    h.fire();
    const ids = plugin.getSnapshot().items.map((i) => i.step.id);
    expect(ids).not.toContain("acme:extra");
    const back = plugin.getSnapshot().items.find((i) => i.step.id === "acme:setup")!;
    expect(back.step.origin).toBe("static");
    expect(back.step.ownerEnabled).toBe(false);
  });

  it("skipping a step removes it from the required total; reset clears everything", async () => {
    const h = makeHarness();
    const plugin = new OnboardingPlugin(h.app);
    plugin.load();
    await plugin.ready;
    const before = plugin.getSnapshot().completeness.total;
    await plugin.skipStep("onboarding:create-note");
    expect(plugin.getSnapshot().completeness.total).toBe(before - 1);
    await plugin.setOnboardingDismissed(true);
    await plugin.toggleStep("onboarding:command-palette");
    await plugin.resetProgress();
    expect(plugin.getSnapshot()).toMatchObject({ dismissedOnboarding: false });
    expect(plugin.getSnapshot().completeness.total).toBe(before);
    expect(plugin.getSnapshot().completeness.completed).toBe(0);
  });

  it("runStep executes the command through app.commands", async () => {
    const h = makeHarness();
    const plugin = new OnboardingPlugin(h.app);
    plugin.load();
    await plugin.ready;
    expect(plugin.runStep("onboarding:create-note")).toBe(true);
    expect(h.executed).toEqual(["new-note"]);
    expect(plugin.runStep("onboarding:link-notes")).toBe(false);
  });
});

describe("OnboardingPlugin.autoOpenIfOutstanding", () => {
  const MANUAL_FIRST_PARTY = ["onboarding:create-note", "onboarding:command-palette", "onboarding:open-graph"];

  async function boot(h: ReturnType<typeof makeHarness>, headless = false) {
    const plugin = new OnboardingPlugin(h.app, () => headless);
    plugin.load();
    await plugin.ready;
    return plugin;
  }

  it("opens in the sidebar without activating when required steps are outstanding", async () => {
    const h = makeHarness();
    const plugin = await boot(h);
    expect(await plugin.autoOpenIfOutstanding()).toBe(true);
    expect(h.openLeaves).toHaveLength(1);
    expect(h.openLeaves[0].setViewState).toHaveBeenCalledWith({ type: "onboarding-checklist", active: false });
    expect(h.app.workspace.revealLeaf).toHaveBeenCalledTimes(1);
  });

  it("runs checks first: auto-detected completion prevents a spurious open", async () => {
    const h = makeHarness();
    const plugin = await boot(h);
    for (const id of MANUAL_FIRST_PARTY) await plugin.toggleStep(id);
    expect(plugin.hasOutstandingSteps()).toBe(true); // link-notes not yet detected
    h.app.metadataCache.resolvedLinks = { "a.md": { "b.md": 1 } };
    expect(await plugin.autoOpenIfOutstanding()).toBe(false);
    expect(h.openLeaves).toHaveLength(0);
  });

  it("does not open when only skipped or optional steps remain", async () => {
    const h = makeHarness();
    const plugin = await boot(h);
    for (const id of [...MANUAL_FIRST_PARTY, "onboarding:link-notes"]) await plugin.skipStep(id);
    // community-plugin is optional and still incomplete
    expect(await plugin.autoOpenIfOutstanding()).toBe(false);
  });

  it("does not open when onboarding was dismissed", async () => {
    const h = makeHarness();
    const plugin = await boot(h);
    await plugin.setOnboardingDismissed(true);
    expect(await plugin.autoOpenIfOutstanding()).toBe(false);
    expect(h.openLeaves).toHaveLength(0);
  });

  it("does not open when the pane is already open (restored layout)", async () => {
    const h = makeHarness();
    const plugin = await boot(h);
    h.openLeaves.push({ type: "onboarding-checklist", setViewState: vi.fn() });
    expect(await plugin.autoOpenIfOutstanding()).toBe(false);
    expect(h.openLeaves).toHaveLength(1);
  });

  it("does not open when headless (GEODE_HEADLESS / e2e)", async () => {
    const h = makeHarness();
    const plugin = await boot(h, true);
    expect(await plugin.autoOpenIfOutstanding()).toBe(false);
    expect(h.openLeaves).toHaveLength(0);
  });
});
