import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeJsonAtomic } from "./config-file";
import {
  normalizeRootRelativeBase,
  type RootAvailability,
  type RootCapability,
  type RootIntegrationBinding,
  type RootIntegrationBindingKey,
  type RootDescriptor,
  type RootKind,
} from "../shared/root-registry";

export const ROOT_REGISTRY_SCHEMA_VERSION = 1 as const;
const READ_ONLY_CAPABILITIES = ["browse", "read", "open"] as const satisfies readonly RootCapability[];

declare const canonicalRootPathBrand: unique symbol;
/** Host-only proof that the Tranche 2 boundary resolved this locator with realpath. */
export type TrustedCanonicalRootPath = string & { readonly [canonicalRootPathBrand]: true };

export interface HostRootLocator {
  canonicalPath: TrustedCanonicalRootPath;
  chosenPath?: string;
}

/** Host-private grant record. Absolute locators must never cross renderer/plugin boundaries. */
export interface RootRecord {
  rootId: string;
  kind: RootKind;
  label: string;
  locator: HostRootLocator;
  capabilities: ReadonlySet<RootCapability>;
  availability: RootAvailability;
  createdAt: number;
  lastConnectedAt?: number;
}

export interface PersistedRootRecord extends Omit<RootRecord, "capabilities" | "locator"> {
  locator: { canonicalPath: string; chosenPath?: string };
  capabilities: RootCapability[];
}

export interface PersistedRootRegistry {
  schemaVersion: typeof ROOT_REGISTRY_SCHEMA_VERSION;
  roots: PersistedRootRecord[];
  bindings: RootIntegrationBinding[];
}

export interface RootRegistryStore {
  load(): Promise<unknown | null>;
  save(value: PersistedRootRegistry): Promise<void>;
}

export interface RootRegistryOpenOptions {
  store: RootRegistryStore;
  activeVaultPath?: TrustedCanonicalRootPath;
  now?: () => number;
  createRootId?: () => string;
}

export interface AttachProjectRootRequest extends RootIntegrationBindingKey {
  /** Canonical path established by the Tranche 2 grant/containment boundary. */
  canonicalPath: TrustedCanonicalRootPath;
  chosenPath?: string;
  label: string;
}

export type AttachProjectRootResult =
  | { kind: "attached" | "reused"; root: RootRecord; binding: RootIntegrationBinding }
  | { kind: "inside-vault"; relativeBase: string };

export class RootOverlapError extends Error {
  readonly conflictingRootIds: string[];

  constructor(conflictingRootIds: string[]) {
    super("The requested folder contains an existing external root and would broaden its grant");
    this.name = "RootOverlapError";
    this.conflictingRootIds = conflictingRootIds;
  }
}

export class BindingRetargetError extends Error {
  constructor() {
    super("An existing integration binding cannot be silently retargeted");
    this.name = "BindingRetargetError";
  }
}

export class JsonRootRegistryStore implements RootRegistryStore {
  readonly filePath: string;

  constructor(userDataDir: string) {
    this.filePath = path.join(userDataDir, "external-roots.json");
  }

  async load(): Promise<unknown | null> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(value: PersistedRootRegistry): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJsonAtomic(this.filePath, value);
  }
}

function bindingIdentity(binding: RootIntegrationBindingKey): string {
  return JSON.stringify([binding.integrationId, binding.instanceId, binding.projectId]);
}

function isWithinOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function relativeBase(parent: string, candidate: string): string {
  const relative = path.relative(parent, candidate);
  return normalizeRootRelativeBase(relative.split(path.sep).join("/"));
}

function cloneRoot(root: RootRecord): RootRecord {
  return {
    ...root,
    locator: { ...root.locator },
    capabilities: new Set(root.capabilities),
  };
}

