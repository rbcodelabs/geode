import * as fs from "node:fs/promises";
import { constants as fsConstants, type Dir } from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  normalizeResourceRelativePath,
  normalizeRootRelativeBase,
  type ExternalRootAccessErrorCode,
  type ExternalRootDirectoryEntry,
  type ExternalRootDirectoryPage,
  type ResourceRef,
  type RootDirectoryRef,
  type RootIntegrationBindingKey,
  type RootDescriptor,
} from "../shared/root-registry";
import {
  RootRegistry,
  type AttachProjectRootResult,
  type RootPhysicalIdentity,
  type RootRecord,
  type TrustedCanonicalRootPath,
} from "./root-registry";

export const MAX_EXTERNAL_TEXT_BYTES = 2 * 1024 * 1024;
export const EXTERNAL_ROOT_PAGE_SIZE = 250;
const CURSOR_TTL_MS = 30_000;
const MAX_SESSION_CURSORS = 16;

export class ExternalRootAccessError extends Error {
  constructor(readonly code: ExternalRootAccessErrorCode, message: string) {
    super(message);
    this.name = "ExternalRootAccessError";
  }
}

export interface ExternalRootAttachmentRequest extends RootIntegrationBindingKey {
  sourceFingerprint?: string;
  label: string;
  /** Native picker starting location only; never an access grant. */
  suggestedPath?: string;
  /** Host-only contribution lifetime check; never deserialized from IPC. */
  isCurrent?: () => boolean;
}

export interface ExternalRootDirectoryPicker {
  (purpose: "attach" | "reconnect", details: { label: string; suggestedPath?: string }): Promise<string | null>;
}

export interface ExternalRootSessionOptions {
  activeVaultPath: string;
  pickDirectory: ExternalRootDirectoryPicker;
  confirmDirectory?: (details: { purpose: "attach" | "reconnect"; label: string; selectedPath: string }) => Promise<boolean>;
  isSessionCurrent?: () => boolean;
  now?: () => number;
}

export type ExternalRootSessionAttachmentResult = AttachProjectRootResult
  | { kind: "inside-vault"; relativeBase: string };

export function mapExternalRootFsError(
  error: unknown,
  scope: "root" | "target"
): ExternalRootAccessError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new ExternalRootAccessError(scope === "root" ? "root-missing" : "not-found", "Path not found");
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ExternalRootAccessError("permission-denied", "Permission denied");
  }
  if (code === "ELOOP") {
    return new ExternalRootAccessError("unavailable-link", "Symbolic link cannot be resolved");
  }
  return new ExternalRootAccessError("unavailable", "Filesystem resource is unavailable");
}

function isWithinOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** The sole production constructor for TrustedCanonicalRootPath. */
interface CanonicalDirectoryProof {
  canonicalPath: TrustedCanonicalRootPath;
  physicalIdentity: RootPhysicalIdentity;
}

async function realCanonicalDirectory(selectedPath: string): Promise<CanonicalDirectoryProof> {
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(selectedPath);
    const stat = await fs.stat(canonicalPath);
    if (!stat.isDirectory()) throw new ExternalRootAccessError("not-directory", "Selected root is not a directory");
    return {
      canonicalPath: canonicalPath as TrustedCanonicalRootPath,
      physicalIdentity: { dev: stat.dev, ino: stat.ino },
    };
  } catch (error) {
    if (error instanceof ExternalRootAccessError) throw error;
    throw mapExternalRootFsError(error, "root");
  }
}

