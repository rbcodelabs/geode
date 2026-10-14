/** Stable reasons a pairing step fails. The UI maps each to one sentence; none carries payload content. */
export type PairingErrorCode =
  | "invalid-invitation" | "unsupported-version" | "expired" | "relay-unsupported" | "unreachable" | "denied"
  | "identity-mismatch" | "decrypt-failed" | "invalid-bundle" | "secure-storage-unavailable" | "rate-limited"
  | "unsupported-provider" | "no-network-interface" | "cancelled";

export class PairingError extends Error {
  readonly code: PairingErrorCode;
  constructor(code: PairingErrorCode, message: string) { super(message); this.name = "PairingError"; this.code = code; }
}
