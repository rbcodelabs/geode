export function fixture(source: string) {
  const owner = { path: "Notes/Owner.md", extension: "md" };
  const image = { path: "Pictures/Photo.png", extension: "png" };
  const other = { path: "Pictures/Other.jpg", extension: "jpg" };
  const vault = {};
  let currentVault = vault;
  let root = "/synthetic";
  let snapshot = {};
  const capturedSnapshot = snapshot;
  const indexed = new Map([owner, image, other].map(file => [file.path, file]));
  const context = {
    source, owner, vault, root, snapshot: capturedSnapshot,
    currentSnapshot: () => snapshot,
    currentVault: () => currentVault,
    currentRoot: () => root,
    fileByPath: (path: string) => indexed.get(path) ?? null,
    resolve: (target: string) => {
      const path = target.split("#")[0];
      return [...indexed.values()].find(file => file.path === path || file.path.split("/").at(-1) === path) ?? null;
    },
  };
  return { context, owner, image, other, indexed, changeVault: () => { currentVault = {}; }, changeRoot: () => { root = "/other"; }, changeSnapshot: () => { snapshot = {}; } };
}

