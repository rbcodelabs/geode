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
