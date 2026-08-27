import { describe, expect, it, vi } from "vitest";
import { isIgnoredSegment, isIgnoredVaultPath } from "../../src/main/vault-ignore";
import {
  DEFAULT_STABILITY_THRESHOLD_MS,
  VaultPathMirror,
  startVaultWatcher,
  synthesizeVaultEvents,
  toVaultRelative,
  type VaultPathKind,
  type VaultWatchEventName,
  type VaultWatcherDependencies,
  type VaultWatcherSeedEntry,
} from "../../src/main/vault-watcher";

const ROOT = "/vault";

function seed(...paths: string[]): VaultWatcherSeedEntry[] {
  return paths.map((entry) => entry.endsWith("/")
    ? { path: entry.slice(0, -1), isFolder: true }
    : { path: entry, isFolder: false });
}

function mirrorWith(...paths: string[]): VaultPathMirror {
  return new VaultPathMirror(seed(...paths));
}

/** `[event, path]` pairs — terser to assert against than objects. */
function pairs(emissions: Array<{ event: string; path: string }>): Array<[string, string]> {
  return emissions.map(({ event, path }) => [event, path]);
}

/**
 * A watcher wired to an in-memory filesystem: no real `fs.watch` latency, so
 * debounce and event-ordering assertions are deterministic.
 */
function harness(options: {
  seed?: VaultWatcherSeedEntry[];
  tree?: Record<string, VaultPathKind>;
  recursiveWatchThrows?: boolean;
} = {}) {
  const tree = new Map<string, VaultPathKind>(Object.entries(options.tree ?? {}));
  const emitted: Array<[VaultWatchEventName, string]> = [];
  const warnings: string[] = [];
  let deliver: ((relativePath: string | null) => void) | null = null;
  let failWatch: ((error: unknown) => void) | null = null;
  let nativeClosed = false;
  let fallbackClosed = false;
  let fallbackEmit: ((event: VaultWatchEventName, relativePath: string) => void) | null = null;

  const relativeOf = (absolutePath: string) =>
    absolutePath === ROOT ? "" : absolutePath.slice(ROOT.length + 1);

  const dependencies: VaultWatcherDependencies = {
    watchRecursive(_root, onEvent, onError) {
      if (options.recursiveWatchThrows) throw new Error("recursive watch unsupported");
      deliver = onEvent;
      failWatch = onError;
      return { close: () => { nativeClosed = true; } };
    },
    async statPath(absolutePath) {
      return tree.get(relativeOf(absolutePath)) ?? "missing";
    },
    async readFolder(absolutePath) {
      const prefix = relativeOf(absolutePath);
      const children: Array<{ name: string; kind: VaultPathKind }> = [];
      for (const [entryPath, kind] of tree) {
        if (!prefix ? entryPath.includes("/") : !entryPath.startsWith(`${prefix}/`)) continue;
        const remainder = prefix ? entryPath.slice(prefix.length + 1) : entryPath;
        if (remainder.includes("/")) continue;
        children.push({ name: remainder, kind });
      }
      return children;
    },
    startFallback(_root, _threshold, emit) {
      fallbackEmit = emit;
      return { close: () => { fallbackClosed = true; } };
    },
    logger: {
      warn: (message: string) => { warnings.push(message); },
      error: (message: string) => { warnings.push(message); },
    },
  };

  const watcher = startVaultWatcher({
    root: ROOT,
    seed: options.seed ?? [],
    emit: (event, relativePath) => { emitted.push([event, relativePath]); },
    dependencies,
  });

  return {
    watcher,
    emitted,
    warnings,
    tree,
    fire: (relativePath: string | null) => deliver?.(relativePath),
    failWatch: (error: unknown) => failWatch?.(error),
    fallbackEmit: (event: VaultWatchEventName, relativePath: string) => fallbackEmit?.(event, relativePath),
    get nativeClosed() { return nativeClosed; },
    get fallbackClosed() { return fallbackClosed; },
    /** Advance past the debounce window and drain the resulting work. */
    settle: async () => {
      await vi.advanceTimersByTimeAsync(DEFAULT_STABILITY_THRESHOLD_MS);
      await watcher.idle();
    },
  };
}

