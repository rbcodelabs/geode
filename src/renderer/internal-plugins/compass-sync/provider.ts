/**
 * Geode sync provider for Compass docs (`conditional-mutation-v1`). A thin client over Compass's sync REST API
 * (`{baseUrl}/api/v1/workspaces/{workspaceId}/sync/docs`); see docs/design/compass-sync-provider.md for the contract.
 *
 * Compass stores documents, not files, so the provider maps between the two worlds:
 *  - a vault file `Folder/Note.md` is the doc `Folder/Note`; only exact-lowercase `.md` files are represented,
 *    everything else is excluded through `excludePath` (never uploaded, never treated as deleted);
 *  - only UTF-8 text ever crosses the wire, so `binary: true` (which Geode requires) is satisfied honestly by
 *    refusing non-UTF-8 content instead of mangling it;
 *  - Compass's delete is a hard delete, so `trash()` moves a file doc into a reserved trash folder (recoverable),
 *    mirroring the iCloud provider's `.geode-trash/`.
 *
 * Fail closed everywhere: a disabled endpoint is `unavailable`, a partial/cursorless/inconsistent snapshot is
 * `partial`, and a stale revision is a `SyncPreconditionError`.
 */
import { validateSyncPath } from "../../../sync-core/scope";
import type { SyncProvider, SyncProviderCapabilities, SyncRemoteEntry, SyncScanResult, SyncSession, SyncWriteInput } from "../../sync/types";
import { SyncPreconditionError } from "../../sync/types";

export const COMPASS_PROVIDER_ID = "compass.docs";
export const COMPASS_PROVIDER_NAME = "Compass";
/** Server doc limit. */
export const COMPASS_MAX_FILE_SIZE = 1024 * 1024;
/** Reserved top-level doc folder that holds trashed notes. Not configurable, so every device excludes and recognizes the same one. */
export const TRASH_FOLDER = "Geode Trash";
const MARKDOWN_EXTENSION = ".md";
const PAGE_LIMIT = 200;
/** A scan restarted this many times because its continuation went stale is reported as an error, not retried forever. */
const MAX_SCAN_RESTARTS = 3;
const MAX_SCAN_PAGES = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;

export const ErrorCodes = {
  disabled: "compass-sync-disabled",
  partial: "compass-scan-partial",
  unavailable: "compass-unavailable",
} as const;

export interface CompassConnection {
  baseUrl: string;
  workspaceId: string;
  token: string;
  /** Optional extra request header, e.g. `x-vercel-protection-bypass` for a Vercel preview deployment. */
  extraHeader?: { name: string; value: string };
  /** Trash behavior: move file docs into the reserved "Geode Trash" folder (default, recoverable) or hard-delete them. */
  trashMode?: "move" | "delete";
  /** Ask the server for incremental scans. Off by default: the snapshot path is the only one that can prove absence. */
  useDelta?: boolean;
}

export interface CompassProviderOptions {
  /** Resolves the connection for the current vault, or null when the user has not configured one. */
  connection: () => Promise<CompassConnection | null>;
  /** Test seam and platform seam: the app passes `pluginFetch` so desktop requests run outside the renderer CSP. */
  fetch?: typeof fetch;
  maxFileSize?: number;
  requestTimeoutMs?: number;
  onDiagnostics?: (vaultId: string, message: string) => void;
}

export const COMPASS_CAPABILITIES = {
  binary: true,
  conditionalWrites: true,
  delta: true,
  completeSnapshots: true,
  atomicMoves: true,
  trash: true,
} as const;

/** A non-2xx Compass response. Never carries the URL, token or response body beyond the problem's own title. */
export class CompassHttpError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message);
    this.name = "CompassHttpError";
  }
}

export function createCompassProvider(options: CompassProviderOptions): SyncProvider {
  const maxFileSize = options.maxFileSize ?? COMPASS_MAX_FILE_SIZE;
  const capabilities: SyncProviderCapabilities = { ...COMPASS_CAPABILITIES, maxFileSize };
  const resolve = async (): Promise<CompassConnection> => {
    const connection = await options.connection();
    if (!connection) throw new Error("Compass sync is not configured. Enter the Compass URL, workspace and token in Settings > Core plugins > Compass sync.");
    return normalizeConnection(connection);
  };
  return {
    protocol: "conditional-mutation-v1",
    id: COMPASS_PROVIDER_ID,
    name: COMPASS_PROVIDER_NAME,
    capabilities,
    async preflight() {
      const probe = new CompassClient(await resolve(), options);
      try {
        await probe.request("GET", "scan", { query: { limit: "1" } });
      } catch (error) {
        throw preflightError(error);
      } finally {
        probe.close();
      }
    },
    async open({ vaultId }) {
      const connection = await resolve();
      return new CompassSession(vaultId, new CompassClient(connection, options), connection, options, maxFileSize);
    },
    excludePath: (path, data) => compassExclusion(path, data),
  };
}

