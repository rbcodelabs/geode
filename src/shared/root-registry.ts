export type RootId = string;

export type RootKind = "vault" | "project-cwd";

export type RootCapability = "browse" | "read" | "open";

export type RootAvailability =
  | "connected"
  | "missing"
  | "permission-revoked"
  | "unavailable";

/** Locator-free root metadata safe to expose outside the host process. */
export interface RootDescriptor {
  rootId: RootId;
  kind: RootKind;
  label: string;
  capabilities: readonly RootCapability[];
  availability: RootAvailability;
  createdAt: number;
  lastConnectedAt?: number;
}

export interface ResourceRef {
  rootId: RootId;
  relativePath: string;
}

export interface RootDirectoryRef {
  rootId: RootId;
  /** Empty denotes the root itself; all other values use ResourceRef validation. */
  relativePath: string;
}

export type ExternalRootDirectoryEntryKind =
  | "file"
  | "directory"
  | "file-symlink"
  | "directory-symlink"
  | "unavailable-link";

export interface ExternalRootDirectoryEntry {
  name: string;
  ref: ResourceRef;
  kind: ExternalRootDirectoryEntryKind;
  size: number;
  modifiedAt: number;
  unavailableReason?: "outside-root" | "broken" | "loop" | "permission-denied" | "unavailable";
}

export interface ExternalRootDirectoryPage {
  entries: ExternalRootDirectoryEntry[];
  nextCursor?: string;
  /** Entries intentionally omitted by host policy, such as .git and .DS_Store. */
  omittedCount: number;
}

export type ExternalRootAccessErrorCode =
  | "root-not-found"
  | "root-missing"
  | "root-unavailable"
  | "permission-denied"
  | "not-found"
  | "invalid-path"
  | "outside-root"
  | "not-directory"
  | "directory-symlink"
  | "unavailable-link"
  | "unsupported-file"
  | "too-large"
  | "invalid-utf8"
  | "invalid-cursor"
  | "unavailable";

export interface RootIntegrationBindingKey {
  integrationId: string;
  instanceId: string;
  projectId: string;
}

export interface RootIntegrationBinding extends RootIntegrationBindingKey {
  /** Opaque digest of the integration's requested cwd at explicit attachment. */
  sourceFingerprint?: string;
  rootId: RootId;
  relativeBase: string;
  label: string;
}

function invalidRelativePath(input: string): never {
  throw new Error(`Invalid resource relative path: ${JSON.stringify(input)}`);
}

/**
 * Validate the canonical spelling used in ResourceRef identity. Invalid input is
 * rejected rather than repaired so alternate spellings cannot identify the same
 * resource differently.
 */
export function normalizeResourceRelativePath(input: string): string {
  if (
    input.length === 0
    || input.includes("\0")
    || input.includes("\\")
    || input.startsWith("/")
    || /^[A-Za-z]:/.test(input)
  ) {
    return invalidRelativePath(input);
  }

  const segments = input.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return invalidRelativePath(input);
  }
  return input;
}

/** A binding can point at the root itself; ResourceRef cannot. */
export function normalizeRootRelativeBase(input: string): string {
  return input === "" ? "" : normalizeResourceRelativePath(input);
}
