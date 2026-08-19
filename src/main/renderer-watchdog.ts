import type { DiagnosticEntry } from "./crash-diagnostics";

export interface RendererWatchdogState {
  lastHeartbeat: number;
}

export type WatchdogPowerEvent = "suspend" | "resume";

export function handleWatchdogPowerEvent<T extends RendererWatchdogState>(
  states: ReadonlyMap<number, T>,
  event: WatchdogPowerEvent,
  at: number,
  recordDiagnostic: (state: T, entry: DiagnosticEntry) => void,
): void {
  for (const state of states.values()) {
    if (event === "resume") state.lastHeartbeat = at;
    recordDiagnostic(state, {
      at,
      category: "power",
      message: `power-${event}`,
    });
  }
}

export function isRendererHeartbeatStale(lastHeartbeat: number, now: number, timeoutMs: number): boolean {
  return now - lastHeartbeat >= timeoutMs;
}
