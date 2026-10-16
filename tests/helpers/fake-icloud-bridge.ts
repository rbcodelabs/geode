import { createHash, randomUUID } from "node:crypto";
import {
  FOLDER_REVISION,
  ICLOUD_CONTAINER_ID,
  IcloudBridgeError,
  type IcloudAvailability,
  type IcloudContainerBridge,
  type IcloudListEntry,
  type IcloudReadRange,
  type IcloudStat,
  type IcloudWalkEntry,
  type IcloudWalkOptions,
  type IcloudWalkProblem,
  type IcloudWritePrecondition,
} from "../../src/shared/icloud-container";

/**
 * In-memory `IcloudContainerBridge` for provider unit tests. It models only what the contract promises
 * (revisions, conditional publish, not-downloaded items, typed errors, abort), so a provider that passes
 * against it AND against the Node implementation relies on the contract and nothing else.
 */
type Node =
  | { kind: "folder" }
  | { kind: "file"; bytes: Uint8Array; mtimeMs: number; evicted: boolean }
  | { kind: "symlink" };

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const aborted = () => new IcloudBridgeError("aborted", "The operation was aborted");
const check = (signal?: AbortSignal) => {
  if (signal?.aborted) throw aborted();
};

export class FakeIcloudBridge implements IcloudContainerBridge {
  /** Keys are `root` or `root/rel`. */
  readonly nodes = new Map<string, Node>();
  availabilityState: IcloudAvailability = { state: "available", containerId: ICLOUD_CONTAINER_ID };
  /** Called for each path `startDownload` is asked to materialise. Tests use it to simulate iCloud finishing a download. */
  onDownload: (root: string, rel: string) => void | Promise<void> = () => {};
  readonly calls: string[] = [];
  private clock = 1_700_000_000_000;
  private readonly pending = new Map<string, { key: string; chunks: Uint8Array[] }>();

  private key(root: string, rel: string): string {
    return rel ? `${root}/${rel}` : root;
  }

  private tick(): number {
    this.clock += 1000;
    return this.clock;
  }

