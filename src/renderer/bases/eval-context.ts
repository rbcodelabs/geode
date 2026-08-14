import type { CachedMetadata, TFile } from "../types";
import { Expr } from "./ast";
import { BaseValue } from "./value";

/**
 * Narrow structural slice of `Vault` (see `src/renderer/vault.ts`) — just
 * enough for query/formula evaluation. The real `Vault` class satisfies
 * this without any adapter code.
 */
export interface VaultReader {
  getFileByPath(path: string): TFile | null;
  getMarkdownFiles(): TFile[];
  getFiles(): TFile[];
}

/**
 * Narrow structural slice of `MetadataCache` (see
 * `src/renderer/metadata-cache.ts`) — just enough for query/formula
 * evaluation. The real `MetadataCache` class satisfies this without any
 * adapter code (its `getBacklinks` returns a more specific array type than
 * `unknown[]`, which is a valid covariant return-type match).
 */
export interface MetadataCacheReader {
  getFileCache(file: TFile): CachedMetadata | null;
  getBacklinks(file: TFile): unknown[];
  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null;
}

/**
 * Per-row evaluation context. One `EvalContext` is created per file being
 * evaluated (a query row, a single ad hoc filter/formula test, etc.) — the
 * memoization (`formulaCache`), cycle-guard (`inProgress`), and lambda/
 * summary variable bindings (`locals`) are all row-scoped and must not leak
 * across rows, hence `createRowContext` always builds them fresh.
 */
export interface EvalContext {
  file: TFile;
  frontmatter: Record<string, unknown> | null;
  vault: VaultReader;
  metadataCache: MetadataCacheReader;
  /** The contextual `this` file — see the spec's `this` keyword section. Phase A treats it as an opaque caller-supplied value. */
  thisFile: TFile | null;
  formulas: Record<string, Expr>;
  formulaCache: Map<string, BaseValue>;
  inProgress: Set<string>;
  /**
   * Bound local variables — used for list-method lambda params (`value`,
   * `index`, `acc` in `.filter()`/`.map()`/`.reduce()`) and the `values`
   * keyword in custom summaries. `resolvePropertyPath` checks this first
   * for any bare (shorthand) identifier, which is how those lambda/summary
   * variables shadow real frontmatter properties of the same name.
   */
  locals: Record<string, BaseValue>;
  now: number;
  randomSeed?: number;
}

/** Build a fresh `EvalContext` for evaluating expressions against one file. */
export function createRowContext(
  file: TFile,
  vault: VaultReader,
  metadataCache: MetadataCacheReader,
  formulas: Record<string, Expr>,
  thisFile: TFile | null,
  now: number,
  randomSeed?: number
): EvalContext {
  return {
    file,
    frontmatter: metadataCache.getFileCache(file)?.frontmatter ?? null,
    vault,
    metadataCache,
    thisFile,
    formulas,
    formulaCache: new Map(),
    inProgress: new Set(),
    locals: {},
    now,
    randomSeed,
  };
}
