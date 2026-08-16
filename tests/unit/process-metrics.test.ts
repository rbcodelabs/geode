import { describe, expect, it } from "vitest";
import { mapProcessMetrics } from "../../src/main/process-metrics";

describe("mapProcessMetrics", () => {
  it("returns an empty array for an empty input", () => {
    expect(mapProcessMetrics([])).toEqual([]);
  });

  it("maps cpu/memory fields into the simplified shape (workingSetSize KB -> memoryMb)", () => {
    const raw = [
      {
        pid: 123,
        type: "Browser",
        creationTime: 1000,
        cpu: { percentCPUUsage: 4.5, idleWakeupsPerSecond: 0 },
        memory: { workingSetSize: 204800, peakWorkingSetSize: 300000 },
      },
    ] as unknown as Electron.ProcessMetric[];

    expect(mapProcessMetrics(raw)).toEqual([{ type: "Browser", pid: 123, cpuPercent: 4.5, memoryMb: 200 }]);
  });

  it("handles an entry missing optional fields (name, sandboxed, integrityLevel, serviceName)", () => {
    const raw = [
      {
        pid: 456,
        type: "Tab",
        creationTime: 2000,
        cpu: { percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
        memory: { workingSetSize: 51200, peakWorkingSetSize: 60000 },
        // name, sandboxed, integrityLevel, serviceName intentionally omitted
      },
    ] as unknown as Electron.ProcessMetric[];

    expect(mapProcessMetrics(raw)).toEqual([{ type: "Tab", pid: 456, cpuPercent: 0, memoryMb: 50 }]);
  });

  it("rounds memoryMb to one decimal place", () => {
    const raw = [
      {
        pid: 789,
        type: "Utility",
        creationTime: 3000,
        cpu: { percentCPUUsage: 12.3456, idleWakeupsPerSecond: 0 },
        memory: { workingSetSize: 1500, peakWorkingSetSize: 1500 }, // 1500 KB = 1.46484375 MB
      },
    ] as unknown as Electron.ProcessMetric[];

    const result = mapProcessMetrics(raw);
    expect(result[0].memoryMb).toBe(1.5);
    expect(result[0].cpuPercent).toBe(12.3456);
  });

  it("maps multiple process entries, preserving order", () => {
    const raw = [
      { pid: 1, type: "Browser", creationTime: 0, cpu: { percentCPUUsage: 1, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: 1024, peakWorkingSetSize: 1024 } },
      { pid: 2, type: "GPU", creationTime: 0, cpu: { percentCPUUsage: 2, idleWakeupsPerSecond: 0 }, memory: { workingSetSize: 2048, peakWorkingSetSize: 2048 } },
    ] as unknown as Electron.ProcessMetric[];

    const result = mapProcessMetrics(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "Browser", pid: 1, cpuPercent: 1, memoryMb: 1 });
    expect(result[1]).toEqual({ type: "GPU", pid: 2, cpuPercent: 2, memoryMb: 2 });
  });
});