function preflightError(error: unknown): Error {
  if (error instanceof CompassHttpError && error.status === 404) return new Error("Compass sync is not enabled for this workspace on the server (404). Check the URL and workspace id.");
  return error instanceof Error ? error : new Error(String(error));
}

// --- path mapping ---------------------------------------------------------

/** Why Geode must not sync this vault path to Compass, or null when it can be represented. */
export function compassExclusion(path: string, data?: ArrayBuffer): string | null {
  if (path === TRASH_FOLDER || path.startsWith(`${TRASH_FOLDER}/`)) return `"${TRASH_FOLDER}" is reserved for Compass sync trash`;
  if (!path.endsWith(MARKDOWN_EXTENSION)) return "Compass syncs Markdown notes (.md) only";
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name.length <= MARKDOWN_EXTENSION.length) return "A Compass doc needs a name";
  if (data) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      return "Compass can only store UTF-8 text";
    }
  }
  return null;
}

/** The vault path of a doc path (`Folder/Note` -> `Folder/Note.md`). */
export function vaultPathOfDoc(docPath: string): string {
  return `${docPath.normalize("NFC")}${MARKDOWN_EXTENSION}`;
}

/** The doc path of a vault file path (`Folder/Note.md` -> `Folder/Note`). Throws for a path Compass cannot hold. */
export function docPathOfVault(vaultPath: string): string {
  if (!vaultPath.endsWith(MARKDOWN_EXTENSION) || vaultPath.length === MARKDOWN_EXTENSION.length) throw new Error(`Compass can only store Markdown notes: ${vaultPath}`);
  return vaultPath.slice(0, -MARKDOWN_EXTENSION.length);
}

/** Whether a remote path can become a safe local vault path that Geode's own scope would also include. */
function representable(path: string): boolean {
  try {
    validateSyncPath(path);
  } catch {
    return false;
  }
  return !path.split("/").some((part) => part.startsWith(".")) && !/\.sync-conflict-\d+/.test(path);
}

// --- HTTP -----------------------------------------------------------------

interface CompassEntryWire {
  id: string;
  path: string;
  kind: "file" | "folder" | "tombstone";
  revision: string;
  size?: number;
  hash?: string;
  operationKey?: string;
  /** Optional hint on a tombstone about what was deleted; without it a tombstone is ambiguous between a doc and a folder. */
  deletedKind?: "file" | "folder";
  content?: string;
}

interface ScanPageWire {
  mode?: "snapshot" | "delta";
  status?: string;
  entries?: CompassEntryWire[];
  cursor?: string | null;
  continuation?: string;
  hasMore?: boolean;
  reason?: string;
  skipped?: unknown[];
}

