import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:net";
import { constants as fsConstants } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExternalRootAccessError,
  ExternalRootDesktopBoundary,
  MAX_EXTERNAL_TEXT_BYTES,
  mapExternalRootFsError,
} from "../../src/main/external-root-boundary";
import { RootRegistry, type PersistedRootRegistry, type RootRegistryStore } from "../../src/main/root-registry";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

class MemoryStore implements RootRegistryStore {
  value: PersistedRootRegistry | null = null;
  async load(): Promise<unknown | null> { return this.value; }
  async save(value: PersistedRootRegistry): Promise<void> { this.value = structuredClone(value); }
}

const tempDirs: string[] = [];
const boundaries: ExternalRootDesktopBoundary[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(boundaries.splice(0).map((boundary) => boundary.dispose()));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "geode-external-boundary-"));
  tempDirs.push(base);
  const repo = path.join(base, "repo");
  const vault = path.join(base, "vault");
  await fs.mkdir(path.join(repo, "src", "nested"), { recursive: true });
  await fs.mkdir(vault);
  const registry = await RootRegistry.open({ store: new MemoryStore() });
  let selectedPath = repo;
  const boundary = await ExternalRootDesktopBoundary.create(registry, {
    activeVaultPath: vault,
    pickDirectory: async () => selectedPath,
    confirmDirectory: async () => true,
  });
  boundaries.push(boundary);
  return { base, repo, vault, registry, boundary, selectPath: (value: string) => { selectedPath = value; } };
}

const attachment = (projectId = "project-a") => ({
  integrationId: "test-integration",
  instanceId: "instance-a",
  projectId,
  label: projectId,
});

async function attachRepo(boundary: ExternalRootDesktopBoundary) {
  const result = await boundary.attach(attachment());
  if (result === null) throw new Error("unexpected picker cancellation");
  if (result.kind === "inside-vault") throw new Error("unexpected vault result");
  return result;
}

