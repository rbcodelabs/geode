import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ProcessMetric } from "./process-metrics";

export interface DiagnosticEntry {
  at: number;
  category: string;
  message: string;
  level?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface CrashDumpFile {
  name: string;
  size: number;
  modifiedAt: number;
}

export interface RendererIncidentInput {
  incidentId: string;
  at: number;
  reason: string;
  exitCode: number;
  activePlugins: string[];
  suppressPlugins: boolean;
  recovering: boolean;
  breadcrumbs: DiagnosticEntry[];
  consoleEntries: DiagnosticEntry[];
  processMetrics: ProcessMetric[];
  appVersion: string;
  electronVersion: string;
  platform: string;
  arch: string;
  uptimeSeconds: number;
  windowUrl: string;
  dumpFiles: CrashDumpFile[];
}

export interface RendererIncident extends RendererIncidentInput {
  type: "renderer-gone";
}

/**
 * How close to `RLIMIT_NOFILE` counts as trouble. Chromium needs a spare
 * descriptor to hand a sandboxed renderer its seatbelt policy, so the table
 * does not have to be completely full before `<webview>` guests start dying.
 */
export const FD_PRESSURE_RATIO = 0.85;

export interface FdPressureSnapshot {
  /**
   * Approximate number of descriptors in use. `open()` always returns the
   * lowest free descriptor, so opening (and immediately closing) the null
   * device reports how far up the table allocation has reached — cheap, and
   * accurate enough to tell "a few dozen" from "ten thousand".
   */
  openFileDescriptors: number | null;
  /** Soft `RLIMIT_NOFILE`, when the runtime can report it. */
  limit: number | null;
  ratio: number | null;
  underPressure: boolean;
  /** The probe itself could not get a descriptor: the table is full. */
  exhausted: boolean;
}

function defaultOpenProbe(): number {
  const fd = fs.openSync(os.devNull, "r");
  try {
    return fd;
  } finally {
    fs.closeSync(fd);
  }
}

let cachedFdLimit: number | null | undefined;

/** Soft open-file limit, read once — `RLIMIT_NOFILE` does not change under us. */
export function readFdLimit(report: () => unknown = () => process.report?.getReport()): number | null {
  if (cachedFdLimit !== undefined) return cachedFdLimit;
  let limit: number | null = null;
  try {
    const soft = (report() as { userLimits?: { open_files?: { soft?: unknown } } } | undefined)
      ?.userLimits?.open_files?.soft;
    if (typeof soft === "number" && Number.isFinite(soft) && soft > 0) limit = soft;
  } catch {
    limit = null;
  }
  cachedFdLimit = limit;
  return limit;
}

/** Test seam — the cached limit would otherwise leak between cases. */
export function resetFdLimitCache(): void {
  cachedFdLimit = undefined;
}

/**
 * Sample file-descriptor pressure. Exhausting the table is silent until
 * something needs a *new* descriptor at an awkward moment (spawning a
 * sandboxed renderer), which surfaces as an unactionable "exit code 6"
 * crash, so this exists to name the real cause.
 */
export function probeFdPressure(options: {
  openProbe?: () => number;
  limit?: number | null;
  threshold?: number;
} = {}): FdPressureSnapshot {
  const limit = options.limit !== undefined ? options.limit : readFdLimit();
  // Reproducing genuine descriptor exhaustion in a test would mean opening
  // ten thousand files; the same GEODE_TEST_* escape hatch the watchdog and
  // heartbeat timings use lets a test reach the pressure branch instead.
  const threshold = options.threshold
    ?? Number(process.env.GEODE_TEST_FD_PRESSURE_RATIO ?? FD_PRESSURE_RATIO);
  let openFileDescriptors: number;
  try {
    openFileDescriptors = (options.openProbe ?? defaultOpenProbe)();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EMFILE" || code === "ENFILE") {
      return { openFileDescriptors: limit, limit, ratio: 1, underPressure: true, exhausted: true };
    }
    return { openFileDescriptors: null, limit, ratio: null, underPressure: false, exhausted: false };
  }
  const ratio = limit ? openFileDescriptors / limit : null;
  return {
    openFileDescriptors,
    limit,
    ratio,
    underPressure: ratio !== null && ratio >= threshold,
    exhausted: false,
  };
}

