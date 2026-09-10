import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ExternalRootService, externalRootReply, submitExternalProjects } from "../../src/main/external-root-service";
import { RootRegistry } from "../../src/main/root-registry";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "geode-root-service-")); dirs.push(dir);
  const vault = path.join(dir, "vault"); const repo = path.join(dir, "repo");
  await fs.mkdir(vault); await fs.mkdir(repo); await fs.writeFile(path.join(repo, "a.txt"), "hello");
  const load = vi.fn(async () => RootRegistry.open({ store: { load: async () => null, save: async () => {} } }));
  const service = new ExternalRootService(load);
  let current = true;
  const pickDirectory = vi.fn(async () => repo);
  const confirmDirectory = vi.fn(async () => true);
  const confirmDetach = vi.fn(async () => true);
  const session = await service.createSession({ activeVaultPath: vault, isSessionCurrent: () => current, pickDirectory, confirmDirectory, confirmDetach });
  return { service, session, vault, repo, load, pickDirectory, confirmDirectory, stale: () => { current = false; } };
}
it("initializes one registry across sessions and does not grant from contribution", async () => {
  const s = await setup();
  await s.service.createSession({ activeVaultPath: s.vault, isSessionCurrent: () => true, pickDirectory: async () => null });
  expect(s.load).toHaveBeenCalledTimes(1);
  expect(await s.session.contribute([{ projectId: "p", label: "Project", suggestedPath: s.repo }])).toEqual([{ projectId: "p", label: "Project", state: "unbound" }]);
  expect(s.pickDirectory).not.toHaveBeenCalled();
});
it("requires contributed project and returns locator-free descriptors", async () => {
  const s = await setup();
  await expect(s.session.attach("unknown")).rejects.toThrow();
  await s.session.contribute([{ projectId: "p", label: "Project", suggestedPath: s.repo }]);
  const attached = await s.session.attach("p");
  expect(attached?.state).toBe("bound");
  expect(JSON.stringify(attached)).not.toContain(s.repo);
  expect(JSON.stringify(attached)).not.toContain("physicalIdentity");
  if (attached?.state !== "bound") throw new Error("Expected bound project");
  expect(await s.session.readText({ rootId: attached.root.rootId, relativePath: "a.txt" })).toBe("hello");
});
it("hides roots not contributed in the current session", async () => {
  const s = await setup(); await s.session.contribute([{ projectId: "p", label: "Project" }]);
  const attached = await s.session.attach("p"); if (attached?.state !== "bound") throw new Error("Expected bound");
  const other = await s.service.createSession({ activeVaultPath: s.vault, isSessionCurrent: () => true, pickDirectory: async () => null });
  await expect(other.readText({ rootId: attached.root.rootId, relativePath: "a.txt" })).rejects.toThrow();
  expect(await other.listProjects()).toEqual([]);
});
it("cancel and stale session never attach", async () => {
  const s = await setup(); await s.session.contribute([{ projectId: "p", label: "Project" }]);
  s.confirmDirectory.mockResolvedValueOnce(false);
  expect(await s.session.attach("p")).toBeNull();
  s.stale(); await expect(s.session.attach("p")).rejects.toThrow();
});
it("rejects malformed contributions atomically", async () => {
  const s = await setup(); await s.session.contribute([{ projectId: "p", label: "Project" }]);
  await expect(s.session.contribute([{ projectId: "bad", label: "" }])).rejects.toThrow();
  expect(await s.session.listProjects()).toEqual([{ projectId: "p", label: "Project", state: "unbound" }]);
});
it("removing contribution during confirmation cancels pending grant", async () => {
  const s = await setup(); await s.session.contribute([{ projectId: "p", label: "Project" }]);
  s.confirmDirectory.mockImplementationOnce(async () => { await s.session.contribute([]); return true; });
  await expect(s.session.attach("p")).rejects.toThrow();
  await s.session.contribute([{ projectId: "p", label: "Project" }]);
  expect(await s.session.listProjects()).toEqual([{ projectId: "p", label: "Project", state: "unbound" }]);
});
it("does not send host error locators across IPC", async () => {
  const result = await externalRootReply(async () => { throw new Error("ENOENT /private/secret/repository"); });
  expect(result).toEqual({ ok: false, error: "unavailable" });
});
it("changed cwd hides saved binding until explicit detach and new attach", async () => {
  const s = await setup(); await s.session.contribute([{ projectId: "p", label: "Project", suggestedPath: s.repo }]);
  const attached = await s.session.attach("p"); if (attached?.state !== "bound") throw new Error("Expected bound");
  await s.session.contribute([{ projectId: "p", label: "Project", suggestedPath: s.repo + "-changed" }]);
  expect(await s.session.listProjects()).toEqual([{ projectId: "p", label: "Project", state: "unbound", needsDetach: true }]);
  await expect(s.session.readText({ rootId: attached.root.rootId, relativePath: "a.txt" })).rejects.toThrow();
  expect(await s.session.detach("p")).toBe(true);
  expect(await fs.readFile(path.join(s.repo, "a.txt"), "utf8")).toBe("hello");
});
it("binds by canonical vault identity and survives a new window without exposing other vaults", async () => {
  const s = await setup(); const contribution = { projectId: "p", label: "Project", suggestedPath: s.repo };
  await s.session.contribute([contribution]); const attached = await s.session.attach("p");
  const otherVault = path.join(path.dirname(s.vault), "other-vault"); await fs.mkdir(otherVault);
  const other = await s.service.createSession({ activeVaultPath: otherVault, isSessionCurrent: () => true, pickDirectory: async () => null });
  expect(await other.contribute([contribution])).toEqual([{ projectId: "p", label: "Project", state: "unbound" }]);
  const same = await s.service.createSession({ activeVaultPath: s.vault, isSessionCurrent: () => true, pickDirectory: async () => null });
  expect(await same.contribute([contribution])).toEqual([attached]);
  if (attached?.state !== "bound") throw new Error("Expected bound");
  await expect(other.readText({ rootId: attached.root.rootId, relativePath: "a.txt" })).rejects.toThrow();
  const changed = await s.service.createSession({ activeVaultPath: s.vault, isSessionCurrent: () => true, pickDirectory: async () => null });
  expect(await changed.contribute([{ ...contribution, suggestedPath: s.repo + "-new" }])).toEqual([{ projectId: "p", label: "Project", state: "unbound", needsDetach: true }]);
});
it("fresh listing reports a moved root without losing its identity", async () => {
  const s = await setup(); await s.session.contribute([{ projectId: "p", label: "Project" }]);
  const attached = await s.session.attach("p"); if (attached?.state !== "bound") throw new Error("Expected bound");
  await fs.rename(s.repo, s.repo + "-moved");
  const [project] = await s.session.listProjects();
  expect(project.state).toBe("bound");
  if (project.state !== "bound") throw new Error("Expected bound");
  expect(project.root.rootId).toBe(attached.root.rootId);
  expect(project.root.availability).toBe("missing");
});
it("classifies an in-vault cwd using existing vault authority without asking for a grant", async () => {
  const s = await setup();
  const folder = path.join(s.vault, "notes"); await fs.mkdir(folder);
  expect(await s.session.contribute([{ projectId: "p", label: "Project", suggestedPath: folder }]))
    .toEqual([{ projectId: "p", label: "Project", state: "inside-vault", relativeBase: "notes" }]);
  expect(s.pickDirectory).not.toHaveBeenCalled(); expect(s.confirmDirectory).not.toHaveBeenCalled();
});
it("broadcasts contribution revocation before a delayed probe completes", async () => {
  let finish!: (value: []) => void;
  const contribute = vi.fn(() => new Promise<[]>(resolve => { finish = resolve; }));
  const notify = vi.fn();
  const result = submitExternalProjects({ contribute }, [], undefined, notify);
  expect(contribute).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledTimes(1);
  finish([]);
  await result;
  expect(notify).toHaveBeenCalledTimes(2);
});
it("clears inside-vault association when cwd changes", async () => {
  const s = await setup(); s.pickDirectory.mockResolvedValueOnce(s.vault);
  await s.session.contribute([{ projectId: "p", label: "Project", suggestedPath: s.vault }]);
  expect((await s.session.attach("p"))?.state).toBe("inside-vault");
  expect(await s.session.contribute([{ projectId: "p", label: "Project", suggestedPath: s.repo }])).toEqual([{ projectId: "p", label: "Project", state: "unbound" }]);
});
