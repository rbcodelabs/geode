import { describe, expect, it } from "vitest";
import { createBrowserHost, createBrowserHostState } from "../../../src/renderer/host/browser-host";
import { Vault } from "../../../src/renderer/vault";

describe("Vault host subscriptions", () => {
  it("replaces the host change subscription when a vault is reopened", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: { "Note.md": "one" } }));
    const vault = new Vault(host);
    await vault.open("managed://default");
    await vault.open("managed://default");
    let modifications = 0;
    vault.on("modify", () => { modifications += 1; });

    await host.vaultFiles.write("Note.md", "two");

    expect(modifications).toBe(1);
  });

  it("stops receiving host changes after disposal", async () => {
    const host = createBrowserHost(createBrowserHostState({ files: { "Note.md": "one" } }));
    const vault = new Vault(host);
    await vault.open("managed://default");
    let modifications = 0;
    vault.on("modify", () => { modifications += 1; });
    vault.dispose();

    await host.vaultRegistry.openVault("managed://default");
    await host.vaultFiles.write("Note.md", "two");

    expect(modifications).toBe(0);
  });
});
