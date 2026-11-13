/**
 * Per-view UI state that survives a plugin reload (QA-G3-12). A reload is dispose THEN register: the registry notifies on
 * dispose, so the view tears its coordinator down before the plugin is back. The state below (never comment data) is parked
 * for a grace window and handed back only to the SAME owner plugin; the first list after the re-register is authoritative.
 */

export const PINS_UI_GRACE_MS = 10_000;

export interface PinsUiState {
  readonly railOpen: boolean;
  readonly filter: "all" | "open" | "sent" | "resolved" | "dismissed";
  readonly clusterIds: readonly string[] | null;
  readonly selected: readonly string[] | null;
  readonly resultsLine: string | null;
  /** A timed-out send whose Retry must reuse this request id (the first click may already have reached the plugin). */
  readonly lastSend: { readonly requestId: string; readonly ids: readonly string[]; readonly resend: boolean } | null;
}

export class PinsUiStateHolder {
  private parked: { ownerId: string; state: PinsUiState; at: number } | null = null;

  constructor(private readonly graceMs: number = PINS_UI_GRACE_MS) {}

  save(ownerId: string, state: PinsUiState, now: number): void {
    this.parked = { ownerId, state, at: now };
  }

  /** The parked state for this owner if it is still fresh; always consumed (a different owner or an expired state is dropped). */
  take(ownerId: string, now: number): PinsUiState | null {
    const parked = this.parked;
    this.parked = null;
    if (parked === null || parked.ownerId !== ownerId || now - parked.at > this.graceMs) return null;
    return parked.state;
  }

  clear(): void { this.parked = null; }
}
