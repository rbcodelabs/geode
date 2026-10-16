import { isEditablePropertyValue } from "./property-source";

export const PROPERTY_TYPES = ["text", "list", "number", "checkbox", "date", "datetime"] as const;
export type PropertyType = typeof PROPERTY_TYPES[number] | "tags";
interface TypeInfo { name: string; type: string }
interface Config { read(name: string): Promise<unknown>; write(name: string, value: unknown): Promise<void> }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const normalized = (name: string) => name.toLowerCase();

/** One owner for UI and compatibility APIs; config I/O stays in its vault session. */
export class PropertyTypes {
  private types = new Map<string, unknown>();
  private acknowledged = new Map<string, unknown>();
  private names = new Map<string, string>();
  private versions = new Map<string, number>();
  private extra: Record<string, unknown> = Object.create(null);
  private config?: Config;
  private accepting = true;
  private writes: Promise<void> = Promise.resolve();
  private changes = new Set<() => void>();
  private errors = new Set<(error: unknown) => void>();
  async load(config: Config): Promise<void> {
    this.accepting = false; await this.flush();
    this.types.clear(); this.acknowledged.clear(); this.names.clear(); this.versions.clear(); this.extra = Object.create(null); this.config = undefined; this.changed();
    const saved = await config.read("types");
    if (saved !== null && saved !== undefined && (!record(saved) || (Object.hasOwn(saved, "types") && !record(saved.types)))) throw new Error("Unsupported property type document format.");
    if (record(saved)) {
      for (const [key, value] of Object.entries(saved)) if (key !== "types") this.extra[key] = value;
      if (record(saved.types)) for (const [name, type] of Object.entries(saved.types)) this.types.set(normalized(name), type);
    }
    this.acknowledged = new Map(this.types);
    this.config = config; this.accepting = true; this.changed();
  }
  getAllProperties(): Record<string, TypeInfo> {
    const result: Record<string, TypeInfo> = Object.create(null);
    for (const [name, type] of this.types) if (typeof type === "string") result[name] = this.getPropertyInfo(name)!;
    return result;
  }
  getPropertyInfo(name: string): TypeInfo | null {
    const key = normalized(name), type = this.types.get(key);
    return typeof type === "string" ? { name: this.names.get(key) ?? name, type: key === "tags" ? "tags" : key === "aliases" || key === "cssclasses" ? "list" : type } : null;
  }
  getType(name: string, value: unknown): string {
    const key = normalized(name);
    if (key === "tags") return "tags";
    if (key === "aliases" || key === "cssclasses") return "list";
    return this.getPropertyInfo(name)?.type ?? (Array.isArray(value) ? "list" : typeof value === "number" ? "number" : typeof value === "boolean" ? "checkbox" : "text");
  }
  /** Synchronous compatibility contract; failed asynchronous writes revert this assignment. */
  setType(name: string, type: string): void {
    if (!this.accepting) throw new Error("Property types are closed or not loaded.");
    if (!name.trim() || !type.trim()) throw new Error("Property name and type must be nonempty.");
    const key = normalized(name);
    if ((key === "tags" && type !== "tags") || ((key === "aliases" || key === "cssclasses") && type !== "list")) throw new Error("This property has a reserved type.");
    const before = this.types.get(key);
    if (before === type) return;
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version); this.types.set(key, type); this.names.set(key, name); this.changed();
    this.writes = this.writes.then(async () => {
      if (!this.config) { this.acknowledged.set(key, type); return; }
      const types = Object.create(null) as Record<string, unknown>;
      for (const [name, value] of this.acknowledged) types[name] = value;
      types[key] = type;
      try { await this.config.write("types", { ...this.extra, types }); this.acknowledged.set(key, type); }
      catch (error) {
        if (this.versions.get(key) === version) {
          if (this.acknowledged.has(key)) this.types.set(key, this.acknowledged.get(key)); else this.types.delete(key);
          this.changed();
        }
        for (const notify of this.errors) notify(error);
      }
    });
  }
  onChange(callback: () => void): () => void { this.changes.add(callback); return () => this.changes.delete(callback); }
  onError(callback: (error: unknown) => void): () => void { this.errors.add(callback); return () => this.errors.delete(callback); }
  private changed(): void { for (const callback of this.changes) callback(); }
  flush(): Promise<void> { return this.writes; }
  async close(): Promise<void> { this.accepting = false; await this.flush(); }
}

function date(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
export function isPropertyTypeValue(type: string, value: unknown): boolean {
  if (value === null) return PROPERTY_TYPES.includes(type as typeof PROPERTY_TYPES[number]) || type === "tags";
  switch (type) {
    case "text": return typeof value === "string";
    case "list": case "tags": return (Array.isArray(value) && isEditablePropertyValue(value)) || typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "checkbox": return typeof value === "boolean";
    case "date": return typeof value === "string" && date(value);
    case "datetime": {
      if (typeof value !== "string") return false;
      const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/.exec(value);
      return !!match && date(match[1]) && +match[2] < 24 && +match[3] < 60 && (!match[4] || +match[4] < 60);
    }
    default: return false;
  }
}
