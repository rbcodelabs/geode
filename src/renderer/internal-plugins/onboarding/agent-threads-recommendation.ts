/**
 * Agent Threads is published in the supported-plugin catalog
 * (https://geode.rbcodelabs.com/supported-plugins/v1.json) as id
 * `claude-threads` (display name "Agent Threads", repo rbcodelabs/agent-threads).
 * The id is the plugin's real, historical id and must not be renamed with the
 * product name; only user-facing copy says "Agent Threads".
 * Installation reuses `CommunityManager.installSupported`, which goes through
 * the main-process-admitted `installSupportedPlugin` IPC. Nothing new is
 * downloaded or admitted here.
 */
export const AGENT_THREADS_ID = "claude-threads";
export const AGENT_THREADS_STEP_NAME = "install-agent-threads";

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
export function shouldRecommendAgentThreads(s: ThreadsRecommendationState): boolean {
  return !s.installed && s.installApiAvailable && !s.headless && !s.declined;
}

export type ThreadsInstallPhase = "idle" | "installing" | "enabling" | "failed" | "enable-failed";

export type ThreadsCardKind =
  | "hidden"
  | "idle" // not installed: Install
  | "enable" // installed but disabled: Enable
  | "installing"
  | "enabling"
  | "installed" // installed and enabled by this card this session
  | "failed" // install failed: Retry / Skip
  | "enable-failed" // installed, but enabling failed: Enable (retry)
  | "dismissed";

export interface ThreadsCardInput {
  installed: boolean;
  /** Enabled (loaded). Implies installed. */
  enabled: boolean;
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
 * Card state machine. Hidden when headless, or when the plugin is installed
 * AND enabled (shown as "installed" only if this session's card did it), or
 * dismissed in an earlier session. Installed-but-disabled shows "enable".
 * Installed/enabled state is the source of truth, which keeps the card in sync
 * with the checklist step's check() (installed and enabled).
 */
export function computeThreadsCard(i: ThreadsCardInput): ThreadsCardKind {
  if (i.headless) return "hidden";
  if (i.phase === "installing") return "installing";
  if (i.phase === "enabling") return "enabling";
  if (i.phase === "failed") return "failed";
  if (i.phase === "enable-failed") return "enable-failed";
  if (i.installed && i.enabled) return i.installedThisSession ? "installed" : "hidden";
  // Installing needs the catalog API; enabling an existing install does not.
  if (!i.installed && !i.installApiAvailable) return "hidden";
  if (i.dismissed) return i.dismissedThisSession ? "dismissed" : "hidden";
  return i.installed ? "enable" : "idle";
}

export interface ThreadsCardView {
  kind: ThreadsCardKind;
  /** Present when kind is "failed" or "enable-failed". */
  error?: string;
}

export type InstallOutcome = { ok: true } | { ok: false; error: string };

/**
 * Install Agent Threads via the existing supported-catalog path. Never
 * throws: offline, catalog-unavailable and admission failures come back as
 * `{ ok: false, error }` so callers can show an error without blocking setup.
 */
export async function installAgentThreads(
  install: (pluginId: string, release: "tested" | "latest") => Promise<unknown>,
  onProgress?: (phase: "installing" | "done" | "failed") => void
): Promise<InstallOutcome> {
  onProgress?.("installing");
  try {
    await install(AGENT_THREADS_ID, "tested");
    onProgress?.("done");
    return { ok: true };
  } catch (err) {
    onProgress?.("failed");
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
