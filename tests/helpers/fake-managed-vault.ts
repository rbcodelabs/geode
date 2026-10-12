import type { ManagedVaultPlugin } from "../../src/renderer/host/capacitor-host";
import { base64ToBytes, bytesToBase64 } from "../../src/renderer/host/base64";

/**
 * An in-memory GeodeManagedVault native plugin with the semantics sync relies on: relative-path tree, atomic
 * writes that need an existing parent, mkdir collision, trash into a hidden `.geode-trash` that listings skip,
 * links reported as "symlink", content that can be "evicted" (iCloud) or too large for the bridge, a sandbox
 * private store entirely separate from the vault, and a Keychain. Failures use the native `{ code }` shape.
 */
export class FakeManagedVault {
  readonly files = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  readonly links = new Set<string>();
  readonly evicted = new Set<string>();
  readonly oversize = new Set<string>();
  readonly trashed: string[] = [];
  readonly privateFiles = new Map<string, Uint8Array>();
  readonly keychain = new Map<string, string>();
  readonly calls: string[] = [];
  /** Disk space reported to sync-private storage. */
  availableBytes = 10 * 1024 ** 3;
  /** Called with the vault path before every native write; throw to simulate a native failure. */
  beforeWrite?: (path: string) => void;
  /** Changes made by "another app" (Files, iCloud) at a chosen moment. */
  beforeStat?: (path: string) => void;
  mtime = 1000;
  readonly plugin: ManagedVaultPlugin;

