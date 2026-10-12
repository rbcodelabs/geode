import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AppendOnlySession, AppendOnlySyncProvider, BlobRef, HistoryRecord, HistoryScan, VaultDescriptor } from "../sync-core/history-types";
import type { HubErrorInfo, HubOpenReply, HubTarget } from "../shared/hub-sync";
import { FsStoreProvider } from "./fs-store";
import { spawnSshStore } from "./rpc-store";
import { isStoreError } from "./store-errors";

/**
 * The Node half of the desktop "Folder or SSH hub" provider. The app's HistoryController runs in the renderer and
 * only needs an `AppendOnlySession`; this class owns the sessions on the main-process side so the renderer never
 * touches the filesystem or spawns ssh. It reuses the exact store classes the CLI uses (`FsStoreProvider`,
 * `spawnSshStore`), so a hub written by either side is readable by the other.
 *
 * Deliberately NOT exported from `sync-node/index.ts`: the CLI bundle must not contain it. Imported by
 * `src/main/hub-sync-ipc.ts` only. See docs/design/app-hub-sync-provider.md.
 */

export type { HubErrorInfo, HubOpenReply, HubTarget };

export class HubError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string) { super(message); this.name = "HubError"; }
  toInfo(): HubErrorInfo { return { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}) }; }
}

const SAFE_HOST = /^[A-Za-z0-9_][A-Za-z0-9_.@:%[\]-]*$/;

export function validateHubTarget(value: unknown): HubTarget {
  const target = value as Partial<{ kind: string; path: unknown; host: unknown }> | null;
  if (!target || typeof target !== "object") throw new HubError("invalid-target", "No hub is configured");
  if (typeof target.path !== "string" || !target.path.trim() || target.path.includes("\0")) throw new HubError("invalid-target", "Enter the hub store path");
  if (target.kind === "fs") {
    if (!path.isAbsolute(target.path)) throw new HubError("invalid-target", "The hub folder must be an absolute path");
    return { kind: "fs", path: path.resolve(target.path) };
  }
  if (target.kind === "ssh") {
    if (typeof target.host !== "string" || !SAFE_HOST.test(target.host)) throw new HubError("invalid-target", "Enter a valid ssh host or ~/.ssh/config alias");
    return { kind: "ssh", host: target.host, path: target.path };
  }
  throw new HubError("invalid-target", "Unknown hub kind");
}

/** Turns what ssh printed into something a person can act on. Null when stderr says nothing recognisable. */
export function classifySshFailure(stderr: string, host: string): HubErrorInfo | null {
  const text = stderr.trim();
  if (!text) return null;
  if (/permission denied|authentication failed|no supported authentication|too many authentication failures/i.test(text)) {
    return { code: "ssh-auth", message: `ssh to ${host} was refused: authentication failed`, hint: "Is the key loaded and the ssh agent unlocked? Geode runs ssh non-interactively (BatchMode), so it can never prompt for a passphrase." };
  }
  if (/host key verification failed|remote host identification has changed/i.test(text)) {
    return { code: "ssh-host-key", message: `ssh to ${host} failed: host key verification`, hint: `Connect once from a terminal (ssh ${host}) to trust the host key.` };
  }
  if (/could not resolve hostname|name or service not known|nodename nor servname/i.test(text)) {
    return { code: "ssh-unreachable", message: `ssh could not resolve host "${host}"`, hint: "Check the host name or the alias in ~/.ssh/config." };
  }
  if (/connection refused|connection timed out|operation timed out|no route to host|network is unreachable|connection reset|connection closed/i.test(text)) {
    return { code: "ssh-unreachable", message: `ssh could not reach ${host}: ${text.split("\n").pop()}`, hint: "Is the hub machine up and reachable from this network?" };
  }
  if (/geode-wiki: (command )?not found|geode-wiki.*no such file/i.test(text)) {
    return { code: "ssh-no-geode-wiki", message: `geode-wiki is not installed on ${host}`, hint: "Put a geode-wiki wrapper on the hub's non-login PATH (ssh runs `geode-wiki sync serve`)." };
  }
  return null;
}