export class ExternalRootDesktopBoundary {
  private disposed = false;
  private readonly cursors = new Map<string, {
    directoryKey: string;
    directory: Dir;
    target: CanonicalDirectoryProof;
    omittedCount: number;
    expiresAt: number;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private constructor(
    private readonly registry: RootRegistry,
    private readonly activeVaultPath: TrustedCanonicalRootPath,
    private readonly options: ExternalRootSessionOptions
  ) {}

  static async create(registry: RootRegistry, options: ExternalRootSessionOptions): Promise<ExternalRootDesktopBoundary> {
    const vault = await realCanonicalDirectory(options.activeVaultPath);
    return new ExternalRootDesktopBoundary(registry, vault.canonicalPath, options);
  }

  /** A cwd inside the already-authorized vault needs no external attachment. */
  async classifyVaultDirectory(suggestedPath: string | undefined): Promise<string | undefined> {
    this.assertCurrentSession();
    if (!suggestedPath || !path.isAbsolute(suggestedPath) || suggestedPath.includes("\0")) return undefined;
    let relative: string | undefined;
    try {
      const proof = await realCanonicalDirectory(suggestedPath);
      if (isWithinOrEqual(this.activeVaultPath, proof.canonicalPath)) {
        relative = path.relative(this.activeVaultPath, proof.canonicalPath).split(path.sep).join("/");
      }
    } catch (error) {
      if (!(error instanceof ExternalRootAccessError)) throw error;
    }
    this.assertCurrentSession();
    return relative;
  }

  /** Refresh display availability without discarding the persisted grant or its identity. */
  async probeRoot(rootId: string): Promise<RootDescriptor> {
    this.assertCurrentSession();
    const descriptor = this.registry.getRootDescriptor(rootId);
    if (!descriptor) throw new ExternalRootAccessError("root-not-found", "External root is not registered");
    if (descriptor.availability !== "connected") return descriptor;
    try {
      await this.getUsableRoot(rootId);
    } catch (error) {
      if (!(error instanceof ExternalRootAccessError)) throw error;
      descriptor.availability = error.code === "root-missing" ? "missing"
        : error.code === "permission-denied" ? "permission-revoked" : "unavailable";
    }
    this.assertCurrentSession();
    return descriptor;
  }

  async attach(request: ExternalRootAttachmentRequest): Promise<ExternalRootSessionAttachmentResult | null> {
    this.assertCurrentSession(request.isCurrent);
    const selectedPath = await this.options.pickDirectory("attach", { label: request.label, suggestedPath: request.suggestedPath });
    if (selectedPath === null) return null;
    const selectedAbsolute = path.resolve(selectedPath);
    const proof = await realCanonicalDirectory(selectedPath);
    const { canonicalPath } = proof;
    this.assertCurrentSession(request.isCurrent);
    if (isWithinOrEqual(this.activeVaultPath, canonicalPath)) {
      const relative = path.relative(this.activeVaultPath, canonicalPath).split(path.sep).join("/");
      return { kind: "inside-vault", relativeBase: relative };
    }
    if (isWithinOrEqual(canonicalPath, this.activeVaultPath)) {
      throw new ExternalRootAccessError("outside-root", "External root cannot contain the active vault");
    }
    for (const root of this.registry.listRoots()) {
      const historicalPaths = [root.locator.canonicalPath, root.locator.chosenPath].filter(
        (candidate): candidate is string => candidate !== undefined
      );
      const selectedOverlapsHistory = historicalPaths.some((historical) =>
        isWithinOrEqual(historical, selectedAbsolute) || isWithinOrEqual(selectedAbsolute, historical)
      );
      const canonicalOverlap = isWithinOrEqual(root.locator.canonicalPath, canonicalPath)
        || isWithinOrEqual(canonicalPath, root.locator.canonicalPath);
      if (selectedOverlapsHistory || canonicalOverlap) {
        await this.proveCurrentRoot(root);
      }
      if (historicalPaths.some((historical) => isWithinOrEqual(historical, selectedAbsolute))
        && !isWithinOrEqual(root.locator.canonicalPath, canonicalPath)) {
        throw new ExternalRootAccessError("outside-root", "Selected path escapes an existing root through a symbolic link");
      }
    }
    if (!this.options.confirmDirectory
      || !await this.options.confirmDirectory({ purpose: "attach", label: request.label, selectedPath: selectedAbsolute })) return null;
    this.assertCurrentSession(request.isCurrent);
    const confirmedProof = await realCanonicalDirectory(selectedPath);
    if (!samePhysicalProof(proof, confirmedProof)) {
      throw new ExternalRootAccessError("root-unavailable", "Selected root changed during attachment");
    }
    return this.registry.attachProjectRoot({
      commitGuard: () => this.assertCurrentSession(request.isCurrent),
      beforeCommit: async () => {
        const current = await realCanonicalDirectory(selectedPath);
        if (!samePhysicalProof(proof, current)) {
          throw new ExternalRootAccessError("root-unavailable", "Selected root changed before attachment committed");
        }
        for (const existing of this.registry.listRoots()) {
          if (isWithinOrEqual(existing.locator.canonicalPath, canonicalPath)
            || isWithinOrEqual(canonicalPath, existing.locator.canonicalPath)) {
            await this.proveCurrentRoot(existing);
          }
        }
        this.assertCurrentSession(request.isCurrent);
      },
      canonicalPath,
      physicalIdentity: proof.physicalIdentity,
      chosenPath: selectedAbsolute,
      integrationId: request.integrationId,
      instanceId: request.instanceId,
      projectId: request.projectId,
      label: request.label,
      sourceFingerprint: request.sourceFingerprint,
    });
  }

  async reconnect(rootId: string, isCurrent?: () => boolean): Promise<RootRecord | null> {
    this.assertCurrentSession(isCurrent);
    const root = this.registry.getRoot(rootId);
    if (!root) throw new ExternalRootAccessError("root-not-found", "External root is not registered");
    const selectedPath = await this.options.pickDirectory("reconnect", {
      label: root.label, suggestedPath: root.locator.chosenPath ?? root.locator.canonicalPath,
    });
    if (selectedPath === null) return null;
    const proof = await realCanonicalDirectory(selectedPath);
    if (isWithinOrEqual(this.activeVaultPath, proof.canonicalPath)
      || isWithinOrEqual(proof.canonicalPath, this.activeVaultPath)) {
      throw new ExternalRootAccessError("outside-root", "Reconnected root cannot overlap the active vault");
    }
    if (!this.options.confirmDirectory
      || !await this.options.confirmDirectory({ purpose: "reconnect", label: root.label, selectedPath: path.resolve(selectedPath) })) return null;
    this.assertCurrentSession(isCurrent);
    const confirmedProof = await realCanonicalDirectory(selectedPath);
    if (!samePhysicalProof(proof, confirmedProof)) {
      throw new ExternalRootAccessError("root-unavailable", "Selected root changed during reconnect");
    }
    return this.registry.reconnectRoot(rootId, {
      canonicalPath: proof.canonicalPath,
      chosenPath: path.resolve(selectedPath),
    }, proof.physicalIdentity, async () => {
      const current = await realCanonicalDirectory(selectedPath);
      if (!samePhysicalProof(proof, current)) {
        throw new ExternalRootAccessError("root-unavailable", "Selected root changed before reconnect committed");
      }
      this.assertCurrentSession(isCurrent);
    }, () => this.assertCurrentSession(isCurrent));
  }

  detachIntegration(binding: RootIntegrationBindingKey, isCurrent?: () => boolean): Promise<boolean> {
    this.assertCurrentSession(isCurrent);
    return this.registry.removeBinding(binding, () => this.assertCurrentSession(isCurrent));
  }

  /**
   * Map a host-side absolute path to a root-relative resource identity, or null
   * when it is not an openable file inside this root.
   *
   * Containment is decided on canonical real paths, so a symbolic link may be
   * opened only when its final target stays inside the same registered root
   * (ADR-0015). This is a read-only classification: it grants no access on its
   * own, and callers still go through `readText` to load content.
   */
  async resolveOpenableFile(rootId: string, absolutePath: string): Promise<ResourceRef | null> {
    if (!path.isAbsolute(absolutePath) || absolutePath.includes("\0")) return null;
    const root = await this.getUsableRoot(rootId);
    if (!root.capabilities.has("open")) return null;
    let realTarget: string;
    try {
      realTarget = await fs.realpath(absolutePath);
      const stat = await fs.stat(realTarget);
      if (!stat.isFile()) return null;
    } catch {
      return null;
    }
    if (!isWithinOrEqual(root.locator.canonicalPath, realTarget)) return null;
    let relativePath: string;
    try {
      relativePath = normalizeResourceRelativePath(
        path.relative(root.locator.canonicalPath, realTarget).split(path.sep).join("/")
      );
    } catch {
      // The root itself, or a spelling that cannot be a resource identity.
      return null;
    }
    await this.proveCurrentRoot(root);
    return { rootId: root.rootId, relativePath };
  }

  async listDirectory(
    ref: RootDirectoryRef,
    options: { cursor?: string } = {}
  ): Promise<ExternalRootDirectoryPage> {
    const root = await this.getUsableRoot(ref.rootId);
    let relativePath: string;
    try {
      relativePath = normalizeRootRelativeBase(ref.relativePath);
    } catch {
      throw new ExternalRootAccessError("invalid-path", "Directory path is not a canonical root-relative path");
    }
    const directoryKey = JSON.stringify([ref.rootId, relativePath]);
    await this.expireCursors();
    let directory: Dir;
    let target: CanonicalDirectoryProof;
    let omittedCount = 0;
    if (options.cursor) {
      const state = this.cursors.get(options.cursor);
      if (!state || state.directoryKey !== directoryKey) {
        throw new ExternalRootAccessError("invalid-cursor", "Directory cursor is invalid or expired");
      }
      this.cursors.delete(options.cursor);
      clearTimeout(state.timer);
      ({ directory, target, omittedCount } = state);
    } else {
      for (const [cursor, state] of this.cursors) {
        if (state.directoryKey === directoryKey) await this.closeCursor(cursor);
      }
      const resolved = await this.resolveTarget(root, relativePath, "directory");
      target = { canonicalPath: resolved.path as TrustedCanonicalRootPath, physicalIdentity: resolved.physicalIdentity };
      try {
        directory = await fs.opendir(resolved.path);
      } catch (error) {
        throw mapExternalRootFsError(error, "target");
      }
    }
    let retained = false;
    let completed = false;
    try {
      await this.validateDirectory(root, relativePath, target);
      const entries: ExternalRootDirectoryEntry[] = [];
      let done = false;
      for (let scanned = 0; scanned < EXTERNAL_ROOT_PAGE_SIZE; scanned++) {
        const entry = await directory.read();
        if (!entry) { done = true; break; }
        if (entry.name === ".git" || entry.name === ".DS_Store") { omittedCount++; continue; }
        const described = await this.describeEntry(root, relativePath, entry.name);
        if (described) entries.push(described);
        else omittedCount++;
      }
      await this.validateDirectory(root, relativePath, target);
      this.assertCurrentSession();
      this.assertRootCurrent(root);
      entries.sort((a, b) => a.name.localeCompare(b.name));
      if (done) { completed = true; return { entries, omittedCount }; }
      while (this.cursors.size >= MAX_SESSION_CURSORS) {
        await this.closeCursor(this.cursors.keys().next().value!);
      }
      this.assertCurrentSession();
      this.assertRootCurrent(root);
      const nextCursor = randomUUID();
      const timer = setTimeout(() => { void this.closeCursor(nextCursor); }, CURSOR_TTL_MS);
      timer.unref();
      this.cursors.set(nextCursor, { directoryKey, directory, target, omittedCount, expiresAt: this.now() + CURSOR_TTL_MS, timer });
      retained = true;
      completed = true;
      return { entries, omittedCount, nextCursor };
    } catch (error) {
      if (error instanceof ExternalRootAccessError) throw error;
      throw mapExternalRootFsError(error, "target");
    } finally {
      if (!retained) await directory.close().catch(() => undefined);
      if (completed) {
        this.assertCurrentSession();
        this.assertRootCurrent(root);
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.cursors.keys()].map((cursor) => this.closeCursor(cursor)));
  }

  async readText(ref: ResourceRef): Promise<string> {
    const root = await this.getUsableRoot(ref.rootId);
    let relativePath: string;
    try {
      relativePath = normalizeResourceRelativePath(ref.relativePath);
    } catch {
      throw new ExternalRootAccessError("invalid-path", "File path is not a canonical root-relative path");
    }
    const target = await this.resolveTarget(root, relativePath, "file");
    let handle: fs.FileHandle | undefined;
    let completed = false;
    try {
      // O_NONBLOCK prevents a substituted FIFO from blocking before fstat can reject it.
      handle = await fs.open(target.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new ExternalRootAccessError("unsupported-file", "Resource is not a regular file");
      if (stat.dev !== target.physicalIdentity.dev || stat.ino !== target.physicalIdentity.ino) {
        throw new ExternalRootAccessError("unavailable", "Resource changed before it could be read");
      }
      // Re-resolve after open so a path replacement cannot redirect a read outside the grant unnoticed.
      const revalidated = await fs.realpath(path.join(root.locator.canonicalPath, ...relativePath.split("/")));
      const revalidatedStat = await fs.stat(revalidated);
      if (!isWithinOrEqual(root.locator.canonicalPath, revalidated)
        || revalidated !== target.path
        || revalidatedStat.dev !== stat.dev
        || revalidatedStat.ino !== stat.ino) {
        throw new ExternalRootAccessError("outside-root", "Resource changed outside the granted root");
      }
      const buffer = Buffer.allocUnsafe(MAX_EXTERNAL_TEXT_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > MAX_EXTERNAL_TEXT_BYTES) {
        throw new ExternalRootAccessError("too-large", "Text files are limited to 2 MiB");
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
      } catch {
        throw new ExternalRootAccessError("invalid-utf8", "File is not valid UTF-8 text");
      }
      if (text.includes("\0")) {
        throw new ExternalRootAccessError("unsupported-file", "Files containing NUL bytes are not text resources");
      }
      await this.proveCurrentRoot(root);
      const finalTarget = await this.resolveTarget(root, relativePath, "file");
      const finalStat = await handle.stat();
      if (finalTarget.path !== target.path
        || finalTarget.physicalIdentity.dev !== stat.dev
        || finalTarget.physicalIdentity.ino !== stat.ino
        || finalStat.size !== stat.size
        || finalStat.mtimeMs !== stat.mtimeMs
        || finalStat.ctimeMs !== stat.ctimeMs) {
        throw new ExternalRootAccessError("unavailable", "Resource changed during the read");
      }
      this.assertCurrentSession();
      this.assertRootCurrent(root);
      completed = true;
      return text;
    } catch (error) {
      if (error instanceof ExternalRootAccessError) throw error;
      throw mapExternalRootFsError(error, "target");
    } finally {
      await handle?.close().catch(() => undefined);
      if (completed) {
        this.assertCurrentSession();
        this.assertRootCurrent(root);
      }
    }
  }

  private async getUsableRoot(rootId: string): Promise<RootRecord> {
    this.assertCurrentSession();
    const root = this.registry.getRoot(rootId);
    if (!root) throw new ExternalRootAccessError("root-not-found", "External root is not registered");
    if (root.availability === "missing") throw new ExternalRootAccessError("root-missing", "External root must be reconnected");
    if (root.availability === "permission-revoked") throw new ExternalRootAccessError("permission-denied", "External root permission was revoked");
    if (root.availability !== "connected") throw new ExternalRootAccessError("root-unavailable", "External root must be reconnected");
    await this.proveCurrentRoot(root);
    return root;
  }

  private async proveCurrentRoot(root: RootRecord): Promise<void> {
    this.assertRootCurrent(root);
    if (root.availability !== "connected") {
      throw new ExternalRootAccessError("root-unavailable", "External root requires explicit reconnect");
    }
    try {
      const current = await fs.realpath(root.locator.canonicalPath);
      const stat = await fs.stat(current);
      if (!stat.isDirectory()
        || current !== root.locator.canonicalPath
        || stat.dev !== root.physicalIdentity.dev
        || stat.ino !== root.physicalIdentity.ino) {
        throw new ExternalRootAccessError("root-unavailable", "External root identity changed; reconnect explicitly");
      }
      this.assertRootCurrent(root);
    } catch (error) {
      if (error instanceof ExternalRootAccessError) throw error;
      throw mapExternalRootFsError(error, "root");
    }
  }

  private assertRootCurrent(root: RootRecord): void {
    const current = this.registry.getRoot(root.rootId);
    if (!current || current.locator.canonicalPath !== root.locator.canonicalPath
      || current.physicalIdentity.dev !== root.physicalIdentity.dev
      || current.physicalIdentity.ino !== root.physicalIdentity.ino
      || current.availability !== root.availability) {
      throw new ExternalRootAccessError("root-unavailable", "External root grant changed during the operation");
    }
  }

  private assertCurrentSession(isCurrent?: () => boolean): void {
    if (this.disposed || (this.options.isSessionCurrent && !this.options.isSessionCurrent())
      || (isCurrent && !isCurrent())) {
      throw new ExternalRootAccessError("root-unavailable", "Vault session changed before the operation completed");
    }
  }

  private async validateDirectory(root: RootRecord, relativePath: string, expected: CanonicalDirectoryProof): Promise<void> {
    await this.proveCurrentRoot(root);
    const current = await this.resolveTarget(root, relativePath, "directory");
    if (current.path !== expected.canonicalPath
      || current.physicalIdentity.dev !== expected.physicalIdentity.dev
      || current.physicalIdentity.ino !== expected.physicalIdentity.ino) {
      throw new ExternalRootAccessError("unavailable", "Directory changed while listing");
    }
    this.assertCurrentSession();
    this.assertRootCurrent(root);
  }

  private async closeCursor(cursor: string): Promise<void> {
    const state = this.cursors.get(cursor);
    if (!state) return;
    this.cursors.delete(cursor);
    clearTimeout(state.timer);
    await state.directory.close().catch(() => undefined);
  }

  private async expireCursors(): Promise<void> {
    const now = this.now();
    for (const [cursor, state] of this.cursors) {
      if (state.expiresAt <= now) await this.closeCursor(cursor);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async resolveTarget(
    root: RootRecord,
    relativePath: string,
    expected: "file" | "directory"
  ): Promise<{ path: string; physicalIdentity: RootPhysicalIdentity }> {
    const segments = relativePath === "" ? [] : relativePath.split("/");
    let candidate: string = root.locator.canonicalPath;
    try {
      for (let index = 0; index < segments.length; index++) {
        candidate = path.join(candidate, segments[index]);
        const lstat = await fs.lstat(candidate);
        const isLast = index === segments.length - 1;
        if (lstat.isSymbolicLink()) {
          const resolved = await fs.realpath(candidate);
          if (!isWithinOrEqual(root.locator.canonicalPath, resolved)) {
            throw new ExternalRootAccessError("outside-root", "Symbolic link escapes the granted root");
          }
          const targetStat = await fs.stat(resolved);
          if (!isLast || targetStat.isDirectory()) {
            throw new ExternalRootAccessError("directory-symlink", "Directory symbolic links are not traversable");
          }
          candidate = resolved;
        } else if (!isLast && !lstat.isDirectory()) {
          throw new ExternalRootAccessError("not-directory", "A parent path is not a directory");
        }
      }
      const resolved = await fs.realpath(candidate);
      if (!isWithinOrEqual(root.locator.canonicalPath, resolved)) {
        throw new ExternalRootAccessError("outside-root", "Resource escapes the granted root");
      }
      const stat = await fs.stat(resolved);
      if (expected === "directory" && !stat.isDirectory()) {
        throw new ExternalRootAccessError("not-directory", "Resource is not a directory");
      }
      if (expected === "file" && !stat.isFile()) {
        throw new ExternalRootAccessError("unsupported-file", "Resource is not a regular file");
      }
      return { path: resolved, physicalIdentity: { dev: stat.dev, ino: stat.ino } };
    } catch (error) {
      if (error instanceof ExternalRootAccessError) throw error;
      throw mapExternalRootFsError(error, "target");
    }
  }

  private async describeEntry(root: RootRecord, parentRelative: string, name: string): Promise<ExternalRootDirectoryEntry | null> {
    const relativePath = parentRelative ? `${parentRelative}/${name}` : name;
    const absolutePath = path.join(root.locator.canonicalPath, ...relativePath.split("/"));
    let lstat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      lstat = await fs.lstat(absolutePath);
    } catch (error) {
      throw mapExternalRootFsError(error, "target");
    }
    const base = {
      name,
      ref: { rootId: root.rootId, relativePath },
      size: lstat.size,
      modifiedAt: lstat.mtimeMs,
    };
    if (!lstat.isSymbolicLink()) {
      if (!lstat.isDirectory() && !lstat.isFile()) return null;
      return { ...base, kind: lstat.isDirectory() ? "directory" : "file" };
    }
    try {
      const resolved = await fs.realpath(absolutePath);
      if (!isWithinOrEqual(root.locator.canonicalPath, resolved)) {
        return { ...base, kind: "unavailable-link", unavailableReason: "outside-root" };
      }
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory() && !stat.isFile()) return null;
      return {
        ...base,
        kind: stat.isDirectory() ? "directory-symlink" : "file-symlink",
        size: stat.size,
        modifiedAt: stat.mtimeMs,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const reason = code === "ENOENT" ? "broken"
        : code === "ELOOP" ? "loop"
          : code === "EACCES" || code === "EPERM" ? "permission-denied"
            : "unavailable";
      return { ...base, kind: "unavailable-link", unavailableReason: reason };
    }
  }
}

function samePhysicalProof(first: CanonicalDirectoryProof, second: CanonicalDirectoryProof): boolean {
  return first.canonicalPath === second.canonicalPath
    && first.physicalIdentity.dev === second.physicalIdentity.dev
    && first.physicalIdentity.ino === second.physicalIdentity.ino;
}
