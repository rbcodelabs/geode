import { PairingError } from "../../shared/pairing/errors";
import type { PairingBundle } from "../../shared/pairing/bundle";
import { parseInvitation } from "../../shared/pairing/invitation";
import { redeemInvitation, type RedeemOptions } from "../../shared/pairing/client";
import { applyPairingBundle, assertCanStoreCredential, type ApplyPorts, type ApplyReport } from "./apply";

export interface PairingFlowDeps {
  ports: ApplyPorts;
  /** Returns a reason this device must not pair right now (for example another sync provider is active), or null. */
  precheck?: () => string | null;
  /** Shows the confirmation sheet. Nothing has been stored when this runs; resolve false to discard everything. */
  confirm: (bundle: PairingBundle) => Promise<boolean>;
  redeem?: (invitation: string, options?: RedeemOptions) => ReturnType<typeof redeemInvitation>;
  redeemOptions?: RedeemOptions;
  /** Progress hooks for the UI. */
  onStep?: (step: "checking" | "connecting" | "confirming" | "applying") => void;
}
export type PairingOutcome = { status: "declined" } | { status: "applied"; bundle: PairingBundle; report: ApplyReport };

/**
 * Phone-side orchestration. Order is the security design (docs/design/mobile-qr-pairing.md "Phone behaviour"):
 * validate the invitation, then require secure storage BEFORE the one-time token is spent, redeem, validate, confirm, only then apply.
 */
export async function runPairingFlow(invitationText: string, deps: PairingFlowDeps): Promise<PairingOutcome> {
  deps.onStep?.("checking");
  parseInvitation(invitationText, deps.redeemOptions?.nowMs);          // cheap local rejection (format, version, expiry, address policy)
  assertCanStoreCredential(deps.ports);                                 // fail closed: do not spend the token
  const blocked = deps.precheck?.(); if (blocked) throw new PairingError("unsupported-provider", blocked);
  deps.onStep?.("connecting");
  const { bundle } = await (deps.redeem ?? redeemInvitation)(invitationText, deps.redeemOptions);
  deps.onStep?.("confirming");
  if (!(await deps.confirm(bundle))) return { status: "declined" };      // the reply is dropped; the desktop's code is already spent
  deps.onStep?.("applying");
  return { status: "applied", bundle, report: await applyPairingBundle(bundle, deps.ports) };
}
