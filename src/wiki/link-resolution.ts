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
    let target = linkpath.split("#")[0].split("^")[0].trim();
    if (!target) {
      return provider.getFileByPath(sourcePath); // [[#Heading]] self-link
    }
    // Exact path (with and without .md)
    const direct =
      provider.getFileByPath(target) ?? provider.getFileByPath(target + ".md");
    if (direct) return direct;
    // Relative to source folder
    const srcParent = sourcePath.includes("/")
      ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
      : "";
    if (srcParent) {
      const rel =
        provider.getFileByPath(`${srcParent}/${target}`) ??
        provider.getFileByPath(`${srcParent}/${target}.md`);
      if (rel) return rel;
    }
    // Basename match: shortest path wins
    const candidates = provider.byBasename.get(target.toLowerCase());
    if (candidates?.length) {
      const sorted = [...candidates].sort((a, b) => a.length - b.length);
      return provider.getFileByPath(sorted[0]);
    }
    const aliasMatch = provider.byAlias.get(target.toLowerCase());
    if (aliasMatch?.length) return provider.getFileByPath(aliasMatch[0]);
    return null;
}
