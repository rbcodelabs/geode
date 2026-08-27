import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BoundedBuffer,
  DiagnosticLog,
  buildRendererIncident,
  exportDiagnostics,
  listCrashDumps,
  probeFdPressure,
  pruneCrashDumps,
  readFdLimit,
  resetFdLimitCache,
  sanitizeDiagnosticValue,
} from "../../src/main/crash-diagnostics";

describe("renderer crash diagnostics", () => {
  it("keeps bounded entries in chronological order", () => {
    const buffer = new BoundedBuffer<number>(2);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    expect(buffer.values()).toEqual([2, 3]);
  });

  it("redacts secrets and paths and truncates large values", () => {
    const sanitized = sanitizeDiagnosticValue(
      "token=abc123 /Users/rick/SecretVault/note.md " + "x".repeat(200),
      { homeDir: "/Users/rick", maxLength: 80 },
    );
    expect(sanitized).not.toContain("abc123");
    expect(sanitized).not.toContain("SecretVault");
    expect(sanitized).toContain("token=[REDACTED]");
    expect(sanitized).toContain("[HOME]");
    expect(sanitized.length).toBeLessThanOrEqual(81);
  });

  it("rotates a structured log and retains only the configured files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "geode-diagnostics-"));
    const log = new DiagnosticLog(path.join(dir, "diagnostic.log"), { maxBytes: 90, maxFiles: 2 });
    for (let i = 0; i < 8; i++) await log.append({ at: i, category: "test", message: "x".repeat(40) });
    const files = (await readdir(dir)).filter((name) => name.startsWith("diagnostic.log"));
    expect(files.sort()).toEqual(["diagnostic.log", "diagnostic.log.1"]);
    expect((await stat(path.join(dir, "diagnostic.log"))).size).toBeGreaterThan(0);
  });

  it("correlates only newly observed safe-named minidumps in an incident", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "geode-dumps-"));
    await writeFile(path.join(dir, "old.dmp"), "old");
    const before = await listCrashDumps(dir);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(path.join(dir, "new.dmp"), "new");
    await writeFile(path.join(dir, "not-a-dump.txt"), "secret");
    const after = await listCrashDumps(dir);
    const incident = buildRendererIncident({
      incidentId: "incident-1",
      at: 10,
      reason: "crashed",
      exitCode: 5,
      activePlugins: ["alpha"],
      suppressPlugins: false,
      recovering: false,
      breadcrumbs: [{ at: 8, category: "lifecycle", message: "ready" }],
      consoleEntries: [{ at: 9, category: "renderer-console", level: "error", message: "before crash" }],
      processMetrics: [{ type: "Browser", pid: 1, cpuPercent: 2, memoryMb: 3 }],
      appVersion: "1.0.0",
      electronVersion: "42.4.0",
      platform: "darwin",
      arch: "arm64",
      uptimeSeconds: 4,
      windowUrl: "file:///app/index.html",
      dumpFiles: after.filter((dump) => !before.some((old) => old.name === dump.name)),
    });
    expect(incident).toMatchObject({ type: "renderer-gone", incidentId: "incident-1", reason: "crashed", exitCode: 5 });
    expect(incident.dumpFiles.map((dump) => dump.name)).toEqual(["new.dmp"]);
    expect(JSON.stringify(incident)).not.toContain(dir);
  });

  it("prunes the oldest minidumps to the retention bound", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "geode-dump-retention-"));
    for (const name of ["one.dmp", "two.dmp", "three.dmp"]) {
      await writeFile(path.join(dir, name), name);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await pruneCrashDumps(dir, 2);
    expect((await readdir(dir)).sort()).toEqual(["three.dmp", "two.dmp"]);
  });

  it("copies only allowlisted files and never reads the nearby config fixture", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "geode-export-source-"));
    const destination = await mkdtemp(path.join(tmpdir(), "geode-export-destination-"));
    const dumpDir = path.join(source, "dumps");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dumpDir);
    await writeFile(path.join(source, "diagnostic.log"), "safe log");
    await writeFile(path.join(source, "crash-journal.json"), "[]");
    await writeFile(path.join(source, "geode.json"), "SUPER_SECRET vault content");
    await writeFile(path.join(dumpDir, "one.dmp"), "dump bytes");

    const result = await exportDiagnostics({
      destinationRoot: destination,
      userDataDir: source,
      crashDumpsDir: dumpDir,
      manifest: { appVersion: "1.0.0", platform: "darwin", generatedAt: "now" },
    });
    const names = await readdir(result.directory);
    expect(names.sort()).toEqual(["crash-dumps", "crash-journal.json", "diagnostic.log", "manifest.json"]);
    const exportedText = await Promise.all(
      names.filter((name) => name !== "crash-dumps").map((name) => readFile(path.join(result.directory, name), "utf8")),
    );
    expect(exportedText.join("\n")).not.toContain("SUPER_SECRET");
    expect(names).not.toContain("geode.json");
    expect(await readdir(path.join(result.directory, "crash-dumps"))).toEqual(["one.dmp"]);
  });
});

