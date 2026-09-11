import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalRootsHost, ExternalProjectDescriptor } from "../../src/shared/external-roots";
import type { ExternalRootDirectoryPage } from "../../src/shared/root-registry";
import { PortableProjectSource } from "../../src/renderer/integrations/threads-projects";
import { groupProjectRoots, ProjectsSection, type BoundProject } from "../../src/renderer/views/projects-section";

function project(id: string, rootId: string, relativeBase = ""): BoundProject {
  return { projectId: id, label: id, state: "bound", relativeBase,
    root: { rootId, label: "root", kind: "project-cwd", capabilities: ["browse", "read", "open"], availability: "connected", createdAt: 0 } };
}
describe("Project root grouping", () => {
  it("preserves exact and nested project labels with one tree", () => {
    const projects = [project("Main", "root"), project("Nested", "root", "packages/app")];
    expect(groupProjectRoots(projects)).toEqual([{ rootId: "root", relativeBase: "", projects }]);
  });
  it("uses one component-wise common base for sibling descendants", () => {
    const projects = [project("A", "root", "packages/app"), project("B", "root", "packages/api")];
    expect(groupProjectRoots(projects)[0].relativeBase).toBe("packages");
  });
  it("does not confuse path prefixes with common directory segments", () => {
    const projects = [project("A", "root", "app"), project("B", "root", "apple")];
    expect(groupProjectRoots(projects)[0].relativeBase).toBe("");
  });
  it("keeps a sole descendant scoped to its project base", () => {
    expect(groupProjectRoots([project("A", "root", "packages/app")])[0].relativeBase).toBe("packages/app");
  });
  it("separates root identities and excludes unattached or vault projects", () => {
    expect(groupProjectRoots([project("A", "one"), project("B", "two"), { projectId: "C", label: "C", state: "unbound" }, { projectId: "D", label: "D", state: "inside-vault", relativeBase: "" }]).map(group => group.rootId)).toEqual(["one", "two"]);
  });
});

