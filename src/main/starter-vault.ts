/**
 * Copies the bundled `resources/starter-vault/` content into a destination
 * folder so the "Try the sample vault" picker button (src/renderer/app.ts's
 * `showVaultPicker`) has somewhere to open. `resources/starter-vault/` is a
 * content-only prototype (PR #285) already shipped inside every packaged
 * build via electron-builder's `files: ["resources/**\/*"]`.
 *
 * Since ADR 0050 the starter vault is just a vault pack: the folder is read
 * into an in-memory pack and handed to `applyVaultPack`, the same code path a
 * `.vault` file takes (staged, atomic, `.geode/` allowlist enforced).
 *
 * Modeled on ./builtin-themes.ts's `packagedResourcesDir()` convention:
 * esbuild bundles main-process code to `dist/main.js`, so `__dirname` is
 * `<repo>/dist` at runtime in both dev and packaged builds, and
 * `GEODE_RESOURCES_DIR` overrides it for tests exactly as it does there.
 */
import * as path from "node:path";
import { applyVaultPack, buildMemoryPack, readDirectoryFiles } from "./vault-pack";

function packagedResourcesDir(): string {
  return process.env.GEODE_RESOURCES_DIR || path.join(__dirname, "..", "resources");
}

/**
 * Applies `<resourcesDir>/starter-vault` to `destRoot` (missing or empty).
 *
 * Files are read as `Buffer`s (never decoded as utf8) so binary content —
 * images, `.canvas` JSON, anything — copies byte-for-byte, using the same
 * `fsp.readdir`/`fsp.readFile` idiom builtin-themes.ts relies on to read out
 * of a packaged asar archive. Inside `.geode/` only `app.json` is copied, so untracked
 * runtime state (`metadata-cache/`, `workspace.json`, `community.json`,
 * `device-reconcile:*`) from a maintainer's local checkout can never leak into
 * a vault copied for a real user.
 */
export async function copyStarterVault(
  destRoot: string,
  resourcesDir = packagedResourcesDir(),
): Promise<void> {
  // Only `.geode/app.json` is honored, exactly as before packs existed.
  const { files, dirs } = await readDirectoryFiles(path.join(resourcesDir, "starter-vault"), { geodeFiles: ["app.json"] });
  const pack = buildMemoryPack({ id: "geode-starter-vault", name: "Geode Starter Vault", files, dirs });
  await applyVaultPack({ kind: "memory", pack }, destRoot);
}