describe("vault ignore predicate", () => {
  it("ignores a dot-prefixed segment anywhere in the path, not just the basename", () => {
    expect(isIgnoredVaultPath("Notes/note.md")).toBe(false);
    expect(isIgnoredVaultPath(".hidden.md")).toBe(true);
    expect(isIgnoredVaultPath("Notes/.hidden.md")).toBe(true);
    expect(isIgnoredVaultPath(".geode/plugins/thing/main.js")).toBe(true);
    expect(isIgnoredVaultPath("Notes/.trash/old.md")).toBe(true);
  });

  it("ignores the indexer's own cache file, whose basename is not dotted", () => {
    // The debounced writer in src/indexer/indexer-process.ts rewrites this on
    // every metadata change. Watching it would loop: write -> event ->
    // reindex -> write.
    expect(isIgnoredVaultPath(".geode/metadata-cache/cache.json")).toBe(true);
    // The basename-only rule this replaced would have let it through.
    expect(isIgnoredSegment("cache.json")).toBe(false);
  });

  it("treats the vault root as visible and tolerates both separators", () => {
    expect(isIgnoredVaultPath("")).toBe(false);
    expect(isIgnoredVaultPath(".geode\\metadata-cache\\cache.json")).toBe(true);
  });

  it("does not ignore names that merely contain a dot", () => {
    expect(isIgnoredVaultPath("Notes/my.note.md")).toBe(false);
    expect(isIgnoredVaultPath("v1.2/release.md")).toBe(false);
  });
});

describe("toVaultRelative", () => {
  it("strips stray separators and leaves ordinary paths alone", () => {
    expect(toVaultRelative("Notes/a.md")).toBe("Notes/a.md");
    expect(toVaultRelative("/Notes/a.md/")).toBe("Notes/a.md");
    expect(toVaultRelative("")).toBe("");
  });
});