function toRootDescriptor(root: RootRecord): RootDescriptor {
  return {
    rootId: root.rootId,
    kind: root.kind,
    label: root.label,
    capabilities: [...root.capabilities],
    availability: root.availability,
    createdAt: root.createdAt,
    ...(root.lastConnectedAt === undefined ? {} : { lastConnectedAt: root.lastConnectedAt }),
  };
}

function toPersistedRoot(root: RootRecord): PersistedRootRecord {
  return {
    ...root,
    locator: { ...root.locator },
    capabilities: [...root.capabilities],
  };
}

function fromPersistedRoot(root: PersistedRootRecord): RootRecord {
  return {
    ...root,
    locator: {
      canonicalPath: hydratePersistedCanonicalRootPath(root.locator.canonicalPath),
      ...(root.locator.chosenPath ? { chosenPath: root.locator.chosenPath } : {}),
    },
    capabilities: new Set(root.capabilities),
  };
}

export class RootRegistry {
  private readonly roots = new Map<string, RootRecord>();
  private readonly bindings = new Map<string, RootIntegrationBinding>();
  private readonly store: RootRegistryStore;
  private readonly activeVaultPath?: TrustedCanonicalRootPath;
  private readonly now: () => number;
  private readonly createRootId: () => string;
  private mutationTail: Promise<void> = Promise.resolve();

  private constructor(options: RootRegistryOpenOptions, activeVaultPath?: TrustedCanonicalRootPath) {
    this.store = options.store;
    this.activeVaultPath = activeVaultPath;
    this.now = options.now ?? Date.now;
    this.createRootId = options.createRootId ?? randomUUID;
  }

  static async open(options: RootRegistryOpenOptions): Promise<RootRegistry> {
    if (options.activeVaultPath) validateCanonicalPath(options.activeVaultPath, "active vault");
    const registry = new RootRegistry(options, options.activeVaultPath);
    const persisted = parsePersistedRootRegistry(await options.store.load());
    for (const root of persisted.roots) registry.roots.set(root.rootId, fromPersistedRoot(root));
    for (const binding of persisted.bindings) {
      registry.bindings.set(bindingIdentity(binding), { ...binding });
    }
    return registry;
  }

  listRoots(): RootRecord[] {
    return [...this.roots.values()].map(cloneRoot);
  }

  getRoot(rootId: string): RootRecord | undefined {
    const root = this.roots.get(rootId);
    return root ? cloneRoot(root) : undefined;
  }

  getRootDescriptor(rootId: string): RootDescriptor | undefined {
    const root = this.roots.get(rootId);
    return root ? toRootDescriptor(root) : undefined;
  }

  listRootDescriptors(): RootDescriptor[] {
    return [...this.roots.values()].map(toRootDescriptor);
  }

  listBindings(): RootIntegrationBinding[] {
    return [...this.bindings.values()].map((binding) => ({ ...binding }));
  }

  async attachProjectRoot(request: AttachProjectRootRequest): Promise<AttachProjectRootResult> {
    return this.enqueueMutation(() => this.attachProjectRootMutation(request));
  }