  constructor(private readonly id = "managed://default") {
    const fail = (code: string, message = code): never => { throw Object.assign(new Error(message), { code }); };
    const parentOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const hasFolder = (path: string) => path === "" || this.folders.has(path);
    const has = (path: string) => this.files.has(path) || this.folders.has(path);
    const entry = (path: string) => ({ path, isFolder: this.folders.has(path), mtime: this.mtime, ctime: 1, size: this.files.get(path)?.byteLength ?? 0 });
    const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const privateOk = (path: string) => { if (!path || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) fail("INVALID_PATH"); };
    const writeFile = (path: string, bytes: Uint8Array) => {
      this.beforeWrite?.(path);
      if (!hasFolder(parentOf(path))) fail("NOT_FOUND");
      if (this.folders.has(path)) fail("IO_FAILURE");
      this.files.set(path, bytes); this.mtime++;
    };
    const plugin = {
      chooseExternalVault: async () => ({ id: null }),
      reconnectVault: async () => ({ reconnected: false }),
      describeVault: async ({ id }: { id: string }) => ({ id, name: "Fake", kind: "managed" as const }),
      checkVault: async () => ({}),
      openVault: async ({ id } = { id: this.id }) => ({ id, name: "Fake", kind: "managed" as const, status: "ready" as const }),
      getRecentVaults: async () => ({ ids: [this.id] }),
      getLaunchVault: async () => ({ id: this.id as string | null }),
      closeVault: async () => ({}),
      list: async () => ({ entries: [...this.folders, ...this.files.keys()].sort().map(entry) }),
      read: async ({ path }: { path: string }) => { const bytes = this.files.get(path); if (!bytes) fail("NOT_FOUND"); return { data: text(bytes!) }; },
      readBinary: async ({ path }: { path: string }) => {
        this.calls.push(`readBinary ${path}`);
        if (this.evicted.has(path)) fail("CONTENT_UNAVAILABLE");
        if (this.oversize.has(path)) fail("PAYLOAD_TOO_LARGE");
        const bytes = this.files.get(path); if (!bytes) fail("NOT_FOUND");
        return { base64: bytesToBase64(bytes!) };
      },
      writeBinary: async ({ path, base64 }: { path: string; base64: string }) => { this.calls.push(`writeBinary ${path}`); const bytes = base64ToBytes(base64); writeFile(path, bytes); return { mtime: this.mtime, ctime: 1, size: bytes.byteLength }; },
      write: async ({ path, data }: { path: string; data: string }) => { this.calls.push(`write ${path}`); const bytes = new TextEncoder().encode(data); writeFile(path, bytes); return { mtime: this.mtime, ctime: 1, size: bytes.byteLength }; },
      mkdir: async ({ path }: { path: string }) => {
        this.calls.push(`mkdir ${path}`);
        if (has(path)) fail("COLLISION");
        const parts = path.split("/");
        for (let index = 1; index <= parts.length; index++) this.folders.add(parts.slice(0, index).join("/"));
        return {};
      },
      trash: async ({ path }: { path: string }) => {
        this.calls.push(`trash ${path}`);
        if (!has(path)) fail("NOT_FOUND");
        for (const file of [...this.files.keys()]) if (file === path || file.startsWith(path + "/")) this.files.delete(file);
        for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) this.folders.delete(folder);
        this.trashed.push(path);
        return {};
      },
      rename: async () => ({}),
      exists: async ({ path }: { path: string }) => ({ exists: has(path) }),
      listPluginIds: async () => ({ ids: [] }),
      listThemes: async () => ({ ids: [] }),
      readPluginFile: async () => ({ content: "" }),
      replacePluginFiles: async () => ({}),
      settleMutation: async () => ({}),
      addListener: async () => ({ remove: async () => {} }),
      stat: async ({ path }: { path: string }) => {
        this.beforeStat?.(path);
        const parts = path.split("/");
        for (let index = 1; index <= parts.length; index++) if (this.links.has(parts.slice(0, index).join("/"))) return { kind: "symlink" as const, size: 0, children: 0 };
        if (this.folders.has(path)) return { kind: "folder" as const, size: 0, children: [...this.files.keys(), ...this.folders].filter(other => other.startsWith(path + "/") && !other.slice(path.length + 1).includes("/")).length };
        const bytes = this.files.get(path);
        return bytes ? { kind: "file" as const, size: this.oversize.has(path) ? 40 * 1024 * 1024 : bytes.byteLength, children: 0 } : { kind: "none" as const, size: 0, children: 0 };
      },
      syncPrivateWrite: async ({ path, base64 }: { path: string; base64: string }) => { privateOk(path); this.privateFiles.set(path, base64ToBytes(base64)); return {}; },
      syncPrivateRead: async ({ path }: { path: string }) => { privateOk(path); const bytes = this.privateFiles.get(path); return bytes ? { found: true, base64: bytesToBase64(bytes) } : { found: false }; },
      syncPrivateList: async ({ path }: { path: string }) => {
        privateOk(path);
        const names = new Map<string, boolean>();
        for (const key of this.privateFiles.keys()) if (key.startsWith(path + "/")) { const rest = key.slice(path.length + 1), head = rest.split("/")[0]; names.set(head, rest.includes("/") || names.get(head) === true); }
        return { entries: [...names].map(([name, isFolder]) => ({ name, isFolder })) };
      },
      syncPrivateRemove: async ({ path, recursive }: { path: string; recursive: boolean }) => {
        privateOk(path);
        if (recursive) { for (const key of [...this.privateFiles.keys()]) if (key === path || key.startsWith(path + "/")) this.privateFiles.delete(key); } else this.privateFiles.delete(path);
        return {};
      },
      syncPrivateAvailableBytes: async () => ({ bytes: this.availableBytes }),
      appSecretGet: async ({ key }: { key: string }) => this.keychain.has(key) ? { found: true, value: this.keychain.get(key) } : { found: false },
      appSecretSet: async ({ key, value }: { key: string; value: string }) => { this.keychain.set(key, value); return {}; },
      appSecretRemove: async ({ key }: { key: string }) => { this.keychain.delete(key); return {}; },
    };
    this.plugin = plugin as unknown as ManagedVaultPlugin;
  }

  put(path: string, text: string | Uint8Array): this {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) this.folders.add(parts.slice(0, index).join("/"));
    this.files.set(path, typeof text === "string" ? new TextEncoder().encode(text) : text);
    return this;
  }
  text(path: string): string | null { const bytes = this.files.get(path); return bytes ? new TextDecoder().decode(bytes) : null; }
  /** Every byte the sync-private store holds, as one string, for "never leaked" assertions. */
  privateDump(): string { return [...this.privateFiles].map(([key, bytes]) => key + "\n" + new TextDecoder().decode(bytes)).join("\n"); }
}
