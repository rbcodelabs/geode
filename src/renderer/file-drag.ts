export const VAULT_FILE_DRAG_MIME = "application/x-geode-vault-path";

export function isValidVaultFileDragPath(path: string): boolean {
  if (!path || path !== path.trim() || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