  private async attachProjectRootMutation(request: AttachProjectRootRequest): Promise<AttachProjectRootResult> {
    validateBindingMetadata(request);
    const canonicalPath = request.canonicalPath;
    validateCanonicalPath(canonicalPath, "external root");
    if (request.chosenPath !== undefined) validateAbsolutePath(request.chosenPath, "chosen root path");

    if (this.activeVaultPath && isWithinOrEqual(this.activeVaultPath, canonicalPath)) {
      return { kind: "inside-vault", relativeBase: relativeBase(this.activeVaultPath, canonicalPath) };
    }
    if (this.activeVaultPath && isWithinOrEqual(canonicalPath, this.activeVaultPath)) {
      throw new RootOverlapError([]);
    }

    const existing = [...this.roots.values()];
    const reusable = existing.find((root) => isWithinOrEqual(root.locator.canonicalPath, canonicalPath));
    if (reusable) {
      const binding: RootIntegrationBinding = {
        integrationId: request.integrationId,
        instanceId: request.instanceId,
        projectId: request.projectId,
        label: request.label,
        rootId: reusable.rootId,
        relativeBase: relativeBase(reusable.locator.canonicalPath, canonicalPath),
      };
      this.assertBindingDoesNotRetarget(binding);
      const nextBindings = new Map(this.bindings);
      nextBindings.set(bindingIdentity(binding), binding);
      await this.save(this.roots, nextBindings);
      this.replaceBindings(nextBindings);
      return { kind: "reused", root: cloneRoot(reusable), binding: { ...binding } };
    }

    const conflicts = existing
      .filter((root) => isWithinOrEqual(canonicalPath, root.locator.canonicalPath))
      .map((root) => root.rootId);
    if (conflicts.length > 0) throw new RootOverlapError(conflicts);

    const timestamp = this.now();
    const rootId = this.createRootId();
    if (!UUID_V4.test(rootId)) throw new Error("Root identity factory must return a UUIDv4");
    if (this.roots.has(rootId)) throw new Error("Root identity factory returned a duplicate UUID");
    const root: RootRecord = {
      rootId,
      kind: "project-cwd",
      label: request.label,
      locator: {
        canonicalPath,
        ...(request.chosenPath ? { chosenPath: request.chosenPath } : {}),
      },
      capabilities: new Set(READ_ONLY_CAPABILITIES),
      availability: "connected",
      createdAt: timestamp,
      lastConnectedAt: timestamp,
    };
    const binding: RootIntegrationBinding = {
      integrationId: request.integrationId,
      instanceId: request.instanceId,
      projectId: request.projectId,
      label: request.label,
      rootId: root.rootId,
      relativeBase: "",
    };
    this.assertBindingDoesNotRetarget(binding);
    const nextRoots = new Map(this.roots).set(root.rootId, root);
    const nextBindings = new Map(this.bindings).set(bindingIdentity(binding), binding);
    await this.save(nextRoots, nextBindings);
    this.replaceRoots(nextRoots);
    this.replaceBindings(nextBindings);
    return { kind: "attached", root: cloneRoot(root), binding: { ...binding } };
  }

  async removeBinding(key: RootIntegrationBindingKey): Promise<boolean> {
    return this.enqueueMutation(() => this.removeBindingMutation(key));
  }

  private async removeBindingMutation(key: RootIntegrationBindingKey): Promise<boolean> {
    const identity = bindingIdentity(key);
    if (!this.bindings.has(identity)) return false;
    const nextBindings = new Map(this.bindings);
    nextBindings.delete(identity);
    await this.save(this.roots, nextBindings);
    this.replaceBindings(nextBindings);
    return true;
  }

  async setAvailability(rootId: string, availability: RootAvailability): Promise<void> {
    return this.enqueueMutation(() => this.setAvailabilityMutation(rootId, availability));
  }

  private async setAvailabilityMutation(rootId: string, availability: RootAvailability): Promise<void> {
    const current = this.requireRoot(rootId);
    if (current.availability === availability) return;
    const updated = { ...current, availability };
    const nextRoots = new Map(this.roots).set(rootId, updated);
    await this.save(nextRoots, this.bindings);
    this.replaceRoots(nextRoots);
  }

  async reconnectRoot(rootId: string, locator: HostRootLocator): Promise<RootRecord> {
    return this.enqueueMutation(() => this.reconnectRootMutation(rootId, locator));
  }

