export interface ElectronE2EEnvironment {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

const MACOS_CODEX_SANDBOX_ERROR = [
  "Electron E2E tests cannot run inside the macOS Codex sandbox.",
  "The sandbox blocks macOS LaunchServices/Mach registration, so Electron aborts before the test app starts and macOS opens a crash-report dialog for every launch.",
  "Please rerun this E2E command outside the sandbox (for example, directly in Terminal).",
].join(" ");

/**
 * Electron must register with macOS LaunchServices before any JavaScript runs.
 * Codex's macOS seatbelt blocks the required Mach services, so fail once in
 * Playwright setup instead of spawning an Electron process per test/retry.
 */
export function assertElectronE2EEnvironment(
  environment: ElectronE2EEnvironment = {
    platform: process.platform,
    env: process.env,
  },
): void {
  if (environment.platform === "darwin" && environment.env.CODEX_SANDBOX === "seatbelt") {
    throw new Error(MACOS_CODEX_SANDBOX_ERROR);
  }
}
