import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeResourceRelativePath,
  normalizeRootRelativeBase,
} from "../../src/shared/root-registry";
import {
  ROOT_REGISTRY_SCHEMA_VERSION,
  BindingRetargetError,
  JsonRootRegistryStore,
  RootOverlapError,
  RootRegistry,
  type TrustedCanonicalRootPath,
  type PersistedRootRegistry,
  type RootRegistryStore,
} from "../../src/main/root-registry";

class MemoryRootRegistryStore implements RootRegistryStore {
  value: PersistedRootRegistry | null = null;
  failNext = false;
  async load(): Promise<unknown | null> { return this.value; }
  async save(value: PersistedRootRegistry): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("disk full");
    }
    this.value = structuredClone(value);
  }
}

class ControlledRootRegistryStore implements RootRegistryStore {
  value: PersistedRootRegistry | null = null;
  pending: Array<{
    value: PersistedRootRegistry;
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];

  async load(): Promise<unknown | null> { return this.value; }
  save(value: PersistedRootRegistry): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.push({ value: structuredClone(value), resolve, reject });
    });
  }
  succeedNext(): void {
    const pending = this.pending.shift();
    if (!pending) throw new Error("No pending save");
    this.value = pending.value;
    pending.resolve();
  }
  failNext(error = new Error("disk full")): void {
    const pending = this.pending.shift();
    if (!pending) throw new Error("No pending save");
    pending.reject(error);
  }
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTree(): Promise<{ base: string; repo: string; packageDir: string; vault: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "geode-roots-"));
  tempDirs.push(base);
  const repo = path.join(base, "repo");
  const packageDir = path.join(repo, "packages", "app");
  const vault = path.join(base, "vault");
  await Promise.all([
    fs.mkdir(packageDir, { recursive: true }),
    fs.mkdir(path.join(vault, "Projects", "inside"), { recursive: true }),
  ]);
  return { base, repo, packageDir, vault };
}

const binding = (projectId: string, label = projectId) => ({
  integrationId: "claude-threads",
  instanceId: "vault-instance-a",
  projectId,
  label,
});

/** Test-only bypass for the future Tranche 2 realpath producer. Never use in host production code. */
const canonical = (value: string): TrustedCanonicalRootPath => value as TrustedCanonicalRootPath;

// These compile-time assertions guard the trust boundary; they never execute.
if (false) {
  // @ts-expect-error ordinary strings have not passed the host canonical-real-path boundary
  void RootRegistry.open({ store: new MemoryRootRegistryStore(), activeVaultPath: "/vault" });
}

describe("external resource path identity", () => {
  it("does not export a lexical caster that can manufacture trusted canonical paths", async () => {
    const moduleExports = await import("../../src/main/root-registry");
    expect(moduleExports).not.toHaveProperty("trustedCanonicalRootPath");
  });

  it("preserves a canonical slash-separated, Unicode relative path", () => {
    expect(normalizeResourceRelativePath("src/café/猫.ts")).toBe("src/café/猫.ts");
  });

  it.each([
    "",
    ".",
    "..",
    "/etc/passwd",
    "src//file.ts",
    "src/./file.ts",
    "src/../secret",
    "src/",
    "C:/Windows/system.ini",
    "C:\\Windows\\system.ini",
    "\\\\server\\share\\file",
    "src\\file.ts",
    "src/nu\0ll.ts",
  ])("rejects non-canonical or authority-bearing path %j", (candidate) => {
    expect(() => normalizeResourceRelativePath(candidate)).toThrow(/relative path/i);
  });

  it("allows only the root binding base to use the empty path", () => {
    expect(normalizeRootRelativeBase("")).toBe("");
    expect(normalizeRootRelativeBase("packages/app")).toBe("packages/app");
    expect(() => normalizeRootRelativeBase("packages/../app")).toThrow(/relative path/i);
  });
});

