import { selectLinkCandidates } from "./link-candidates";

/** Internal Phase 0 read contract; caller owns sorted basename/alias indices. */
export interface LinkResolutionProvider<T> {
  getFileByPath(path: string): T | null;
  byBasename: ReadonlyMap<string, readonly string[]>;
  byAlias: ReadonlyMap<string, readonly string[]>;
}

/** Desktop compatibility resolution; ambiguity and subpath checks are deferred. */
export function resolveFirstLinkpathDest<T>(
  linkpath: string,
  sourcePath: string,
  provider: LinkResolutionProvider<T>,
): T | null {
  const target = linkpath.split("#")[0].split("^")[0].trim();
  const { candidates } = selectLinkCandidates(target, sourcePath, provider, "desktop-compatibility");
  return candidates.length ? provider.getFileByPath(candidates[0]) : null;
}
