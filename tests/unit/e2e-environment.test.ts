import { describe, expect, it } from "vitest";
import { assertElectronE2EEnvironment } from "../../scripts/e2e-environment.mts";

describe("assertElectronE2EEnvironment", () => {
  it("stops macOS Codex seatbelt runs before Electron can launch", () => {
    const runPreflight = () =>
      assertElectronE2EEnvironment({
        platform: "darwin",
        env: { CODEX_SANDBOX: "seatbelt" },
      });

    expect(runPreflight).toThrowError(
      /Electron E2E tests cannot run inside the macOS Codex sandbox.*rerun.*outside the sandbox/is,
    );
    expect(runPreflight).toThrowError(/LaunchServices|Mach/);
  });

  it("allows macOS runs outside the Codex seatbelt", () => {
    expect(() =>
      assertElectronE2EEnvironment({ platform: "darwin", env: {} }),
    ).not.toThrow();
  });

  it("does not block non-macOS environments", () => {
    expect(() =>
      assertElectronE2EEnvironment({
        platform: "linux",
        env: { CODEX_SANDBOX: "seatbelt" },
      }),
    ).not.toThrow();
  });
});
