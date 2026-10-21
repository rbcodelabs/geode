import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An in-process stand-in for Compass's sync REST API (`/api/v1/workspaces/{ws}/sync/docs`), implementing the contract
 * documented in docs/design/compass-sync-provider.md: paged snapshot/delta scans with continuation, optimistic
 * revisions, idempotent creates, moves, checked deletes with tombstones, problem+json errors. It is a test double, not
 * a spec: the knobs below stage the failure modes the provider must survive.
 */
interface Doc { id: string; path: string; kind: "file" | "folder"; content: string; version: number }
interface Tombstone { id: string; path: string; deletedKind: "file" | "folder"; version: number }

export class FakeCompassServer {
  readonly token = "test-token";
  readonly workspaceId = "ws-1";
  /** Required request header (name lower-case), checked on every request when set. */
  requireHeader?: { name: string; value: string };
  /** The sync endpoint answers 404 for every request (server flag off). */
  disabled = false;
  pageSize = 200;
  /** Next scan pages answer status "partial". */
  partial = false;
  /** Final scan page reports cursor null. */
  nullCursor = false;
  /** Reject this many continuation requests with 409 continuation_stale. */
  staleContinuations = 0;
  /** Delay (ms) before every response, to exercise abort/close. */
  delayMs = 0;
  /** Include `deletedKind` on tombstones (a server may omit it). */
  tombstoneKinds = true;
  /** Serve incremental scans for a supplied cursor. */
  deltaEnabled = true;
  readonly requests: Array<{ method: string; path: string; query: URLSearchParams; body?: any; headers: IncomingMessage["headers"] }> = [];
  private docs = new Map<string, Doc>();
  private tombstones: Tombstone[] = [];
  private operations = new Map<string, string>();
  private version = 0;
  private nextId = 1;
  private server?: Server;
  baseUrl = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  // --- direct state access for tests ---------------------------------------

  seed(path: string, content = ""): Doc {
    this.ensureParents(path);
    return this.put({ id: `doc-${this.nextId++}`, path, kind: "file", content, version: ++this.version });
  }

  seedFolder(path: string): Doc {
    this.ensureParents(path);
    return this.put({ id: `doc-${this.nextId++}`, path, kind: "folder", content: "", version: ++this.version });
  }

  /** Edit a doc behind the client's back (another device). */
  edit(path: string, content: string): void {
    const doc = this.byPath(path)!;
    doc.content = content;
    doc.version = ++this.version;
  }

  contentOf(path: string): string | undefined {
    return this.byPath(path)?.content;
  }

  paths(): string[] {
    return [...this.docs.values()].map((doc) => doc.path).sort();
  }

  idOf(path: string): string {
    return this.byPath(path)!.id;
  }

  revisionOf(path: string): string {
    return String(this.byPath(path)!.version);
  }

  removeBehindBack(path: string): void {
    const doc = this.byPath(path)!;
    this.docs.delete(doc.id);
    this.tombstones.push({ id: doc.id, path: doc.path, deletedKind: doc.kind, version: ++this.version });
  }

  currentCursor(): string {
    return String(this.version);
  }

  // --- internals -----------------------------------------------------------

  private put(doc: Doc): Doc {
    this.docs.set(doc.id, doc);
    return doc;
  }

  private byPath(path: string): Doc | undefined {
    return [...this.docs.values()].find((doc) => doc.path === path);
  }

  private children(path: string): Doc[] {
    return [...this.docs.values()].filter((doc) => doc.path.startsWith(`${path}/`));
  }

