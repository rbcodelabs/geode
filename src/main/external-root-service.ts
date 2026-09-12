import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { ExternalProjectContribution, ExternalProjectDescriptor, ExternalRootsHost, ExternalRootReply, ExternalGrantDescriptor, ExternalProjectContributionOptions } from "../shared/external-roots";
import type { ResourceRef, RootDirectoryRef, RootIntegrationBinding } from "../shared/root-registry";
import { ExternalRootAccessError, ExternalRootDesktopBoundary, type ExternalRootSessionOptions } from "./external-root-boundary";
import { RootRegistry } from "./root-registry";

/** App lifetime owner. All windows share the same load and mutation queue. */
export class ExternalRootService {
  private registry?: Promise<RootRegistry>;
  private sessions = new Set<ExternalRootServiceSession>();
  private revision = 0;
  constructor(private readonly initialize: () => Promise<RootRegistry>) {}
  async createSession(options: ExternalRootServiceOptions): Promise<ExternalRootServiceSession> {
    const registry = await (this.registry ??= this.initialize());
    const canonicalVault = await realpath(options.activeVaultPath);
    const instanceId = createHash("sha256").update(canonicalVault).digest("hex");
    const boundary = await ExternalRootDesktopBoundary.create(registry, options);
    const session = new ExternalRootServiceSession(registry, boundary, instanceId, options, this);
    this.sessions.add(session);
    this.changed();
    return session;
  }
  get lifecycleRevision(): number { return this.revision; }
  changed(): void { this.revision++; }
  removeSession(session: ExternalRootServiceSession): void { if (this.sessions.delete(session)) this.changed(); }
  hasActiveBinding(binding: RootIntegrationBinding): boolean {
    return [...this.sessions].some((session) => session.hasActiveBinding(binding));
  }
}

export interface ExternalRootServiceOptions extends ExternalRootSessionOptions {
  confirmDetach?: (label: string) => Promise<boolean>;
  confirmManagement?: (details: { kind: "remove-root" | "remove-association"; label: string; selectedPath: string }) => Promise<boolean>;
}

export class ExternalRootServiceSession implements ExternalRootsHost {
  readonly version = 1;
  private projects = new Map<string, ExternalProjectContribution>();
  /** Ephemeral deletion leases, invalidated only when that Project changes or reappears. */
  private pendingDeletions = new Map<string, object>();
  private vaultProjects = new Map<string, string>();
  private disposed = false;
  constructor(private readonly registry: RootRegistry, private readonly boundary: ExternalRootDesktopBoundary,
    private readonly instanceId: string, private readonly options: ExternalRootServiceOptions, private readonly owner: ExternalRootService) {}

