import type { VaultEvent, VaultFileEntry, VaultFilesService } from "./host/contracts";

export type ReconcileScanStatus = Awaited<ReturnType<VaultFilesService["reconcileScan"]>>["status"];

export interface VaultManifest {
  version: 1;
  vaultId: string;
  entries: Record<string, Pick<VaultFileEntry, "path" | "isFolder" | "mtime" | "ctime" | "size">>;
}

export type ReconcileChange =
  | { event: "create" | "modify" | "create-folder"; path: string; entry: VaultFileEntry }
  | { event: "delete" | "delete-folder"; path: string };

export interface ReconcileScan {
  status: ReconcileScanStatus;
  entries: VaultFileEntry[];
  errorCode?: string;
}

export function buildVaultManifest(vaultId: string, entries: VaultFileEntry[]): VaultManifest {
  return {
    version: 1,
    vaultId,
    entries: Object.fromEntries(
      [...entries]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((entry) => [entry.path, { ...entry }]),
    ),
  };
}

export function diffVaultManifests(previous: VaultManifest, next: VaultManifest): ReconcileChange[] {
  const changes: ReconcileChange[] = [];
  const deletedFolders = Object.entries(previous.entries)
    .filter(([path, entry]) => entry.isFolder &&
      (!next.entries[path] || next.entries[path].isFolder !== entry.isFolder))
    .map(([path]) => path);
  for (const [path, before] of Object.entries(previous.entries)) {
    const after = next.entries[path];
    if ((!after || before.isFolder !== after.isFolder) &&
      (before.isFolder || !deletedFolders.some((folder) => path.startsWith(`${folder}/`)))) {
      changes.push({ event: before.isFolder ? "delete-folder" : "delete", path });
    }
  }
  for (const [path, after] of Object.entries(next.entries)) {
    const before = previous.entries[path];
    if (!before || before.isFolder !== after.isFolder) {
      changes.push({ event: after.isFolder ? "create-folder" : "create", path, entry: after });
    } else if (!after.isFolder && (before.mtime !== after.mtime || before.size !== after.size)) {
      changes.push({ event: "modify", path, entry: after });
    }
  }
  return coalesceReconcileChanges(changes);
}

export function coalesceReconcileChanges(changes: ReconcileChange[]): ReconcileChange[] {
  const byPath = new Map<string, ReconcileChange[]>();
  for (const change of changes) {
    const pathChanges = byPath.get(change.path) ?? [];
    const previous = pathChanges.at(-1);
    const replacement = previous &&
      (previous.event === "delete" || previous.event === "delete-folder") &&
      (change.event === "create" || change.event === "create-folder");
    if (replacement) pathChanges.push(change);
    else if (!previous || previous.event !== change.event) pathChanges.push(change);
    else pathChanges[pathChanges.length - 1] = change;
    byPath.set(change.path, pathChanges);
  }
  return [...byPath.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, pathChanges]) => pathChanges);
}

/** Reduce only provably redundant adjacent provider notifications. */
export function reduceProviderEvents(events: VaultEvent[]): VaultEvent[] {
  const reduced: VaultEvent[] = [];
  for (const event of events) {
    const previous = reduced.at(-1);
    if (!previous || previous.path !== event.path) {
      reduced.push(event);
      continue;
    }
    if (previous.event === "delete" && event.event === "create") {
      reduced[reduced.length - 1] = { ...event, event: "modify" };
      continue;
    }
    if (previous.event === "create" && event.event === "modify") {
      reduced[reduced.length - 1] = { ...previous, version: event.version ?? previous.version };
      continue;
    }
    const sameVersion = previous.version === event.version;
    if (previous.event === event.event && sameVersion) continue;
    reduced.push(event);
  }
  return reduced;
}

export async function stageReconcileManifest(options: {
  vaultId: string;
  previous: VaultManifest;
  scan: () => Promise<ReconcileScan>;
}): Promise<{ status: ReconcileScanStatus; changes: ReconcileChange[]; manifest: VaultManifest; errorCode?: string }> {
  const scan = await options.scan();
  if (scan.status !== "complete") {
    return { status: scan.status, changes: [], manifest: options.previous, errorCode: scan.errorCode };
  }
  const manifest = buildVaultManifest(options.vaultId, scan.entries);
  const changes = diffVaultManifests(options.previous, manifest);
  return { status: "complete", changes, manifest };
}

export function formatConflictTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function buildConflictPath(path: string, timestamp: string, exists: (path: string) => boolean): string {
  const slash = path.lastIndexOf("/");
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const base = `${directory}${stem} (Geode conflict ${timestamp})`;
  let candidate = `${base}${extension}`;
  let collision = 2;
  while (exists(candidate)) candidate = `${base} ${collision++}${extension}`;
  return candidate;
}
