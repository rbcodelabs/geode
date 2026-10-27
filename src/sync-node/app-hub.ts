import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { constants as fsc } from "node:fs";
import * as path from "node:path";
import type { AppendOnlySession, AppendOnlySyncProvider, BlobRef, HistoryRecord, HistoryScan, VaultDescriptor } from "../sync-core/history-types";
import { hubTargetProblem, type HubErrorInfo, type HubOpenReply, type HubProbeResult, type MainHubTarget } from "../shared/hub-sync";
import { FsStoreProvider } from "./fs-store";
import { spawnSshStore } from "./rpc-store";
import { isStoreError } from "./store-errors";
import { hubTargetBlockReason, SYNC_POLICY_BLOCKED, type SyncPolicyInput } from "../shared/sync-policy";

/**
 * The Node half of the desktop "Folder or SSH hub" provider. The app's HistoryController runs in the renderer and
 * only needs an `AppendOnlySession`; this class owns the sessions on the main-process side so the renderer never
 * touches the filesystem or spawns ssh. It reuses the exact store classes the CLI uses (`FsStoreProvider`,
 * `spawnSshStore`), so a hub written by either side is readable by the other.
 *
 * Deliberately NOT exported from `sync-node/index.ts`: the CLI bundle must not contain it. Imported by
 * `src/main/hub-sync-ipc.ts` only. See docs/design/app-hub-sync-provider.md.
 */

export type { HubErrorInfo, HubOpenReply, MainHubTarget as HubTarget };

export class HubError extends Error {
  constructor(readonly code: string, message: string, readonly hint?: string) { super(message); this.name = "HubError"; }
  toInfo(): HubErrorInfo { return { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}) }; }
}

/** Validates a renderer-supplied target (strictly: see hubTargetProblem) and normalises a folder path. */
export function validateHubTarget(value: unknown, policy?: SyncPolicyInput): MainHubTarget {
  if ((value as { kind?: unknown } | null)?.kind === "http") throw new HubError("invalid-target", "HTTPS hubs are reached from the app window, not through the main process");
  const problem = hubTargetProblem(value);
  if (problem) throw new HubError("invalid-target", problem);
  const target = value as MainHubTarget;
  // Managed sync policy (docs/adr/0053): checked here, before any provider, ssh child or folder access exists.
  const blocked = hubTargetBlockReason(policy, target);
  if (blocked) throw new HubError(SYNC_POLICY_BLOCKED, blocked);
  return target.kind === "fs" ? { kind: "fs", path: path.resolve(target.path) } : { kind: "ssh", host: target.host, path: target.path };
}

/** Turns what ssh printed into something a person can act on. Null when stderr says nothing recognisable. */
export function classifySshFailure(stderr: string, host: string): HubErrorInfo | null {
  const text = stderr.trim();
  if (!text) return null;
  if (/permission denied|authentication failed|no supported authentication|too many authentication failures/i.test(text)) {
    return { code: "ssh-auth", message: `ssh to ${host} was refused: authentication failed.`, hint: "Is the key loaded and the ssh agent unlocked? Geode runs ssh non-interactively (BatchMode), so it can never prompt for a passphrase." };
  }
  if (/host key verification failed|remote host identification has changed/i.test(text)) {
    return { code: "ssh-host-key", message: `ssh to ${host} failed: host key verification.`, hint: `Connect once from a terminal (ssh ${host}) to trust the host key.` };
  }
  if (/could not resolve hostname|name or service not known|nodename nor servname/i.test(text)) {
    return { code: "ssh-unreachable", message: `ssh could not resolve host "${host}".`, hint: "Check the host name or the alias in ~/.ssh/config." };
  }
  if (/connection refused|connection timed out|operation timed out|no route to host|network is unreachable|connection reset|connection closed/i.test(text)) {
    return { code: "ssh-unreachable", message: `ssh could not reach ${host}: ${text.split("\n").pop()}.`, hint: "Is the hub machine up and reachable from this network?" };
  }
  if (/geode-wiki: (command )?not found|geode-wiki.*no such file/i.test(text)) {
    return { code: "ssh-no-geode-wiki", message: `geode-wiki is not installed on ${host}.`, hint: "Put a geode-wiki wrapper on the hub's non-login PATH (ssh runs `geode-wiki sync serve`)." };
  }
  return null;
}