describe("synthesizeVaultEvents", () => {
  it("emits create for an unknown file and modify for a known one", () => {
    const mirror = mirrorWith("Known.md");
    expect(pairs(synthesizeVaultEvents(mirror, "New.md", "file"))).toEqual([["create", "New.md"]]);
    // Now known: a second event on the same path is a modify.
    expect(pairs(synthesizeVaultEvents(mirror, "New.md", "file"))).toEqual([["modify", "New.md"]]);
    expect(pairs(synthesizeVaultEvents(mirror, "Known.md", "file"))).toEqual([["modify", "Known.md"]]);
  });

  it("never emits modify for a path the renderer does not know", () => {
    // src/renderer/vault.ts drops a modify for an unknown path outright, so
    // the file would never enter the tree.
    const mirror = mirrorWith();
    const emissions = synthesizeVaultEvents(mirror, "Folder/New.md", "file");
    expect(emissions.some((emission) => emission.event === "modify")).toBe(false);
    expect(pairs(emissions)).toEqual([
      ["create-folder", "Folder"],
      ["create", "Folder/New.md"],
    ]);
  });

  it("announces unknown ancestor folders before the file inside them", () => {
    const mirror = mirrorWith("a/");
    expect(pairs(synthesizeVaultEvents(mirror, "a/b/c/note.md", "file"))).toEqual([
      ["create-folder", "a/b"],
      ["create-folder", "a/b/c"],
      ["create", "a/b/c/note.md"],
    ]);
  });

  it("emits create-folder for an unknown folder and nothing for a known one", () => {
    const mirror = mirrorWith();
    expect(pairs(synthesizeVaultEvents(mirror, "Folder", "folder"))).toEqual([
      ["create-folder", "Folder"],
    ]);
    expect(synthesizeVaultEvents(mirror, "Folder", "folder")).toEqual([]);
  });

  it("emits delete for a vanished known file", () => {
    const mirror = mirrorWith("Known.md");
    expect(pairs(synthesizeVaultEvents(mirror, "Known.md", "missing"))).toEqual([
      ["delete", "Known.md"],
    ]);
    // Second delete of the same path is dropped, not repeated.
    expect(synthesizeVaultEvents(mirror, "Known.md", "missing")).toEqual([]);
  });

  it("drops an event for a path that vanished and was never known", () => {
    expect(synthesizeVaultEvents(mirrorWith(), "Ghost.md", "missing")).toEqual([]);
  });

  it("drops sockets, fifos and anything else that is neither file nor folder", () => {
    expect(synthesizeVaultEvents(mirrorWith(), "weird.sock", "other")).toEqual([]);
  });

  it("ignores dot-segment paths in every stat state", () => {
    const mirror = mirrorWith(".geode/metadata-cache/cache.json");
    for (const kind of ["file", "folder", "missing", "other"] as VaultPathKind[]) {
      expect(synthesizeVaultEvents(mirror, ".geode/metadata-cache/cache.json", kind)).toEqual([]);
    }
  });

  it("cascades a folder delete to every known descendant, deepest first", () => {
    // src/renderer/vault.ts does not cascade; it only removes the folder it
    // is told about. Without this the descendants stay in the tree forever.
    const mirror = mirrorWith(
      "Projects/",
      "Projects/note.md",
      "Projects/Sub/",
      "Projects/Sub/deep.md",
      "Projects/Sub/Deeper/",
      "Projects/Sub/Deeper/deepest.md",
      "Unrelated/",
      "Unrelated/keep.md",
    );

    expect(pairs(synthesizeVaultEvents(mirror, "Projects", "missing"))).toEqual([
      ["delete", "Projects/Sub/Deeper/deepest.md"],
      ["delete", "Projects/Sub/deep.md"],
      ["delete", "Projects/note.md"],
      ["delete-folder", "Projects/Sub/Deeper"],
      ["delete-folder", "Projects/Sub"],
      ["delete-folder", "Projects"],
    ]);
    // A sibling subtree is untouched.
    expect(mirror.hasFile("Unrelated/keep.md")).toBe(true);
    expect(mirror.hasFolder("Unrelated")).toBe(true);
    expect(mirror.hasFolder("Projects")).toBe(false);
  });

  it("does not cascade across a name prefix that is not a folder boundary", () => {
    const mirror = mirrorWith("Notes/", "Notes/a.md", "NotesArchive/", "NotesArchive/b.md");
    expect(pairs(synthesizeVaultEvents(mirror, "Notes", "missing"))).toEqual([
      ["delete", "Notes/a.md"],
      ["delete-folder", "Notes"],
    ]);
    expect(mirror.hasFile("NotesArchive/b.md")).toBe(true);
  });

  it("replaces a folder with a file of the same name without leaving both", () => {
    const mirror = mirrorWith("Thing/", "Thing/inner.md");
    expect(pairs(synthesizeVaultEvents(mirror, "Thing", "file"))).toEqual([
      ["delete", "Thing/inner.md"],
      ["delete-folder", "Thing"],
      ["create", "Thing"],
    ]);
    expect(mirror.hasFolder("Thing")).toBe(false);
    expect(mirror.hasFile("Thing")).toBe(true);
  });

  it("replaces a file with a folder of the same name without leaving both", () => {
    const mirror = mirrorWith("Thing");
    expect(pairs(synthesizeVaultEvents(mirror, "Thing", "folder"))).toEqual([
      ["delete", "Thing"],
      ["create-folder", "Thing"],
    ]);
    expect(mirror.hasFile("Thing")).toBe(false);
  });
});