export class BoundedBuffer<T> {
  private entries: T[] = [];
  constructor(private readonly capacity: number) {}
  push(entry: T): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }
  values(): T[] { return [...this.entries]; }
}

export function sanitizeDiagnosticValue(
  value: unknown,
  options: { homeDir?: string; maxLength?: number } = {},
): string {
  const maxLength = options.maxLength ?? 500;
  let result = typeof value === "string" ? value : String(value);
  const homeDir = options.homeDir ?? os.homedir();
  if (homeDir) {
    const escapedHome = homeDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`${escapedHome}(?:/[^\\s,;]+)?`, "g"), "[HOME]/[PATH]");
  }
  result = result
    .replace(/\b(token|password|secret|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]");
  return result.length > maxLength ? `${result.slice(0, Math.max(0, maxLength - 1))}…` : result;
}

export class DiagnosticLog {
  private pending = Promise.resolve();
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  constructor(
    readonly filePath: string,
    options: { maxBytes?: number; maxFiles?: number } = {},
  ) {
    this.maxBytes = options.maxBytes ?? 1_000_000;
    this.maxFiles = Math.max(1, options.maxFiles ?? 3);
  }

  append(entry: DiagnosticEntry): Promise<void> {
    this.pending = this.pending.catch(() => {}).then(async () => {
      const line = `${JSON.stringify(entry)}\n`;
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      const size = (await fsp.stat(this.filePath).catch(() => null))?.size ?? 0;
      if (size > 0 && size + Buffer.byteLength(line) > this.maxBytes) await this.rotate();
      await fsp.appendFile(this.filePath, line, "utf8");
    });
    return this.pending;
  }

  private async rotate(): Promise<void> {
    await fsp.rm(`${this.filePath}.${this.maxFiles - 1}`, { force: true }).catch(() => {});
    for (let i = this.maxFiles - 2; i >= 1; i--) {
      await fsp.rename(`${this.filePath}.${i}`, `${this.filePath}.${i + 1}`).catch(() => {});
    }
    if (this.maxFiles > 1) await fsp.rename(this.filePath, `${this.filePath}.1`).catch(() => {});
    else await fsp.rm(this.filePath, { force: true }).catch(() => {});
  }
}

export async function listCrashDumps(directory: string): Promise<CrashDumpFile[]> {
  const names = await fsp.readdir(directory).catch(() => [] as string[]);
  const dumps: CrashDumpFile[] = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9._-]+\.dmp$/.test(name)) continue;
    const info = await fsp.stat(path.join(directory, name)).catch(() => null);
    if (info?.isFile()) dumps.push({ name, size: info.size, modifiedAt: info.mtimeMs });
  }
  return dumps.sort((a, b) => a.modifiedAt - b.modifiedAt || a.name.localeCompare(b.name));
}

export async function pruneCrashDumps(directory: string, maxFiles = 10): Promise<void> {
  const dumps = await listCrashDumps(directory);
  for (const dump of dumps.slice(0, Math.max(0, dumps.length - maxFiles))) {
    await fsp.rm(path.join(directory, dump.name), { force: true }).catch(() => {});
  }
}

export function buildRendererIncident(input: RendererIncidentInput): RendererIncident {
  return { type: "renderer-gone", ...input };
}

export async function exportDiagnostics(options: {
  destinationRoot: string;
  userDataDir: string;
  crashDumpsDir: string;
  manifest: Record<string, string | number | boolean | null>;
}): Promise<{ directory: string }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(options.destinationRoot, `Geode-Diagnostics-${stamp}`);
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(path.join(directory, "manifest.json"), JSON.stringify(options.manifest, null, 2), "utf8");
  for (const name of ["crash-journal.json", "diagnostic.log", "diagnostic.log.1", "diagnostic.log.2"]) {
    const source = path.join(options.userDataDir, name);
    if (fs.existsSync(source)) await fsp.copyFile(source, path.join(directory, name));
  }
  const dumps = await listCrashDumps(options.crashDumpsDir);
  if (dumps.length) {
    const target = path.join(directory, "crash-dumps");
    await fsp.mkdir(target);
    for (const dump of dumps) await fsp.copyFile(path.join(options.crashDumpsDir, dump.name), path.join(target, dump.name));
  }
  return { directory };
}