/** Last stderr lines of the ssh child, plus a promise that settles once that stream is fully read. */
type Stderr = string[] & { drained?: Promise<void> };
const DRAIN_WAIT_MS = 1500;

interface Live { provider: AppendOnlySyncProvider & { close?(): Promise<void> }; session: AppendOnlySession; owner: string; stderr: Stderr; target: MainHubTarget }
interface FailureInterruption { signal?: AbortSignal; timedOut?: () => boolean; close(): void | Promise<void> }

export interface HubStoreManagerOptions {
  /** Test seams. */
  fsProvider?: (path: string) => AppendOnlySyncProvider & { close?(): Promise<void> };
  sshProvider?: (target: { host: string; path: string }, onStderr: (line: string) => void) => AppendOnlySyncProvider & { close?(): Promise<void> };
  /** Deadline for calls that establish a connection (discover, createVault, open). */
  connectTimeoutMs?: number;
}

export const CONNECT_TIMEOUT_MS = 30_000;
/** Folder operations are local (or a mounted share): a tighter deadline, so an unusable path errors out instead of hanging. */
export const FS_TIMEOUT_MS = 15_000;
const STDERR_LINES = 12;

export class HubStoreManager {
  private readonly sessions = new Map<string, Live>();
  constructor(private readonly options: HubStoreManagerOptions = {}) {}

  private make(target: MainHubTarget, stderr: Stderr): AppendOnlySyncProvider & { close?(): Promise<void> } {
    const onStderr = (line: string) => { stderr.push(line); if (stderr.length > STDERR_LINES) stderr.shift(); };
    if (target.kind === "fs") return this.options.fsProvider?.(target.path) ?? new FsStoreProvider(target.path);
    if (this.options.sshProvider) return this.options.sshProvider({ host: target.host, path: target.path }, onStderr);
    // ConnectTimeout bounds a black-holed host; BatchMode (set by spawnSshStore) means no prompt can ever hang us.
    return spawnSshStore({ host: target.host, storePath: target.path, sshOptions: ["-o", "ConnectTimeout=10"], onStderr, onTransport: transport => { stderr.drained = transport.drained; } });
  }

