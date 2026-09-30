import type { ExternalRootAccessErrorCode, ExternalRootDirectoryPage, ResourceRef, RootDescriptor, RootDirectoryRef } from "./root-registry";
export type ExternalRootReply<T> = { ok: true; value: T } | { ok: false; error: ExternalRootAccessErrorCode };

/** Internal Geode/Threads integration v1; not part of the Obsidian plugin API. */
export interface ExternalProjectContribution {
  projectId: string;
  label: string;
  /** Native picker hint only, never a filesystem grant or resource identity. */
  suggestedPath?: string;
}
export interface ExternalProjectContributionOptions {
  /** Only manager-observed Project deletions, never plugin disable or initial snapshots. */
  deletedProjectIds?: string[];
}
export type ExternalProjectDescriptor = { projectId: string; label: string } & (
  | { state: "unbound"; needsDetach?: true }
  | { state: "inside-vault"; relativeBase: string }
  | { state: "bound"; root: RootDescriptor; relativeBase: string }
);
/** Core settings metadata. Other-vault association names and locators are omitted. */
export interface ExternalGrantDescriptor {
  root: RootDescriptor;
  associations: { projectId: string; label: string; active: boolean }[];
  sharedBindingCount: number;
  removable: boolean;
}
/**
 * Privileged host-mediated mount descriptor for the Threads sandbox VM. It is the
 * single, deliberate exception to "no absolute paths to plugins" (ADR-0015 addendum).
 */
export interface ExternalMountRoot {
  rootId: string;
  label: string;
  /** Canonical absolute path, freshly revalidated. Never persist it. */
  path: string;
  projectId?: string;
}
export interface ExternalRootsHost {
  readonly version: 1;
  contribute(projects: ExternalProjectContribution[], options?: ExternalProjectContributionOptions): Promise<ExternalProjectDescriptor[]>;
  listProjects(): Promise<ExternalProjectDescriptor[]>;
  attach(projectId: string): Promise<ExternalProjectDescriptor | null>;
  reconnect(projectId: string): Promise<ExternalProjectDescriptor | null>;
  detach(projectId: string): Promise<boolean>;
  listDirectory(ref: RootDirectoryRef, options?: { cursor?: string }): Promise<ExternalRootDirectoryPage>;
  readText(ref: ResourceRef): Promise<string>;
  /** Contribution/grant lifecycle only; never a filesystem watch. */
  onChange?(callback: () => void): () => void;
  listGrants?(): Promise<ExternalGrantDescriptor[]>;
  removeStaleAssociation?(projectId: string): Promise<boolean>;
  removeOrphanGrant?(rootId: string): Promise<boolean>;
  /** Connected, freshly revalidated roots bound in the calling window's vault; read-only mount use. */
  listMountRoots?(): Promise<ExternalMountRoot[]>;
}
