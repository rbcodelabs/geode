import { describe, expect, it } from "vitest";
import { VaultAccessError } from "../../../src/renderer/host/contracts";
import { mobileVaultActions, vaultAccessPresentation } from "../../../src/renderer/host/mobile-vault-access";

describe("mobile vault access presentation", () => {
  it("distinguishes the managed vault from Files-provider selection", () => {
    expect(mobileVaultActions(true)).toEqual([
      { id: "managed", label: "On this device" },
      { id: "external", label: "Choose folder in Files" },
    ]);
    expect(mobileVaultActions(false)).toEqual([{ id: "managed", label: "On this device" }]);
  });

  it("keeps an inaccessible vault identity visible and reconnectable", () => {
    const state = vaultAccessPresentation(new VaultAccessError(
      "Vault permission was revoked", "VAULT_PERMISSION_REVOKED",
      "external://stable-id", "Family Notes", "permission-revoked",
    ));

    expect(state).toEqual({
      title: "Reconnect Family Notes",
      message: "Geode no longer has permission to access this exact Files folder.",
      vaultId: "external://stable-id",
      action: "Reconnect",
    });
  });
});