  private ensureParents(key: string): void {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!this.nodes.has(dir)) this.nodes.set(dir, { kind: "folder" });
    }
  }

  // --- direct seeding, used by tests to play "iCloud" or "another device" ---

  seedFile(root: string, rel: string, content: string | Uint8Array, options: { evicted?: boolean } = {}): void {
    const key = this.key(root, rel);
    this.ensureParents(key);
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.nodes.set(key, { kind: "file", bytes, mtimeMs: this.tick(), evicted: options.evicted ?? false });
  }

  seedFolder(root: string, rel = ""): void {
    const key = this.key(root, rel);
    this.ensureParents(key);
    this.nodes.set(key, { kind: "folder" });
  }

  seedSymlink(root: string, rel: string): void {
    const key = this.key(root, rel);
    this.ensureParents(key);
    this.nodes.set(key, { kind: "symlink" });
  }

  remove(root: string, rel: string): void {
    const key = this.key(root, rel);
    for (const k of [...this.nodes.keys()]) if (k === key || k.startsWith(`${key}/`)) this.nodes.delete(k);
  }

  text(root: string, rel: string): string | null {
    const node = this.nodes.get(this.key(root, rel));
    return node?.kind === "file" ? new TextDecoder().decode(node.bytes) : null;
  }

  children(root: string, rel: string): string[] {
    const prefix = `${this.key(root, rel)}/`;
    return [...this.nodes.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map((k) => k.slice(prefix.length)).sort();
  }

  // --- bridge ---

  async availability(signal?: AbortSignal): Promise<IcloudAvailability> {
    check(signal);
    return this.availabilityState;
  }

  private requireAvailable(): void {
    if (this.availabilityState.state !== "available") throw new IcloudBridgeError("unavailable", this.availabilityState.message);
  }

  async listRoots(signal?: AbortSignal): Promise<string[]> {
    check(signal);
    this.requireAvailable();
    return [...this.nodes.entries()].filter(([k, n]) => !k.includes("/") && n.kind === "folder" && !k.startsWith(".")).map(([k]) => k).sort((a, b) => a.localeCompare(b));
  }

  async list(root: string, rel: string, signal?: AbortSignal): Promise<IcloudListEntry[] | null> {
    check(signal);
    this.requireAvailable();
    const dir = this.nodes.get(this.key(root, rel));
    if (!dir) return null;
    if (dir.kind !== "folder") throw new IcloudBridgeError("failed", `${rel} is not a folder`);
    return this.children(root, rel).map((name) => {
      const node = this.nodes.get(this.key(root, rel ? `${rel}/${name}` : name))!;
      return { name, kind: node.kind === "symlink" ? "symlink" : node.kind, availability: node.kind === "file" && node.evicted ? "not-downloaded" : "current" } as IcloudListEntry;
    });
  }

  private statNode(node: Node, maxHashBytes: number): IcloudStat {
    if (node.kind === "folder") return { kind: "folder", size: 0, mtimeMs: 0, revision: FOLDER_REVISION, availability: "current" };
    if (node.kind === "symlink") throw new IcloudBridgeError("precondition-failed", "not a regular file or folder");
    if (node.evicted) return { kind: "file", size: 0, mtimeMs: 0, revision: "", availability: "not-downloaded" };
    const digest = node.bytes.byteLength > maxHashBytes ? "-" : sha(node.bytes);
    return { kind: "file", size: node.bytes.byteLength, mtimeMs: node.mtimeMs, revision: `${Math.trunc(node.mtimeMs)}:${node.bytes.byteLength}:${digest}`, availability: "current" };
  }

  async stat(root: string, rel: string, options: { maxHashBytes: number }, signal?: AbortSignal): Promise<IcloudStat | null> {
    check(signal);
    this.requireAvailable();
    const node = this.nodes.get(this.key(root, rel));
    return node ? this.statNode(node, options.maxHashBytes) : null;
  }

  async walk(root: string, rel: string, options: IcloudWalkOptions, signal?: AbortSignal) {
    check(signal);
    this.requireAvailable();
    const base = this.key(root, rel);
    if (!this.nodes.has(base)) throw new IcloudBridgeError("not-found", `${root} does not exist`);
    const entries: IcloudWalkEntry[] = [];
    const problems: IcloudWalkProblem[] = [];
    const visit = (dirKey: string, dirRel: string) => {
      check(signal);
      for (const name of this.children(root, dirKey === root ? "" : dirKey.slice(root.length + 1))) {
        const top = dirRel === "";
        if ((options.skipNames ?? []).includes(name) || (options.skipPrefixes ?? []).some((p) => name.startsWith(p)) || (top && (options.skipTopLevel ?? []).includes(name))) continue;
        const key = `${dirKey}/${name}`;
        const node = this.nodes.get(key)!;
        const relPath = dirRel ? `${dirRel}/${name}` : name;
        if (node.kind === "symlink") {
          problems.push({ code: "symlink", message: `symlink ${relPath}` });
          continue;
        }
        entries.push({ path: relPath, ...this.statNode(node, options.maxHashBytes) });
        if (node.kind === "folder") visit(key, relPath);
      }
    };
    visit(base, "");
    return { entries, problems };
  }

  async read(root: string, rel: string, range: IcloudReadRange, signal?: AbortSignal): Promise<{ bytes: ArrayBuffer; revision: string }> {
    check(signal);
    this.requireAvailable();
    const node = this.nodes.get(this.key(root, rel));
    if (!node) throw new IcloudBridgeError("not-found", `${rel} does not exist`);
    if (node.kind !== "file") throw new IcloudBridgeError("failed", `${rel} is not a file`);
    if (node.evicted) throw new IcloudBridgeError("unavailable", `${rel} has not finished downloading`);
    if (range.maxBytes !== undefined && node.bytes.byteLength > range.maxBytes) throw new IcloudBridgeError("too-large", `${rel} is too large`);
    const full = this.statNode(node, Number.MAX_SAFE_INTEGER).revision;
    if (range.expectedRevision && full !== range.expectedRevision) throw new IcloudBridgeError("precondition-failed", `Remote file ${rel} changed since it was listed`);
    const offset = range.offset ?? 0;
    const slice = node.bytes.slice(offset, range.length === undefined ? undefined : offset + range.length);
    return { bytes: slice.buffer as ArrayBuffer, revision: offset === 0 && range.length === undefined ? full : range.expectedRevision ? full : "" };
  }

  async beginWrite(root: string, rel: string, signal?: AbortSignal): Promise<string> {
    check(signal);
    this.requireAvailable();
    if (!this.nodes.has(root)) throw new IcloudBridgeError("not-found", `${root} does not exist`);
    const handle = randomUUID();
    this.pending.set(handle, { key: this.key(root, rel), chunks: [] });
    this.calls.push(`beginWrite:${rel}`);
    return handle;
  }

  async appendChunk(handle: string, bytes: ArrayBuffer, signal?: AbortSignal): Promise<void> {
    check(signal);
    const write = this.pending.get(handle);
    if (!write) throw new IcloudBridgeError("failed", "Unknown write handle");
    write.chunks.push(new Uint8Array(bytes.slice(0)));
  }

  async commitWrite(handle: string, precondition: IcloudWritePrecondition, options: { maxHashBytes: number }, signal?: AbortSignal): Promise<IcloudStat> {
    const write = this.pending.get(handle);
    if (!write) throw new IcloudBridgeError("failed", "Unknown write handle");
    this.pending.delete(handle);
    check(signal);
    const existing = this.nodes.get(write.key);
    if ("absent" in precondition && existing) throw new IcloudBridgeError("precondition-failed", `${write.key} already exists`);
    if ("revision" in precondition) {
      if (!existing) throw new IcloudBridgeError("precondition-failed", `${write.key} no longer exists`);
      const actual = this.statNode(existing, options.maxHashBytes).revision;
      if (actual !== precondition.revision) throw new IcloudBridgeError("precondition-failed", `${write.key} changed`);
    }
    const bytes = new Uint8Array(write.chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const chunk of write.chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    this.ensureParents(write.key);
    this.nodes.set(write.key, { kind: "file", bytes, mtimeMs: this.tick(), evicted: false });
    return this.statNode(this.nodes.get(write.key)!, options.maxHashBytes);
  }

  async discardWrite(handle: string): Promise<void> {
    this.pending.delete(handle);
  }

  get pendingWrites(): number {
    return this.pending.size;
  }

  async move(root: string, from: string, to: string, options: { expectedRevision: string; maxHashBytes: number }, signal?: AbortSignal): Promise<IcloudStat> {
    check(signal);
    this.requireAvailable();
    const fromKey = this.key(root, from);
    const toKey = this.key(root, to);
    const node = this.nodes.get(fromKey);
    if (!node) throw new IcloudBridgeError("precondition-failed", `${from} no longer exists`);
    const actual = this.statNode(node, options.maxHashBytes).revision;
    if (actual !== options.expectedRevision) throw new IcloudBridgeError("precondition-failed", `${from} changed`);
    if (this.nodes.has(toKey)) throw new IcloudBridgeError("precondition-failed", `${to} already exists`);
    this.ensureParents(toKey);
    for (const k of [...this.nodes.keys()]) {
      if (k === fromKey || k.startsWith(`${fromKey}/`)) {
        this.nodes.set(toKey + k.slice(fromKey.length), this.nodes.get(k)!);
        this.nodes.delete(k);
      }
    }
    return this.statNode(this.nodes.get(toKey)!, options.maxHashBytes);
  }

  async mkdir(root: string, rel: string, signal?: AbortSignal): Promise<void> {
    check(signal);
    this.requireAvailable();
    this.seedFolder(root, rel);
  }

  async startDownload(root: string, paths: string[], signal?: AbortSignal): Promise<void> {
    check(signal);
    this.requireAvailable();
    for (const rel of paths) {
      this.calls.push(`download:${rel}`);
      await this.onDownload(root, rel);
    }
  }

  async waitForDownload(root: string, paths: string[], options: { timeoutMs: number; pollMs: number }, signal?: AbortSignal) {
    const deadline = Date.now() + options.timeoutMs;
    for (;;) {
      check(signal);
      const state = paths.map((rel) => {
        const node = this.nodes.get(this.key(root, rel));
        return { rel, ready: node?.kind === "file" && !node.evicted };
      });
      const pending = state.filter((s) => !s.ready).map((s) => s.rel);
      if (pending.length === 0 || Date.now() >= deadline) return { ready: state.filter((s) => s.ready).map((s) => s.rel), pending };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.pollMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(aborted()); }, { once: true });
      });
    }
  }
}
