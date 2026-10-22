import {
  compileVaultAllowlist,
  parseVaultQueryRequest,
  vaultQueryError,
  type VaultAllowlist,
  type VaultQueryError,
} from "../../artifacts/vault-access";
import { parseBaseFile, runQuery, type QueryRow } from "../bases";
import type { BaseDefinition, BaseViewDefinition } from "../bases/base-file";
import { valueToDisplayString } from "../bases/coerce";
import { columnDisplayName, enumerateFrontmatterKeys, resolveColumns } from "../bases/columns";
import type { MetadataCacheReader, VaultReader } from "../bases/eval-context";
import type { BaseValue } from "../bases/value";
import type { TFile } from "../types";

/** Serialized-response budget; rows beyond it are dropped and `truncated` is set. */
export const VAULT_BRIDGE_MAX_RESPONSE_CHARS = 3_000_000;
const MAX_CELL_DISPLAY_CHARS = 10_000;
const MAX_VALUE_DEPTH = 6;
const MAX_LIST_ITEMS = 500;
const MAX_CONCURRENT_QUERIES = 4;

/** What a guest sees for one Bases value: JSON-native `value` plus the string Geode would render. */
export interface SerializedCell {
  type: BaseValue["type"];
  value: unknown;
  display: string;
}

export interface SerializedRow {
  file: { path: string; name: string; basename: string; extension: string; mtime: number; ctime: number; size: number };
  /** Resolved value per column path (the view's `order`, or every known property when unset). */
  values: Record<string, SerializedCell>;
  /** Every base-level formula, resolved for this row. */
  formulas: Record<string, SerializedCell>;
}

export interface VaultQuerySuccess {
  base: string;
  view: string;
  viewType: string;
  columns: { path: string; name: string }[];
  rows: SerializedRow[];
  groups: { key: SerializedCell; rows: SerializedRow[] }[] | null;
  summaries: Record<string, SerializedCell>;
  /** Rows the query produced before the row/size cap. */
  totalRows: number;
  truncated: boolean;
}

export type VaultQueryResponse = VaultQuerySuccess | VaultQueryError;

/** Structural slice of the real Vault / MetadataCache used here (both satisfy it unchanged). */
export interface VaultBridgeVault extends VaultReader {
  read(file: TFile): Promise<string>;
  on(name: string, callback: (...args: any[]) => unknown): unknown;
  off(name: string, callback: (...args: any[]) => unknown): void;
}
export interface VaultBridgeMetadataCache extends MetadataCacheReader {
  on(name: string, callback: (...args: any[]) => unknown): unknown;
  off(name: string, callback: (...args: any[]) => unknown): void;
}

function toPlain(value: BaseValue, depth = 0): unknown {
  if (depth > MAX_VALUE_DEPTH) return null;
  switch (value.type) {
    case "null": return null;
    case "string":
    case "number":
    case "boolean":
    case "date":
    case "html": return value.value;
    case "duration": return { amount: value.value.amount, unit: value.value.unit };
    case "list": return value.value.slice(0, MAX_LIST_ITEMS).map((item) => toPlain(item, depth + 1));
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value.value)) out[key] = toPlain(item, depth + 1);
      return out;
    }
    case "link": return { raw: value.value.raw, display: value.value.display ?? null, path: value.value.resolved?.path ?? null };
    case "file": return value.value.path;
    case "regexp": return { source: value.value.source, flags: value.value.flags };
    case "image": return value.value.source;
  }
}

export function serializeBaseValue(value: BaseValue): SerializedCell {
  let display = valueToDisplayString(value);
  if (display.length > MAX_CELL_DISPLAY_CHARS) display = `${display.slice(0, MAX_CELL_DISPLAY_CHARS)}…`;
  return { type: value.type, value: toPlain(value), display };
}

function serializeRecord(record: Record<string, BaseValue>): Record<string, SerializedCell> {
  const out: Record<string, SerializedCell> = {};
  for (const [key, value] of Object.entries(record)) out[key] = serializeBaseValue(value);
  return out;
}

function serializeRow(row: QueryRow): SerializedRow {
  const f = row.file;
  return {
    file: { path: f.path, name: f.name, basename: f.basename, extension: f.extension, mtime: f.mtime, ctime: f.ctime, size: f.size },
    values: serializeRecord(row.properties),
    formulas: serializeRecord(row.formulas),
  };
}

/**
 * Renderer-side half of the artifact vault bridge (see the Compass "ADR - Artifact vault read bridge"). One instance per
 * registered artifact, constructed from the allowlist of its validated
 * manifest. The guest is untrusted: every request is re-validated here, and
 * every failure resolves to `{ error }` rather than throwing.
 */
export class ArtifactVaultBridge {
  private readonly allowlist: VaultAllowlist;
  private inFlight = 0;

