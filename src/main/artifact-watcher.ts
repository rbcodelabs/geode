import * as path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

export interface ArtifactWatcher {
  ready: Promise<void>;
  close(): Promise<void>;
}

export function createArtifactWatcher(root: string, onChange: (eventPath: string) => void): ArtifactWatcher {
  const watcher: FSWatcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (candidate) => path.relative(root, candidate).split(path.sep)[0] === "captures",
  });
  watcher.on("all", (_event, eventPath) => onChange(eventPath));
  return {
    ready: new Promise<void>((resolve) => watcher.once("ready", () => resolve())),
    close: () => watcher.close(),
  };
}