describe("ExternalRootDesktopBoundary grants", () => {
  it("reports a missing root on refresh without losing its stable descriptor", async () => {
    const { base, repo, boundary } = await fixture();
    const attached = await attachRepo(boundary);
    await fs.rename(repo, path.join(base, "moved"));
    const descriptor = await boundary.probeRoot(attached.root.rootId);
    expect(descriptor).toMatchObject({ rootId: attached.root.rootId, availability: "missing" });
    expect(JSON.stringify(descriptor)).not.toContain(repo);
  });

  it("does not grant access after its project contribution is removed during confirmation", async () => {
    const { repo, vault, registry } = await fixture();
    let contributed = true;
    const boundary = await ExternalRootDesktopBoundary.create(registry, {
      activeVaultPath: vault,
      pickDirectory: async () => repo,
      confirmDirectory: async () => { contributed = false; return true; },
    });
    await expect(boundary.attach({ ...attachment(), isCurrent: () => contributed }))
      .rejects.toMatchObject({ code: "root-unavailable" });
    expect(registry.listRoots()).toEqual([]);
  });

  it("does not reconnect after its project contribution is removed during confirmation", async () => {
    const { repo, vault, registry, boundary } = await fixture();
    const attached = await attachRepo(boundary);
    await registry.setAvailability(attached.root.rootId, "missing");
    let contributed = true;
    const second = await ExternalRootDesktopBoundary.create(registry, {
      activeVaultPath: vault,
      pickDirectory: async () => repo,
      confirmDirectory: async () => { contributed = false; return true; },
    });
    await expect(second.reconnect(attached.root.rootId, () => contributed))
      .rejects.toMatchObject({ code: "root-unavailable" });
    expect(registry.getRoot(attached.root.rootId)?.availability).toBe("missing");
  });

  it("does not detach an integration that becomes stale before its queued mutation", async () => {
    const { registry, boundary } = await fixture();
    await attachRepo(boundary);
    let current = true;
    const remove = registry.removeBinding.bind(registry);
    vi.spyOn(registry, "removeBinding").mockImplementation(async (...args) => {
      current = false;
      return remove(...args);
    });
    await expect(boundary.detachIntegration(attachment(), () => current))
      .rejects.toMatchObject({ code: "root-unavailable" });
    expect(registry.listBindings()).toHaveLength(1);
  });

  it("passes per-request folder context to the native picker and confirmation", async () => {
    const { repo, vault, registry } = await fixture();
    const picker = vi.fn(async () => repo);
    const confirm = vi.fn(async () => true);
    const boundary = await ExternalRootDesktopBoundary.create(registry, {
      activeVaultPath: vault, pickDirectory: picker, confirmDirectory: confirm,
    });
    await boundary.attach({ ...attachment(), suggestedPath: repo });
    expect(picker).toHaveBeenCalledWith("attach", { label: "project-a", suggestedPath: repo });
    expect(confirm).toHaveBeenCalledWith({ purpose: "attach", label: "project-a", selectedPath: repo });
  });

  it("does not reveal a vault folder if the session changes while picking it", async () => {
    const { vault, registry } = await fixture();
    let current = true;
    const boundary = await ExternalRootDesktopBoundary.create(registry, {
      activeVaultPath: vault,
      pickDirectory: async () => { current = false; return vault; },
      isSessionCurrent: () => current,
    });
    await expect(boundary.attach(attachment())).rejects.toMatchObject({ code: "root-unavailable" });
  });

  it("rechecks the session when a reconnect reaches the registry mutation queue", async () => {
    const { repo, vault, registry } = await fixture();
    let current = true;
    const boundary = await ExternalRootDesktopBoundary.create(registry, {
      activeVaultPath: vault,
      pickDirectory: async () => repo,
      confirmDirectory: async () => true,
      isSessionCurrent: () => current,
    });
    const attached = await attachRepo(boundary);
    await registry.setAvailability(attached.root.rootId, "missing");
    const reconnect = registry.reconnectRoot.bind(registry);
    vi.spyOn(registry, "reconnectRoot").mockImplementation(async (...args) => {
      current = false;
      return reconnect(...args);
    });
    await expect(boundary.reconnect(attached.root.rootId)).rejects.toMatchObject({ code: "root-unavailable" });
    expect(registry.getRoot(attached.root.rootId)?.availability).toBe("missing");
  });

  it("rechecks the session when an attachment reaches the registry mutation queue", async () => {
    const { repo, vault, registry } = await fixture();
    let current = true;
    const boundary = await ExternalRootDesktopBoundary.create(registry, {
      activeVaultPath: vault,
      pickDirectory: async () => repo,
      confirmDirectory: async () => true,
      isSessionCurrent: () => current,
    });
    const attach = registry.attachProjectRoot.bind(registry);
    vi.spyOn(registry, "attachProjectRoot").mockImplementation(async (request) => {
      current = false;
      return attach(request);
    });
    await expect(boundary.attach(attachment())).rejects.toMatchObject({ code: "root-unavailable" });
    expect(registry.listRoots()).toEqual([]);
  });

  it("does not grant access without explicit confirmation", async () => {
    const { repo, vault, registry } = await fixture();
    const boundary = await ExternalRootDesktopBoundary.create(registry, {
      activeVaultPath: vault,
      pickDirectory: async () => repo,
    });
    expect(await boundary.attach(attachment())).toBeNull();
    expect(registry.listRoots()).toEqual([]);
  });

  it("is the trusted-path producer and canonicalizes a selected directory through realpath", async () => {
    const { base, repo, registry, boundary, selectPath } = await fixture();
    const alias = path.join(base, "repo-alias");
    await fs.symlink(repo, alias, "dir");

    selectPath(alias);
    const attached = await attachRepo(boundary);

    expect(registry.getRoot(attached.root.rootId)?.locator).toEqual({
      canonicalPath: await fs.realpath(repo),
      chosenPath: alias,
    });
  });

  it("supports explicit reconnect and binding detach without deleting the root grant", async () => {
    const { base, repo, registry, boundary, selectPath } = await fixture();
    const attached = await attachRepo(boundary);
    const moved = path.join(base, "moved");
    await fs.rename(repo, moved);

    selectPath(moved);
    const reconnected = await boundary.reconnect(attached.root.rootId);
    if (reconnected === null) throw new Error("unexpected picker cancellation");
    expect(reconnected.rootId).toBe(attached.root.rootId);
    expect(registry.getRoot(attached.root.rootId)?.locator.canonicalPath).toBe(await fs.realpath(moved));

    expect(await boundary.detachIntegration({
      integrationId: "test-integration",
      instanceId: "instance-a",
      projectId: "project-a",
    })).toBe(true);
    expect(registry.getRoot(attached.root.rootId)).toBeDefined();
  });

  it("requires explicit reconnect for an unavailable persisted grant", async () => {
    const { repo, registry, boundary } = await fixture();
    const attached = await attachRepo(boundary);
    await registry.setAvailability(attached.root.rootId, "missing");

    await expect(boundary.attach(attachment("project-b")))
      .rejects.toMatchObject({ code: "root-unavailable" });
    expect(registry.listRoots()).toHaveLength(1);
    expect(registry.listBindings()).toHaveLength(1);
  });

  it("requires explicit reconnect when the selected historical locator now resolves elsewhere", async () => {
    const { base, repo, registry, boundary } = await fixture();
    await attachRepo(boundary);
    const moved = path.join(base, "moved");
    const replacement = path.join(base, "replacement");
    await fs.rename(repo, moved);
    await fs.mkdir(replacement);
    await fs.symlink(replacement, repo, "dir");

    await expect(boundary.attach(attachment("project-b")))
      .rejects.toMatchObject({ code: "root-unavailable" });
    expect(registry.listRoots()).toHaveLength(1);
    expect(registry.listBindings()).toHaveLength(1);
  });

  it("does not widen an existing grant through a selected descendant symlink", async () => {
    const { base, repo, registry, boundary, selectPath } = await fixture();
    await attachRepo(boundary);
    const outside = path.join(base, "outside-project");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(repo, "linked-project"), "dir");

    selectPath(path.join(repo, "linked-project"));
    await expect(boundary.attach(attachment("project-b")))
      .rejects.toMatchObject({ code: "outside-root" });
    expect(registry.listRoots()).toHaveLength(1);
  });
});