describe("startVaultWatcher", () => {
  it("coalesces a burst of events on one path into a single emission", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ seed: seed("Note.md"), tree: { "Note.md": "file" } });
      for (let i = 0; i < 5; i++) {
        h.fire("Note.md");
        await vi.advanceTimersByTimeAsync(50);
      }
      // Still inside the stability window: nothing emitted yet.
      expect(h.emitted).toEqual([]);
      await h.settle();
      expect(h.emitted).toEqual([["modify", "Note.md"]]);
      await h.watcher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounces each path independently", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        seed: seed("A.md", "B.md"),
        tree: { "A.md": "file", "B.md": "file" },
      });
      h.fire("A.md");
      h.fire("B.md");
      await h.settle();
      expect(h.emitted).toEqual([["modify", "A.md"], ["modify", "B.md"]]);
      await h.watcher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("collapses a delete-then-recreate write into a single modify", async () => {
    // Atomic saves (write temp file, rename over the original) produce two
    // raw events; emitting a delete the renderer then has to undo is worse
    // than reporting the net effect.
    vi.useFakeTimers();
    try {
      const h = harness({ seed: seed("Note.md"), tree: {} });
      h.fire("Note.md");
      await vi.advanceTimersByTimeAsync(100);
      h.tree.set("Note.md", "file");
      h.fire("Note.md");
      await h.settle();
      expect(h.emitted).toEqual([["modify", "Note.md"]]);
      await h.watcher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a rename as a delete of the old path and a create of the new one", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ seed: seed("Old.md"), tree: { "New.md": "file" } });
      h.fire("Old.md");
      h.fire("New.md");
      await h.settle();
      expect(h.emitted).toEqual([["delete", "Old.md"], ["create", "New.md"]]);
      await h.watcher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discovers the contents of a folder that appears whole", async () => {
    // FSEvents can coalesce a moved-in directory into a single event for the
    // directory itself, so its contents have to be walked by hand.
    vi.useFakeTimers();
    try {
      const h = harness({
        seed: [],
        tree: {
          Moved: "folder",
          "Moved/a.md": "file",
          "Moved/Inner": "folder",
          "Moved/Inner/b.md": "file",
          "Moved/.hidden": "folder",
          "Moved/.hidden/c.md": "file",
        },
      });
      h.fire("Moved");
      await h.settle();
      expect(h.emitted).toEqual([
        ["create-folder", "Moved"],
        ["create", "Moved/a.md"],
        ["create-folder", "Moved/Inner"],
        ["create", "Moved/Inner/b.md"],
      ]);
      await h.watcher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-announce a known subtree when discovering a folder", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        seed: seed("Existing/note.md"),
        tree: { Existing: "folder", "Existing/note.md": "file", "Existing/new.md": "file" },
      });
      h.fire("Existing");
      await h.settle();
      expect(h.emitted).toEqual([
        ["create-folder", "Existing"],
        ["create", "Existing/new.md"],
      ]);
      await h.watcher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never schedules work for an ignored path", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        seed: [],
        tree: { ".geode/metadata-cache/cache.json": "file", ".obsidian/workspace.json": "file" },
      });
      h.fire(".geode/metadata-cache/cache.json");
      h.fire(".obsidian/workspace.json");
      await h.settle();
      expect(h.emitted).toEqual([]);
      await h.watcher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cascades a folder removal through to emitted events", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        seed: seed("Projects/", "Projects/a.md", "Projects/Sub/", "Projects/Sub/b.md"),
        tree: {},
      });
      h.fire("Projects");
      await h.settle();
      expect(h.emitted).toEqual([
        ["delete", "Projects/Sub/b.md"],
        ["delete", "Projects/a.md"],
        ["delete-folder", "Projects/Sub"],
        ["delete-folder", "Projects"],
      ]);
      await h.watcher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits nothing after close, and closes the underlying watch", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ seed: seed("Note.md"), tree: { "Note.md": "file" } });
      h.fire("Note.md");
      await h.watcher.close();
      expect(h.nativeClosed).toBe(true);
      await vi.advanceTimersByTimeAsync(DEFAULT_STABILITY_THRESHOLD_MS * 2);
      expect(h.emitted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a path-less overflow event instead of throwing", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ seed: [], tree: {} });
      h.fire(null);
      await h.settle();
      expect(h.emitted).toEqual([]);
      expect(h.warnings.join(" ")).toContain("no path");
      await h.watcher.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to chokidar when a recursive watch is unsupported", async () => {
    const h = harness({ recursiveWatchThrows: true, seed: [], tree: {} });
    expect(h.watcher.backend).toBe("chokidar");
    expect(h.warnings.join(" ")).toContain("Recursive vault watch unavailable");
    h.fallbackEmit("create", "Note.md");
    expect(h.emitted).toEqual([["create", "Note.md"]]);
    await h.watcher.close();
    expect(h.fallbackClosed).toBe(true);
  });

  it("falls back to chokidar when the recursive watch fails after starting", async () => {
    const h = harness({ seed: [], tree: {} });
    expect(h.watcher.backend).toBe("native-recursive");
    h.failWatch(new Error("EPERM"));
    expect(h.watcher.backend).toBe("chokidar");
    h.fallbackEmit("modify", "Note.md");
    expect(h.emitted).toEqual([["modify", "Note.md"]]);
    await h.watcher.close();
  });
});
