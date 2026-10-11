import { contextBridge, ipcRenderer } from "electron";
import {
  ARTIFACT_VAULT_CHANGE_CHANNEL,
  ARTIFACT_VAULT_QUERY_CHANNEL,
  ARTIFACT_VAULT_QUERY_TIMEOUT_MS,
  ARTIFACT_VAULT_RESPONSE_CHANNEL,
} from "../artifacts/guest-protocol";

/**
 * Guest preload for artifacts whose validated manifest declares
 * `permissions.vault: "read"` (ADR 0029). Main attaches it to no other
 * artifact guest. It runs sandboxed with contextIsolation, and exposes exactly
 * two functions on `window.geodeArtifact`. It never exposes `ipcRenderer`, the
 * IPC event object, or any Node API; messages only ever travel to the
 * embedding renderer via `sendToHost` (never to the main process), and the
 * renderer bridge re-validates every request against the manifest allowlist.
 */

interface PendingQuery { resolve(value: unknown): void; timer: ReturnType<typeof setTimeout> }

const pending = new Map<number, PendingQuery>();
const listeners = new Set<(event: { changedAt: number }) => void>();
let nextId = 1;

ipcRenderer.on(ARTIFACT_VAULT_RESPONSE_CHANNEL, (_event, message: unknown) => {
  if (typeof message !== "object" || message === null) return;
  const { id, result } = message as { id?: unknown; result?: unknown };
  if (typeof id !== "number") return;
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(result);
});

ipcRenderer.on(ARTIFACT_VAULT_CHANGE_CHANNEL, () => {
  const event = { changedAt: Date.now() };
  for (const listener of [...listeners]) {
    try { listener({ ...event }); } catch (error) { console.error("geodeArtifact.onChange listener threw", error); }
  }
});

function unavailable(message: string) {
  return { error: { code: "unavailable", message } };
}

function query(request: unknown): Promise<unknown> {
  // Copy only the known fields: the page may pass proxies/getters, and the host
  // validates strictly anyway.
  let payload: unknown;
  try {
    const input = request as { base?: unknown; view?: unknown; limit?: unknown } | null;
    payload = input && typeof input === "object"
      ? { base: input.base, ...(input.view !== undefined ? { view: input.view } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) }
      : input;
  } catch {
    return Promise.resolve({ error: { code: "bad_request", message: "Request could not be read." } });
  }
  return new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(unavailable("Geode did not answer the query in time."));
    }, ARTIFACT_VAULT_QUERY_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    try {
      ipcRenderer.sendToHost(ARTIFACT_VAULT_QUERY_CHANNEL, { id, request: payload });
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      resolve(unavailable("Geode bridge is not reachable."));
    }
  });
}

function onChange(callback: (event: { changedAt: number }) => void): () => void {
  if (typeof callback !== "function") throw new TypeError("onChange expects a function.");
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

contextBridge.exposeInMainWorld("geodeArtifact", Object.freeze({ query, onChange }));