/** Last stderr lines of the ssh child, plus a promise that settles once that stream is fully read. */
type Stderr = string[] & { drained?: Promise<void> };
const DRAIN_WAIT_MS = 1500;

interface Live { provider: AppendOnlySyncProvider & { close?(): Promise<void> }; session: AppendOnlySession; owner: string; stderr: Stderr; target: HubTarget }

export interface HubStoreManagerOptions {
  /** Test seams. */
  fsProvider?: (path: string) => AppendOnlySyncProvider & { close?(): Promise<void> };
  sshProvider?: (target: { host: string; path: string }, onStderr: (line: string) => void) => AppendOnlySyncProvider & { close?(): Promise<void> };
  /** Deadline for calls that establish a connection (discover, createVault, open). */
  connectTimeoutMs?: number;
}

export const CONNECT_TIMEOUT_MS = 30_000;
const STDERR_LINES = 12;

export class HubStoreManager {
  private readonly sessions = new Map<string, Live>();
  constructor(private readonly options: HubStoreManagerOptions = {}) {}

  private make(target: HubTarget, stderr: Stderr): AppendOnlySyncProvider & { close?(): Promise<void> } {
    const onStderr = (line: string) => { stderr.push(line); if (stderr.length > STDERR_LINES) stderr.shift(); };
    if (target.kind === "fs") return this.options.fsProvider?.(target.path) ?? new FsStoreProvider(target.path);
    if (this.options.sshProvider) return this.options.sshProvider({ host: target.host, path: target.path }, onStderr);
    // ConnectTimeout bounds a black-holed host; BatchMode (set by spawnSshStore) means no prompt can ever hang us.
    return spawnSshStore({ host: target.host, storePath: target.path, sshOptions: ["-o", "ConnectTimeout=10"], onStderr, onTransport: transport => { stderr.drained = transport.drained; } });
  }

