import type { OnboardingStep } from "./registry";

export const ONBOARDING_PLUGIN_ID = "onboarding";

/** The slice of `App` the first-party checks read. Kept narrow so it is trivially faked in tests. */
export interface OnboardingHost {
  metadataCache: { resolvedLinks: Record<string, Record<string, number>> };
  pluginManager?: { enabledIds(): string[] } | undefined;
}

/**
 * Steps the onboarding plugin registers for itself. Every `commandId` is a
 * real app command (asserted against `app.ts` in
 * tests/unit/onboarding-first-party-steps.test.ts). A step without a `check`
 * is ticked by hand.
 */
export function firstPartySteps(host: OnboardingHost): OnboardingStep[] {
  const id = (s: string) => `${ONBOARDING_PLUGIN_ID}:${s}`;
  return [
    {
      id: id("create-note"),
      ownerId: ONBOARDING_PLUGIN_ID,
      group: "Basics",
      order: 10,
      title: "Create your first note",
      description: "Notes are plain Markdown files in your vault.",
      commandId: "new-note",
    },
    {
      id: id("link-notes"),
      ownerId: ONBOARDING_PLUGIN_ID,
      group: "Basics",
      order: 20,
      title: "Link two notes with a [[wikilink]]",
      description: "Type [[ in a note and pick another note. The target then shows the link under Backlinks.",
      check: () => Object.values(host.metadataCache.resolvedLinks).some((targets) => Object.keys(targets).length > 0),
    },
    {
      id: id("command-palette"),
      ownerId: ONBOARDING_PLUGIN_ID,
      group: "Basics",
      order: 30,
      title: "Try the command palette",
      description: "Every action in Geode is a command. Press Cmd/Ctrl+P to search them.",
      commandId: "command-palette",
    },
    {
      id: id("open-graph"),
      ownerId: ONBOARDING_PLUGIN_ID,
      group: "Explore",
      order: 40,
      title: "Open the graph view",
      description: "See how your notes connect.",
      commandId: "open-graph",
    },
    {
      id: id("community-plugin"),
      ownerId: ONBOARDING_PLUGIN_ID,
      group: "Explore",
      order: 50,
      optional: true,
      title: "Enable a community plugin",
      description: "Install one from GitHub, then turn it on in Settings.",
      commandId: "community-add",
      check: () => (host.pluginManager?.enabledIds().length ?? 0) > 0,
    },
  ];
}
