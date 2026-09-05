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

export interface RootIntegrationBindingKey {
  integrationId: string;
  instanceId: string;
  projectId: string;
}

export interface RootIntegrationBinding extends RootIntegrationBindingKey {
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
