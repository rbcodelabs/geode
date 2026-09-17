import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseMetadata } from "./metadata";
import { normalizeWikiPath } from "./link-candidates";
import {
  captureLocalWikiFolder,
  nodeWikiFileSystem,
  type CaptureError,
  type OpenSnapshotOptions,
  type WikiFileSystem,
} from "./local-filesystem";
import { createWikiSnapshot, type CapturedFile, type CaptureInfo, type SnapshotLimits, type WikiSnapshot } from "./snapshot";
import type { WikiChangeEvent, WikiEventSink, WikiIndexSink } from "./contracts";

/**
 * A local folder provider with validated writes.
 *
 * `openLocalWikiSnapshot` reads a folder into a frozen, detached, point-in-time
 * view. This builds on that and adds create/update/delete, keeping the same
 * read semantics: after every applied write the in-memory view is rebuilt with
 * `createWikiSnapshot`, so resolution, search and backlinks come from one
 * implementation rather than a second write-side fork.
 *
 * Boundary, stated plainly and repeated in the docs: portable Node pathname
 * APIs are not an OS sandbox against a hostile *process*. This validates paths,
 * refuses to follow symlinks, and re-verifies containment immediately before
 * each operation, which defends a trusted folder against malformed input and
 * ordinary races. It does not defend against an adversary racing the
 * filesystem with equal privilege.
 */

/** The write half of the adapter seam; the read half is `WikiFileSystem`. */
export interface WikiWriteFileSystem extends WikiFileSystem {
  /** Create one directory. Must reject when the path already exists. */
  mkdir(path: string): Promise<void>;
  /** Create a new regular file. Must fail if anything already exists at `path`, and must not follow a final symlink. */
  createFile(path: string, text: string): Promise<void>;
  /** Replace an existing regular file's contents. Must not follow a final symlink, and must not create. */
  replaceFile(path: string, text: string): Promise<void>;
  /** Remove a directory entry without following it. */
  removeFile(path: string): Promise<void>;
}

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export const nodeWikiWriteFileSystem: WikiWriteFileSystem = {
  ...nodeWikiFileSystem,
  mkdir: async (path) => { await mkdir(path); },
  // O_EXCL makes "does it already exist?" one atomic question rather than a
  // check followed by a racy write. O_NOFOLLOW means a symlink planted at the
  // target is an error, never a write through to its destination.
  createFile: async (path, text) => {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW);
    try { await handle.writeFile(text, "utf8"); } finally { await handle.close(); }
  },
  // Write a sibling temp file, then rename over the target.
  //
  // Truncating in place is what a naive implementation does, and it loses data:
  // O_TRUNC empties the note *before* the write, so a failure partway through
  // (ENOSPC, EIO) leaves a truncated or half-written note on disk while the
  // caller still holds a view asserting the old content. `rename` within a
  // directory is atomic, so a reader sees either the old note or the new one.
  //
  // `rename` would happily create the target, which would let an update
  // resurrect a note deleted from under it — so the target is checked first and
  // must still be a regular, non-symlink file. That check is not a substitute
  // for O_NOFOLLOW (rename replaces a symlink rather than following it, which
  // is the behaviour we want) but it does preserve the no-resurrect contract.
  replaceFile: async (path, text) => {
    const target = await lstat(path);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw Object.assign(new Error("not a regular file"), { code: "ELOOP" });
    }
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW);
      try {
        await handle.writeFile(text, "utf8");
        // Durable before the rename, so a crash cannot publish a short file.
        await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => { /* nothing to clean up */ });
      throw error;
    }
  },
  removeFile: async (path) => { await unlink(path); },
};