  /** Maps any failure to a HubError, preferring what ssh itself said over the generic "unavailable". */
  private async fail(error: unknown, target: MainHubTarget, stderr: Stderr, timedOut: boolean, interruption?: FailureInterruption): Promise<HubError> {
    const forceClose = () => { try { void Promise.resolve(interruption?.close()).catch(() => {}); } catch { /* Preserve the connection failure. */ } };
    const interruptedError = (): HubError | null => {
      if (interruption?.timedOut?.() ?? timedOut) return target.kind === "ssh"
        ? new HubError("timeout", `Timed out connecting to the hub over ssh (${target.host}).`, `Check the network and that ssh works non-interactively: ssh -o BatchMode=yes ${target.host} true`)
        : new HubError("timeout", `Timed out accessing the hub folder ${target.path}.`, "Is the path valid and reachable (a mounted or network volume)?");
      return interruption?.signal?.aborted ? new HubError("aborted", "Cancelled") : null;
    };
    const initialInterruption = interruptedError();
    if (initialInterruption) { forceClose(); return initialInterruption; }
    if (error instanceof HubError) return error;
    // The transport can report "closed" before the child's last stderr line has been read; wait (bounded) for the
    // stream to finish so the message is what ssh actually said, not the vague "unavailable".
    if (!timedOut && target.kind === "ssh" && stderr.drained) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let interruptWait!: () => void;
      const interrupted = new Promise<void>(resolve => { interruptWait = resolve; });
      const onAbort = () => { forceClose(); interruptWait(); };
      interruption?.signal?.addEventListener("abort", onAbort, { once: true });
      if (interruption?.signal?.aborted) onAbort();
      try {
        await Promise.race([stderr.drained.catch(() => {}), interrupted, new Promise<void>(resolve => { timer = setTimeout(resolve, DRAIN_WAIT_MS); })]);
      } finally {
        clearTimeout(timer);
        interruption?.signal?.removeEventListener("abort", onAbort);
      }
    }
    const finalInterruption = interruptedError();
    if (finalInterruption) { forceClose(); return finalInterruption; }
    if (target.kind === "ssh") {
      const classified = classifySshFailure(stderr.join("\n"), target.host);
      if (classified) return new HubError(classified.code, classified.message, classified.hint);
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (target.kind === "fs" && typeof code === "string" && !isStoreError(error)) {
      // Name the path the user typed, never an internal one (blobs/, records/) from the raw errno message.
      const typed = target.path;
      if (code === "ENOTDIR") return new HubError("hub-unavailable", `Cannot use ${typed}: a part of that path is a file, not a folder.`);
      if (code === "ENOENT") return new HubError("hub-unavailable", `The hub folder ${typed} is not reachable.`);
      if (code === "EACCES" || code === "EPERM" || code === "EROFS") return new HubError("hub-unavailable", `No permission to write the hub folder ${typed}${code === "EROFS" ? " (read-only volume)" : ""}.`);
      return new HubError("hub-unavailable", `The hub folder ${typed} cannot be used (${code}).`);
    }
    if (isStoreError(error)) return new HubError(error.code, error.message);
    const message = error instanceof Error ? error.message : String(error);
    if ((error as Error | undefined)?.name === "AbortError") return new HubError("aborted", "Cancelled");
    return new HubError("hub-failed", message);
  }

