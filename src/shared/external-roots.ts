import type { ExternalRootAccessErrorCode, ExternalRootDirectoryPage, ResourceRef, RootDescriptor, RootDirectoryRef } from "./root-registry";
export type ExternalRootReply<T> = { ok: true; value: T } | { ok: false; error: ExternalRootAccessErrorCode };

/** Internal Geode/Threads integration v1; not part of the Obsidian plugin API. */
export interface ExternalProjectContribution {
  projectId: string;
  label: string;
  /** Native picker hint only, never a filesystem grant or resource identity. */
  suggestedPath?: string;
}
export type ExternalProjectDescriptor = { projectId: string; label: string } & (
  | { state: "unbound"; needsDetach?: true }
  | { state: "inside-vault"; relativeBase: string }
  | { state: "bound"; root: RootDescriptor; relativeBase: string }
);
export interface ExternalRootsHost {
  readonly version: 1;
  contribute(projects: ExternalProjectContribution[]): Promise<ExternalProjectDescriptor[]>;
  listProjects(): Promise<ExternalProjectDescriptor[]>;
  attach(projectId: string): Promise<ExternalProjectDescriptor | null>;
  reconnect(projectId: string): Promise<ExternalProjectDescriptor | null>;
  detach(projectId: string): Promise<boolean>;
  listDirectory(ref: RootDirectoryRef, options?: { cursor?: string }): Promise<ExternalRootDirectoryPage>;
  readText(ref: ResourceRef): Promise<string>;
  /** Contribution/grant lifecycle only; never a filesystem watch. */
  onChange?(callback: () => void): () => void;
}