describe("ExternalRootDesktopBoundary listing", () => {
  it("reads only a bounded page and closes the iterator on dispose", async () => {
    const { repo, boundary } = await fixture();
    await Promise.all(Array.from({ length: 251 }, (_, i) => fs.writeFile(path.join(repo, `${i}.txt`), "x")));
    const attached = await attachRepo(boundary);
    const originalOpen = fs.opendir;
    let read: ReturnType<typeof vi.spyOn> | undefined;
    let close: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(fs, "opendir").mockImplementation(async (...args) => {
      const dir = await originalOpen(...args);
      read = vi.spyOn(dir, "read");
      close = vi.spyOn(dir, "close");
      return dir;
    });
    const page = await boundary.listDirectory({ rootId: attached.root.rootId, relativePath: "" });
    expect(page.entries).toHaveLength(250);
    expect(read).toHaveBeenCalledTimes(250);
    expect(close).not.toHaveBeenCalled();
    await boundary.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("expires cursors and closes their directory handles", async () => {
    const { repo, vault, registry } = await fixture();
    await Promise.all(Array.from({ length: 251 }, (_, i) => fs.writeFile(path.join(repo, `${i}.txt`), "x")));
    let now = 0;
    const boundary = await ExternalRootDesktopBoundary.create(registry, {
      activeVaultPath: vault, pickDirectory: async () => repo, confirmDirectory: async () => true, now: () => now,
    });
    boundaries.push(boundary);
    const attached = await attachRepo(boundary);
    const ref = { rootId: attached.root.rootId, relativePath: "" };
    const first = await boundary.listDirectory(ref);
    now = 30_001;
    await expect(boundary.listDirectory(ref, { cursor: first.nextCursor })).rejects.toMatchObject({ code: "invalid-cursor" });
  });

  it("rejects reads and listings after the owning vault session changes", async () => {
    const { repo, vault, registry } = await fixture();
    let current = true;
    const boundary = await ExternalRootDesktopBoundary.create(registry, {
      activeVaultPath: vault,
      pickDirectory: async () => repo,
      isSessionCurrent: () => current,
      confirmDirectory: async () => true,
    });
    await fs.writeFile(path.join(repo, "note.txt"), "hello");
    const attached = await attachRepo(boundary);
    current = false;
    await expect(boundary.listDirectory({ rootId: attached.root.rootId, relativePath: "" }))
      .rejects.toMatchObject({ code: "root-unavailable" });
    await expect(boundary.readText({ rootId: attached.root.rootId, relativePath: "note.txt" }))
      .rejects.toMatchObject({ code: "root-unavailable" });
  });

  it("rejects a continuation when its directory has been replaced", async () => {
    const { repo, boundary } = await fixture();
    const directory = path.join(repo, "paged");
    await fs.mkdir(directory);
    await Promise.all(Array.from({ length: 251 }, (_, i) => fs.writeFile(path.join(directory, `${i}.txt`), "x")));
    const attached = await attachRepo(boundary);
    const ref = { rootId: attached.root.rootId, relativePath: "paged" };
    const first = await boundary.listDirectory(ref);
    await fs.rename(directory, path.join(repo, "old-paged"));
    await fs.mkdir(directory);
    await expect(boundary.listDirectory(ref, { cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: "unavailable" });
    await boundary.dispose();
  });

  it("lists one directory lazily with explicit regular and symlink kinds", async () => {
    const { base, repo, boundary } = await fixture();
    await fs.writeFile(path.join(repo, "README.md"), "hello");
    await fs.writeFile(path.join(repo, "target.txt"), "target");
    await fs.mkdir(path.join(repo, ".git"));
    await fs.writeFile(path.join(repo, ".DS_Store"), "hidden");
    await fs.symlink("target.txt", path.join(repo, "file-link"));
    await fs.symlink("src", path.join(repo, "dir-link"));
    await fs.symlink(path.join(base, "outside.txt"), path.join(repo, "outside-link"));
    await fs.symlink("missing.txt", path.join(repo, "broken-link"));
    const attached = await attachRepo(boundary);

    const page = await boundary.listDirectory({ rootId: attached.root.rootId, relativePath: "" });
    const entries = page.entries;

    expect(entries.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "broken-link", kind: "unavailable-link" },
      { name: "dir-link", kind: "directory-symlink" },
      { name: "file-link", kind: "file-symlink" },
      { name: "outside-link", kind: "unavailable-link" },
      { name: "README.md", kind: "file" },
      { name: "src", kind: "directory" },
      { name: "target.txt", kind: "file" },
    ]);
    expect(entries.some((entry) => entry.name === "nested")).toBe(false);
    expect(page.omittedCount).toBe(2);
  });

  it("does not traverse a directory symlink even when its target is contained", async () => {
    const { repo, boundary } = await fixture();
    await fs.symlink("src", path.join(repo, "dir-link"));
    const attached = await attachRepo(boundary);

    await expect(boundary.listDirectory({
      rootId: attached.root.rootId,
      relativePath: "dir-link",
    })).rejects.toMatchObject({ code: "directory-symlink" });
  });

  it("rejects traversal and absolute directory paths before filesystem access", async () => {
    const { repo, boundary } = await fixture();
    const attached = await attachRepo(boundary);
    for (const relativePath of ["..", "../outside", "/etc", "src/../nested", "src\\nested"]) {
      await expect(boundary.listDirectory({ rootId: attached.root.rootId, relativePath }))
        .rejects.toMatchObject({ code: "invalid-path" });
    }
  });

  it("paginates at 250 entries with opaque single-use progress cursors", async () => {
    const { repo, boundary } = await fixture();
    await Promise.all(Array.from({ length: 252 }, (_, index) =>
      fs.writeFile(path.join(repo, `file-${String(index).padStart(3, "0")}.txt`), "x")
    ));
    const attached = await attachRepo(boundary);

    const first = await boundary.listDirectory({ rootId: attached.root.rootId, relativePath: "" });
    expect(first.entries).toHaveLength(250);
    expect(first.nextCursor).toMatch(/^[0-9a-f-]{36}$/i);
    const second = await boundary.listDirectory(
      { rootId: attached.root.rootId, relativePath: "" },
      { cursor: first.nextCursor }
    );
    // The fixture also contains the src directory.
    expect(second.entries).toHaveLength(3);
    expect(second.nextCursor).toBeUndefined();
    await expect(boundary.listDirectory(
      { rootId: attached.root.rootId, relativePath: "" },
      { cursor: first.nextCursor }
    )).rejects.toMatchObject({ code: "invalid-cursor" });
  });
});

describe("ExternalRootDesktopBoundary text reads", () => {
  it("opens nonblocking so a last-moment FIFO substitution cannot hang the host", async () => {
    const { repo, boundary } = await fixture();
    await fs.writeFile(path.join(repo, "note.txt"), "hello");
    const attached = await attachRepo(boundary);
    const open = vi.spyOn(fs, "open");
    await boundary.readText({ rootId: attached.root.rootId, relativePath: "note.txt" });
    const flags = open.mock.calls[0][1] as number;
    expect(flags & fsConstants.O_NONBLOCK).toBe(fsConstants.O_NONBLOCK);
  });

  it("rejects special filesystem nodes before opening a handle", async () => {
    const { repo, boundary } = await fixture();
    const socket = createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(path.join(repo, "socket"), resolve);
    });
    try {
      const attached = await attachRepo(boundary);
      const open = vi.spyOn(fs, "open");
      await expect(boundary.readText({ rootId: attached.root.rootId, relativePath: "socket" }))
        .rejects.toMatchObject({ code: "unsupported-file" });
      expect(open).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
    }
  });

  it("continues short filesystem reads until EOF", async () => {
    const { repo, boundary } = await fixture();
    await fs.writeFile(path.join(repo, "short.txt"), "abcdef");
    const attached = await attachRepo(boundary);
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation((...parameters: any[]) =>
        read(parameters[0], parameters[1], Math.min(parameters[2], 2), parameters[3]) as any);
      return handle;
    });
    await expect(boundary.readText({ rootId: attached.root.rootId, relativePath: "short.txt" }))
      .resolves.toBe("abcdef");
  });

  it("discards text if the file is replaced during the read", async () => {
    const { repo, boundary } = await fixture();
    const file = path.join(repo, "changed.txt");
    await fs.writeFile(file, "original");
    const attached = await attachRepo(boundary);
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementationOnce(async (...parameters: any[]) => {
        const result = await read(parameters[0], parameters[1], parameters[2], parameters[3]);
        await fs.rename(file, path.join(repo, "old.txt"));
        await fs.writeFile(file, "replacement");
        return result as any;
      });
      return handle;
    });
    await expect(boundary.readText({ rootId: attached.root.rootId, relativePath: "changed.txt" }))
      .rejects.toMatchObject({ code: "unavailable" });
  });

  it("reads UTF-8 text and contained file symlinks", async () => {
    const { repo, boundary } = await fixture();
    await fs.writeFile(path.join(repo, "café.txt"), "hello 猫");
    await fs.symlink("café.txt", path.join(repo, "link.txt"));
    const attached = await attachRepo(boundary);

    await expect(boundary.readText({ rootId: attached.root.rootId, relativePath: "café.txt" }))
      .resolves.toBe("hello 猫");
    await expect(boundary.readText({ rootId: attached.root.rootId, relativePath: "link.txt" }))
      .resolves.toBe("hello 猫");
  });

  it("rejects out-of-root file symlinks and all directory symlinks", async () => {
    const { base, repo, boundary } = await fixture();
    const outside = path.join(base, "outside.txt");
    await fs.writeFile(outside, "secret");
    await fs.symlink(outside, path.join(repo, "outside-link"));
    await fs.symlink("src", path.join(repo, "dir-link"));
    const attached = await attachRepo(boundary);

    await expect(boundary.readText({ rootId: attached.root.rootId, relativePath: "outside-link" }))
      .rejects.toMatchObject({ code: "outside-root" });
    await expect(boundary.readText({ rootId: attached.root.rootId, relativePath: "dir-link" }))
      .rejects.toMatchObject({ code: "directory-symlink" });
  });

  it("caps reads at 2 MiB and rejects invalid UTF-8", async () => {
    const { repo, boundary } = await fixture();
    await fs.writeFile(path.join(repo, "limit.txt"), Buffer.alloc(MAX_EXTERNAL_TEXT_BYTES, 0x61));
    await fs.writeFile(path.join(repo, "too-large.txt"), Buffer.alloc(MAX_EXTERNAL_TEXT_BYTES + 1, 0x61));
    await fs.writeFile(path.join(repo, "binary.bin"), Buffer.from([0xc3, 0x28]));
    await fs.writeFile(path.join(repo, "nul.txt"), Buffer.from("a\0b"));
    const attached = await attachRepo(boundary);

    expect((await boundary.readText({ rootId: attached.root.rootId, relativePath: "limit.txt" })).length)
      .toBe(MAX_EXTERNAL_TEXT_BYTES);
    await expect(boundary.readText({ rootId: attached.root.rootId, relativePath: "too-large.txt" }))
      .rejects.toMatchObject({ code: "too-large" });
    await expect(boundary.readText({ rootId: attached.root.rootId, relativePath: "binary.bin" }))
      .rejects.toMatchObject({ code: "invalid-utf8" });
    await expect(boundary.readText({ rootId: attached.root.rootId, relativePath: "nul.txt" }))
      .rejects.toMatchObject({ code: "unsupported-file" });
  });

  it("revalidates the root and target containment on every operation", async () => {
    const { base, repo, boundary } = await fixture();
    await fs.writeFile(path.join(repo, "safe.txt"), "safe");
    const attached = await attachRepo(boundary);
    const moved = path.join(base, "moved-repo");
    const outside = path.join(base, "outside");
    await fs.rename(repo, moved);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "safe.txt"), "secret");
    await fs.symlink(outside, repo, "dir");

    await expect(boundary.readText({ rootId: attached.root.rootId, relativePath: "safe.txt" }))
      .rejects.toMatchObject({ code: "root-unavailable" });
  });

  it("maps missing, permission, and unavailable filesystem failures", () => {
    expect(mapExternalRootFsError(Object.assign(new Error(), { code: "ENOENT" }), "target"))
      .toMatchObject<Partial<ExternalRootAccessError>>({ code: "not-found" });
    expect(mapExternalRootFsError(Object.assign(new Error(), { code: "EACCES" }), "root"))
      .toMatchObject<Partial<ExternalRootAccessError>>({ code: "permission-denied" });
    expect(mapExternalRootFsError(Object.assign(new Error(), { code: "ELOOP" }), "target"))
      .toMatchObject<Partial<ExternalRootAccessError>>({ code: "unavailable-link" });
    expect(mapExternalRootFsError(new Error("I/O"), "target"))
      .toMatchObject<Partial<ExternalRootAccessError>>({ code: "unavailable" });
  });
});