  async contribute(projects: ExternalProjectContribution[], options?: ExternalProjectContributionOptions): Promise<ExternalProjectDescriptor[]> {
    this.assertCurrent();
    if (!Array.isArray(projects) || projects.length > 1000) throw new Error("Invalid project contributions");
    const next = new Map<string, ExternalProjectContribution>();
    for (const project of projects) {
      if (!project || !validText(project.projectId, 256) || !validText(project.label, 256)
        || (project.suggestedPath !== undefined && !validText(project.suggestedPath, 4096))
        || next.has(project.projectId)) throw new Error("Invalid project contribution");
      const prior = this.projects.get(project.projectId);
      next.set(project.projectId, prior?.label === project.label && prior.suggestedPath === project.suggestedPath ? prior : {
        projectId: project.projectId, label: project.label,
        ...(project.suggestedPath === undefined ? {} : { suggestedPath: project.suggestedPath }) });
    }
    if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) throw new Error("Invalid contribution options");
    const deletedIds = options?.deletedProjectIds ?? [];
    if (!Array.isArray(deletedIds) || deletedIds.length > 1000 || new Set(deletedIds).size !== deletedIds.length
      || deletedIds.some((id) => !validText(id, 256) || !this.projects.has(id) || next.has(id))) throw new Error("Invalid Project deletion batch");
    const deletedBindings = deletedIds.flatMap((id) => { const binding = this.binding(id); return binding ? [binding] : []; });
    for (const [projectId, prior] of this.projects) {
      if (next.get(projectId) !== prior) this.vaultProjects.delete(projectId);
    }
    const changedIds = [...new Set([...this.projects.keys(), ...next.keys()])].filter((id) => this.projects.get(id) !== next.get(id));
    for (const id of changedIds) this.pendingDeletions.delete(id);
    const changed = changedIds.length > 0;
    this.projects = next;
    if (changed) this.owner.changed();
    if (deletedBindings.length) {
      const lease = {};
      for (const binding of deletedBindings) this.pendingDeletions.set(binding.projectId, lease);
      let failure: unknown;
      for (const binding of deletedBindings) {
        const guard = () => {
          this.assertCurrent();
          if (this.projects.has(binding.projectId) || this.pendingDeletions.get(binding.projectId) !== lease
            || JSON.stringify(this.binding(binding.projectId)) !== JSON.stringify(binding)) throw new Error("Project deletion became stale");
        };
        // Each target has its own atomic commit: re-adding A must not strand deleted B.
        try {
          if (await this.registry.removeBinding(binding, guard)) this.owner.changed();
        } catch (error) {
          failure ??= error;
        } finally {
          if (this.pendingDeletions.get(binding.projectId) === lease) this.pendingDeletions.delete(binding.projectId);
        }
      }
      if (failure !== undefined) throw failure;
    }
    return this.listProjects();
  }

  async listProjects(): Promise<ExternalProjectDescriptor[]> {
    this.assertCurrent();
    const projects = [...this.projects.values()];
    const result = await Promise.all(projects.map((project) => this.describe(project)));
    this.assertCurrent();
    if (projects.some((project) => this.projects.get(project.projectId) !== project)) throw new Error("Project contributions changed");
    return result;
  }

  async attach(projectId: string): Promise<ExternalProjectDescriptor | null> {
    const project = this.project(projectId);
    if (this.binding(projectId)) throw new Error("Existing Project attachment requires reconnect or detach");
    const result = await this.boundary.attach({ ...project, integrationId: "claude-threads", instanceId: this.instanceId,
      sourceFingerprint: fingerprint(project),
      isCurrent: () => this.projects.get(projectId) === project });
    this.assertCurrent();
    if (this.projects.get(projectId) !== project) throw new Error("Project contribution changed");
    if (!result) return null;
    this.owner.changed();
    if (result.kind === "inside-vault") this.vaultProjects.set(projectId, result.relativeBase);
    return this.describe(project);
  }

  async reconnect(projectId: string): Promise<ExternalProjectDescriptor | null> {
    const project = this.project(projectId);
    const binding = this.binding(projectId);
    if (!binding || binding.sourceFingerprint !== fingerprint(project)) throw new Error("Project requires detach and attachment");
    const result = await this.boundary.reconnect(binding.rootId, () => this.projects.get(projectId) === project);
    if (result) this.owner.changed();
    this.assertCurrent();
    return result ? this.describe(project) : null;
  }

  async detach(projectId: string): Promise<boolean> {
    const project = this.project(projectId);
    const binding = this.binding(projectId);
    if (!binding || !await this.options.confirmDetach?.(project.label)) return false;
    const removed = await this.boundary.detachIntegration(binding, () => this.projects.get(projectId) === project);
    if (removed) this.owner.changed();
    return removed;
  }

  async listGrants(): Promise<ExternalGrantDescriptor[]> {
    this.assertCurrent();
    const revision = this.owner.lifecycleRevision;
    const bindings = this.registry.listBindings();
    const result: ExternalGrantDescriptor[] = [];
    for (const root of this.registry.listRoots()) {
      if (root.kind !== "project-cwd") continue;
      const references = bindings.filter((binding) => binding.rootId === root.rootId);
      const own = references.filter((binding) => binding.integrationId === "claude-threads" && binding.instanceId === this.instanceId);
      if (references.length && !own.length) continue;
      const descriptor = await this.boundary.probeRoot(root.rootId);
      result.push({ root: { ...descriptor, label: own[0]?.label ?? "Unassigned folder" },
        associations: own.map((binding) => ({ projectId: binding.projectId, label: binding.label, active: this.owner.hasActiveBinding(binding) })),
        sharedBindingCount: references.length - own.length, removable: references.length === 0 });
    }
    this.assertManagementCurrent(revision);
    return result;
  }

  async removeStaleAssociation(projectId: string): Promise<boolean> {
    this.assertCurrent();
    const binding = this.binding(projectId);
    if (!binding || this.owner.hasActiveBinding(binding)) throw new Error("Association is active or unavailable in this vault");
    const root = this.registry.getRoot(binding.rootId);
    if (!root || root.kind !== "project-cwd") throw new Error("External root is unavailable");
    const revision = this.owner.lifecycleRevision;
    const snapshot = JSON.stringify(binding);
    const rootSnapshot = JSON.stringify(root);
    const guard = () => {
      this.assertManagementCurrent(revision);
      if (JSON.stringify(this.binding(projectId)) !== snapshot || this.owner.hasActiveBinding(binding)
        || JSON.stringify(this.registry.getRoot(binding.rootId)) !== rootSnapshot) throw new Error("Association changed during confirmation");
    };
    if (!await this.options.confirmManagement?.({ kind: "remove-association", label: binding.label, selectedPath: root.locator.canonicalPath })) return false;
    guard();
    const removed = await this.registry.removeBinding(binding, guard);
    if (removed) this.owner.changed();
    return removed;
  }

  async removeOrphanGrant(rootId: string): Promise<boolean> {
    this.assertCurrent();
    const root = this.registry.getRoot(rootId);
    if (!root || root.kind !== "project-cwd" || this.registry.listBindings().some((binding) => binding.rootId === rootId)) {
      throw new Error("Only unreferenced external grants can be removed");
    }
    const revision = this.owner.lifecycleRevision;
    const snapshot = JSON.stringify(root);
    const guard = () => {
      this.assertManagementCurrent(revision);
      if (JSON.stringify(this.registry.getRoot(rootId)) !== snapshot) throw new Error("Grant changed during confirmation");
    };
    if (!await this.options.confirmManagement?.({ kind: "remove-root", label: "Unassigned folder", selectedPath: root.locator.canonicalPath })) return false;
    guard();
    const removed = await this.registry.removeOrphanRoot(rootId, guard);
    if (removed) this.owner.changed();
    return removed;
  }

  /** Host-only cross-window activity check; no other window metadata is returned. */
  hasActiveBinding(binding: RootIntegrationBinding): boolean {
    if (this.disposed || !this.options.isSessionCurrent?.() || binding.integrationId !== "claude-threads" || binding.instanceId !== this.instanceId) return false;
    const project = this.projects.get(binding.projectId);
    return !!project && binding.sourceFingerprint === fingerprint(project);
  }

  private assertManagementCurrent(revision: number): void {
    this.assertCurrent();
    if (revision !== this.owner.lifecycleRevision) throw new Error("Project lifecycle changed during management");
  }

  async listDirectory(ref: RootDirectoryRef, options?: { cursor?: string }) {
    this.authorize(ref);
    const result = await this.boundary.listDirectory(ref, options);
    this.authorize(ref);
    return result;
  }
  async readText(ref: ResourceRef): Promise<string> {
    this.authorize(ref);
    const result = await this.boundary.readText(ref);
    this.authorize(ref);
    return result;
  }

  /**
   * Classify a host-side absolute path against the roots this vault session
   * actually exposes, so a local-file link can open in Geode's read-only
   * viewer instead of the OS default application.
   *
   * Only roots bound to a Project contributed in *this* window are considered:
   * a device-global grant made for another vault must not become reachable
   * here just because the path exists on disk (ADR-0015). An unavailable root
   * is skipped rather than failing the whole lookup.
   */
  async resolveOpenableFile(absolutePath: string): Promise<{ ref: ResourceRef; label: string } | null> {
    this.assertCurrent();
    if (typeof absolutePath !== "string" || !absolutePath) return null;
    const seen = new Set<string>();
    for (const project of [...this.projects.values()]) {
      const binding = this.binding(project.projectId);
      if (!binding || binding.sourceFingerprint !== fingerprint(project)) continue;
      if (seen.has(binding.rootId)) continue;
      seen.add(binding.rootId);
      let ref: ResourceRef | null;
      try {
        ref = await this.boundary.resolveOpenableFile(binding.rootId, absolutePath);
      } catch {
        continue;
      }
      if (!ref) continue;
      this.authorize(ref);
      return { ref, label: project.label };
    }
    return null;
  }
  async dispose(): Promise<void> { this.disposed = true; this.pendingDeletions.clear(); this.owner.removeSession(this); await this.boundary.dispose(); }
  private assertCurrent(): void {
    if (this.disposed || !this.options.isSessionCurrent?.()) throw new Error("External root vault session is stale");
  }
  private project(projectId: string): ExternalProjectContribution {
    this.assertCurrent();
    const project = this.projects.get(projectId);
    if (!project) throw new Error("Project is not contributed in this vault session");
    return project;
  }
  private binding(projectId: string): RootIntegrationBinding | undefined {
    return this.registry.listBindings().find((binding) => binding.integrationId === "claude-threads"
      && binding.instanceId === this.instanceId && binding.projectId === projectId);
  }
  private authorize(ref: ResourceRef): void {
    this.assertCurrent();
    if (!ref || typeof ref.rootId !== "string" || typeof ref.relativePath !== "string"
      || ![...this.projects.values()].some((project) => {
        const binding = this.binding(project.projectId);
        return binding?.rootId === ref.rootId && binding.sourceFingerprint === fingerprint(project);
      })) {
      throw new Error("Root is not contributed in this vault session");
    }
  }
  private async describe(project: ExternalProjectContribution): Promise<ExternalProjectDescriptor> {
    const display = { projectId: project.projectId, label: project.label };
    const binding = this.binding(project.projectId);
    if (binding && binding.sourceFingerprint !== fingerprint(project)) return { ...display, state: "unbound", needsDetach: true };
    const root = binding && await this.boundary.probeRoot(binding.rootId);
    this.assertCurrent();
    if (this.projects.get(project.projectId) !== project) throw new Error("Project contribution changed");
    if (root && binding) return { ...display, state: "bound", root: { ...root, label: project.label }, relativeBase: binding.relativeBase };
    const relativeBase = this.vaultProjects.get(project.projectId) ?? await this.boundary.classifyVaultDirectory(project.suggestedPath);
    this.assertCurrent();
    if (this.projects.get(project.projectId) !== project) throw new Error("Project contribution changed");
    return relativeBase === undefined ? { ...display, state: "unbound" } : { ...display, state: "inside-vault", relativeBase };
  }
}

function fingerprint(project: ExternalProjectContribution): string {
  return createHash("sha256").update(project.suggestedPath ?? "").digest("hex");
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
}

/** Electron strips custom Error fields; an explicit envelope also prevents locator leakage. */
export async function externalRootReply<T>(operation: () => Promise<T>): Promise<ExternalRootReply<T>> {
  try { return { ok: true, value: await operation() }; }
  catch (error) { return { ok: false, error: error instanceof ExternalRootAccessError ? error.code : "unavailable" }; }
}

/** Revoke displayed content immediately; filesystem probes must not delay lifecycle invalidation. */
export async function submitExternalProjects(
  session: Pick<ExternalRootsHost, "contribute">,
  projects: ExternalProjectContribution[], options: ExternalProjectContributionOptions | undefined,
  notify: () => void,
): Promise<ExternalProjectDescriptor[]> {
  const pending = session.contribute(projects, options);
  notify();
  try { return await pending; }
  finally { notify(); }
}
