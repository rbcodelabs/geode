import * as path from "node:path";

export interface VaultWindow {
  windowId: number;
  vaultPath: string;
}

export type VaultWindowAction =
  | { kind: "current" }
  | { kind: "focus"; windowId: number }
  | { kind: "create"; vaultPath: string };

export function selectVaultWindowAction(
  requestedPath: string,
  currentWindowId: number,
  windows: VaultWindow[]
): VaultWindowAction {
  const vaultPath = path.resolve(requestedPath);
  const existing = windows.find((entry) => path.resolve(entry.vaultPath) === vaultPath);
  if (existing?.windowId === currentWindowId) return { kind: "current" };
  if (existing) return { kind: "focus", windowId: existing.windowId };
  return { kind: "create", vaultPath };
}
