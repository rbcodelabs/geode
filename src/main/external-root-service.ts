import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { ExternalProjectContribution, ExternalProjectDescriptor, ExternalRootsHost, ExternalRootReply } from "../shared/external-roots";
import type { ResourceRef, RootDirectoryRef, RootIntegrationBinding } from "../shared/root-registry";
import { ExternalRootAccessError, ExternalRootDesktopBoundary, type ExternalRootSessionOptions } from "./external-root-boundary";
import { RootRegistry } from "./root-registry";

/** App lifetime owner. All windows share the same load and mutation queue. */
export class ExternalRootService {
  private registry?: Promise<RootRegistry>;
  constructor(private readonly initialize: () => Promise<RootRegistry>) {}
  async createSession(options: ExternalRootServiceOptions): Promise<ExternalRootServiceSession> {
    const registry = await (this.registry ??= this.initialize());
    const canonicalVault = await realpath(options.activeVaultPath);
    const instanceId = createHash("sha256").update(canonicalVault).digest("hex");
    const boundary = await ExternalRootDesktopBoundary.create(registry, options);
    return new ExternalRootServiceSession(registry, boundary, instanceId, options);
  }
}

export interface ExternalRootServiceOptions extends ExternalRootSessionOptions {
  confirmDetach?: (label: string) => Promise<boolean>;
}

export class ExternalRootServiceSession implements ExternalRootsHost {
  readonly version = 1;
  private projects = new Map<string, ExternalProjectContribution>();
  private vaultProjects = new Map<string, string>();
  private disposed = false;
  constructor(private readonly registry: RootRegistry, private readonly boundary: ExternalRootDesktopBoundary,
    private readonly instanceId: string, private readonly options: ExternalRootServiceOptions) {}

  async contribute(projects: ExternalProjectContribution[]): Promise<ExternalProjectDescriptor[]> {
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
    for (const [projectId, prior] of this.projects) {
      if (next.get(projectId) !== prior) this.vaultProjects.delete(projectId);
    }
    this.projects = next;
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
    if (result.kind === "inside-vault") this.vaultProjects.set(projectId, result.relativeBase);
    return this.describe(project);
  }

  async reconnect(projectId: string): Promise<ExternalProjectDescriptor | null> {
    const project = this.project(projectId);
    const binding = this.binding(projectId);
    if (!binding || binding.sourceFingerprint !== fingerprint(project)) throw new Error("Project requires detach and attachment");
    const result = await this.boundary.reconnect(binding.rootId, () => this.projects.get(projectId) === project);
    this.assertCurrent();
    return result ? this.describe(project) : null;
  }

  async detach(projectId: string): Promise<boolean> {
    const project = this.project(projectId);
    const binding = this.binding(projectId);
    if (!binding || !await this.options.confirmDetach?.(project.label)) return false;
    return this.boundary.detachIntegration(binding, () => this.projects.get(projectId) === project);
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
  async dispose(): Promise<void> { this.disposed = true; await this.boundary.dispose(); }
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
    if (root && binding) return { ...display, state: "bound", root, relativeBase: binding.relativeBase };
    const relativeBase = this.vaultProjects.get(project.projectId);
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