  private async reconnectRootMutation(rootId: string, locator: HostRootLocator): Promise<RootRecord> {
    const current = this.requireRoot(rootId);
    const canonicalPath = locator.canonicalPath;
    validateCanonicalPath(canonicalPath, "reconnected root");
    if (locator.chosenPath !== undefined) validateAbsolutePath(locator.chosenPath, "chosen root path");
    if (this.activeVaultPath && isWithinOrEqual(this.activeVaultPath, canonicalPath)) {
      throw new RootOverlapError([]);
    }
    if (this.activeVaultPath && isWithinOrEqual(canonicalPath, this.activeVaultPath)) {
      throw new RootOverlapError([]);
    }
    const conflicts = [...this.roots.values()]
      .filter((root) => root.rootId !== rootId)
      .filter((root) =>
        isWithinOrEqual(root.locator.canonicalPath, canonicalPath)
        || isWithinOrEqual(canonicalPath, root.locator.canonicalPath)
      )
      .map((root) => root.rootId);
    if (conflicts.length > 0) throw new RootOverlapError(conflicts);

    const timestamp = this.now();
    const updated: RootRecord = {
      ...current,
      locator: { canonicalPath, ...(locator.chosenPath ? { chosenPath: locator.chosenPath } : {}) },
      availability: "connected",
      lastConnectedAt: timestamp,
    };
    const nextRoots = new Map(this.roots).set(rootId, updated);
    await this.save(nextRoots, this.bindings);
    this.replaceRoots(nextRoots);
    return cloneRoot(updated);
  }

  private async save(
    roots: ReadonlyMap<string, RootRecord>,
    bindings: ReadonlyMap<string, RootIntegrationBinding>
  ): Promise<void> {
    await this.store.save({
      schemaVersion: ROOT_REGISTRY_SCHEMA_VERSION,
      roots: [...roots.values()].map(toPersistedRoot),
      bindings: [...bindings.values()].map((binding) => ({ ...binding })),
    });
  }

  private replaceRoots(roots: ReadonlyMap<string, RootRecord>): void {
    this.roots.clear();
    for (const [rootId, root] of roots) this.roots.set(rootId, root);
  }

  private replaceBindings(bindings: ReadonlyMap<string, RootIntegrationBinding>): void {
    this.bindings.clear();
    for (const [identity, binding] of bindings) this.bindings.set(identity, binding);
  }

  private requireRoot(rootId: string): RootRecord {
    const root = this.roots.get(rootId);
    if (!root) throw new Error(`Unknown root: ${rootId}`);
    return root;
  }

