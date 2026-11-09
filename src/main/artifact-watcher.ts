import * as path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { isReservedArtifactPath } from "../artifacts/reserved-paths";
import { isReservedOnDisk } from "./artifact-reserved-dir";

export interface ArtifactWatcher {
  ready: Promise<void>;
  close(): Promise<void>;
}

function underRootAsPosix(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join("/");
}

/**
 * Watches a static artifact root and calls `onChange` for changes that should reload the page.
 * `root` must be the realpath of the artifact root.
 *
 * Ignored: `captures/` (host screenshots) and the reserved `.threads-design/` directory (host sidecar
 * writes must not reload the page, ADR 0006 D7). chokidar follows symlinks, so an alias inside the
 * artifact that points into the reserved directory would still emit events under the alias name; those
 * are re-checked by realpath at event time. Residual: deleting such an alias cannot be resolved any more
 * and causes one harmless extra reload; a hard link into the directory is not detected.
 */
export function createArtifactWatcher(root: string, onChange: (eventPath: string) => void): ArtifactWatcher {
  const watcher: FSWatcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (candidate) => {
      const relative = underRootAsPosix(root, candidate);
      return relative.split("/")[0] === "captures" || isReservedArtifactPath(relative);
    },
  });
  watcher.on("all", (_event, eventPath) => {
    void isReservedOnDisk(root, eventPath)
      .catch(() => false) // when in doubt, reload: a spurious reload is harmless, a missed one is not
      .then((reserved) => {
        if (!reserved) onChange(eventPath);
      });
  });
  return {
    ready: new Promise<void>((resolve) => watcher.once("ready", () => resolve())),
    close: () => watcher.close(),
  };
}
