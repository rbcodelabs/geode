import type { IpcMain } from "electron";
import {
  ICLOUD_BRIDGE_METHODS,
  IcloudBridgeError,
  type IcloudBridgeFailure,
  type IcloudBridgeMethod,
  type IcloudBridgeResponse,
  type IcloudContainerBridge,
} from "../shared/icloud-container";
import { NodeIcloudContainer } from "../sync-node/icloud-container";
import { icloudCallBlockReason, type SyncPolicyInput } from "../shared/sync-policy";
import type { SyncPolicyFor } from "./sync-policy-gate";

/**
 * Main-process endpoint of the iCloud container bridge (ADR 0030). The renderer holds only the container root
 * through this narrow, method-allowlisted surface; it never gets a raw `fs`. `dispatchIcloudCall` is pure over a
 * bridge (unit-tested without Electron); `registerIcloudContainerIpc` binds it to ipcMain and ties each window's
 * staged writes to the window's lifetime.
 */
export function toFailure(error: unknown): IcloudBridgeFailure {
  if (error instanceof IcloudBridgeError) return { code: error.code, message: error.message };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (error instanceof Error && (error.name === "AbortError" || code === "ABORT_ERR")) return { code: "aborted", message: "The operation was aborted" };
  if (code === "ENOENT") return { code: "not-found", message: error instanceof Error ? error.message : "Not found" };
  if (code === "EACCES" || code === "EPERM") return { code: "unavailable", message: `Permission denied by macOS. Allow Geode to access iCloud Drive in System Settings > Privacy & Security. (${(error as Error).message})` };
  return { code: "failed", message: error instanceof Error ? error.message : String(error) };
}

const ALLOWED = new Set<string>(ICLOUD_BRIDGE_METHODS);

export async function dispatchIcloudCall(bridge: IcloudContainerBridge, method: unknown, args: unknown, signal: AbortSignal, policy?: SyncPolicyInput): Promise<IcloudBridgeResponse> {
  try {
    // Managed sync policy (docs/adr/0053): refuse before touching the container. Reported as `unavailable` so no new
    // bridge error code is needed; the message names the policy. Only `discardWrite` (local cleanup) passes.
    const blocked = typeof method === "string" ? icloudCallBlockReason(policy, method) : null;
    if (blocked) throw new IcloudBridgeError("unavailable", blocked);
    if (typeof method !== "string" || !ALLOWED.has(method) || !Array.isArray(args)) throw new IcloudBridgeError("failed", "Unknown iCloud container request");
    const fn = bridge[method as IcloudBridgeMethod] as (...callArgs: unknown[]) => Promise<unknown>;
    // `discardWrite` is the one primitive without a signal; every other method takes it last.
    const value = method === "discardWrite" ? await fn.apply(bridge, args) : await fn.apply(bridge, [...args, signal]);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: toFailure(error) };
  }
}

export function registerIcloudContainerIpc(ipcMain: IpcMain, createBridge: () => IcloudContainerBridge & { close(): Promise<void> } = () => new NodeIcloudContainer(), policyFor?: SyncPolicyFor): void {
  const bridges = new Map<number, IcloudContainerBridge & { close(): Promise<void> }>();
  const inflight = new Map<string, AbortController>();
  ipcMain.handle("icloud-container", async (event, method: unknown, args: unknown, requestId: unknown) => {
    const senderId = event.sender.id;
    let bridge = bridges.get(senderId);
    if (!bridge) {
      bridge = createBridge();
      bridges.set(senderId, bridge);
      event.sender.once("destroyed", () => {
        const owned = bridges.get(senderId);
        bridges.delete(senderId);
        void owned?.close();
      });
    }
    const key = `${senderId}:${String(requestId)}`;
    const abort = new AbortController();
    inflight.set(key, abort);
    try {
      return await dispatchIcloudCall(bridge, method, args, abort.signal, policyFor?.(event));
    } finally {
      inflight.delete(key);
    }
  });
  ipcMain.on("icloud-container-abort", (event, requestId: unknown) => {
    inflight.get(`${event.sender.id}:${String(requestId)}`)?.abort();
  });
}
