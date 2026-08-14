import { MetadataCache } from "../../../src/renderer/metadata-cache";
import type { TFile } from "../../../src/renderer/types";
import { FakeVault } from "../../helpers/fake-vault";
import { createRowContext, EvalContext } from "../../../src/renderer/bases/eval-context";
import { Expr } from "../../../src/renderer/bases/ast";

/**
 * Build a real `Vault`/`MetadataCache` pair over a `FakeVault` (same
 * construction pattern `tests/unit/metadata-cache.test.ts` uses), then
 * return an `EvalContext` for `targetPath` — exercising the real structural
 * `VaultReader`/`MetadataCacheReader` interfaces end to end rather than
 * hand-rolled fakes.
 */
export async function buildContext(
  files: Record<string, string>,
  targetPath: string,
  opts: { thisFile?: TFile | null; now?: number; formulas?: Record<string, Expr>; randomSeed?: number } = {}
): Promise<{ ctx: EvalContext; vault: FakeVault; metadataCache: MetadataCache; file: TFile }> {
  const fake = new FakeVault(files);
  const vault = fake.asVault();
  const metadataCache = new MetadataCache(vault);
  await metadataCache.initialize();
  const file = vault.getFileByPath(targetPath);
  if (!file) throw new Error(`Test fixture missing file: ${targetPath}`);
  const ctx = createRowContext(
    file,
    vault,
    metadataCache,
    opts.formulas ?? {},
    opts.thisFile ?? null,
    opts.now ?? Date.now(),
    opts.randomSeed
  );
  return { ctx, vault: fake, metadataCache, file };
}
