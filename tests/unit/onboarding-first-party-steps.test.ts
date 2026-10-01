import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { firstPartySteps } from "../../src/renderer/internal-plugins/onboarding/first-party-steps";

const appSource = readFileSync("src/renderer/app.ts", "utf8");

type Links = Record<string, Record<string, number>>;
const host = (links: Links, enabled: string[] = []) => ({
  metadataCache: { resolvedLinks: links },
  pluginManager: { enabledIds: () => enabled },
});

describe("first-party onboarding steps", () => {
  it("every commandId is a command registered in app.ts", () => {
    for (const step of firstPartySteps(host({}))) {
      // `onboarding:*` commands are registered by the plugin itself (see onboarding-plugin.test.ts).
      if (!step.commandId || step.commandId.startsWith("onboarding:")) continue;
      expect(appSource, `${step.id} -> ${step.commandId}`).toMatch(
        new RegExp(`\\bc\\("${step.commandId}",|id: "${step.commandId}"`)
      );
    }
  });

  it("ids are namespaced by the onboarding owner and unique", () => {
    const steps = firstPartySteps(host({}));
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
    for (const s of steps) expect(s.id.startsWith("onboarding:") && s.ownerId === "onboarding").toBe(true);
  });

  it("link check detects a resolved wikilink", async () => {
    const link = (links: Links) => firstPartySteps(host(links)).find((s) => s.id === "onboarding:link-notes")!.check!();
    expect(await link({ "a.md": {} })).toBe(false);
    expect(await link({ "a.md": { "b.md": 1 } })).toBe(true);
  });

  it("community plugin step is optional and detects an enabled plugin", async () => {
    const step = (enabled: string[]) =>
      firstPartySteps(host({}, enabled)).find((s) => s.id === "onboarding:community-plugin")!;
    expect(step([]).optional).toBe(true);
    expect(await step([]).check!()).toBe(false);
    expect(await step(["x"]).check!()).toBe(true);
  });
});