  private async withProvider<T>(target: MainHubTarget, signal: AbortSignal | undefined, work: (provider: AppendOnlySyncProvider, deadline: AbortSignal) => Promise<T>, keep?: (provider: AppendOnlySyncProvider & { close?(): Promise<void> }, stderr: Stderr, result: T) => void): Promise<T> {
    const stderr: Stderr = [];
    const provider = this.make(target, stderr);
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; deadline.abort(); }, this.options.connectTimeoutMs ?? (target.kind === "fs" ? FS_TIMEOUT_MS : CONNECT_TIMEOUT_MS));
    // A store call that never settles (a path the filesystem wedges on) must not wedge the caller: the deadline or a
    // cancel rejects this race whether or not the underlying work ever honours its signal.
    const cut = new Promise<never>((_resolve, reject) => deadline.signal.addEventListener("abort", () => reject(Object.assign(new Error("Operation aborted"), { name: "AbortError" })), { once: true }));
    cut.catch(() => {});
    const forward = () => deadline.abort();
    signal?.addEventListener("abort", forward, { once: true });
    if (signal?.aborted) forward();
    let kept = false;
    try {
      const result = await Promise.race([work(provider, deadline.signal), cut]);
      keep?.(provider, stderr, result); kept = Boolean(keep);
      return result;
    } catch (error) {
      throw await this.fail(error, target, stderr, timedOut, { signal: deadline.signal, timedOut: () => timedOut, close: () => provider.close?.() });
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", forward);
      if (!kept) await provider.close?.().catch(() => {});
    }
  }

  discover(target: MainHubTarget, signal?: AbortSignal): Promise<VaultDescriptor[]> {
    return this.withProvider(target, signal, (provider, deadline) => provider.discover(deadline));
  }

  createVault(target: MainHubTarget, input: { name: string; operationId: string }, signal?: AbortSignal): Promise<VaultDescriptor> {
    return this.withProvider(target, signal, async (provider, deadline) => {
      if (target.kind === "fs") await inspectFsHub(target.path, true); // fail fast and legibly; never mkdir a path that cannot work
      return provider.createVault(input, deadline);
    });
  }

  /** "Test connection": reachability plus, when a hub may be created, whether it can be (nothing is created). */
  probe(target: MainHubTarget, create: boolean, signal?: AbortSignal): Promise<HubProbeResult> {
    return this.withProvider(target, signal, async (provider, deadline) => {
      let detail: string;
      if (target.kind === "fs") detail = (await inspectFsHub(target.path, create)).detail;
      else detail = "Reached the hub over ssh and listed its vaults. Whether a new hub can be created there is only known when you create it.";
      return { vaults: await provider.discover(deadline), detail };
    });
  }

  open(owner: string, target: MainHubTarget, binding: VaultDescriptor, deviceId: string, signal?: AbortSignal): Promise<HubOpenReply> {
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
      throw await this.fail(error, live.target, live.stderr, false, { signal, close: () => live.provider.close?.() });
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
      return { appended: result.appended, ...(result.error ? { error: (await this.fail(result.error, live.target, live.stderr, false, { signal: s, close: () => live.provider.close?.() })).toInfo() } : {}) };
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

/**
 * Read-only inspection of a folder hub, naming the path the user typed. Nothing is created or written.
 *  - existing folder: readable? When `create` is on (sync will write) also writable?
 *  - missing folder: the nearest existing ancestor must be a writable folder, or it cannot be created.
 */
export async function inspectFsHub(hub: string, create: boolean): Promise<{ exists: boolean; detail: string }> {
  const fail = (message: string) => new HubError("hub-unavailable", message);
  const stat = async (p: string) => { try { return await fsp.stat(p); } catch (error) { return error as NodeJS.ErrnoException; } };
  const first = await stat(hub);
  if (!(first instanceof Error)) {
    if (!first.isDirectory()) throw fail(`${hub} is a file, not a folder.`);
    try { await fsp.access(hub, fsc.R_OK); } catch { throw fail(`No permission to read the hub folder ${hub}.`); }
    if (!create) return { exists: true, detail: "The folder exists and is readable (write access was not checked)." };
    try { await fsp.access(hub, fsc.W_OK); } catch { throw fail(`The hub folder ${hub} is read-only for you; sync could not write to it.`); }
    return { exists: true, detail: "The folder exists and is readable and writable." };
  }
  if (first.code === "ENOTDIR") throw fail(`Cannot use ${hub}: a part of that path is a file, not a folder.`);
  if (first.code !== "ENOENT") throw fail(`The hub folder ${hub} cannot be used (${first.code ?? "error"}).`);
  // Missing. Walk up (terminates at the filesystem root) to the nearest ancestor that exists.
  let ancestor = path.dirname(hub);
  for (;;) {
    const found = await stat(ancestor);
    if (!(found instanceof Error)) {
      if (!found.isDirectory()) throw fail(`Cannot create ${hub}: ${ancestor} is a file, not a folder.`);
      break;
    }
    if (found.code === "ENOTDIR") throw fail(`Cannot create ${hub}: a part of that path is a file, not a folder.`);
    if (found.code !== "ENOENT") throw fail(`Cannot create ${hub} (${found.code ?? "error"}).`);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw fail(`Cannot create ${hub}: no part of that path exists.`);
    ancestor = parent;
  }
  if (!create) return { exists: false, detail: "The folder does not exist yet. Tick \"Create the hub if it is missing\" to start one there." };
  try { await fsp.access(ancestor, fsc.W_OK); } catch { throw fail(`Cannot create ${hub}: no write permission in ${ancestor}.`); }
  return { exists: false, detail: `The folder does not exist yet; it can be created (${ancestor} is writable).` };
}