describe("probeFdPressure", () => {
  it("reports the lowest free descriptor as the occupancy estimate", () => {
    const snapshot = probeFdPressure({ openProbe: () => 42, limit: 1000 });
    expect(snapshot).toEqual({
      openFileDescriptors: 42,
      limit: 1000,
      ratio: 0.042,
      underPressure: false,
      exhausted: false,
    });
  });

  it("flags pressure once occupancy reaches the threshold", () => {
    // Chromium needs a spare descriptor for the sandbox handshake, so the
    // table does not have to be completely full to break <webview>.
    expect(probeFdPressure({ openProbe: () => 8_704, limit: 10_240 }).underPressure).toBe(true);
    expect(probeFdPressure({ openProbe: () => 8_703, limit: 10_240 }).underPressure).toBe(false);
    // The real observed failure: an 11k-file vault against a 10,240 ceiling.
    expect(probeFdPressure({ openProbe: () => 9_999, limit: 10_240 })).toMatchObject({
      underPressure: true,
      exhausted: false,
    });
  });

  it("treats an EMFILE from the probe itself as full exhaustion", () => {
    const emfile = Object.assign(new Error("too many open files"), { code: "EMFILE" });
    expect(probeFdPressure({
      openProbe: () => { throw emfile; },
      limit: 10_240,
    })).toEqual({
      openFileDescriptors: 10_240,
      limit: 10_240,
      ratio: 1,
      underPressure: true,
      exhausted: true,
    });
  });

  it("degrades to an inconclusive answer rather than throwing", () => {
    expect(probeFdPressure({
      openProbe: () => { throw new Error("no such device"); },
      limit: 10_240,
    })).toEqual({
      openFileDescriptors: null,
      limit: 10_240,
      ratio: null,
      underPressure: false,
      exhausted: false,
    });
    expect(probeFdPressure({ openProbe: () => 10, limit: null })).toMatchObject({
      ratio: null,
      underPressure: false,
    });
  });

  it("measures a real descriptor count against the real limit", () => {
    resetFdLimitCache();
    const snapshot = probeFdPressure();
    expect(snapshot.openFileDescriptors).toBeGreaterThan(0);
    expect(snapshot.exhausted).toBe(false);
    // A test process holds a handful of descriptors, nowhere near any limit.
    expect(snapshot.underPressure).toBe(false);
  });
});

describe("readFdLimit", () => {
  it("reads the soft open-file limit and caches it", () => {
    resetFdLimitCache();
    let calls = 0;
    const report = () => { calls += 1; return { userLimits: { open_files: { soft: 10_240, hard: "unlimited" } } }; };
    expect(readFdLimit(report)).toBe(10_240);
    expect(readFdLimit(report)).toBe(10_240);
    expect(calls).toBe(1);
  });

  it("returns null when the runtime cannot report a usable limit", () => {
    resetFdLimitCache();
    expect(readFdLimit(() => ({ userLimits: { open_files: { soft: "unlimited" } } }))).toBeNull();
    resetFdLimitCache();
    expect(readFdLimit(() => { throw new Error("unavailable"); })).toBeNull();
    resetFdLimitCache();
  });
});
