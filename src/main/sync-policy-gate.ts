import type { IpcMainInvokeEvent } from "electron";
import { loadEffectivePolicy } from "./policy-loader";
import { assertSyncAllowed, syncChannelBlockReason, type SyncPolicyView } from "../shared/sync-policy";

/**
 * Main-process side of the `sync` managed policy (docs/adr/0053-sync-policy.md). The effective policy (machine + the
 * calling window's vault policy) is read fresh on every call: no cache, no watcher, so a kill switch applies to the next
 * operation. Any failure to load policy fails open (docs/adr/0002), the same as every other policy consumer.
 */
export function syncPolicyForRoot(root: string | null): SyncPolicyView | null {
  try {
    return loadEffectivePolicy(root).effective.sync;
  } catch (error) {
    console.error("Sync policy: could not evaluate the effective policy; allowing (fail open).", error);
    return null;
  }
}

/** Effective sync policy for the window behind an IPC event. Evaluated per call. */
export type SyncPolicyFor = (event: Pick<IpcMainInvokeEvent, "sender">) => SyncPolicyView | null;

export function createSyncPolicyFor(rootOf: (event: Pick<IpcMainInvokeEvent, "sender">) => string | null): SyncPolicyFor {
  return (event) => syncPolicyForRoot(rootOf(event));
}

/** Throws a `SyncPolicyError` ("blocked by administrator policy: sync ...") when the provider-agnostic sync channels are blocked. */
export function assertSyncChannelAllowed(policyFor: SyncPolicyFor, event: Pick<IpcMainInvokeEvent, "sender">): void {
  assertSyncAllowed(syncChannelBlockReason(policyFor(event)));
}
