import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { assertValidThemeId } from "../shared/theme-id";

function packagedResourcesDir(): string {
  return process.env.GEODE_RESOURCES_DIR || path.join(__dirname, "..", "resources");
}

async function discoverThemes(parentDir: string): Promise<string[]> {
  const entries = await fsp.readdir(parentDir, { withFileTypes: true }).catch(() => []);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      assertValidThemeId(entry.name);
      await fsp.access(path.join(parentDir, entry.name, "theme.css"));
      names.push(entry.name);
    } catch {
      // Ignore incomplete or invalid theme directories.
    }
  }
  return names;
}

/** Returns the sorted union of app-owned built-ins and vault-owned themes. */
export async function listThemes(
  vaultRoot: string,
  resourcesDir = packagedResourcesDir(),
): Promise<string[]> {
  const [builtIn, local] = await Promise.all([
    discoverThemes(path.join(resourcesDir, "builtin-themes")),
    discoverThemes(path.join(vaultRoot, ".geode", "themes")),
  ]);
  return [...new Set([...builtIn, ...local])].sort((a, b) => a.localeCompare(b));
}

/** Reads a vault override first, then falls back to the app-owned copy. */
export async function readThemeCss(
  vaultRoot: string,
  id: unknown,
  resourcesDir = packagedResourcesDir(),
): Promise<string> {
  assertValidThemeId(id);
  const localPath = path.join(vaultRoot, ".geode", "themes", id, "theme.css");
  try {
    return await fsp.readFile(localPath, "utf8");
  } catch {
    return fsp.readFile(path.join(resourcesDir, "builtin-themes", id, "theme.css"), "utf8");
  }
}
