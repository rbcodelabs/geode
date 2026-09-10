import type { DiagnosticEntry } from "./crash-diagnostics";

export interface RendererWatchdogState {
  lastHeartbeat: number;
}

export type WatchdogPowerEvent = "suspend" | "resume";

// Power state belongs to the process, including windows created after suspend.
// Intervals can run during suspension or before Electron delivers resume on wake.
let suspended = false;

export function handleWatchdogPowerEvent<T extends RendererWatchdogState>(
  states: ReadonlyMap<number, T>,
  event: WatchdogPowerEvent,
  at: number,
  recordDiagnostic: (state: T, entry: DiagnosticEntry) => void,
): void {
  suspended = event === "suspend";
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
  return !suspended && now - lastHeartbeat >= timeoutMs;
}
