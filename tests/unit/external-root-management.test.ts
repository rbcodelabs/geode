import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ExternalRootService } from "../../src/main/external-root-service";
import { JsonRootRegistryStore, RootRegistry } from "../../src/main/root-registry";
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));

const temporary: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "geode-root-management-")); temporary.push(base);
  const vault = path.join(base, "vault"); const repo = path.join(base, "projects", "repo");
  await fs.mkdir(vault); await fs.mkdir(repo, { recursive: true }); await fs.writeFile(path.join(repo, "file.txt"), "preserved");
  const store = new JsonRootRegistryStore(base);
  const registry = await RootRegistry.open({ store });
  const service = new ExternalRootService(async () => registry);
  let current = true;
  const confirmManagement = vi.fn(async () => true);
  const options = { activeVaultPath: vault, isSessionCurrent: () => current, pickDirectory: async () => repo,
    confirmDirectory: async () => true, confirmDetach: async () => true, confirmManagement };
  const session = await service.createSession(options);
  const project = { projectId: "p", label: "Private project", suggestedPath: repo };
  await session.contribute([project]);
  const attached = await session.attach("p"); if (attached?.state !== "bound") throw new Error("Expected bound");
  return { base, repo, vault, registry, store, service, session, options, project, rootId: attached.root.rootId, confirmManagement, stale: () => { current = false; } };
}
it("lists own associations after plugin unload without exposing other-vault labels", async () => {
  const s = await setup(); await s.session.contribute([]);
  const [grant] = await s.session.listGrants();
  expect(grant.root.rootId).toBe(s.rootId);
  expect(grant.associations).toEqual([{ projectId: "p", label: "Private project", active: false }]);
  expect(JSON.stringify(grant)).not.toContain(s.repo);
  const otherVault = path.join(s.base, "other"); await fs.mkdir(otherVault);
  const other = await s.service.createSession({ ...s.options, activeVaultPath: otherVault });
  expect(await other.listGrants()).toEqual([]);
  await expect(other.removeStaleAssociation("p")).rejects.toThrow();
  await expect(other.removeOrphanGrant(s.rootId)).rejects.toThrow();
});
it("removes only confirmed stale association then orphan grant and persists without touching files", async () => {
  const s = await setup(); await s.session.contribute([]);
  expect(await s.session.removeStaleAssociation("p")).toBe(true);
  const [grant] = await s.session.listGrants();
  expect(grant.root.label).toBe("Unassigned folder"); expect(grant.removable).toBe(true);
  expect(await s.session.removeOrphanGrant(s.rootId)).toBe(true);
  expect((await RootRegistry.open({ store: s.store })).listRoots()).toEqual([]);
  expect(await fs.readFile(path.join(s.repo, "file.txt"), "utf8")).toBe("preserved");
  expect(s.confirmManagement).toHaveBeenLastCalledWith(expect.objectContaining({ selectedPath: await fs.realpath(s.repo), kind: "remove-root" }));
});
it("cancel changes neither stale association nor orphan grant", async () => {
  const s = await setup(); await s.session.contribute([]);
  s.confirmManagement.mockResolvedValue(false);
  expect(await s.session.removeStaleAssociation("p")).toBe(false);
  expect(s.registry.listBindings()).toHaveLength(1);
  s.confirmManagement.mockResolvedValue(true); await s.session.removeStaleAssociation("p");
  s.confirmManagement.mockResolvedValue(false);
  expect(await s.session.removeOrphanGrant(s.rootId)).toBe(false);
  expect(s.registry.listRoots()).toHaveLength(1);
});
it("rejects active associations in another window and preserves shared roots", async () => {
  const s = await setup();
  const second = await s.service.createSession(s.options); await second.contribute([s.project]);
  await s.session.contribute([]);
  await expect(s.session.removeStaleAssociation("p")).rejects.toThrow();
  await second.contribute([]);
  const otherVault = path.join(s.base, "other"); await fs.mkdir(otherVault);
  const other = await s.service.createSession({ ...s.options, activeVaultPath: otherVault });
  await other.contribute([{ ...s.project, label: "Other secret" }]); await other.attach("p");
  const [otherProject] = await other.listProjects();
  expect(JSON.stringify(otherProject)).not.toContain("Private project");
  const [grant] = await s.session.listGrants();
  expect(grant.sharedBindingCount).toBe(1); expect(JSON.stringify(grant)).not.toContain("Other secret");
  expect(await s.session.removeStaleAssociation("p")).toBe(true);
  await expect(s.session.removeOrphanGrant(s.rootId)).rejects.toThrow();
  expect(s.registry.listBindings()).toHaveLength(1);
});
it("fails pending confirmation on contribution or session changes", async () => {
  const s = await setup(); await s.session.contribute([]);
  s.confirmManagement.mockImplementationOnce(async () => { await s.session.contribute([s.project]); return true; });
  await expect(s.session.removeStaleAssociation("p")).rejects.toThrow();
  await s.session.contribute([]);
  s.confirmManagement.mockImplementationOnce(async () => { s.stale(); return true; });
  await expect(s.session.removeStaleAssociation("p")).rejects.toThrow();
  expect(s.registry.listBindings()).toHaveLength(1);
});
it("identical contributions do not cancel management confirmation", async () => {
  const s = await setup(); await s.session.contribute([]);
  s.confirmManagement.mockImplementationOnce(async () => { await s.session.contribute([]); return true; });
  expect(await s.session.removeStaleAssociation("p")).toBe(true);
  await expect(s.session.removeOrphanGrant("unknown")).rejects.toThrow();
});
it("rejects orphan removal if a binding is attached while native confirmation is pending", async () => {
  const s = await setup(); await s.session.detach("p");
  s.confirmManagement.mockImplementationOnce(async () => { await s.session.attach("p"); return true; });
  await expect(s.session.removeOrphanGrant(s.rootId)).rejects.toThrow();
  expect(s.registry.listRoots()).toHaveLength(1); expect(s.registry.listBindings()).toHaveLength(1);
});
it("cancels staged orphan removal on vault invalidation", async () => {
  const s = await setup(); await s.session.detach("p");
  const write = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => { await write(...args); s.stale(); });
  await expect(s.session.removeOrphanGrant(s.rootId)).rejects.toThrow();
  expect((await RootRegistry.open({ store: s.store })).listRoots()).toHaveLength(1);
});
it("removing a narrower orphan permits deliberate parent attachment", async () => {
  const s = await setup(); await s.session.detach("p");
  const externalParent = path.dirname(s.repo);
  const other = await s.service.createSession({ ...s.options, pickDirectory: async () => externalParent });
  await other.contribute([{ projectId: "parent", label: "Parent" }]);
  await expect(other.attach("parent")).rejects.toThrow();
  await s.session.removeOrphanGrant(s.rootId);
  expect((await other.attach("parent"))?.state).toBe("bound");
});
it("Project deletion removes only the current vault binding while disable retains it", async () => {
  const s = await setup();
  await s.session.contribute([]); expect(s.registry.listBindings()).toHaveLength(1);
  await s.session.contribute([s.project]);
  const otherVault = path.join(s.base, "other"); await fs.mkdir(otherVault);
  const other = await s.service.createSession({ ...s.options, activeVaultPath: otherVault });
  await other.contribute([s.project]); await other.attach("p");
  await s.session.contribute([], { deletedProjectIds: ["p"] });
  expect(s.registry.listBindings()).toHaveLength(1);
  expect((await other.listProjects())[0].state).toBe("bound");
  expect(s.registry.listRoots()).toHaveLength(1);
  expect(s.confirmManagement).not.toHaveBeenCalled();
});
it("rejects deletion IDs not removed from the prior contribution before changing state", async () => {
  const s = await setup();
  await expect(s.session.contribute([], { deletedProjectIds: ["unknown"] })).rejects.toThrow();
  await expect(s.session.contribute([s.project], { deletedProjectIds: ["p"] })).rejects.toThrow();
  expect((await s.session.listProjects())[0].state).toBe("bound");
});
it("staged Project deletion fails if the project is re-added before commit", async () => {
  const s = await setup(); const write = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
    await write(...args); await s.session.contribute([s.project]);
  });
  await expect(s.session.contribute([], { deletedProjectIds: ["p"] })).rejects.toThrow();
  expect((await RootRegistry.open({ store: s.store })).listBindings()).toHaveLength(1);
  expect((await s.session.listProjects())[0].state).toBe("bound");
});
it.each([false, true])("rapid Project deletions keep independent guards (re-add first: %s)", async (readdFirst) => {
  const s = await setup(); const secondProject = { ...s.project, projectId: "q", label: "Second" };
  await s.session.contribute([s.project, secondProject]); await s.session.attach("q");
  const otherVault = path.join(s.base, "other"); await fs.mkdir(otherVault);
  const other = await s.service.createSession({ ...s.options, activeVaultPath: otherVault });
  await other.contribute([s.project]); await other.attach("p");
  const write = fs.writeFile; let secondDeletion!: Promise<unknown>;
  vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
    await write(...args);
    secondDeletion = s.session.contribute([], { deletedProjectIds: ["q"] });
    if (readdFirst) await s.session.contribute([s.project]);
  });
  const firstDeletion = s.session.contribute([secondProject], { deletedProjectIds: ["p"] });
  const firstResult = await firstDeletion.then((value) => ({ value }), (error: unknown) => ({ error }));
  const secondResult = await secondDeletion.then((value) => ({ value }), (error: unknown) => ({ error }));
  if (readdFirst) {
    expect(firstResult).toHaveProperty("error");
    expect(secondResult).toHaveProperty("value");
    expect((await s.session.listProjects())[0].state).toBe("bound");
  } else {
    expect(firstResult).toEqual({ value: [] }); expect(secondResult).toEqual({ value: [] });
  }
  const restored = await RootRegistry.open({ store: s.store });
  expect(restored.listBindings()).toHaveLength(readdFirst ? 2 : 1);
  expect(restored.listBindings().some((binding) => binding.projectId === "q")).toBe(false);
  expect((await other.listProjects())[0].state).toBe("bound");
  expect(restored.listRoots()).toHaveLength(1);
});
it("re-adding one target in a deletion batch does not strand another deleted Project", async () => {
  const s = await setup(); const secondProject = { ...s.project, projectId: "q", label: "Second" };
  await s.session.contribute([s.project, secondProject]); await s.session.attach("q");
  const write = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementationOnce(async (...args) => {
    await write(...args); await s.session.contribute([s.project]);
  });
  await expect(s.session.contribute([], { deletedProjectIds: ["p", "q"] })).rejects.toThrow();
  const persisted = await RootRegistry.open({ store: s.store });
  expect(persisted.listBindings().map((binding) => binding.projectId)).toEqual(["p"]);
  expect((await s.session.listProjects())[0].state).toBe("bound");
});