export type WriteStatus =
  /** Applied. */
  | "ok"
  /** Not a portable vault-relative path: absolute, drive-qualified, escaping, backslashed or NUL-bearing. */
  | "invalid-path"
  /** Writes in this increment are notes only. */
  | "not-a-note"
  /** `create` found something already at that path. */
  | "already-exists"
  /** `update`/`delete` found no note at that path. */
  | "absent"
  /** A different path already occupies the same NFC-lowercased identity. */
  | "portability-collision"
  /** Containment, symlink or identity re-verification failed at write time. */
  | "path-changed"
  /** Would exceed the configured per-note or total byte limits. */
  | "note-byte-limit"
  /** The folder already holds the configured maximum number of entries. */
  | "entry-limit"
  /**
   * The capture was incomplete (entry, depth or visited-entry limits), so
   * "this note does not exist" cannot be distinguished from "this note was
   * never seen". Refusing beats guessing.
   */
  | "capture-incomplete"
  /** The filesystem refused the operation. */
  | "write-failed";

export interface WriteResult {
  readonly status: WriteStatus;
  readonly path?: string;
}

export interface OpenProviderOptions extends OpenSnapshotOptions {
  filesystem?: WikiWriteFileSystem;
  index?: WikiIndexSink;
  events?: WikiEventSink;
}

export interface LocalWikiProvider {
  /** The current view. A new frozen snapshot is produced after each applied write. */
  snapshot(): WikiSnapshot;
  create(path: string, text: string): Promise<WriteResult>;
  update(path: string, text: string): Promise<WriteResult>;
  delete(path: string): Promise<WriteResult>;
  /**
   * Re-read the whole folder from disk, discarding the in-memory view.
   *
   * Fails with `root-changed` if the root now resolves to a different
   * directory than the one this provider was opened against — that is a
   * different vault, and every write is anchored to the original root.
   */
  refresh(): Promise<{ status: "ok" } | { status: "error"; error: RefreshError }>;
}

export type OpenProviderResult =
  | { status: "ok"; provider: LocalWikiProvider }
  | { status: "error"; error: CaptureError };

/** Capture failures, plus the one failure only a re-capture can have. */
export type RefreshError = CaptureError | { code: "root-changed" };

const isNote = (path: string): boolean => /\.md$/i.test(path);
const identityKey = (path: string): string => path.normalize("NFC").toLowerCase();

