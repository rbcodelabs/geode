import { VaultAccessError } from "./contracts";

export function mobileVaultActions(externalVaultFolder: boolean): Array<{ id: "managed" | "external"; label: string }> {
  const actions: Array<{ id: "managed" | "external"; label: string }> = [
    { id: "managed", label: "On this device" },
  ];
  if (externalVaultFolder) actions.push({ id: "external", label: "Choose folder in Files" });
  return actions;
}

export function vaultAccessPresentation(error: VaultAccessError): {
  title: string;
  message: string;
  vaultId: string;
  action: "Reconnect";
} {
  const messages = {
    "permission-revoked": "Geode no longer has permission to access this exact Files folder.",
    missing: "Geode cannot find the exact Files folder previously selected for this vault.",
    unavailable: "This Files provider is temporarily unavailable. Your vault was not replaced.",
  } as const;
  return {
    title: `Reconnect ${error.vaultName}`,
    message: messages[error.state],
    vaultId: error.vaultId,
    action: "Reconnect",
  };
}
