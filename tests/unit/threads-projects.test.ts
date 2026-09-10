import { describe, expect, it, vi } from "vitest";
import { portableThreadsProjects, PortableProjectSource, ThreadsProjectsAdapter, observeThreadsData, notifyThreadsDataSaved, threadsProjectSource } from "../../src/renderer/integrations/threads-projects";

function fixture() {
  let listener: (_id: string, event: { type: string }) => void = () => {};
  const unsubscribe = vi.fn();
  const projects = [{ id: "p", name: "Project", vaultFolder: "notes", cwdOverride: "/repo" }];
  const manager = { getProjects: () => projects, getProjectCwd: (project: typeof projects[number]) => project.cwdOverride || `/vault/${project.vaultFolder}`,
    subscribe: (callback: typeof listener) => { listener = callback; return unsubscribe; } };
  const host = { contribute: vi.fn(async () => []) };
  let current = true;
  const adapter = new ThreadsProjectsAdapter(host, () => current);
  return { adapter, host, manager, projects, unsubscribe, event: (type = "projects_changed") => listener("", { type }), stale: () => { current = false; } };
}
describe("portable Threads project metadata", () => {
  it("copies only validated ids and labels, never cwd or other settings", () => {
    expect(portableThreadsProjects({ projects: [{ id: "p", name: "Project", cwdOverride: "/private", vaultFolder: "notes" }], secrets: "secret" })).toEqual([{ projectId: "p", label: "Project" }]);
  });
  it("fails closed on malformed or duplicated project identities", () => {
    expect(portableThreadsProjects({ projects: [{ id: "p", name: "P" }, { id: "p", name: "Duplicate" }] })).toEqual([]);
    expect(portableThreadsProjects({ projects: [{ id: 1, name: "P" }] })).toEqual([]);
  });
  it("scopes portable sources by vault and removes subscriptions", () => {
    const vault = {};
    const source = threadsProjectSource(vault);
    expect(threadsProjectSource(vault)).toBe(source);
    expect(threadsProjectSource({})).not.toBe(source);
    const changed = vi.fn();
    const off = source.subscribe(changed);
    source.publish([{ projectId: "p", label: "P" }]);
    expect(source.getProjects()).toEqual([{ projectId: "p", label: "P" }]);
    expect(changed).toHaveBeenCalledTimes(1);
    off(); source.publish([]);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("observes only the registered mobile plugin save path and cleans up", () => {
    const plugin = {};
    const saved = vi.fn();
    const off = observeThreadsData(plugin, saved);
    notifyThreadsDataSaved({}, { projects: [] });
    expect(saved).not.toHaveBeenCalled();
    notifyThreadsDataSaved(plugin, { projects: [] });
    expect(saved).toHaveBeenCalledTimes(1);
    off(); notifyThreadsDataSaved(plugin, {});
    expect(saved).toHaveBeenCalledTimes(1);
  });
  it("does not turn an already successful plugin save into failure when an observer throws", () => {
    const plugin = {};
    observeThreadsData(plugin, () => { throw new Error("UI failure"); });
    expect(() => notifyThreadsDataSaved(plugin, {})).not.toThrow();
  });
});
describe("Threads manager v1 adapter", () => {
  it("snapshots actual manager cwd and forwards only project lifecycle updates", async () => {
    const h = fixture();
    h.adapter.connect({ manager: h.manager });
    await h.adapter.drain();
    expect(h.host.contribute).toHaveBeenLastCalledWith([{ projectId: "p", label: "Project", suggestedPath: "/repo" }]);
    h.event("thread_updated"); await h.adapter.drain();
    expect(h.host.contribute).toHaveBeenCalledTimes(1);
    h.projects[0].name = "Renamed";
    h.event(); await h.adapter.drain();
    expect(h.host.contribute).toHaveBeenLastCalledWith([{ projectId: "p", label: "Renamed", suggestedPath: "/repo" }]);
    h.projects.splice(0); h.event(); await h.adapter.drain();
    expect(h.host.contribute).toHaveBeenLastCalledWith([], { deletedProjectIds: ["p"] });
  });
  it("clears contributions after pending work on disable and unregisters listener", async () => {
    const h = fixture();
    let resolve!: (value: []) => void;
    h.host.contribute.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    h.adapter.connect({ manager: h.manager });
    await Promise.resolve();
    const disposed = h.adapter.dispose();
    expect(h.host.contribute).toHaveBeenLastCalledWith([]);
    resolve([]); await disposed;
    expect(h.host.contribute).toHaveBeenLastCalledWith([]);
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    h.event(); await h.adapter.drain();
    expect(h.host.contribute).toHaveBeenCalledTimes(2);
  });
  it("never submits a queued snapshot into a changed vault session", async () => {
    const h = fixture();
    h.stale(); h.adapter.connect({ manager: h.manager }); await h.adapter.drain();
    expect(h.host.contribute).not.toHaveBeenCalled();
    await h.adapter.dispose();
    expect(h.host.contribute).not.toHaveBeenCalled();
  });
  it("submits changed cwd immediately while an older root probe is stalled", async () => {
    const h = fixture();
    h.host.contribute.mockImplementationOnce(() => new Promise(() => {}));
    h.adapter.connect({ manager: h.manager });
    await Promise.resolve();
    h.projects[0].cwdOverride = "/new-repo";
    h.event();
    expect(h.host.contribute).toHaveBeenLastCalledWith([{ projectId: "p", label: "Project", suggestedPath: "/new-repo" }]);
    await h.adapter.drain();
  });
  it("ignores unsupported manager shapes without invoking plugin code", async () => {
    const h = fixture();
    h.adapter.connect({ manager: { getProjects: () => [] } });
    await h.adapter.drain();
    expect(h.host.contribute).not.toHaveBeenCalled();
  });
  it("contains unsupported subscription and teardown errors", async () => {
    const h = fixture();
    h.manager.subscribe = () => { throw new Error("unsupported"); };
    expect(() => h.adapter.connect({ manager: h.manager })).not.toThrow();
    await expect(h.adapter.dispose()).resolves.toBeUndefined();
    const other = fixture();
    other.manager.subscribe = () => () => { throw new Error("teardown"); };
    other.adapter.connect({ manager: other.manager });
    await expect(other.adapter.dispose()).resolves.toBeUndefined();
    expect(other.host.contribute).toHaveBeenLastCalledWith([]);
  });
  it("withdraws a snapshot with an invalid effective cwd instead of omitting the hint", async () => {
    const h = fixture();
    h.manager.getProjectCwd = () => "\0";
    h.adapter.connect({ manager: h.manager }); await h.adapter.drain();
    expect(h.host.contribute).toHaveBeenLastCalledWith([]);
  });
  it("does not infer Project deletion from an invalid snapshot or plugin disable", async () => {
    const h = fixture();
    h.adapter.connect({ manager: h.manager }); await h.adapter.drain();
    h.manager.getProjectCwd = () => "\0";
    h.event(); await h.adapter.drain();
    expect(h.host.contribute).toHaveBeenLastCalledWith([]);
    await h.adapter.dispose();
    expect(h.host.contribute).toHaveBeenLastCalledWith([]);
  });
});