  constructor(
    private readonly vault: VaultBridgeVault,
    private readonly metadataCache: VaultBridgeMetadataCache,
    allowlistEntries: readonly string[],
    private readonly now: () => number = Date.now,
  ) {
    this.allowlist = compileVaultAllowlist(allowlistEntries);
  }

  async query(rawRequest: unknown): Promise<VaultQueryResponse> {
    try {
      const parsed = parseVaultQueryRequest(rawRequest);
      if (!parsed.ok) return { error: parsed.error };
      const { request } = parsed;

      // Allowlist first, lookup second: a non-allowed path never reveals
      // whether the file exists.
      if (!this.allowlist.matches(request.base)) {
        return vaultQueryError("not_allowed", `"${request.base}" is not in this artifact's vault allowlist.`);
      }
      const file = this.vault.getFileByPath(request.base);
      if (!file) return vaultQueryError("not_found", `Base "${request.base}" was not found.`);
      // The vault may canonicalize (e.g. case-insensitive filesystems); the
      // resolved path must be allowed too.
      if (file.extension !== "base" || !this.allowlist.matches(file.path)) {
        return vaultQueryError("not_allowed", `"${request.base}" is not in this artifact's vault allowlist.`);
      }
      if (this.inFlight >= MAX_CONCURRENT_QUERIES) {
        return vaultQueryError("too_many_requests", "Too many concurrent queries; retry shortly.");
      }
      this.inFlight += 1;
      try {
        return await this.run(file, request.view, request.limit);
      } finally {
        this.inFlight -= 1;
      }
    } catch (error) {
      return vaultQueryError("query_failed", error instanceof Error ? error.message : "Query failed.");
    }
  }

  private async run(file: TFile, viewName: string | undefined, limit: number): Promise<VaultQueryResponse> {
    const text = await this.vault.read(file);
    const parsed = parseBaseFile(text);
    if ("error" in parsed) return vaultQueryError("invalid_base", `Base could not be parsed: ${parsed.error}`);
    const def = parsed.def;
    const view: BaseViewDefinition | undefined = viewName ? def.views.find((v) => v.name === viewName) : def.views[0];
    if (!view) {
      return vaultQueryError("not_found", viewName ? `View "${viewName}" not found in ${file.path}.` : `${file.path} defines no views.`);
    }

    const files = this.vault.getMarkdownFiles();
    const knownKeys = enumerateFrontmatterKeys(files, (f) => this.metadataCache.getFileCache(f)?.frontmatter ?? null);
    const columns = resolveColumns(view.order, knownKeys);
    const defForQuery: BaseDefinition = {
      ...def,
      views: def.views.map((v) => (v === view ? { ...view, order: columns } : v)),
    };
    const result = runQuery(defForQuery, view.name, files, this.vault, this.metadataCache, file, this.now());
    if ("error" in result) return vaultQueryError("query_failed", result.error);

    const kept = new Map<string, SerializedRow>();
    let budget = VAULT_BRIDGE_MAX_RESPONSE_CHARS;
    let truncated = result.rows.length > limit;
    for (const row of result.rows.slice(0, limit)) {
      const serialized = serializeRow(row);
      budget -= JSON.stringify(serialized).length;
      if (budget < 0) { truncated = true; break; }
      kept.set(row.file.path, serialized);
    }
    const rows = [...kept.values()];
    const groups = result.groups
      ? result.groups
        .map((group) => ({
          key: serializeBaseValue(group.key),
          rows: group.rows.map((r) => kept.get(r.file.path)).filter((r): r is SerializedRow => r !== undefined),
        }))
        .filter((group) => group.rows.length > 0)
      : null;

    return {
      base: file.path,
      view: view.name,
      viewType: view.type,
      columns: columns.map((path) => ({ path, name: columnDisplayName(def, path) })),
      rows,
      groups,
      summaries: serializeRecord(result.summaries),
      totalRows: result.rows.length,
      truncated,
    };
  }

  /**
   * Call `onChange` (debounced) whenever vault content or metadata changes.
   * Carries no payload: the guest learns *that* something changed, never which
   * file, and re-queries through the allowlisted path. Returns an unsubscribe.
   */
  watch(onChange: () => void, debounceMs = 250): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; onChange(); }, debounceMs);
    };
    const events: [VaultBridgeVault | VaultBridgeMetadataCache, string][] = [
      [this.vault, "modify"], [this.vault, "create"], [this.vault, "delete"], [this.vault, "rename"],
      [this.metadataCache, "changed"],
    ];
    for (const [source, name] of events) source.on(name, fire);
    return () => {
      if (timer) clearTimeout(timer);
      for (const [source, name] of events) source.off(name, fire);
    };
  }
}