describe("RootRegistry attachment and binding lifecycle", () => {
  it("creates an opaque stable UUID and persists the read-only grant", async () => {
    const { repo, vault } = await makeTree();
    const store = new MemoryRootRegistryStore();
    const registry = await RootRegistry.open({ store, activeVaultPath: canonical(vault), now: () => 1234 });

    const result = await registry.attachProjectRoot({
      canonicalPath: canonical(repo),
      ...binding("project-a", "Geode"),
    });

    expect(result.kind).toBe("attached");
    if (result.kind !== "attached") throw new Error("expected attached root");
    expect(result.root.rootId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(result.root.capabilities).toEqual(new Set(["browse", "read", "open"]));
    expect(result.root.createdAt).toBe(1234);
    expect(store.value).toMatchObject({ schemaVersion: ROOT_REGISTRY_SCHEMA_VERSION });
    expect(store.value?.roots[0]).toMatchObject({
      rootId: result.root.rootId,
      kind: "project-cwd",
      label: "Geode",
      locator: { canonicalPath: repo },
      capabilities: ["browse", "read", "open"],
      availability: "connected",
    });
  });

  it("exactly deduplicates a canonical target", async () => {
    const { repo, vault } = await makeTree();
    const registry = await RootRegistry.open({ store: new MemoryRootRegistryStore(), activeVaultPath: canonical(vault) });

    const first = await registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-a") });
    const second = await registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-b") });

    expect(first.kind).toBe("attached");
    expect(second.kind).toBe("reused");
    if (first.kind === "inside-vault" || second.kind === "inside-vault") throw new Error("unexpected vault result");
    expect(second.root.rootId).toBe(first.root.rootId);
    expect(second.binding.relativeBase).toBe("");
    expect(registry.listRoots()).toHaveLength(1);
    expect(registry.listBindings()).toHaveLength(2);
  });

  it("reuses an ancestor grant with a normalized relative base", async () => {
    const { repo, packageDir, vault } = await makeTree();
    const registry = await RootRegistry.open({ store: new MemoryRootRegistryStore(), activeVaultPath: canonical(vault) });
    const first = await registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-a") });

    const child = await registry.attachProjectRoot({ canonicalPath: canonical(packageDir), ...binding("project-b") });

    expect(child.kind).toBe("reused");
    if (first.kind === "inside-vault" || child.kind === "inside-vault") throw new Error("unexpected vault result");
    expect(child.root.rootId).toBe(first.root.rootId);
    expect(child.binding.relativeBase).toBe("packages/app");
    expect(registry.listRoots()).toHaveLength(1);
  });

  it("blocks a parent attachment that would broaden an existing grant", async () => {
    const { repo, packageDir, vault } = await makeTree();
    const registry = await RootRegistry.open({ store: new MemoryRootRegistryStore(), activeVaultPath: canonical(vault) });
    const child = await registry.attachProjectRoot({ canonicalPath: canonical(packageDir), ...binding("project-a") });
    if (child.kind === "inside-vault") throw new Error("unexpected vault result");

    await expect(
      registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-b") })
    ).rejects.toMatchObject<Partial<RootOverlapError>>({
      name: "RootOverlapError",
      conflictingRootIds: [child.root.rootId],
    });
    expect(registry.listRoots()).toHaveLength(1);
    expect(registry.listBindings()).toHaveLength(1);
  });

  it("returns a vault-relative base instead of mounting a directory inside the active vault", async () => {
    const { vault } = await makeTree();
    const registry = await RootRegistry.open({ store: new MemoryRootRegistryStore(), activeVaultPath: canonical(vault) });

    const result = await registry.attachProjectRoot({
      canonicalPath: canonical(path.join(vault, "Projects", "inside")),
      ...binding("project-a"),
    });

    expect(result).toEqual({ kind: "inside-vault", relativeBase: "Projects/inside" });
    expect(registry.listRoots()).toEqual([]);
    expect(registry.listBindings()).toEqual([]);
  });

  it("blocks an external root that would envelop and duplicate the active vault", async () => {
    const { base, vault } = await makeTree();
    const registry = await RootRegistry.open({ store: new MemoryRootRegistryStore(), activeVaultPath: canonical(vault) });

    await expect(
      registry.attachProjectRoot({ canonicalPath: canonical(base), ...binding("project-a") })
    ).rejects.toBeInstanceOf(RootOverlapError);
    expect(registry.listRoots()).toEqual([]);
  });

  it("removes only the requested integration binding and retains orphaned grants", async () => {
    const { repo, vault } = await makeTree();
    const registry = await RootRegistry.open({ store: new MemoryRootRegistryStore(), activeVaultPath: canonical(vault) });
    const attached = await registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-a") });
    if (attached.kind === "inside-vault") throw new Error("unexpected vault result");

    expect(await registry.removeBinding(binding("project-a"))).toBe(true);

    expect(registry.listBindings()).toEqual([]);
    expect(registry.getRoot(attached.root.rootId)?.rootId).toBe(attached.root.rootId);
    expect(await registry.removeBinding(binding("project-a"))).toBe(false);
  });

  it("does not silently retarget an existing composite binding", async () => {
    const { base, repo, vault } = await makeTree();
    const other = path.join(base, "other");
    await fs.mkdir(other);
    const registry = await RootRegistry.open({ store: new MemoryRootRegistryStore(), activeVaultPath: canonical(vault) });
    const first = await registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-a") });
    if (first.kind === "inside-vault") throw new Error("unexpected vault result");

    await expect(
      registry.attachProjectRoot({ canonicalPath: canonical(other), ...binding("project-a") })
    ).rejects.toBeInstanceOf(BindingRetargetError);
    expect(registry.listRoots()).toHaveLength(1);
    expect(registry.listBindings()).toEqual([first.binding]);
  });

  it("preserves root identity across an explicit reconnect and updates availability", async () => {
    const { base, repo, vault } = await makeTree();
    const moved = path.join(base, "repo-moved");
    await fs.mkdir(moved);
    const registry = await RootRegistry.open({ store: new MemoryRootRegistryStore(), activeVaultPath: canonical(vault) });
    const attached = await registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-a") });
    if (attached.kind === "inside-vault") throw new Error("unexpected vault result");

    await registry.setAvailability(attached.root.rootId, "missing");
    expect(registry.getRoot(attached.root.rootId)?.availability).toBe("missing");

    const reconnected = await registry.reconnectRoot(attached.root.rootId, {
      canonicalPath: canonical(moved),
      chosenPath: path.join(base, "friendly-repo"),
    });
    expect(reconnected.rootId).toBe(attached.root.rootId);
    expect(reconnected.locator).toEqual({ canonicalPath: moved, chosenPath: path.join(base, "friendly-repo") });
    expect(reconnected.availability).toBe("connected");
  });

  it.each(["equal", "descendant", "ancestor"] as const)(
    "rejects reconnect to the active vault %s",
    async (relationship) => {
      const { base, repo, vault } = await makeTree();
      const registry = await RootRegistry.open({
        store: new MemoryRootRegistryStore(),
        activeVaultPath: canonical(vault),
      });
      const attached = await registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-a") });
      if (attached.kind === "inside-vault") throw new Error("unexpected vault result");
      const target = relationship === "equal"
        ? vault
        : relationship === "descendant"
          ? path.join(vault, "Projects", "inside")
          : base;

      await expect(
        registry.reconnectRoot(attached.root.rootId, { canonicalPath: canonical(target) })
      ).rejects.toBeInstanceOf(RootOverlapError);
      expect(registry.getRoot(attached.root.rootId)?.locator.canonicalPath).toBe(repo);
    }
  );

  it("keeps in-memory state unchanged when persistence fails", async () => {
    const { repo, vault } = await makeTree();
    const store: RootRegistryStore = {
      load: async () => null,
      save: async () => { throw new Error("disk full"); },
    };
    const registry = await RootRegistry.open({ store, activeVaultPath: canonical(vault) });

    await expect(
      registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-a") })
    ).rejects.toThrow("disk full");
    expect(registry.listRoots()).toEqual([]);
    expect(registry.listBindings()).toEqual([]);
  });

  it("rejects a non-UUID identity factory result before granting or persisting", async () => {
    const { repo, vault } = await makeTree();
    const store = new MemoryRootRegistryStore();
    const registry = await RootRegistry.open({
      store,
      activeVaultPath: canonical(vault),
      createRootId: () => "predictable-id",
    });

    await expect(
      registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-a") })
    ).rejects.toThrow(/UUID/i);
    expect(store.value).toBeNull();
    expect(registry.listRoots()).toEqual([]);
  });

  it("rejects invalid integration metadata and display paths before persisting", async () => {
    const { repo, vault } = await makeTree();
    const store = new MemoryRootRegistryStore();
    const registry = await RootRegistry.open({ store, activeVaultPath: canonical(vault) });

    await expect(registry.attachProjectRoot({
      canonicalPath: canonical(repo),
      ...binding("project-a"),
      integrationId: "",
    })).rejects.toThrow(/binding/i);
    await expect(registry.attachProjectRoot({
      canonicalPath: canonical(repo),
      chosenPath: "relative/repo",
      ...binding("project-a"),
    })).rejects.toThrow(/absolute path/i);
    expect(store.value).toBeNull();
  });

  it("rolls back remove, availability, and reconnect when their saves fail", async () => {
    const { base, repo, vault } = await makeTree();
    const moved = path.join(base, "moved");
    const store = new MemoryRootRegistryStore();
    const registry = await RootRegistry.open({ store, activeVaultPath: canonical(vault) });
    const attached = await registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-a") });
    if (attached.kind === "inside-vault") throw new Error("unexpected vault result");
    const persisted = structuredClone(store.value);

    store.failNext = true;
    await expect(registry.removeBinding(binding("project-a"))).rejects.toThrow("disk full");
    expect(registry.listBindings()).toEqual([attached.binding]);
    expect(store.value).toEqual(persisted);

    store.failNext = true;
    await expect(registry.setAvailability(attached.root.rootId, "missing")).rejects.toThrow("disk full");
    expect(registry.getRoot(attached.root.rootId)?.availability).toBe("connected");
    expect(store.value).toEqual(persisted);

    store.failNext = true;
    await expect(registry.reconnectRoot(attached.root.rootId, {
      canonicalPath: canonical(moved),
    })).rejects.toThrow("disk full");
    expect(registry.getRoot(attached.root.rootId)?.locator.canonicalPath).toBe(repo);
    expect(store.value).toEqual(persisted);
  });

  it("exposes locator-free descriptors", async () => {
    const { repo, vault } = await makeTree();
    const registry = await RootRegistry.open({
      store: new MemoryRootRegistryStore(),
      activeVaultPath: canonical(vault),
    });
    const attached = await registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-a") });
    if (attached.kind === "inside-vault") throw new Error("unexpected vault result");

    const descriptor = registry.getRootDescriptor(attached.root.rootId);
    expect(descriptor).toMatchObject({
      rootId: attached.root.rootId,
      capabilities: ["browse", "read", "open"],
      availability: "connected",
    });
    expect(descriptor).not.toHaveProperty("locator");
    expect(JSON.stringify(descriptor)).not.toContain(repo);
  });
});

describe("RootRegistry mutation serialization", () => {
  it("retains both bindings when concurrent exact attachments share a grant", async () => {
    const { repo, vault } = await makeTree();
    const store = new ControlledRootRegistryStore();
    const registry = await RootRegistry.open({ store, activeVaultPath: canonical(vault) });

    const first = registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-a") });
    const second = registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-b") });
    await vi.waitFor(() => expect(store.pending).toHaveLength(1));
    store.succeedNext();
    await first;
    await vi.waitFor(() => expect(store.pending).toHaveLength(1));
    store.succeedNext();
    await second;

    expect(registry.listRoots()).toHaveLength(1);
    expect(registry.listBindings().map((item) => item.projectId).sort()).toEqual(["project-a", "project-b"]);
    expect(store.value?.roots).toHaveLength(1);
    expect(store.value?.bindings).toHaveLength(2);
  });

  it("retains independent roots attached concurrently", async () => {
    const { base, repo, vault } = await makeTree();
    const other = path.join(base, "other");
    const store = new ControlledRootRegistryStore();
    const registry = await RootRegistry.open({ store, activeVaultPath: canonical(vault) });

    const first = registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-a") });
    const second = registry.attachProjectRoot({ canonicalPath: canonical(other), ...binding("project-b") });
    await vi.waitFor(() => expect(store.pending).toHaveLength(1));
    store.succeedNext();
    await first;
    await vi.waitFor(() => expect(store.pending).toHaveLength(1));
    store.succeedNext();
    await second;

    expect(registry.listRoots()).toHaveLength(2);
    expect(store.value?.roots).toHaveLength(2);
  });

  it("continues the mutation queue after a save failure", async () => {
    const { base, repo, vault } = await makeTree();
    const other = path.join(base, "other");
    const store = new ControlledRootRegistryStore();
    const registry = await RootRegistry.open({ store, activeVaultPath: canonical(vault) });

    const failed = registry.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-a") });
    const recovered = registry.attachProjectRoot({ canonicalPath: canonical(other), ...binding("project-b") });
    const failedOutcome = failed.catch((error) => error);
    await vi.waitFor(() => expect(store.pending).toHaveLength(1));
    store.failNext();
    expect(await failedOutcome).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(store.pending).toHaveLength(1));
    store.succeedNext();
    await recovered;

    expect(registry.listRoots()).toHaveLength(1);
    expect(registry.listBindings().map((item) => item.projectId)).toEqual(["project-b"]);
    expect(store.value?.bindings.map((item) => item.projectId)).toEqual(["project-b"]);
  });
});

