import * as os from "node:os";
import type { PairingBundle } from "../shared/pairing/bundle";
import { PairingError } from "../shared/pairing/errors";
import type { PairingService, PairingStartResult } from "./pairing-service";

export type PairingStartReply = { ok: true; value: PairingStartResult } | { ok: false; error: { code: string; message: string } };

/** The display name phones show ("from"): the machine's host name, set here so a renderer cannot choose it. */
export function pairingDisplayName(): string {
  // eslint-disable-next-line no-control-regex
  return os.hostname().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64);
}

export async function startPairing(service: PairingService, owner: string, bundle: PairingBundle): Promise<PairingStartReply> {
  try { return { ok: true, value: await service.start(owner, { ...bundle, from: pairingDisplayName() }) }; }
  catch (error) {
    if (error instanceof PairingError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: "unreachable", message: error instanceof Error ? error.message : "Could not start pairing." } };
  }
}