  private assertBindingDoesNotRetarget(next: RootIntegrationBinding): void {
    const current = this.bindings.get(bindingIdentity(next));
    if (current && (current.rootId !== next.rootId || current.relativeBase !== next.relativeBase)) {
      throw new BindingRetargetError();
    }
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(mutation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function emptyPersistedRootRegistry(): PersistedRootRegistry {
  return { schemaVersion: ROOT_REGISTRY_SCHEMA_VERSION, roots: [], bindings: [] };
}

function parsePersistedRootRegistry(value: unknown | null): PersistedRootRegistry {
  if (value === null) return emptyPersistedRootRegistry();
  if (!isRecord(value)) throw new Error("Invalid root registry persistence payload");
  const candidate = value as Partial<PersistedRootRegistry>;
  if (candidate.schemaVersion !== ROOT_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`Unsupported root registry schema version: ${String(candidate.schemaVersion)}`);
  }
  if (!Array.isArray(candidate.roots) || !Array.isArray(candidate.bindings)) {
    throw new Error("Invalid root registry persistence payload");
  }
  const rootIds = new Set<string>();
  const canonicalPaths: string[] = [];
  for (const root of candidate.roots) {
    validatePersistedRoot(root);
    if (rootIds.has(root.rootId)) {
      throw new Error("Duplicate root identity in persisted root registry");
    }
    if (canonicalPaths.some((existing) =>
      isWithinOrEqual(existing, root.locator.canonicalPath)
      || isWithinOrEqual(root.locator.canonicalPath, existing)
    )) {
      throw new Error("Overlapping roots in persisted root registry");
    }
    rootIds.add(root.rootId);
    canonicalPaths.push(root.locator.canonicalPath);
  }
  const bindingKeys = new Set<string>();
  for (const binding of candidate.bindings) {
    validatePersistedBinding(binding);
    if (!rootIds.has(binding.rootId)) throw new Error("Root binding references an unknown root");
    const identity = bindingIdentity(binding);
    if (bindingKeys.has(identity)) throw new Error("Duplicate integration binding in persisted root registry");
    bindingKeys.add(identity);
  }
  return {
    schemaVersion: ROOT_REGISTRY_SCHEMA_VERSION,
    roots: candidate.roots.map((root) => ({ ...root, locator: { ...root.locator }, capabilities: [...root.capabilities] })),
    bindings: candidate.bindings.map((binding) => ({ ...binding })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOT_AVAILABILITIES: readonly RootAvailability[] = ["connected", "missing", "permission-revoked", "unavailable"];
const ROOT_CAPABILITIES: readonly RootCapability[] = ["browse", "read", "open"];

function validatePersistedRoot(value: unknown): asserts value is PersistedRootRecord {
  if (!isRecord(value) || typeof value.rootId !== "string" || !UUID_V4.test(value.rootId)) {
    throw new Error("Invalid persisted root identity");
  }
  if (value.kind !== "project-cwd" || typeof value.label !== "string" || value.label.length === 0) {
    throw new Error("Invalid persisted root metadata");
  }
  if (!isRecord(value.locator) || typeof value.locator.canonicalPath !== "string") {
    throw new Error("Invalid persisted root locator");
  }
  validateCanonicalPath(value.locator.canonicalPath, "persisted root");
  if (value.locator.chosenPath !== undefined) {
    if (typeof value.locator.chosenPath !== "string") throw new Error("Invalid persisted chosen path");
    validateAbsolutePath(value.locator.chosenPath, "persisted chosen path");
  }
  const capabilities = value.capabilities;
  if (!Array.isArray(capabilities)
    || capabilities.length !== ROOT_CAPABILITIES.length
    || ROOT_CAPABILITIES.some((capability) => !capabilities.includes(capability))) {
    throw new Error("Invalid persisted root capabilities");
  }
  if (!ROOT_AVAILABILITIES.includes(value.availability as RootAvailability)) {
    throw new Error("Invalid persisted root availability");
  }
  if (!Number.isFinite(value.createdAt)
    || (value.lastConnectedAt !== undefined && !Number.isFinite(value.lastConnectedAt))) {
    throw new Error("Invalid persisted root timestamps");
  }
}

function validatePersistedBinding(value: unknown): asserts value is RootIntegrationBinding {
  if (!isRecord(value)) throw new Error("Invalid persisted root binding");
  validateBindingMetadata(value);
  const rootId = value.rootId;
  if (typeof rootId !== "string" || !UUID_V4.test(rootId) || typeof value.relativeBase !== "string") {
    throw new Error("Invalid persisted root binding");
  }
  normalizeRootRelativeBase(value.relativeBase);
}

function validateBindingMetadata(value: {
  integrationId?: unknown;
  instanceId?: unknown;
  projectId?: unknown;
  label?: unknown;
}): void {
  for (const key of ["integrationId", "instanceId", "projectId", "label"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error("Invalid root integration binding metadata");
    }
  }
}

function validateAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error(`${label} must be an absolute path`);
  return value;
}

function validateCanonicalPath(value: string, label: string): void {
  validateAbsolutePath(value, label);
  if (path.normalize(value) !== value || value !== path.resolve(value)) {
    throw new Error(`${label} must already be canonical`);
  }
}

/**
 * Rehydrate a branded path only after parsePersistedRootRegistry has validated
 * the complete schema and lexical path shape. New paths can only be produced by
 * the future Tranche 2 realpath boundary.
 */
function hydratePersistedCanonicalRootPath(value: string): TrustedCanonicalRootPath {
  return value as TrustedCanonicalRootPath;
}