function normalizeConnection(connection: CompassConnection): CompassConnection {
  let url: URL;
  try {
    url = new URL(connection.baseUrl.trim());
  } catch {
    throw new Error("The Compass URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The Compass URL must start with https:// (or http:// for local testing).");
  if (!connection.workspaceId.trim()) throw new Error("A Compass workspace id is required.");
  if (!connection.token) throw new Error("A Compass access token is required.");
  return { ...connection, baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, workspaceId: connection.workspaceId.trim() };
}

class CompassClient {
  private readonly fetchImpl: typeof fetch;
  private readonly active = new Set<AbortController>();
  private closed = false;

  constructor(private readonly connection: CompassConnection, private readonly options: CompassProviderOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  close(): void {
    this.closed = true;
    for (const controller of this.active) controller.abort();
    this.active.clear();
  }

  async request<T>(method: string, suffix: string, init: { query?: Record<string, string | undefined>; body?: unknown; signal?: AbortSignal } = {}): Promise<T | undefined> {
    if (this.closed) throw new Error("Compass sync session is closed");
    if (init.signal?.aborted) throw abortError(init.signal);
    const url = new URL(`${this.connection.baseUrl}/api/v1/workspaces/${encodeURIComponent(this.connection.workspaceId)}/sync/docs${suffix === "" ? "" : `/${suffix}`}`);
    for (const [key, value] of Object.entries(init.query ?? {})) if (value !== undefined && value !== "") url.searchParams.set(key, value);
    const headers: Record<string, string> = { Authorization: `Bearer ${this.connection.token}`, Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (this.connection.extraHeader?.name) headers[this.connection.extraHeader.name] = this.connection.extraHeader.value;

    const controller = new AbortController();
    this.active.add(controller);
    const onAbort = () => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error("Compass request timed out")), this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        // `pluginFetch` proxies through the main process, which cannot honor an AbortSignal, so the wait itself is raced against it.
        response = await abortable(controller.signal, this.fetchImpl(url.toString(), { method, headers, signal: controller.signal, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }));
      } catch (error) {
        if (init.signal?.aborted) throw abortError(init.signal);
        if (controller.signal.aborted && controller.signal.reason instanceof Error) throw controller.signal.reason;
        if (isAbort(error)) throw error;
        throw new Error(`Cannot reach Compass at ${new URL(this.connection.baseUrl).host}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status === 204) return undefined;
      const text = await abortable(controller.signal, response.text());
      if (response.status >= 200 && response.status < 300) {
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new Error(`Compass returned an unreadable response (${response.status})`);
        }
      }
      throw problemFrom(response.status, text);
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", onAbort);
      this.active.delete(controller);
    }
  }
}

/** Build the error for a non-2xx response from an RFC 9457-style problem body, tolerating anything else. */
function problemFrom(status: number, body: string): CompassHttpError {
  let code: string | undefined;
  let detail: string | undefined;
  try {
    const parsed = JSON.parse(body) as { code?: unknown; type?: unknown; title?: unknown; detail?: unknown; error?: unknown };
    const nested = typeof parsed.error === "object" && parsed.error !== null ? (parsed.error as { code?: unknown; message?: unknown }) : undefined;
    if (typeof parsed.code === "string") code = parsed.code;
    else if (typeof nested?.code === "string") code = nested.code;
    else if (typeof parsed.type === "string") code = parsed.type.split("/").pop();
    const text = typeof parsed.detail === "string" ? parsed.detail : typeof parsed.title === "string" ? parsed.title : typeof nested?.message === "string" ? nested.message : undefined;
    if (text) detail = text.slice(0, 200);
  } catch {
    /* not a problem document */
  }
  const label = status === 401 ? "Compass rejected the access token (401)" : status === 403 ? "Compass denied access (403)" : `Compass request failed (${status}${code ? ` ${code}` : ""})`;
  return new CompassHttpError(status, code, detail && status !== 401 ? `${label}: ${detail}` : label);
}

// --- session --------------------------------------------------------------

class CompassSession implements SyncSession {
  private closed = false;

  constructor(
    private readonly vaultId: string,
    private readonly client: CompassClient,
    private readonly connection: CompassConnection,
    private readonly options: CompassProviderOptions,
    private readonly maxFileSize: number,
  ) {}

  async close(): Promise<void> {
    this.closed = true;
    this.client.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Compass sync session is closed");
  }

  // --- scan ---------------------------------------------------------------

  async scan(cursor: string | undefined, signal: AbortSignal): Promise<SyncScanResult> {
    this.assertOpen();
    try {
      return await this.scanInner(this.connection.useDelta ? cursor : undefined, signal);
    } catch (error) {
      if (isAbort(error) || signal.aborted) return { status: "cancelled", entries: [] };
      if (error instanceof CompassHttpError && error.status === 404) {
        this.options.onDiagnostics?.(this.vaultId, "Compass sync endpoint returned 404: the server's sync flag is off, or the URL/workspace is wrong.");
        return { status: "unavailable", entries: [], errorCode: ErrorCodes.disabled };
      }
      throw error;
    }
  }

  private async scanInner(cursor: string | undefined, signal: AbortSignal): Promise<SyncScanResult> {
    let result = await this.scanPages(cursor, signal);
    // A delta that cannot be interpreted safely (an unlabelled tombstone) is redone as a full snapshot, which proves absence itself.
    if (result === "ambiguous-tombstone") result = await this.scanPages(undefined, signal);
    if (result === "ambiguous-tombstone") throw new Error("Compass returned a tombstone in a snapshot scan");
    return result;
  }

  private async scanPages(cursor: string | undefined, signal: AbortSignal): Promise<SyncScanResult | "ambiguous-tombstone"> {
    for (let restart = 0; restart <= MAX_SCAN_RESTARTS; restart++) {
      try {
        return await this.followPages(cursor, signal);
      } catch (error) {
        // A continuation that expired mid-walk invalidates the pages collected so far; start over from the first page.
        if (error instanceof CompassHttpError && error.status === 409 && error.code === "continuation_stale" && restart < MAX_SCAN_RESTARTS) continue;
        throw error;
      }
    }
    throw new Error("Compass scan kept restarting because its continuation went stale");
  }

  private async followPages(cursor: string | undefined, signal: AbortSignal): Promise<SyncScanResult | "ambiguous-tombstone"> {
    const entries: SyncRemoteEntry[] = [];
    let mode: "snapshot" | "delta" | undefined;
    let continuation: string | undefined;
    let finalCursor: string | null = null;
    let incomplete: SyncScanResult["status"] | undefined;
    let dropped = 0;
    for (let page = 0; page < MAX_SCAN_PAGES; page++) {
      const wire = (await this.client.request<ScanPageWire>("GET", "scan", { query: { cursor, continuation, limit: String(PAGE_LIMIT) }, signal })) ?? {};
      if (wire.mode !== "snapshot" && wire.mode !== "delta") incomplete ??= "partial";
      else if (mode && mode !== wire.mode) incomplete ??= "partial";
      mode ??= wire.mode === "snapshot" || wire.mode === "delta" ? wire.mode : undefined;
      if (wire.status === "unavailable") incomplete = "unavailable";
      else if (wire.status !== "complete") incomplete ??= "partial";
      for (const wireEntry of wire.entries ?? []) {
        const mapped = this.mapEntry(wireEntry, wire.mode ?? mode);
        if (mapped === "ambiguous-tombstone") return mapped;
        if (mapped) entries.push(mapped);
        else dropped++;
      }
      if (wire.skipped?.length) this.options.onDiagnostics?.(this.vaultId, `Compass skipped ${wire.skipped.length} doc(s) it could not serve${wire.reason ? `: ${wire.reason}` : ""}`);
      finalCursor = wire.cursor ?? null;
      if (!wire.hasMore) break;
      // A page that claims more but gives no new continuation would loop forever; stop and fail closed.
      if (!wire.continuation || wire.continuation === continuation) {
        incomplete ??= "partial";
        break;
      }
      continuation = wire.continuation;
      if (page === MAX_SCAN_PAGES - 1) incomplete ??= "partial";
    }
    if (dropped > 0) this.options.onDiagnostics?.(this.vaultId, `${dropped} Compass entr${dropped === 1 ? "y" : "ies"} cannot be represented in a vault and were left out`);
    if (incomplete === "unavailable") return { status: "unavailable", entries: [], errorCode: ErrorCodes.unavailable };
    // No checkpoint means the server could not vouch for the walk: never let absence delete anything.
    if (incomplete || finalCursor === null || !mode) return { status: "partial", entries, errorCode: ErrorCodes.partial, ...(mode ? { mode } : {}) };
    return { status: "complete", mode, entries, cursor: finalCursor };
  }

  /** Map one wire entry; `null` drops what a vault cannot represent. */
  private mapEntry(wire: CompassEntryWire, mode: "snapshot" | "delta" | undefined): SyncRemoteEntry | null | "ambiguous-tombstone" {
    if (!wire || typeof wire.id !== "string" || typeof wire.path !== "string" || typeof wire.revision !== "string") return null;
    const docPath = wire.path.normalize("NFC");
    const trashed = docPath === TRASH_FOLDER || docPath.startsWith(`${TRASH_FOLDER}/`);
    if (wire.kind === "tombstone" || (trashed && mode === "delta")) {
      if (mode !== "delta") return null;
      return this.tombstoneFor(wire, docPath, trashed);
    }
    if (trashed) return null;
    if (wire.kind === "folder") {
      if (!representable(docPath)) return null;
      return { id: wire.id, path: docPath, kind: "folder", revision: wire.revision, ...(wire.operationKey ? { operationKey: wire.operationKey } : {}) };
    }
    if (wire.kind !== "file") return null;
    const path = vaultPathOfDoc(docPath);
    if (!representable(path) || compassExclusion(path)) return null;
    return { id: wire.id, path, kind: "file", revision: wire.revision, ...(typeof wire.size === "number" ? { size: wire.size } : {}), ...(wire.hash ? { hash: wire.hash } : {}), ...(wire.operationKey ? { operationKey: wire.operationKey } : {}) };
  }

  /**
   * A delta deletion needs the vault path that disappeared. Entries moved into the trash folder carry it in their
   * path; a server tombstone needs a `deletedKind` hint to tell a doc from a folder, otherwise the scan is redone as a snapshot.
   */
  private tombstoneFor(wire: CompassEntryWire, docPath: string, trashed: boolean): SyncRemoteEntry | null | "ambiguous-tombstone" {
    let originalDoc = docPath;
    const kind: "file" | "folder" | undefined = wire.kind === "tombstone" ? wire.deletedKind : wire.kind === "folder" ? "folder" : "file";
    if (trashed) {
      // Only a live doc that arrived in the trash is a deletion of its original. A folder there may be a parent the server
      // created for it, and a tombstone there is the trash being emptied; neither says anything about the vault.
      if (wire.kind !== "file") return null;
      // `<trash>/<bucket>/<original doc path>`
      const rest = docPath.slice(TRASH_FOLDER.length + 1).split("/");
      if (rest.length < 2) return null;
      originalDoc = rest.slice(1).join("/");
    }
    if (!kind) return "ambiguous-tombstone";
    const deletedPath = kind === "file" ? vaultPathOfDoc(originalDoc) : originalDoc;
    if (!representable(deletedPath)) return null;
    return { id: wire.id, path: deletedPath, kind: "tombstone", revision: wire.revision, deletedPath };
  }

  // --- reads --------------------------------------------------------------

  async read(entry: SyncRemoteEntry, signal: AbortSignal): Promise<ArrayBuffer> {
    this.assertOpen();
    if (entry.size !== undefined && entry.size > this.maxFileSize) throw new RangeError(`${entry.path} exceeds the ${this.maxFileSize}-byte limit`);
    let doc: CompassEntryWire | undefined;
    try {
      doc = await this.client.request<CompassEntryWire>("GET", encodeURIComponent(entry.id), { query: { revision: entry.revision }, signal });
    } catch (error) {
      if (error instanceof CompassHttpError && error.status === 404) throw new SyncPreconditionError(`Remote doc ${entry.path} no longer exists`);
      if (error instanceof CompassHttpError && error.status === 409 && error.code === "revision_conflict") throw new SyncPreconditionError(`Remote doc ${entry.path} changed while syncing`);
      throw error;
    }
    if (!doc || doc.kind !== "file" || typeof doc.content !== "string") throw new Error(`${entry.path} is not a readable Compass doc`);
    // Return what the caller asked for or fail: bytes under a different revision would poison its baseline.
    if (entry.revision && doc.revision !== entry.revision) throw new SyncPreconditionError(`Remote doc ${entry.path} changed while syncing`);
    const bytes = new TextEncoder().encode(doc.content);
    if (bytes.byteLength > this.maxFileSize) throw new RangeError(`${entry.path} exceeds the ${this.maxFileSize}-byte limit`);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  // --- mutations ----------------------------------------------------------

  async create(input: SyncWriteInput): Promise<SyncRemoteEntry> {
    this.assertOpen();
    const content = this.contentOf(input);
    const created = await this.guardConflicts(() =>
      this.client.request<CompassEntryWire>("POST", "", { body: { path: input.path, content, operationKey: input.operationKey }, signal: input.signal }),
    );
    return this.fileEntry(created, input.path, input.operationKey);
  }

  async update(input: SyncWriteInput & { id: string; expectedRevision: string }): Promise<SyncRemoteEntry> {
    this.assertOpen();
    const content = this.contentOf(input);
    const updated = await this.guardConflicts(() =>
      this.client.request<CompassEntryWire>("PUT", encodeURIComponent(input.id), { body: { content, expectedRevision: input.expectedRevision, operationKey: input.operationKey }, signal: input.signal }),
    );
    return this.fileEntry(updated, input.path, input.operationKey);
  }

  async move(input: { id: string; path: string; expectedRevision: string; signal: AbortSignal }): Promise<SyncRemoteEntry> {
    this.assertOpen();
    const current = await this.describe(input.id, input.expectedRevision, input.signal);
    // Folders are implicit on Compass (they exist because docs live inside them), so there is nothing to move.
    if (current.kind === "folder") throw new Error("Compass folders cannot be moved directly; move the notes inside them");
    docPathOfVault(input.path);
    // Mutation paths keep their `.md`; the server strips it.
    const moved = await this.guardConflicts(() => this.client.request<CompassEntryWire>("POST", `${encodeURIComponent(input.id)}/move`, { body: { path: input.path, expectedRevision: input.expectedRevision }, signal: input.signal }));
    return this.fileEntry(moved, input.path);
  }

  async trash(input: { id: string; expectedRevision: string; signal: AbortSignal }): Promise<void> {
    this.assertOpen();
    const current = await this.describe(input.id, input.expectedRevision, input.signal);
    // Folders are implicit on Compass: they vanish with their last doc and have no delete endpoint, so removing one is a no-op.
    if (current.kind === "folder") return;
    if (this.connection.trashMode === "delete") {
      await this.guardConflicts(() => this.client.request("DELETE", `${encodeURIComponent(input.id)}`, { query: { expectedRevision: input.expectedRevision }, signal: input.signal }));
      return;
    }
    const bucket = `${new Date().toISOString().replace(/[:.]/g, "-")}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    await this.guardConflicts(() =>
      this.client.request<CompassEntryWire>("POST", `${encodeURIComponent(input.id)}/move`, { body: { path: `${TRASH_FOLDER}/${bucket}/${current.path}${MARKDOWN_EXTENSION}`, expectedRevision: input.expectedRevision }, signal: input.signal }),
    );
  }

  // --- helpers ------------------------------------------------------------

  /** The doc as the server has it now, verified against the revision the caller holds. */
  private async describe(id: string, expectedRevision: string, signal: AbortSignal): Promise<CompassEntryWire> {
    let doc: CompassEntryWire | undefined;
    try {
      doc = await this.client.request<CompassEntryWire>("GET", encodeURIComponent(id), { signal });
    } catch (error) {
      if (error instanceof CompassHttpError && error.status === 404) throw new SyncPreconditionError("Remote doc no longer exists");
      throw error;
    }
    if (!doc || typeof doc.path !== "string") throw new Error("Compass returned an unreadable doc");
    if (doc.revision !== expectedRevision) throw new SyncPreconditionError(`Remote doc ${doc.path} changed (expected ${expectedRevision}, found ${doc.revision})`);
    return doc;
  }

  private contentOf(input: SyncWriteInput): string {
    if (input.data.byteLength > this.maxFileSize) throw new RangeError(`${input.path} exceeds the ${this.maxFileSize}-byte limit`);
    const reason = compassExclusion(input.path, input.data);
    if (reason) throw new Error(`${input.path} cannot be stored in Compass: ${reason}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(input.data);
  }

  /** Revision and path conflicts are the server saying the precondition no longer holds. */
  private async guardConflicts<T>(run: () => Promise<T | undefined>): Promise<T> {
    try {
      return (await run()) as T;
    } catch (error) {
      if (error instanceof CompassHttpError && error.status === 409) {
        if (error.code === "revision_conflict") throw new SyncPreconditionError(error.message);
        if (error.code === "has_children") throw new Error("This folder still has items inside on Compass; Geode removes files before folders, so sync again once they are gone.");
        if (error.code === "path_conflict") throw new Error("A doc or folder already exists at that path on Compass");
      }
      if (error instanceof CompassHttpError && error.status === 404) throw new SyncPreconditionError("Remote doc no longer exists");
      throw error;
    }
  }

  private fileEntry(wire: CompassEntryWire | undefined, fallbackPath: string, operationKey?: string): SyncRemoteEntry {
    if (!wire || typeof wire.id !== "string" || typeof wire.revision !== "string") throw new Error("Compass returned an unreadable entry");
    const path = typeof wire.path === "string" ? vaultPathOfDoc(wire.path) : fallbackPath;
    return { id: wire.id, path, kind: "file", revision: wire.revision, ...(typeof wire.size === "number" ? { size: wire.size } : {}), ...(wire.hash ? { hash: wire.hash } : {}), ...(operationKey ? { operationKey } : {}) };
  }

}

function abortable<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR");
}
