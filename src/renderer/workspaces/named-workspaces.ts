import { migrateWorkspaceLayout, type PersistedWorkspace, type PersistedWorkspaceV3 } from "../workspace";

export interface NamedLayout { id: string; name: string; layout: PersistedWorkspaceV3 }
interface LayoutStore { version: 1; layouts: NamedLayout[] }
interface Config { read(key: string): Promise<unknown>; write(key: string, value: unknown): Promise<void> }
const MAX_BYTES = 2_000_000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function invalid(): never { throw new Error("Invalid or oversized workspace layout."); }
function cloneJson(value: unknown): unknown {
  let bytes: string | undefined;
  try { bytes = JSON.stringify(value); } catch { return invalid(); }
  if (!bytes || bytes.length > MAX_BYTES) return invalid();
  const copy: unknown = JSON.parse(bytes);
  const walk = (value: unknown, depth: number): void => {
    if (depth > 48) invalid();
    if (value && typeof value === "object") for (const child of Object.values(value)) walk(child, depth + 1);
  };
  walk(copy, 0); return copy;
}
export function validateNamedLayout(input: unknown): PersistedWorkspaceV3 {
  const copy = cloneJson(input);
  if (!object(copy) || ![1, 2, 3].includes(copy.version as number)) return invalid();
  let leafCount = 0; let nodeCount = 0; let centerGroups = 0;
  const index = (value: unknown, count: number): void => { if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= Math.max(1, count)) invalid(); };
  const leaves = (items: unknown): number => {
    if (!Array.isArray(items)) return invalid();
    leafCount += items.length; if (leafCount > 200) invalid();
    for (const leaf of items) {
      if (!object(leaf) || typeof leaf.type !== "string" || !/^[\w][\w:.-]{0,127}$/.test(leaf.type)) invalid();
      if (leaf.file !== undefined && (typeof leaf.file !== "string" || !leaf.file || leaf.file.length > 4096 || /[\\\x00-\x1f]|(^\/)|(^[a-z]+:)|(^|\/)\.{1,2}(\/|$)/i.test(leaf.file))) invalid();
      if (["markdown", "canvas", "image"].includes(leaf.type as string) && !leaf.file) invalid();
      if (leaf.pinned !== undefined && typeof leaf.pinned !== "boolean") invalid();
    }
    return items.length;
  };
  const node = (value: unknown, depth: number, center: boolean): void => {
    if (value === null) return;
    if (!object(value) || depth > 16 || ++nodeCount > 256) invalid();
    if (value.type === "tabs") { index(value.active, leaves(value.leaves)); if (center) centerGroups++; }
    else if (value.type === "split") {
      if (!["horizontal", "vertical"].includes(value.direction as string) || !Array.isArray(value.children) || !value.children.length || value.children.length > 64 || !Array.isArray(value.sizes) || value.sizes.length !== value.children.length || value.sizes.some(size => typeof size !== "number" || !Number.isFinite(size) || size <= 0)) invalid();
      for (const child of value.children as unknown[]) { if (child === null) invalid(); node(child, depth + 1, center); }
    } else invalid();
  };
  const sidebar = (value: unknown, legacy: boolean): void => {
    if (!object(value) || typeof value.collapsed !== "boolean") invalid();
    if (value.width !== undefined && (typeof value.width !== "number" || !Number.isFinite(value.width) || value.width <= 0 || value.width > 5000)) invalid();
    if (legacy) leaves(value.leaves); else node(value.root, 0, false);
  };
  if (copy.version === 1) {
    if (!Array.isArray(copy.groups) || !copy.groups.length || copy.groups.length > 64) invalid();
    for (const group of copy.groups as unknown[]) { if (!object(group)) invalid(); index(group.active, leaves(group.leaves)); centerGroups++; }
    index(copy.activeGroup, centerGroups); sidebar(copy.left, true); sidebar(copy.right, true);
  } else {
    if (!object(copy.center)) invalid(); node(copy.center.root, 0, true); index(copy.center.activeGroup, centerGroups);
    sidebar(copy.left, false); sidebar(copy.right, false);
  }
  return migrateWorkspaceLayout(copy as unknown as PersistedWorkspace);
}
function nameOf(value: string): string {
  const name = value.trim(); if (!name || name.length > 120 || /[\x00-\x1f]/.test(name)) throw new Error("Enter a workspace name of 1–120 characters."); return name;
}

/** Per-vault serialized writes; publish records only after durable success. */
export class NamedWorkspaces {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly config: Config, private readonly isCurrent: () => boolean) {}
  private check(): void { if (!this.isCurrent()) throw new Error("The vault changed. Reopen workspace layouts."); }
  private async read(): Promise<LayoutStore> {
    this.check(); const raw = await this.config.read("workspaces"); this.check();
    if (raw === null || raw === undefined) return { version: 1, layouts: [] };
    const value = cloneJson(raw);
    if (!object(value) || value.version !== 1 || !Array.isArray(value.layouts) || value.layouts.length > 100) throw new Error("Saved workspace layouts are unreadable; repair the workspaces configuration before saving.");
    const ids = new Set<string>(); const names = new Set<string>();
    const layouts = value.layouts.map(record => {
      if (!object(record) || typeof record.id !== "string" || !record.id || record.id.length > 128 || typeof record.name !== "string") return invalid();
      const name = nameOf(record.name); if (ids.has(record.id) || names.has(name)) return invalid(); ids.add(record.id); names.add(name);
      return { id: record.id, name, layout: validateNamedLayout(record.layout) };
    });
    return { version: 1, layouts };
  }
  async list(): Promise<NamedLayout[]> { await this.queue.catch(() => {}); return (await this.read()).layouts; }
  async get(id: string): Promise<NamedLayout> { const record = (await this.list()).find(record => record.id === id); if (!record) throw new Error("This saved layout no longer exists."); return record; }
  private mutate<T>(operation: (store: LayoutStore) => T): Promise<T> {
    const pending = this.queue.catch(() => {}).then(async () => {
      const store = await this.read(); const result = operation(store); cloneJson(store); this.check(); await this.config.write("workspaces", store); this.check(); return result;
    });
    this.queue = pending; return pending;
  }
  save(name: string, input: unknown): Promise<NamedLayout> {
    const trimmed = nameOf(name); const layout = validateNamedLayout(input);
    return this.mutate(store => {
      const existing = store.layouts.find(record => record.name === trimmed);
      if (existing) { existing.layout = layout; return existing; }
      if (store.layouts.length >= 100) throw new Error("At most 100 workspace layouts can be saved.");
      const record = { id: crypto.randomUUID(), name: trimmed, layout }; store.layouts.push(record); return record;
    });
  }
  remove(id: string): Promise<void> { return this.mutate(store => { if (!store.layouts.some(record => record.id === id)) throw new Error("This saved layout no longer exists."); store.layouts = store.layouts.filter(record => record.id !== id); }); }
}