  private ensureParents(path: string): void {
    const parts = path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (!this.byPath(folder)) this.put({ id: `doc-${this.nextId++}`, path: folder, kind: "folder", content: "", version: ++this.version });
    }
  }

  private wire(doc: Doc, withContent = false) {
    return {
      id: doc.id, path: doc.path, kind: doc.kind, revision: String(doc.version),
      size: doc.kind === "file" ? Buffer.byteLength(doc.content) : 0,
      hash: doc.kind === "file" ? createHash("sha256").update(doc.content).digest("hex") : undefined,
      ...(withContent ? { content: doc.content } : {}),
    };
  }

  private send(res: ServerResponse, status: number, body?: unknown): void {
    res.writeHead(status, { "content-type": status >= 400 ? "application/problem+json" : "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }

  private problem(res: ServerResponse, status: number, code: string, title = code): void {
    this.send(res, status, { type: `https://compass.test/problems/${code}`, title, status, code });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    this.requests.push({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, body, headers: req.headers });
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const base = `/api/v1/workspaces/${this.workspaceId}/sync/docs`;
    if (!url.pathname.startsWith(base)) return this.problem(res, 404, "not_found");
    if (this.disabled) return this.problem(res, 404, "not_found");
    if (req.headers.authorization !== `Bearer ${this.token}`) return this.problem(res, 401, "unauthorized");
    if (this.requireHeader && req.headers[this.requireHeader.name] !== this.requireHeader.value) return this.problem(res, 401, "protection_bypass_required");
    const rest = url.pathname.slice(base.length).replace(/^\//, "");
    const method = req.method ?? "GET";
    try {
      if (rest === "scan" && method === "GET") return this.scan(url, res);
      if (rest === "" && method === "POST") return this.create(body, res);
      const move = /^([^/]+)\/move$/.exec(rest);
      if (move && method === "POST") return this.move(decodeURIComponent(move[1]), body, res);
      const id = decodeURIComponent(rest);
      if (method === "GET") return this.read(id, url, res);
      if (method === "PUT") return this.update(id, body, res);
      if (method === "DELETE") return this.remove(id, url, res);
    } catch (error) {
      return this.send(res, 500, { code: "internal", title: String(error) });
    }
    return this.problem(res, 405, "method_not_allowed");
  }

  private scan(url: URL, res: ServerResponse): void {
    const continuation = url.searchParams.get("continuation");
    if (continuation && this.staleContinuations > 0) {
      this.staleContinuations--;
      return this.problem(res, 409, "continuation_stale");
    }
    const cursor = url.searchParams.get("cursor");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? this.pageSize) || this.pageSize, this.pageSize);
    const delta = Boolean(cursor) && this.deltaEnabled;
    const since = delta ? Number(cursor) : -1;
    const changed = [...this.docs.values()].filter((doc) => doc.version > since).sort((a, b) => a.path.localeCompare(b.path));
    const tombs = delta ? this.tombstones.filter((t) => t.version > since) : [];
    const all = [
      ...changed.map((doc) => this.wire(doc)),
      ...tombs.map((t) => ({ id: t.id, path: t.path, kind: "tombstone" as const, revision: String(t.version), ...(this.tombstoneKinds ? { deletedKind: t.deletedKind } : {}) })),
    ];
    const offset = continuation ? Number(continuation.replace("page:", "")) : 0;
    const entries = all.slice(offset, offset + limit);
    const hasMore = offset + limit < all.length;
    this.send(res, 200, {
      mode: delta ? "delta" : "snapshot",
      status: this.partial ? "partial" : "complete",
      entries,
      cursor: hasMore || this.nullCursor ? null : String(this.version),
      hasMore,
      ...(hasMore ? { continuation: `page:${offset + limit}` } : {}),
    });
  }

  private read(id: string, url: URL, res: ServerResponse): void {
    const doc = this.docs.get(id);
    if (!doc) return this.problem(res, 404, "not_found");
    const revision = url.searchParams.get("revision");
    if (revision && revision !== String(doc.version)) return this.problem(res, 409, "revision_conflict");
    this.send(res, 200, this.wire(doc, true));
  }

  private create(body: { path: string; content: string; operationKey: string }, res: ServerResponse): void {
    if (!body.path.endsWith(".md")) return this.problem(res, 422, "unsupported_extension");
    const path = body.path.replace(/\.md$/, "");
    const prior = this.operations.get(body.operationKey);
    if (prior && this.docs.has(prior)) return this.send(res, 201, this.wire(this.docs.get(prior)!));
    if (Buffer.byteLength(body.content) > 1024 * 1024) return this.problem(res, 413, "too_large");
    if (this.byPath(path)) return this.problem(res, 409, "path_conflict");
    this.ensureParents(path);
    const doc = this.put({ id: `doc-${this.nextId++}`, path, kind: "file", content: body.content, version: ++this.version });
    this.operations.set(body.operationKey, doc.id);
    this.send(res, 201, this.wire(doc));
  }

  private update(id: string, body: { content: string; expectedRevision: string }, res: ServerResponse): void {
    const doc = this.docs.get(id);
    if (!doc) return this.problem(res, 404, "not_found");
    if (String(doc.version) !== body.expectedRevision) return this.problem(res, 409, "revision_conflict");
    doc.content = body.content;
    doc.version = ++this.version;
    this.send(res, 200, this.wire(doc));
  }

  private move(id: string, body: { path: string; expectedRevision: string }, res: ServerResponse): void {
    const doc = this.docs.get(id);
    if (!doc) return this.problem(res, 404, "not_found");
    if (String(doc.version) !== body.expectedRevision) return this.problem(res, 409, "revision_conflict");
    if (!body.path.endsWith(".md")) return this.problem(res, 422, "unsupported_extension");
    const target = body.path.replace(/\.md$/, "");
    if (this.byPath(target)) return this.problem(res, 409, "path_conflict");
    this.ensureParents(target);
    doc.path = target;
    doc.version = ++this.version;
    this.send(res, 200, this.wire(doc));
  }

  private remove(id: string, url: URL, res: ServerResponse): void {
    const doc = this.docs.get(id);
    if (!doc) return this.problem(res, 404, "not_found");
    if (String(doc.version) !== url.searchParams.get("expectedRevision")) return this.problem(res, 409, "revision_conflict");
    if (this.children(doc.path).length) return this.problem(res, 409, "has_children");
    this.docs.delete(id);
    this.tombstones.push({ id, path: doc.path, deletedKind: doc.kind, version: ++this.version });
    res.writeHead(204);
    res.end();
  }
}