describe("root registry persistence", () => {
  const rootIdA = "11111111-1111-4111-8111-111111111111";
  const rootIdB = "22222222-2222-4222-8222-222222222222";
  const persistedRoot = (rootId: string, canonicalPath: string) => ({
    rootId,
    kind: "project-cwd" as const,
    label: rootId,
    locator: { canonicalPath: canonical(canonicalPath) },
    capabilities: ["browse", "read", "open"] as const,
    availability: "connected" as const,
    createdAt: 1,
  });

  it("stores device-global state in a versioned file and restores stable identities", async () => {
    const { base, repo, vault } = await makeTree();
    const userDataDir = path.join(base, "user-data");
    const store = new JsonRootRegistryStore(userDataDir);
    const first = await RootRegistry.open({ store, activeVaultPath: canonical(vault) });
    const attached = await first.attachProjectRoot({ canonicalPath: canonical(repo), ...binding("project-a") });
    if (attached.kind === "inside-vault") throw new Error("unexpected vault result");

    const restored = await RootRegistry.open({ store, activeVaultPath: canonical(vault) });

    expect(restored.getRoot(attached.root.rootId)).toEqual(attached.root);
    expect(restored.listBindings()).toEqual([attached.binding]);
    const disk = JSON.parse(await fs.readFile(path.join(userDataDir, "external-roots.json"), "utf8"));
    expect(disk.schemaVersion).toBe(ROOT_REGISTRY_SCHEMA_VERSION);
  });

  it.each([
    { schemaVersion: 99, roots: [], bindings: [] },
    { schemaVersion: 1, roots: "not-an-array", bindings: [] },
    { schemaVersion: 1, roots: [], bindings: [{ integrationId: "x", instanceId: "y", projectId: "z", rootId: "missing", relativeBase: "", label: "z" }] },
  ])("fails closed on corrupt or future state without rewriting it", async (invalid) => {
    const { base } = await makeTree();
    const userDataDir = path.join(base, "user-data");
    await fs.mkdir(userDataDir);
    const file = path.join(userDataDir, "external-roots.json");
    const original = JSON.stringify(invalid);
    await fs.writeFile(file, original);

    await expect(RootRegistry.open({ store: new JsonRootRegistryStore(userDataDir) })).rejects.toThrow();
    expect(await fs.readFile(file, "utf8")).toBe(original);
  });

  it.each(["parent-first", "child-first"] as const)(
    "rejects persisted ancestor/descendant overlap in %s order",
    async (order) => {
      const parent = persistedRoot(rootIdA, "/workspace/repo");
      const child = persistedRoot(rootIdB, "/workspace/repo/packages/app");
      const roots = order === "parent-first" ? [parent, child] : [child, parent];
      const store: RootRegistryStore = {
        load: async () => ({ schemaVersion: 1, roots, bindings: [] }),
        save: async () => { throw new Error("must not save"); },
      };

      await expect(RootRegistry.open({ store })).rejects.toThrow(/overlap/i);
    }
  );

  it("allows sibling canonical paths that merely share a string prefix", async () => {
    const store: RootRegistryStore = {
      load: async () => ({
        schemaVersion: 1,
        roots: [
          persistedRoot(rootIdA, "/workspace/repo"),
          persistedRoot(rootIdB, "/workspace/repository"),
        ],
        bindings: [],
      }),
      save: async () => undefined,
    };

    const registry = await RootRegistry.open({ store });
    expect(registry.listRoots()).toHaveLength(2);
  });

  it.each([
    { field: "kind", value: "vault" },
    { field: "capabilities", value: ["browse", "read"] },
    { field: "capabilities", value: ["browse", "read", "open", "future-capability"] },
  ])("rejects unsupported Phase 1 persisted $field values", async ({ field, value }) => {
    const root = { ...persistedRoot(rootIdA, "/workspace/repo"), [field]: value };
    const store: RootRegistryStore = {
      load: async () => ({ schemaVersion: 1, roots: [root], bindings: [] }),
      save: async () => { throw new Error("must not save"); },
    };

    await expect(RootRegistry.open({ store })).rejects.toThrow();
  });
});
