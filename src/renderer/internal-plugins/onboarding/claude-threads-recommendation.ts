/**
 * Claude Threads is published in the supported-plugin catalog
 * (https://geode.rbcodelabs.com/supported-plugins/v1.json) as id
 * `claude-threads` (display name "Agent Threads", repo rbcodelabs/agent-threads).
 * Installation reuses `CommunityManager.installSupported`, which goes through
 * the main-process-admitted `installSupportedPlugin` IPC. Nothing new is
 * downloaded or admitted here.
 */
export const CLAUDE_THREADS_ID = "claude-threads";
export const CLAUDE_THREADS_STEP_NAME = "install-claude-threads";

export interface ThreadsRecommendationState {
  /** The plugin directory exists in the vault (installed, enabled or not). */
  installed: boolean;
  /** The host exposes the supported-catalog install API (desktop only). */
  installApiAvailable: boolean;
  /** GEODE_HEADLESS / e2e. */
  headless: boolean;
  /** The user chose "Not now". */
  declined?: boolean;
}

/** Whether to offer the recommendation card/step: not installed, installable, not declined, not headless. */
export function shouldRecommendClaudeThreads(s: ThreadsRecommendationState): boolean {
  return !s.installed && s.installApiAvailable && !s.headless && !s.declined;
}

export type ThreadsInstallPhase = "idle" | "installing" | "failed";

export type ThreadsCardKind = "hidden" | "idle" | "installing" | "installed" | "failed" | "dismissed";

export interface ThreadsCardInput {
  installed: boolean;
  installApiAvailable: boolean;
  headless: boolean;
  /** "Not now" persisted in onboarding state. */
  dismissed: boolean;
  /** Transient install phase for this session. */
  phase: ThreadsInstallPhase;
  /** This session's card installed the plugin: keep showing the success note. */
  installedThisSession: boolean;
  /** "Not now" was pressed this session: keep showing the Undo note. */
  dismissedThisSession: boolean;
}

/**
 * Card state machine. Hidden when the host can't install, when headless, when
 * the plugin was already installed before this session's card did it, or when
 * dismissed in an earlier session. Installation is the source of truth:
 * once the plugin exists the card is "installed" (this session) or hidden,
 * never "idle", which keeps it in sync with the checklist step's check().
 */
export function computeThreadsCard(i: ThreadsCardInput): ThreadsCardKind {
  if (i.headless || !i.installApiAvailable) return "hidden";
  if (i.installed) return i.installedThisSession ? "installed" : "hidden";
  if (i.phase === "installing") return "installing";
  if (i.phase === "failed") return "failed";
  if (i.dismissed) return i.dismissedThisSession ? "dismissed" : "hidden";
  return "idle";
}

export interface ThreadsCardView {
  kind: ThreadsCardKind;
  /** Present when kind === "failed". */
  error?: string;
}

export type InstallOutcome = { ok: true } | { ok: false; error: string };

/**
 * Install Claude Threads via the existing supported-catalog path. Never
 * throws: offline, catalog-unavailable and admission failures come back as
 * `{ ok: false, error }` so callers can show an error without blocking setup.
 */
export async function installClaudeThreads(
  install: (pluginId: string, release: "tested" | "latest") => Promise<unknown>,
  onProgress?: (phase: "installing" | "done" | "failed") => void
): Promise<InstallOutcome> {
  onProgress?.("installing");
  try {
    await install(CLAUDE_THREADS_ID, "tested");
    onProgress?.("done");
    return { ok: true };
  } catch (err) {
    onProgress?.("failed");
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
