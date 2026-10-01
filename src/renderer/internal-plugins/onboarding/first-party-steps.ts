import {
  AGENT_THREADS_ID,
  AGENT_THREADS_STEP_NAME,
  shouldRecommendAgentThreads,
} from "./agent-threads-recommendation";
import type { OnboardingStep } from "./registry";

export const ONBOARDING_PLUGIN_ID = "onboarding";

/** The slice of `App` the first-party checks read. Kept narrow so it is trivially faked in tests. */
export interface OnboardingHost {
  metadataCache: { resolvedLinks: Record<string, Record<string, number>> };
  pluginManager?: { enabledIds(): string[]; getManifest?(id: string): unknown } | undefined;
  /** True when the supported-catalog install API exists (desktop). Gates the Agent Threads step. */
  supportedInstallAvailable?: boolean;
  /** True under GEODE_HEADLESS / e2e: the Agent Threads step is not offered. */
  headless?: boolean;
}

/**
 * Steps the onboarding plugin registers for itself. Every `commandId` is a
 * real app command (asserted against `app.ts` in
 * tests/unit/onboarding-first-party-steps.test.ts). A step without a `check`
 * is ticked by hand.
 */
export function firstPartySteps(host: OnboardingHost): OnboardingStep[] {
  const id = (s: string) => `${ONBOARDING_PLUGIN_ID}:${s}`;
  // Installed AND enabled: a plugin only appears in enabledIds() once loaded.
  const agentThreadsReady = () => (host.pluginManager?.enabledIds() ?? []).includes(AGENT_THREADS_ID);
  const steps: OnboardingStep[] = [
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
  if (shouldRecommendAgentThreads({
    installed: false, // the step stays listed once installed so it can show as complete
    installApiAvailable: host.supportedInstallAvailable === true,
    headless: host.headless === true,
  })) {
    steps.push({
      id: id(AGENT_THREADS_STEP_NAME),
      ownerId: ONBOARDING_PLUGIN_ID,
      group: "Explore",
      order: 60,
      optional: true,
      title: "Install and enable Agent Threads",
      description: "Chat with AI agents about your notes, and run several at once inside your vault. Installs the tested release from the supported-plugin catalog if needed, then turns it on.",
      commandId: `${ONBOARDING_PLUGIN_ID}:${AGENT_THREADS_STEP_NAME}`,
      check: agentThreadsReady,
    });
  }
  return steps;
}