export async function openLocalWikiProvider(
  rootPath: string,
  options: OpenProviderOptions = {},
): Promise<OpenProviderResult> {
  const fs = options.filesystem ?? nodeWikiWriteFileSystem;
  const capture = await captureLocalWikiFolder(rootPath, { ...options, filesystem: fs });
  if (capture.status === "error") return capture;

  const root = capture.root;
  // Pinned so `verifyParent` can tell "same directory" from "same path".
  const capturedRootStat = await fs.lstat(root).catch(() => null);
  if (!capturedRootStat) return { status: "error", error: { code: "root-unavailable" } };
  let rootStat: Stats = capturedRootStat;
  let limits: SnapshotLimits = capture.limits;
  let info: CaptureInfo = capture.info;
  let captured: CapturedFile[] = capture.captured;
  let view: WikiSnapshot = createWikiSnapshot(captured, info);

  const index = options.index;
  const events = options.events;

  /** Rebuild the frozen view, then tell the adapter what happened. */
  const commit = (event: WikiChangeEvent): void => {
    view = createWikiSnapshot(captured, info);
    if (index) {
      if (event.type === "deleted") index.remove(event.path);
      else {
        const entry = captured.find((file) => file.path === event.path);
        if (entry?.text !== undefined) index.upsert(event.path, { text: entry.text, metadata: parseMetadata(entry.text) });
      }
    }
    // A throwing subscriber must not roll back a write that already happened
    // on disk, nor leave the view stale. Both are already committed above.
    try { events?.emit(event); } catch { /* subscriber's problem, not the vault's */ }
  };

  /**
   * Re-verify the route to `path` immediately before touching it: the root is
   * still the *same* directory (by device and inode, not merely by name), no
   * intermediate component became a symlink or a non-directory, the parent
   * still canonically resolves to itself, and — when the target is expected to
   * exist — it is still a regular, non-symlink file.
   *
   * What this deliberately does NOT do: pin the target note's content identity
   * across capture. A note edited outside this process between capture and
   * `update` is overwritten, last-writer-wins. Callers that need to see such an
   * edit must `refresh()` first. Doing better means threading per-file `Stats`
   * through the capture API, which is a design change rather than a hardening,
   * and is recorded as follow-up rather than half-done here.
   */
  type ParentCheck = true | false | "target-missing";
  const verifyParent = async (path: string, expectTarget: boolean): Promise<ParentCheck> => {
    const components = path.split("/");
    let absolute = root;
    try {
      const currentRoot = await fs.lstat(root);
      // Name equality is not enough: the root can be removed and recreated at
      // the same path, which would leave every subsequent check passing against
      // a directory this provider never captured.
      if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink()) return false;
      if (currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino) return false;
      for (let i = 0; i < components.length - 1; i += 1) {
        absolute = join(absolute, components[i]);
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      }
      // The parent's canonical path must still be the parent we walked to. A
      // resolved path that differs means something swapped underneath us.
      if ((await fs.realpath(absolute)) !== absolute) return false;
      if (!expectTarget) return true;
      // For update/delete the final component matters too: a symlink or a
      // directory planted where a note used to be must not be followed.
      //
      // A target that is simply *gone* is not a containment failure — it is an
      // ordinary "someone deleted it" race, which the operations report as
      // `absent` and converge on. Only a target that exists as the wrong kind
      // of thing is a `path-changed` refusal.
      let target: Stats;
      try { target = await fs.lstat(join(absolute, components[components.length - 1])); }
      catch { return "target-missing"; }
      return target.isFile() && !target.isSymbolicLink();
    } catch { return false; }
  };

  /** Create missing intermediate directories, validating each as we go. */
  const ensureParent = async (path: string): Promise<boolean> => {
    const components = path.split("/");
    let absolute = root;
    for (let i = 0; i < components.length - 1; i += 1) {
      absolute = join(absolute, components[i]);
      try {
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      } catch {
        try { await fs.mkdir(absolute); } catch { return false; }
      }
    }
    return true;
  };

  const validate = (path: string): WriteStatus | null => {
    // `find`, `collidesWith` and the byte accounting all trust `captured`. If
    // discovery was cut short by a limit, that trust is misplaced: an existing
    // note can look absent and a real collision can look free. `create` is
    // still protected by O_EXCL, but update/delete would report `absent` for
    // notes that exist, so refuse every write rather than answer from a view
    // known to be partial.
    if (!info.discoveryComplete) return "capture-incomplete";
    if (normalizeWikiPath(path) !== path) return "invalid-path";
    // The capture walk skips dot-prefixed names and `node_modules`
    // (see `local-filesystem.ts`, and `exclusionPolicy` on the snapshot).
    // Writing to a path the walk will never pick up produces a note that shows
    // in the view until the next refresh and is unreachable forever after —
    // the write validator has to agree with the capture policy, or "a path the
    // engine will not resolve is also a path it will not write" is not true.
    const segments = path.split("/");
    if (segments.some((segment) => segment.startsWith(".") || segment === "node_modules")) return "invalid-path";
    if (!isNote(path)) return "not-a-note";
    return null;
  };

  const withinByteLimits = (text: string, replacingPath?: string): boolean => {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > limits.maxNoteBytes) return false;
    const existing = captured.reduce(
      (total, file) => total + (file.path === replacingPath ? 0 : Buffer.byteLength(file.text ?? "", "utf8")),
      0,
    );
    return existing + bytes <= limits.maxTotalNoteBytes;
  };

  /**
   * A different stored path that folds onto the same identity. macOS and
   * Windows would treat the two as one file; refusing the write keeps a vault
   * portable rather than letting it become unopenable elsewhere.
   */
  const collidesWith = (path: string): boolean => {
    const key = identityKey(path);
    return captured.some((file) => file.path !== path && identityKey(file.path) === key);
  };

  const find = (path: string): CapturedFile | undefined => captured.find((file) => file.path === path);

  return {
    status: "ok",
    provider: {
      snapshot: () => view,

      async create(path, text) {
        const invalid = validate(path);
        if (invalid) return { status: invalid };
        if (find(path)) return { status: "already-exists", path };
        if (collidesWith(path)) return { status: "portability-collision", path };
        if (!withinByteLimits(text)) return { status: "note-byte-limit", path };
        if (captured.length >= limits.maxEntries) return { status: "entry-limit", path };
        if (!(await ensureParent(path))) return { status: "path-changed", path };
        if (!(await verifyParent(path, false))) return { status: "path-changed", path };
        try { await fs.createFile(join(root, path), text); }
        catch (error) {
          // O_EXCL turning up an existing entry is a real answer, not a failure.
          return { status: (error as NodeJS.ErrnoException)?.code === "EEXIST" ? "already-exists" : "write-failed", path };
        }
        captured = [...captured, { path, kind: "note", text }];
        commit({ type: "created", path });
        return { status: "ok", path };
      },

      async update(path, text) {
        const invalid = validate(path);
        if (invalid) return { status: invalid };
        const existing = find(path);
        if (!existing) return { status: "absent", path };
        if (!withinByteLimits(text, path)) return { status: "note-byte-limit", path };
        const updateRoute = await verifyParent(path, true);
        if (updateRoute === "target-missing") return { status: "absent", path };
        if (!updateRoute) return { status: "path-changed", path };
        try { await fs.replaceFile(join(root, path), text); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") return { status: "absent", path };
          // ELOOP is the kernel refusing O_NOFOLLOW on a symlink that appeared
          // where a regular note used to be.
          return { status: code === "ELOOP" ? "path-changed" : "write-failed", path };
        }
        captured = captured.map((file) => (file.path === path ? { ...file, text } : file));
        commit({ type: "updated", path });
        return { status: "ok", path };
      },

      async delete(path) {
        const invalid = validate(path);
        if (invalid) return { status: invalid };
        if (!find(path)) return { status: "absent", path };
        const deleteRoute = await verifyParent(path, true);
        if (deleteRoute === "target-missing") {
          // Already gone on disk. Converge the view rather than insisting.
          captured = captured.filter((file) => file.path !== path);
          commit({ type: "deleted", path });
          return { status: "absent", path };
        }
        if (!deleteRoute) return { status: "path-changed", path };
        try { await fs.removeFile(join(root, path)); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT") {
            // Already gone on disk. Converge the view rather than insisting.
            captured = captured.filter((file) => file.path !== path);
            commit({ type: "deleted", path });
            return { status: "absent", path };
          }
          return { status: "write-failed", path };
        }
        captured = captured.filter((file) => file.path !== path);
        commit({ type: "deleted", path });
        return { status: "ok", path };
      },

      async refresh() {
        const next = await captureLocalWikiFolder(rootPath, { ...options, filesystem: fs });
        if (next.status === "error") return next;
        // If `rootPath` now canonicalises somewhere else — a symlinked root
        // retargeted, a mount moved — this is a different vault, not a newer
        // view of the same one. Adopting it silently would leave the provider
        // reading one folder and writing to another, because every write is
        // anchored to the root captured at open. Refuse instead.
        if (next.root !== root) return { status: "error" as const, error: { code: "root-changed" as const } };
        const currentRoot = await fs.lstat(next.root).catch(() => null);
        if (!currentRoot || currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino) {
          return { status: "error" as const, error: { code: "root-changed" as const } };
        }
        rootStat = currentRoot;
        limits = next.limits;
        captured = next.captured;
        info = next.info;
        view = createWikiSnapshot(captured, info);
        return { status: "ok" as const };
      },
    },
  };
}
