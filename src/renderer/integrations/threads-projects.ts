import type { ExternalRootsHost, ExternalProjectContribution } from "../../shared/external-roots";
export interface PortableProject { projectId: string; label: string }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object"; }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !value.includes("\0"); }
export function portableThreadsProjects(data: unknown): PortableProject[] {
  if (!record(data) || !Array.isArray(data.projects) || data.projects.length > 1000) return [];
  const ids = new Set<string>();
  const result: PortableProject[] = [];
  for (const project of data.projects) {
    if (!record(project) || !text(project.id) || !text(project.name) || ids.has(project.id)) return [];
    ids.add(project.id);
    result.push({ projectId: project.id, label: project.name });
  }
  return result;
}
export class PortableProjectSource {
  private projects: PortableProject[] = [];
  private listeners = new Set<() => void>();
  private refreshCallback?: () => Promise<void>;
  getProjects(): PortableProject[] { return this.projects.map(project => ({ ...project })); }
  subscribe(callback: () => void): () => void { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; }
  publish(projects: PortableProject[]): void {
    this.projects = projects.map(({ projectId, label }) => ({ projectId, label }));
    for (const callback of this.listeners) callback();
  }
  async refresh(): Promise<void> { await this.refreshCallback?.(); }
  setRefresh(callback?: () => Promise<void>): void { this.refreshCallback = callback; }
}
const sources = new WeakMap<object, PortableProjectSource>();
export function threadsProjectSource(vault: object): PortableProjectSource {
  let source = sources.get(vault);
  if (!source) { source = new PortableProjectSource(); sources.set(vault, source); }
  return source;
}
const savedObservers = new WeakMap<object, (data: unknown) => void>();
/** Internal host hook; no new supported Plugin/App method is exposed. */
export function observeThreadsData(plugin: object, callback: (data: unknown) => void): () => void {
  savedObservers.set(plugin, callback);
  return () => { if (savedObservers.get(plugin) === callback) savedObservers.delete(plugin); };
}
export function notifyThreadsDataSaved(plugin: object, data: unknown): void {
  try { savedObservers.get(plugin)?.(data); }
  catch { console.warn("Portable Threads Project metadata could not refresh."); }
}
interface ThreadsManagerV1 {
  getProjects(): unknown;
  getProjectCwd(project: unknown): unknown;
  subscribe(callback: (threadId: unknown, event: unknown) => void): () => void;
}
export class ThreadsProjectsAdapter {
  readonly version = 1;
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  private unsubscribe?: () => void;
  private revision = 0;
  private previousProjectIds?: Set<string>;
  constructor(private readonly host: Pick<ExternalRootsHost, "contribute">, private readonly isCurrent: () => boolean) {}
  connect(plugin: unknown): void {
    if (this.disposed || !this.isCurrent() || !record(plugin) || !record(plugin.manager)) return;
    const candidate = plugin.manager;
    if (typeof candidate.getProjects !== "function" || typeof candidate.getProjectCwd !== "function" || typeof candidate.subscribe !== "function") return;
    const manager = candidate as unknown as ThreadsManagerV1;
    const snapshot = (observedChange = false) => {
      if (this.disposed || !this.isCurrent()) return;
      let contributions: ExternalProjectContribution[] = [];
      let valid = false;
      try {
        const projects = manager.getProjects();
        const portable = portableThreadsProjects({ projects });
        if (Array.isArray(projects) && portable.length === projects.length) {
          contributions = portable.map((project, index) => {
            const cwd = manager.getProjectCwd(projects[index]);
            if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 4096 || cwd.includes("\0")) throw new Error("Unsupported cwd");
            return { ...project, suggestedPath: cwd };
          });
          valid = true;
        }
      } catch { contributions = []; }
      const nextIds = valid ? new Set(contributions.map(project => project.projectId)) : undefined;
      const deletedProjectIds = observedChange && nextIds && this.previousProjectIds
        ? [...this.previousProjectIds].filter(id => !nextIds.has(id)) : [];
      this.previousProjectIds = nextIds;
      const revision = ++this.revision;
      // Host contribution replacement is synchronous before its awaited probes.
      // Never queue revocation/cwd changes behind an older filesystem probe.
      const submitted = deletedProjectIds.length ? this.host.contribute(contributions, { deletedProjectIds }) : this.host.contribute(contributions);
      this.tail = submitted.then(() => {}, () => {
        if (revision === this.revision && !this.disposed) console.warn("Threads Project integration unavailable; no folder access was granted.");
      });
    };
    try {
      const unsubscribe = manager.subscribe((_threadId, event) => { if (record(event) && event.type === "projects_changed") snapshot(true); });
      if (typeof unsubscribe !== "function") { void this.dispose(); return; }
      this.unsubscribe = unsubscribe;
    } catch { void this.dispose(); return; }
    snapshot();
  }
  async drain(): Promise<void> { await this.tail; }
  async dispose(): Promise<void> {
    if (this.disposed) return this.tail;
    this.disposed = true;
    this.revision++;
    try { this.unsubscribe?.(); } catch { /* Withdraw grants even if an old plugin's cleanup throws. */ }
    this.unsubscribe = undefined;
    this.tail = this.isCurrent() ? this.host.contribute([]).then(() => {}, () => {
      console.warn("Threads Project integration could not clear its previous session.");
    }) : Promise.resolve();
    await this.tail;
  }
}
