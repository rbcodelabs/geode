import type { ExternalProjectDescriptor } from "../../shared/external-roots";
import type { ExternalRootsHost } from "../../shared/external-roots";
import type { ResourceRef, RootDirectoryRef, ExternalRootDirectoryEntry } from "../../shared/root-registry";
import type { PortableProjectSource } from "../integrations/threads-projects";
import { setIcon } from "../api/icons";
export type BoundProject = Extract<ExternalProjectDescriptor, { state: "bound" }>;
export interface ProjectRootGroup { rootId: string; projects: BoundProject[]; relativeBase: string }
export interface ProjectsSectionOptions {
  host?: ExternalRootsHost;
  mobileProjects?: PortableProjectSource;
  openResource(ref: ResourceRef, rootLabel: string, newTab: boolean): Promise<void>;
  revealVaultFolder(relativePath: string): void;
}
export class ProjectsSection {
  readonly containerEl = document.createElement("section");
  private generation = 0;
  private disposed = false;
  private unsubscribe?: () => void;
  private actionPending = false;
  private projects: ExternalProjectDescriptor[] = [];
  constructor(private readonly options: ProjectsSectionOptions) {
    this.containerEl.className = "projects-section";
    this.containerEl.hidden = true;
    this.containerEl.setAttribute("aria-label", "External Projects");
    this.unsubscribe = options.host?.onChange?.(() => { void this.refresh(); });
    if (!options.host && options.mobileProjects) this.unsubscribe = options.mobileProjects.subscribe(() => this.renderMobile());
  }
  async refresh(): Promise<void> {
    if (this.disposed) return;
    if (!this.options.host) {
      await this.options.mobileProjects?.refresh();
      if (!this.disposed) this.renderMobile();
      return;
    }
    const generation = ++this.generation;
    // Lifecycle changes invalidate both pending reads and previously displayed trees.
    this.containerEl.replaceChildren();
    try {
      const projects = await this.options.host.listProjects();
      if (this.disposed || generation !== this.generation) return;
      this.projects = projects;
      this.render();
    } catch {
      if (this.disposed || generation !== this.generation) return;
      this.containerEl.hidden = false;
      this.containerEl.append(this.header(), this.message("Projects unavailable. Try Refresh."));
    }
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.containerEl.replaceChildren();
  }
  private render(): void {
    this.containerEl.replaceChildren();
    this.containerEl.hidden = this.projects.length === 0;
    if (!this.projects.length) return;
    this.containerEl.append(this.header());
    for (const group of groupProjectRoots(this.projects)) {
      const wrapper = document.createElement("div");
      wrapper.className = "projects-root";
      const first = group.projects[0];
      const label = group.projects.map(project => project.label).join(" · ");
      const connected = first.root.availability === "connected";
      if (connected) {
        wrapper.append(this.directory({ rootId: group.rootId, relativePath: group.relativeBase }, label, label, "Read-only external folder"));
      } else {
        wrapper.classList.add("is-broken");
        wrapper.append(this.brokenRow(label, first.root.availability));
      }
      const actions = document.createElement("div");
      actions.className = "projects-root-actions";
      for (const project of group.projects) {
        const alias = document.createElement("div");
        alias.className = "projects-root-alias";
        if (group.projects.length > 1) {
          const aliasLabel = document.createElement("span");
          aliasLabel.textContent = `${project.label}${project.relativeBase ? ` · ${project.relativeBase}` : ""}`;
          alias.append(aliasLabel);
        }
        if (project.root.availability !== "connected") alias.append(this.iconAction("Reconnect…", "refresh-cw", "reconnect", project.projectId));
        alias.append(this.iconAction("Detach from Geode", "unlink", "detach", project.projectId));
        actions.append(alias);
      }
      wrapper.append(actions);
      this.containerEl.append(wrapper);
    }
    for (const project of this.projects) {
      if (project.state === "bound") continue;
      const row = document.createElement("div");
      row.className = "projects-unbound";
      const label = document.createElement("span");
      label.className = "projects-unbound-label";
      label.textContent = project.label;
      row.append(label);
      if (project.state === "inside-vault") {
        row.append(this.button("Show in vault", () => this.options.revealVaultFolder(project.relativeBase)));
      } else if (project.needsDetach) {
        row.append(this.message("Working directory changed. Detach before attaching the new folder."), this.actionButton("Detach from Geode", "detach", project.projectId));
      } else {
        const attach = this.actionButton("Attach", "attach", project.projectId);
        attach.setAttribute("aria-label", "Attach folder…");
        attach.title = "Attach a folder to browse this Project read-only";
        row.append(attach);
      }
      this.containerEl.append(row);
    }
  }
  /** A single muted row, styled like a nav folder, naming only what is wrong. */
  private brokenRow(label: string, availability: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "projects-broken-row nav-folder-title nav-item";
    const icon = document.createElement("span");
    icon.className = "projects-folder-icon";
    setIcon(icon, "folder");
    const name = document.createElement("span");
    name.className = "projects-broken-name";
    name.textContent = label;
    const status = document.createElement("span");
    status.className = "projects-status-label";
    status.setAttribute("role", "status");
    status.textContent = availability === "permission-revoked" ? "No permission" : availability === "missing" ? "Folder missing" : "Disconnected";
    row.append(icon, name, status);
    return row;
  }
  private iconAction(label: string, icon: string, action: "reconnect" | "detach", projectId: string): HTMLButtonElement {
    const button = this.actionButton("", action, projectId);
    button.className = "projects-icon-action clickable-icon";
    button.title = label;
    button.setAttribute("aria-label", label);
    setIcon(button, icon);
    return button;
  }
  private renderMobile(): void {
    if (this.disposed) return;
    const projects = this.options.mobileProjects?.getProjects() ?? [];
    this.containerEl.replaceChildren();
    this.containerEl.hidden = projects.length === 0;
    if (!projects.length) return;
    this.containerEl.append(this.header());
    for (const project of projects) {
      const row = document.createElement("div");
      row.className = "projects-unbound";
      row.append(this.button(project.label, () => {
        row.append(this.message("Available on desktop. Project files are not synchronized to this device; browse them in desktop Geode."));
      }), this.message("Available on desktop"));
      this.containerEl.append(row);
    }
  }
  private actionButton(label: string, action: "attach" | "reconnect" | "detach", projectId: string): HTMLButtonElement {
    const button = this.button(label, () => { void this.runAction(action, projectId); });
    button.disabled = this.actionPending;
    return button;
  }
  private async runAction(action: "attach" | "reconnect" | "detach", projectId: string): Promise<void> {
    if (this.disposed || this.actionPending || !this.options.host) return;
    this.actionPending = true;
    this.render();
    const status = this.message(action === "detach" ? "Waiting for confirmation…" : "Waiting for folder selection…");
    this.containerEl.append(status);
    let failed = false;
    try { await this.options.host[action](projectId); }
    catch { failed = true; }
    finally { this.actionPending = false; }
    if (this.disposed) return;
    await this.refresh();
    if (failed && !this.disposed) this.containerEl.append(this.message("Project action unavailable. Check the folder, permissions, and overlapping attachments, then try again."));
  }
  private directory(ref: RootDirectoryRef, label: string, rootLabel: string, tooltip?: string): HTMLElement {
    const generation = this.generation;
    const wrapper = document.createElement("div");
    wrapper.className = "projects-directory";
    const contents = document.createElement("div");
    contents.className = "projects-directory-children";
    contents.hidden = true;
    let expanded = false;
    let request = 0;
    let entries: ExternalRootDirectoryEntry[] = [];
    let cursor: string | undefined;
    const current = (id: number) => !this.disposed && generation === this.generation && expanded && request === id;
    const load = async (more = false): Promise<void> => {
      if (!this.options.host) return;
      const id = ++request;
      const nextCursor = more ? cursor : undefined;
      if (!more) entries = [];
      contents.replaceChildren(this.message("Loading…"));
      try {
        const page = await this.options.host.listDirectory({ ...ref }, nextCursor ? { cursor: nextCursor } : undefined);
        if (!current(id)) return;
        entries = [...new Map([...entries, ...page.entries].map(entry => [entry.ref.relativePath, entry])).values()];
        cursor = page.nextCursor;
        const refresh = this.button("Refresh folder", () => { void load(); });
        refresh.className = "projects-inline-action";
        contents.replaceChildren(refresh);
        const sorted = [...entries].sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        for (const entry of sorted) {
          if (entry.kind === "directory") {
            contents.append(this.directory(entry.ref, entry.name, rootLabel));
          } else {
            const linked = entry.kind !== "file";
            const button = this.button(`${entry.name}${linked ? " ↗" : ""}`, event => {
              void this.options.openResource({ ...entry.ref }, rootLabel, event.metaKey || event.ctrlKey).catch(() => {
                if (current(id)) contents.append(this.message("File unavailable. Refresh and try again."));
              });
            });
            button.className = "projects-file nav-file-title nav-item";
            button.disabled = entry.kind === "directory-symlink" || entry.kind === "unavailable-link";
            if (linked) button.title = entry.kind === "directory-symlink" ? "Directory link: traversal is disabled" : entry.kind === "unavailable-link" ? "Unavailable link: target cannot be safely opened" : "Contained file link · Read-only";
            contents.append(button);
          }
        }
        if (!entries.length && !cursor) contents.append(this.message("Folder is empty."));
        if (cursor) {
          const more = this.button("Load more", () => { void load(true); });
          more.className = "projects-inline-action";
          contents.append(more);
        }
      } catch {
        if (!current(id)) return;
        cursor = undefined;
        const retry = this.button("Retry folder", () => { void load(); });
        retry.className = "projects-inline-action";
        contents.replaceChildren(this.message("Folder unavailable. Refresh Projects to check its connection, or retry."), retry);
      }
    };
    const toggle = this.button(label, () => {
      expanded = !expanded;
      toggle.setAttribute("aria-expanded", String(expanded));
      setIcon(arrow, expanded ? "chevron-down" : "chevron-right");
      contents.hidden = !expanded;
      if (expanded) void load();
      else { request++; contents.replaceChildren(); }
    });
    toggle.className = "projects-directory-toggle nav-folder-title nav-item";
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("aria-expanded", "false");
    const arrow = document.createElement("span");
    arrow.className = "nav-folder-arrow";
    setIcon(arrow, "chevron-right");
    if (tooltip) {
      toggle.title = tooltip;
      const icon = document.createElement("span");
      icon.className = "projects-folder-icon";
      setIcon(icon, "folder");
      toggle.prepend(icon);
    }
    toggle.prepend(arrow);
    wrapper.append(toggle, contents);
    return wrapper;
  }
  private header(): HTMLElement {
    const header = document.createElement("div");
    header.className = "projects-section-header sidebar-view-header";
    const title = document.createElement("span");
    title.className = "sidebar-view-title";
    title.textContent = "Projects";
    const refresh = this.button("Refresh Projects", () => { void this.refresh(); });
    refresh.className = "clickable-icon";
    refresh.title = "Refresh Projects";
    refresh.setAttribute("aria-label", "Refresh Projects");
    setIcon(refresh, "refresh-cw");
    header.append(title, refresh);
    return header;
  }
  private button(label: string, action: (event: MouseEvent) => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }
  private message(text: string): HTMLElement {
    const message = document.createElement("div");
    message.className = "projects-status";
    message.setAttribute("role", "status");
    message.textContent = text;
    return message;
  }
}
export function groupProjectRoots(projects: ExternalProjectDescriptor[]): ProjectRootGroup[] {
  const groups = new Map<string, ProjectRootGroup>();
  for (const project of projects) {
    if (project.state !== "bound") continue;
    const group = groups.get(project.root.rootId);
    if (!group) {
      groups.set(project.root.rootId, { rootId: project.root.rootId, relativeBase: project.relativeBase, projects: [project] });
      continue;
    }
    group.projects.push(project);
    const parts = group.relativeBase ? group.relativeBase.split("/") : [];
    const next = project.relativeBase.split("/");
    let length = 0;
    while (length < parts.length && parts[length] === next[length]) length++;
    group.relativeBase = parts.slice(0, length).join("/");
  }
  return [...groups.values()];
}
