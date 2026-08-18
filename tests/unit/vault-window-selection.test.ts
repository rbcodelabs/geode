import { describe, expect, it } from "vitest";
import { selectVaultWindowAction } from "../../src/main/vault-window-selection";

describe("selectVaultWindowAction", () => {
  it("does nothing when the requested vault is already current", () => {
    expect(selectVaultWindowAction("/vaults/current", 7, [
      { windowId: 7, vaultPath: "/vaults/current" },
    ])).toEqual({ kind: "current" });
  });

  it("focuses the existing window for an already-open vault", () => {
    expect(selectVaultWindowAction("/vaults/other/../other", 7, [
      { windowId: 7, vaultPath: "/vaults/current" },
      { windowId: 12, vaultPath: "/vaults/other" },
    ])).toEqual({ kind: "focus", windowId: 12 });
  });

  it("creates a window with the requested vault as an explicit launch target", () => {
    expect(selectVaultWindowAction("/vaults/new", 7, [
      { windowId: 7, vaultPath: "/vaults/current" },
    ])).toEqual({ kind: "create", vaultPath: "/vaults/new" });
  });
});