  /** Maps any failure to a HubError, preferring what ssh itself said over the generic "unavailable". */
  private async fail(error: unknown, target: HubTarget, stderr: Stderr, timedOut: boolean): Promise<HubError> {
    if (error instanceof HubError) return error;
    // The transport can report "closed" before the child's last stderr line has been read; wait (bounded) for the
    // stream to finish so the message is what ssh actually said, not the vague "unavailable".
    if (!timedOut && target.kind === "ssh" && stderr.drained) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([stderr.drained, new Promise<void>(resolve => { timer = setTimeout(resolve, DRAIN_WAIT_MS); })]);
      clearTimeout(timer);
    }
    if (timedOut) return new HubError("timeout", `Timed out connecting to the hub${target.kind === "ssh" ? ` over ssh (${target.host})` : ""}`, target.kind === "ssh" ? "Check the network and that ssh works non-interactively: ssh -o BatchMode=yes " + target.host + " true" : undefined);
    if (target.kind === "ssh") {
      const classified = classifySshFailure(stderr.join("\n"), target.host);
      if (classified) return new HubError(classified.code, classified.message, classified.hint);
    }
    if (isStoreError(error)) return new HubError(error.code, error.message);
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "ENOENT" || code === "ENOTDIR") return new HubError("hub-unavailable", `Hub folder is not reachable: ${message}`);
    if (code === "EACCES" || code === "EPERM") return new HubError("hub-unavailable", `No permission for the hub folder: ${message}`);
    if ((error as Error | undefined)?.name === "AbortError") return new HubError("aborted", "Cancelled");
    return new HubError("hub-failed", message);
  }

  private async withProvider<T>(target: HubTarget, signal: AbortSignal | undefined, work: (provider: AppendOnlySyncProvider, deadline: AbortSignal) => Promise<T>, keep?: (provider: AppendOnlySyncProvider & { close?(): Promise<void> }, stderr: Stderr, result: T) => void): Promise<T> {
    const stderr: Stderr = [];
    const provider = this.make(target, stderr);
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    const forward = () => deadline.abort();
    signal?.addEventListener("abort", forward, { once: true });
    if (signal?.aborted) forward();
    let kept = false;
    try {
      const result = await work(provider, deadline.signal);
      keep?.(provider, stderr, result); kept = Boolean(keep);
      return result;
    } catch (error) {
      throw await this.fail(error, target, stderr, timedOut);
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", forward);
      if (!kept) await provider.close?.().catch(() => {});
    }
  }

  discover(target: HubTarget, signal?: AbortSignal): Promise<VaultDescriptor[]> {
    return this.withProvider(target, signal, (provider, deadline) => provider.discover(deadline));
  }

  createVault(target: HubTarget, input: { name: string; operationId: string }, signal?: AbortSignal): Promise<VaultDescriptor> {
    return this.withProvider(target, signal, (provider, deadline) => provider.createVault(input, deadline));
  }

  open(owner: string, target: HubTarget, binding: VaultDescriptor, deviceId: string, signal?: AbortSignal): Promise<HubOpenReply> {
    let sessionId = "";
    return this.withProvider(target, signal, (provider, deadline) => provider.open({ binding, deviceId }, deadline), (provider, stderr, session) => {
      sessionId = randomUUID();
      this.sessions.set(sessionId, { provider, session, owner, stderr, target });
    }).then(session => ({
      sessionId, appendRecords: typeof session.appendRecords === "function",
      ...(session.uploadConcurrency !== undefined ? { uploadConcurrency: session.uploadConcurrency } : {}),
      ...(session.readConcurrency !== undefined ? { readConcurrency: session.readConcurrency } : {}),
      ...(session.commitVerified !== undefined ? { commitVerified: session.commitVerified } : {}),
    }));
  }

  private live(owner: string, sessionId: string): Live {
    const live = this.sessions.get(sessionId);
    if (!live || live.owner !== owner) throw new HubError("no-session", "The hub session is closed; the next sync will reopen it");
    return live;
  }

  private async use<T>(owner: string, sessionId: string, signal: AbortSignal | undefined, work: (session: AppendOnlySession, signal: AbortSignal) => Promise<T>): Promise<T> {
    const live = this.live(owner, sessionId);
    try { return await work(live.session, signal ?? new AbortController().signal); }
    catch (error) {
      // Same translation as connection-time failures: a dead ssh link reads as ssh's own words, not "unavailable".
      if (error instanceof HubError) throw error;
      throw await this.fail(error, live.target, live.stderr, false);
    }
  }

  scan(owner: string, sessionId: string, cursor: string | undefined, signal?: AbortSignal): Promise<HistoryScan> {
    return this.use(owner, sessionId, signal, (session, s) => session.scan(cursor, s));
  }
  putBlob(owner: string, sessionId: string, input: { operationId: string; sha256: string; size: number; data: ArrayBuffer }, signal?: AbortSignal): Promise<BlobRef> {
    return this.use(owner, sessionId, signal, (session, s) => session.putBlob(input, s));
  }
  readBlob(owner: string, sessionId: string, ref: BlobRef, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.use(owner, sessionId, signal, (session, s) => session.readBlob(ref, s));
  }
  appendRecord(owner: string, sessionId: string, record: HistoryRecord, signal?: AbortSignal): Promise<void> {
    return this.use(owner, sessionId, signal, (session, s) => session.appendRecord(record, s));
  }
  appendRecords(owner: string, sessionId: string, records: HistoryRecord[], signal?: AbortSignal): Promise<{ appended: number; error?: HubErrorInfo }> {
    return this.use(owner, sessionId, signal, async (session, s) => {
      if (!session.appendRecords) throw new HubError("invalid-request", "This session cannot batch appends");
      const result = await session.appendRecords(records, s);
      const live = this.live(owner, sessionId);
      return { appended: result.appended, ...(result.error ? { error: (await this.fail(result.error, live.target, live.stderr, false)).toInfo() } : {}) };
    });
  }

  async close(owner: string, sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (!live || live.owner !== owner) return;
    this.sessions.delete(sessionId);
    await live.session.close().catch(() => {});
    await live.provider.close?.().catch(() => {});
  }

  /** Closes everything one window opened (the window went away). */
  async closeOwner(owner: string): Promise<void> {
    await Promise.all([...this.sessions].filter(([, live]) => live.owner === owner).map(([id]) => this.close(owner, id)));
  }

  get openSessions(): number { return this.sessions.size; }
}
