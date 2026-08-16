import { app } from "electron";

/** Simplified per-process telemetry shape sent to the renderer over IPC. */
export interface ProcessMetric {
  type: string;
  pid: number;
  cpuPercent: number;
  memoryMb: number;
}

/**
 * Pure mapping from Electron's raw `app.getAppMetrics()` shape to the
 * simplified shape the renderer's Settings -> Performance tab displays. Kept
 * separate from `getProcessMetricsSnapshot()` below so it's unit-testable
 * with injected fake data -- no real Electron call needed in tests.
 */
export function mapProcessMetrics(raw: Electron.ProcessMetric[]): ProcessMetric[] {
  return raw.map((m) => ({
    type: m.type,
    pid: m.pid,
    cpuPercent: m.cpu?.percentCPUUsage ?? 0,
    // Electron reports `memory.workingSetSize` in Kilobytes.
    memoryMb: Math.round(((m.memory?.workingSetSize ?? 0) / 1024) * 10) / 10,
  }));
}

/** Thin wrapper: calls the real Electron API and passes it through the pure mapper. */
export function getProcessMetricsSnapshot(): ProcessMetric[] {
  return mapProcessMetrics(app.getAppMetrics());
}
