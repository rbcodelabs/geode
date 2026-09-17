import { constants } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
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
  // No O_CREAT: update must not resurrect a note deleted from under it.
  replaceFile: async (path, text) => {
    const handle = await open(path, constants.O_WRONLY | constants.O_TRUNC | NOFOLLOW);
    try { await handle.writeFile(text, "utf8"); } finally { await handle.close(); }
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
  /** Would exceed the configured note or total byte limits. */
  | "note-byte-limit"
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
  /** Re-read the whole folder from disk, discarding the in-memory view. */
  refresh(): Promise<{ status: "ok" } | { status: "error"; error: CaptureError }>;
}

export type OpenProviderResult =
  | { status: "ok"; provider: LocalWikiProvider }
  | { status: "error"; error: CaptureError };

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
  const limits: SnapshotLimits = capture.limits;
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
   * Re-verify every component of `path` immediately before touching it: the
   * root is still the same directory, no component became a symlink, and the
   * final component's parent is still inside the root. Mirrors the read side's
   * `checkedComponents`.
   */
  const verifyParent = async (path: string): Promise<boolean> => {
    const components = path.split("/");
    let absolute = root;
    try {
      const rootStat = await fs.lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
      for (let i = 0; i < components.length - 1; i += 1) {
        absolute = join(absolute, components[i]);
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      }
      // The parent's canonical path must still be the parent we walked to. A
      // resolved path that differs means something swapped underneath us.
      return (await fs.realpath(absolute)) === absolute;
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
    if (normalizeWikiPath(path) !== path) return "invalid-path";
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
        if (captured.length >= limits.maxEntries) return { status: "note-byte-limit", path };
        if (!(await ensureParent(path))) return { status: "path-changed", path };
        if (!(await verifyParent(path))) return { status: "path-changed", path };
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
        if (!(await verifyParent(path))) return { status: "path-changed", path };
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
        if (!(await verifyParent(path))) return { status: "path-changed", path };
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
        captured = next.captured;
        info = next.info;
        view = createWikiSnapshot(captured, info);
        return { status: "ok" };
      },
    },
  };
}
