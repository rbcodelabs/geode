import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

// Execute the actual startup prefix without bringing up unrelated Electron
// services. Keeping the ready callback in the snippet catches early native calls.
const main = readFileSync("src/main/main.ts", "utf8");
const start = main.indexOf("app.whenReady().then(() => {");
const end = main.indexOf("  if (!isHeadless) {", start);
const startup = `${main.slice(start, end)}\n});`;

describe("macOS WebAuthn startup", () => {
  it("waits for Electron readiness and uses the current signing team's keychain group", async () => {
    let ready!: () => void;
    const readiness = new Promise<void>((resolve) => { ready = resolve; });
    const configureWebAuthn = vi.fn();
    const started = runInNewContext(startup, {
      app: { whenReady: () => readiness, configureWebAuthn },
      process: { platform: "darwin" },
    });
    expect(configureWebAuthn).not.toHaveBeenCalled();
    ready();
    await started;
    expect(configureWebAuthn).toHaveBeenCalledExactlyOnceWith({
      touchID: {
        keychainAccessGroup: "6M8F464WCQ.com.rbcodelabs.geode.webauthn",
        promptReason: "sign in to $1",
      },
    });
  });

  it.each(["linux", "win32"])("does not call the macOS-only API on %s", async (platform) => {
    await expect(runInNewContext(startup, {
      app: { whenReady: () => Promise.resolve() },
      process: { platform },
    })).resolves.toBeUndefined();
  });
});