class Element {
  className = ""; textContent = ""; innerHTML = ""; hidden = false; disabled = false; type = ""; title = ""; tabIndex = -1;
  children: Element[] = []; attributes: Record<string, string> = {}; dataset: Record<string, string> = {};
  listeners = new Map<string, (event: { metaKey: boolean; ctrlKey: boolean }) => void>();
  append(...children: Element[]): void { this.children.push(...children); }
  prepend(...children: Element[]): void { this.children.unshift(...children); }
  replaceChildren(...children: Element[]): void { this.children = children; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  querySelector(): Element | null { return null; }
  classList = { add: (...names: string[]) => { this.className = [...new Set([...this.className.split(" ").filter(Boolean), ...names])].join(" "); } };
  addEventListener(name: string, action: (event: { metaKey: boolean; ctrlKey: boolean }) => void): void { this.listeners.set(name, action); }
  click(): void { this.listeners.get("click")?.({ metaKey: false, ctrlKey: false }); }
}
function nodes(node: Element): Element[] { return [node, ...node.children.flatMap(nodes)]; }
async function settle(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function setup() {
  let change = () => {};
  const unsubscribe = vi.fn();
  const host = { version: 1 as const, listProjects: vi.fn(async (): Promise<ExternalProjectDescriptor[]> => [project("Main", "root")]),
    listDirectory: vi.fn(async (): Promise<ExternalRootDirectoryPage> => ({ entries: [{ name: "README.md", kind: "file" as const, ref: { rootId: "root", relativePath: "README.md" }, size: 12, modifiedAt: 0 }], omittedCount: 0 })),
    attach: vi.fn(), reconnect: vi.fn(), detach: vi.fn(),
    onChange: (callback: () => void) => { change = callback; return unsubscribe; } };
  const openResource = vi.fn(async () => {});
  const section = new ProjectsSection({ host: host as unknown as ExternalRootsHost, openResource, revealVaultFolder: vi.fn() });
  const all = () => nodes(section.containerEl as unknown as Element);
  return { host, section, all, unsubscribe, openResource, change: () => change(), text: () => all().map(node => node.textContent).join("\n"), button: (text: string) => all().find(node => node.textContent === text || node.attributes["aria-label"] === text)! };
}
beforeEach(() => vi.stubGlobal("document", { createElement: () => new Element() }));
afterEach(() => vi.unstubAllGlobals());
describe("Projects section lifecycle and lazy browsing", () => {
  it("uses explorer header and tree-row semantics with an accessible icon refresh action", async () => {
    const h = setup();
    await h.section.refresh();
    const header = h.all().find(node => node.className.includes("sidebar-view-header"))!;
    const refresh = h.all().find(node => node.attributes["aria-label"] === "Refresh Projects")!;
    const root = h.button("Main");
    expect(header.className).toContain("projects-section-header");
    expect(refresh.className).toContain("clickable-icon");
    expect(refresh.title).toBe("Refresh Projects");
    expect(root.className).toContain("nav-folder-title");
    expect(root.className).toContain("nav-item");
    expect(root.children[0].attributes["data-icon"]).toBe("chevron-right");
    root.click(); await settle();
    expect(root.children[0].attributes["data-icon"]).toBe("chevron-down");
    const file = h.button("README.md");
    expect(file.className).toContain("nav-file-title");
    expect(file.className).toContain("nav-item");
  });
  it("shows only portable desktop-unavailable project labels without a filesystem host", async () => {
    const source = new PortableProjectSource();
    const section = new ProjectsSection({ mobileProjects: source, openResource: vi.fn(), revealVaultFolder: vi.fn() });
    source.publish([{ projectId: "p", label: "Portable Project" }]);
    await section.refresh();
    const elements = nodes(section.containerEl as unknown as Element);
    expect(elements.map(node => node.textContent).join("\n")).toContain("Available on desktop");
    expect(elements.map(node => node.textContent).join("\n")).not.toContain("Attach folder");
    elements.find(node => node.textContent === "Portable Project")!.click();
    expect(nodes(section.containerEl as unknown as Element).map(node => node.textContent).join("\n")).toContain("not synchronized");
    source.publish([]);
    expect(section.containerEl.hidden).toBe(true);
  });
  it("keeps directory and unavailable links disabled and marks contained file links", async () => {
    const h = setup();
    h.host.listDirectory.mockResolvedValueOnce({ entries: ["directory-symlink", "unavailable-link", "file-symlink"].map(kind => ({ name: kind, kind: kind as "directory-symlink" | "unavailable-link" | "file-symlink", ref: { rootId: "root", relativePath: kind }, size: 1, modifiedAt: 0 })), omittedCount: 0 });
    await h.section.refresh();
    h.button("Main").click(); await settle();
    expect(h.button("directory-symlink ↗").disabled).toBe(true);
    expect(h.button("unavailable-link ↗").disabled).toBe(true);
    expect(h.button("file-symlink ↗").disabled).toBe(false);
    expect(h.host.listDirectory).toHaveBeenCalledTimes(1);
  });
  it("preserves an unbound Project after native attachment cancellation", async () => {
    const h = setup();
    h.host.listProjects.mockResolvedValue([{ projectId: "unbound", label: "Unbound", state: "unbound" }]);
    h.host.attach.mockResolvedValue(null);
    await h.section.refresh();
    h.button("Attach folder…").click(); await settle();
    expect(h.host.attach).toHaveBeenCalledWith("unbound");
    expect(h.text()).toContain("Attach folder…");
    expect(h.host.listDirectory).not.toHaveBeenCalled();
  });
  it("offers recovery for a first project-list failure", async () => {
    const h = setup();
    h.host.listProjects.mockRejectedValueOnce(new Error("corrupt private path"));
    await h.section.refresh();
    expect(h.section.containerEl.hidden).toBe(false);
    expect(h.text()).toContain("Projects unavailable");
    expect(h.text()).not.toContain("private path");
    h.button("Refresh Projects").click(); await settle();
    expect(h.text()).toContain("Main");
  });
  it("does not call a paged folder empty before enumeration completes", async () => {
    const h = setup();
    h.host.listDirectory.mockResolvedValueOnce({ entries: [], omittedCount: 250, nextCursor: "opaque" } as Awaited<ReturnType<typeof h.host.listDirectory>>);
    await h.section.refresh();
    h.button("Main").click(); await settle();
    expect(h.text()).not.toContain("Folder is empty");
    expect(h.text()).toContain("Load more");
    h.button("Load more").click(); await settle();
    expect(h.host.listDirectory).toHaveBeenLastCalledWith({ rootId: "root", relativePath: "" }, { cursor: "opaque" });
  });
  it("renders projects without reading directories until expansion", async () => {
    const h = setup();
    await h.section.refresh();
    expect(h.text()).toContain("Projects");
    expect(h.text()).toContain("Main");
    expect(h.host.listDirectory).not.toHaveBeenCalled();
    h.button("Main").click();
    await settle();
    expect(h.host.listDirectory).toHaveBeenCalledTimes(1);
    expect(h.text()).toContain("README.md");
    h.button("README.md").click();
    expect(h.openResource).toHaveBeenCalledWith({ rootId: "root", relativePath: "README.md" }, "Main", false);
  });
  it("refreshes the immediate directory on collapse/reexpand without eager recursion", async () => {
    const h = setup();
    await h.section.refresh();
    h.button("Main").click(); await settle();
    h.button("Main").click();
    h.button("Main").click(); await settle();
    expect(h.host.listDirectory).toHaveBeenCalledTimes(2);
  });
  it("clears content immediately on lifecycle change and ignores obsolete directory reads", async () => {
    const h = setup();
    await h.section.refresh();
    let resolve!: (value: Awaited<ReturnType<typeof h.host.listDirectory>>) => void;
    h.host.listDirectory.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    h.button("Main").click();
    h.host.listProjects.mockResolvedValue([]);
    h.change();
    await settle();
    resolve({ entries: [{ name: "stale.txt", kind: "file", ref: { rootId: "root", relativePath: "stale.txt" }, size: 0, modifiedAt: 0 }], omittedCount: 0 });
    await settle();
    expect(h.text()).not.toContain("stale.txt");
    expect(h.section.containerEl.hidden).toBe(true);
  });
  it("unsubscribes on disposal and ignores future project responses", async () => {
    const h = setup();
    let resolve!: (value: BoundProject[]) => void;
    h.host.listProjects.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = h.section.refresh();
    h.section.dispose();
    resolve([project("stale", "root")]);
    await pending;
    expect(h.text()).not.toContain("stale");
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
