/** Private registrar only. Product main/preload do not install these channels. */
import { ImageCleanupUncertainError, type ImageCleanupFailure } from "../shared/image-cleanup";
export type SupportedRasterMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp" | "image/avif";
export interface ImageReadEvent { sender: { isDestroyed(): boolean; mainFrame: unknown }; senderFrame: unknown }
export interface ImageReadAuthority { window: object; frame: unknown; identity: object; root: string; current(): boolean }
export interface ImageReaderRequest { root: string; expectedRoot: string; path: string; current(): boolean }
export interface ImageReadResult { bytes: ArrayBuffer; mime: SupportedRasterMime }
interface ImageIpc { handle(channel: string, callback: (event: ImageReadEvent, request: unknown) => Promise<unknown>): void; removeHandler(channel: string): void }
interface ActiveRead { id: string; authority: ImageReadAuthority; cancelled: boolean; done: Promise<void> }
const channels = ["image-resources-read", "image-resources-cancel"] as const;
// Stable main-owned window identity survives registrar/Vault-session rotations.
// This is one weak entry per uncertain window, never completed request history.
const sealedWindows = new WeakMap<object, ImageCleanupFailure>();
// Handler replacement cannot turn an old, unsettled OS operation into a free slot.
const windowSlots = new WeakMap<object, ActiveRead>();
function object(value: unknown): value is object { return typeof value === "object" && value !== null; }
function schema(value: unknown, keys: readonly string[]): value is Record<string, string> {
  if (!object(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key)
    && typeof Object.getOwnPropertyDescriptor(value, key)?.value === "string");
}
function bounded(value: string): boolean { return value.length > 0 && value.length <= 4096; }
function validId(value: string): boolean { return /^[a-fA-F0-9]{64}$/.test(value); }

/** authorityFor must come from the actual main-process application registry in future integration. */
export function registerImageReadIpc(ipc: ImageIpc, authorityFor: (event: ImageReadEvent) => ImageReadAuthority | null, read: (request: ImageReaderRequest) => Promise<ImageReadResult>): () => Promise<void> {
  const active = new Set<ActiveRead>();
  let stopped = false;
  let disposal: Promise<void> | undefined;
  let hasUncertainty = false, uncertainty: unknown;
  const remember = (failure: ImageCleanupFailure) => {
    if (!hasUncertainty) { hasUncertainty = true; uncertainty = failure.error; }
    return failure;
  };
  const authorized = (event: ImageReadEvent, root: string): ImageReadAuthority => {
    const authority = authorityFor(event);
    if (stopped || !authority || !object(authority.window) || !object(authority.identity)
      || event.sender.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame
      || event.senderFrame !== authority.frame || root !== authority.root || !authority.current()) throw new Error("Image read authority is unavailable.");
    return authority;
  };
  const current = (event: ImageReadEvent, entry: ActiveRead): boolean => {
    if (entry.cancelled || stopped) return false;
    try {
      const now = authorized(event, entry.authority.root);
      return now.window === entry.authority.window && now.identity === entry.authority.identity
        && now.frame === entry.authority.frame && entry.authority.current();
    } catch { return false; }
  };
  const installed: string[] = [];
  try {
    ipc.handle(channels[0], async (event, input) => {
      if (!schema(input, ["root", "path", "id"]) || !bounded(input.root) || !bounded(input.path) || !validId(input.id)) throw new Error("Invalid image read request.");
      const provider = authorized(event, input.root);
      // A main-owned provider can rotate its fields in place. Slot ownership,
      // session/root/frame identity and the original callback remain captured.
      const authority = Object.freeze({ ...provider, current: provider.current.bind(provider) });
      const sealed = sealedWindows.get(authority.window); if (sealed) return remember(sealed);
      if (windowSlots.has(authority.window)) throw new Error("Image read busy until the previous read settles.");
      let settle!: () => void;
      const entry: ActiveRead = { id: input.id, authority, cancelled: false, done: new Promise(resolve => { settle = resolve; }) };
      // Install ownership before invoking a potentially synchronous reader callback.
      windowSlots.set(authority.window, entry); active.add(entry);
      try {
        const result = await read({ root: input.root, expectedRoot: authority.root, path: input.path, current: () => current(event, entry) });
        if (!current(event, entry)) throw new Error("Image read cancelled or session changed.");
        return result;
      } catch (error) {
        if (!(error instanceof ImageCleanupUncertainError)) throw error;
        const failure: ImageCleanupFailure = { kind: "cleanup-uncertain", error };
        sealedWindows.set(authority.window, failure);
        return remember(failure);
      } finally {
        if (windowSlots.get(authority.window) === entry) windowSlots.delete(authority.window);
        active.delete(entry); settle();
      }
    });
    installed.push(channels[0]);
    ipc.handle(channels[1], async (event, input) => {
      if (!schema(input, ["root", "id"]) || !bounded(input.root) || !validId(input.id)) throw new Error("Invalid image cancel request.");
      const authority = authorized(event, input.root);
      const sealed = sealedWindows.get(authority.window); if (sealed) return remember(sealed);
      const entry = windowSlots.get(authority.window);
      if (!entry || entry.id !== input.id || entry.authority.identity !== authority.identity
        || entry.authority.frame !== authority.frame || entry.authority.root !== authority.root) throw new Error("No matching active image read.");
      // Cancellation invalidates publication; it cannot settle an OS read or release this slot.
      entry.cancelled = true;
    });
    installed.push(channels[1]);
  } catch (primary) {
    // Never remove the failed channel: it may be owned by a different registrar.
    // Even failed rollback must leave a captured handler unable to admit I/O.
    stopped = true;
    for (const entry of active) entry.cancelled = true;
    const failures = [primary];
    for (const channel of installed) { try { ipc.removeHandler(channel); } catch (error) { failures.push(error); } }
    if (failures.length === 1) throw primary;
    throw new AggregateError(failures, "Image IPC registration and rollback failed.");
  }
  return () => {
    if (disposal) return disposal;
    let resolve!: () => void, reject!: (error: unknown) => void;
    disposal = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    stopped = true;
    const failures: unknown[] = [];
    for (const channel of installed) { try { ipc.removeHandler(channel); } catch (error) { failures.push(error); } }
    const retiring = [...active]; for (const entry of retiring) entry.cancelled = true;
    void Promise.all(retiring.map(entry => entry.done)).then(() => {
      // Disposal removes handlers; it cannot certify uncertain descriptor cleanup.
      // Preserve the first owned uncertainty here; each window retains its own full error.
      if (hasUncertainty) failures.push(uncertainty);
      if (failures.length === 1) reject(failures[0]);
      else if (failures.length) reject(new AggregateError(failures, "Image IPC handler cleanup failed."));
      else resolve();
    });
    return disposal;
  };
}
