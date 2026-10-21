/**
 * Pure vault-folder-name validation, shared by the picker's Create new vault
 * modal (live inline feedback) and the main process's `create-vault` handler
 * (which re-validates because it never trusts the renderer).
 */
export type VaultNameProblem = "empty" | "invalid-characters" | "reserved" | "too-long";

const MAX_NAME_BYTES = 255;

export function vaultNameProblem(name: string): VaultNameProblem | null {
  const trimmed = name.trim();
  if (!trimmed) return "empty";
  if (/[/\\:\0]/.test(trimmed)) return "invalid-characters";
  // Leading dot: ".", ".." and hidden/internal folders such as ".geode". Trailing dot and Windows device names are unsafe on some file systems.
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) return "reserved";
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(trimmed)) return "reserved";
  if (new TextEncoder().encode(trimmed).length > MAX_NAME_BYTES) return "too-long";
  return null;
}

export function vaultNameMessage(problem: VaultNameProblem): string {
  switch (problem) {
    case "empty": return "Enter a name for the vault.";
    case "invalid-characters": return "A vault name can't contain / \\ : or control characters.";
    case "reserved": return "That name is reserved. Don't start or end it with a dot or use a system name like CON.";
    case "too-long": return "That name is too long (255 bytes maximum).";
  }
}
