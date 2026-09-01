import { bindingIdentity, eventToHotkey, legacyHotkeyToBinding, normalizeHotkey, type Hotkey } from "../shared/hotkey";
import type { EditorView } from "@codemirror/view";
import type { MarkdownView } from "./views/markdown-view";
export type { Hotkey } from "../shared/hotkey";
export { eventToHotkey };

export interface Command {
  id: string; name: string;
  /** @deprecated Prefer structured, physical-key `hotkeys`. */
  hotkey?: string;
  hotkeys?: Hotkey[];
  callback?: () => any;
  checkCallback?: (checking: boolean) => boolean | void;
  /** Editor-only callback. */
  editorCallback?: (editor: EditorView, context: MarkdownView) => any;
  /** Editor-only availability/execution callback. */
  editorCheckCallback?: (checking: boolean, editor: EditorView, context: MarkdownView) => boolean | void;
}
export interface EditorCommandContext { editor: EditorView; context: MarkdownView }
export type EditorCommandContextProvider = () => EditorCommandContext | null;
interface ConfigStore { read(name: string): Promise<unknown>; write(name: string, data: unknown): Promise<void> }
interface HotkeyFile { version: 1; overrides: Record<string, unknown> }
export interface HotkeySnapshot {
  bindingsByCommand: Readonly<Record<string, readonly Hotkey[]>>;
  ownersByBinding: Readonly<Record<string, readonly string[]>>;
  dispatchable: readonly string[];
}
export type AssignmentResult = { status: "assigned" | "unchanged" } | { status: "conflict"; owners: string[] };
const clone = (bindings: readonly Hotkey[]) => bindings.map(b => ({ modifiers: [...b.modifiers], code: b.code }));

export class CommandRegistry {
  commands: Record<string, Command> = {};
  private overrides: Record<string, Hotkey[]> = {};
  private malformedOverrides: Record<string, unknown> = {};
  private snapshotValue: HotkeySnapshot = { bindingsByCommand: {}, ownersByBinding: {}, dispatchable: [] };
  private changeListeners = new Set<() => void>();
  constructor(private config?: ConfigStore, private editorContext?: EditorCommandContextProvider) {}

  private isAvailable(command: Command): boolean {
    if (command.editorCheckCallback) {
      const context = this.editorContext?.();
      return !!context && command.editorCheckCallback(true, context.editor, context.context) === true;
    }
    if (command.editorCallback) return !!this.editorContext?.();
    return !command.checkCallback || command.checkCallback(true) !== false;
  }

  private executeCommand(command: Command): boolean {
    if (command.editorCheckCallback) {
      const context = this.editorContext?.();
      if (!context || command.editorCheckCallback(true, context.editor, context.context) !== true) return false;
      command.editorCheckCallback(false, context.editor, context.context);
      return true;
    }
    if (command.editorCallback) {
      const context = this.editorContext?.();
      if (!context) return false;
      command.editorCallback(context.editor, context.context);
      return true;
    }
    if (command.checkCallback) {
      if (command.checkCallback(true) === false) return false;
      command.checkCallback(false);
      return true;
    }
    command.callback?.();
    return true;
  }

  async loadHotkeys(): Promise<void> {
    const raw = await this.config?.read("hotkeys");
    const parsed = this.parseFile(raw);
    this.overrides = parsed.overrides;
    this.malformedOverrides = parsed.malformedOverrides;
    this.recompute();
  }
  private parseFile(raw: unknown): { overrides: Record<string, Hotkey[]>; malformedOverrides: Record<string, unknown> } {
    const parsed: Record<string, Hotkey[]> = {};
    const malformedOverrides: Record<string, unknown> = {};
    if (!raw || typeof raw !== "object" || (raw as any).version !== 1 || !(raw as any).overrides || typeof (raw as any).overrides !== "object") {
      return { overrides: parsed, malformedOverrides };
    }
    for (const [id, value] of Object.entries((raw as any).overrides)) {
      if (!Array.isArray(value)) { malformedOverrides[id] = value; parsed[id] = []; continue; }
      const bindings = value.map(normalizeHotkey);
      if (bindings.every(Boolean)) parsed[id] = bindings as Hotkey[];
      else { malformedOverrides[id] = value; parsed[id] = []; }
    }
    return { overrides: parsed, malformedOverrides };
  }
  private defaults(command: Command): Hotkey[] {
    const source = command.hotkeys ?? (command.hotkey ? [legacyHotkeyToBinding(command.hotkey)] : []);
    const seen = new Set<string>();
    return source.map(normalizeHotkey).filter((b): b is Hotkey => {
      if (!b) return false;
      const identity = bindingIdentity(b);
      if (seen.has(identity)) return false;
      seen.add(identity); return true;
    });
  }
  private effective(id: string): Hotkey[] { return clone(Object.prototype.hasOwnProperty.call(this.overrides, id) ? this.overrides[id] : this.defaults(this.commands[id])); }
  private recompute(): void {
    const bindingsByCommand: Record<string, Hotkey[]> = {};
    const ownersByBinding: Record<string, string[]> = {};
    for (const id of Object.keys(this.commands)) {
      const seen = new Set<string>();
      const bindings = this.effective(id).filter(binding => { const key = bindingIdentity(binding); if (seen.has(key)) return false; seen.add(key); return true; });
      bindingsByCommand[id] = Object.freeze(bindings.map(binding => Object.freeze({ modifiers: Object.freeze([...binding.modifiers]) as unknown as Hotkey["modifiers"], code: binding.code }))) as unknown as Hotkey[];
      for (const binding of bindings) (ownersByBinding[bindingIdentity(binding)] ??= []).push(id);
    }
    for (const owners of Object.values(ownersByBinding)) Object.freeze(owners);
    this.snapshotValue = Object.freeze({ bindingsByCommand: Object.freeze(bindingsByCommand), ownersByBinding: Object.freeze(ownersByBinding), dispatchable: Object.freeze(Object.entries(ownersByBinding).filter(([, owners]) => owners.length === 1).map(([identity]) => identity)) });
    for (const listener of this.changeListeners) listener();
  }
  snapshot(): HotkeySnapshot { return this.snapshotValue; }
  bindingsFor(id: string): Hotkey[] { return clone(this.snapshotValue.bindingsByCommand[id] ?? []); }
  conflictsFor(id: string): Array<{ binding: Hotkey; owners: string[] }> {
    return this.bindingsFor(id).flatMap(binding => { const owners = [...(this.snapshotValue.ownersByBinding[bindingIdentity(binding)] ?? [])]; return owners.length > 1 ? [{ binding, owners }] : []; });
  }
  hasOverride(id: string): boolean { return Object.prototype.hasOwnProperty.call(this.overrides, id); }
  async setBindings(id: string, bindings: readonly Hotkey[]): Promise<void> {
    const normalized: Hotkey[] = [];
    const seen = new Set<string>();
    for (const binding of bindings) {
      const value = normalizeHotkey(binding);
      if (!value) throw new TypeError("Invalid hotkey binding");
      const identity = bindingIdentity(value);
      if (!seen.has(identity)) { seen.add(identity); normalized.push(value); }
    }
    await this.commit({ ...this.overrides, [id]: normalized }, [id]);
  }
  async resetBindings(id: string): Promise<void> { const next = { ...this.overrides }; delete next[id]; await this.commit(next, [id]); }
  async removeBinding(id: string, binding: Hotkey): Promise<void> { const identity = bindingIdentity(binding); await this.setBindings(id, this.bindingsFor(id).filter(b => bindingIdentity(b) !== identity)); }
  async assignBinding(id: string, binding: Hotkey, options: { reassign?: boolean } = {}): Promise<AssignmentResult> {
    const normalized = normalizeHotkey(binding); if (!normalized || !this.commands[id]) return { status: "unchanged" };
    const identity = bindingIdentity(normalized);
    if (this.bindingsFor(id).some(b => bindingIdentity(b) === identity)) return { status: "unchanged" };
    const owners = [...(this.snapshotValue.ownersByBinding[identity] ?? [])].filter(owner => owner !== id);
    if (owners.length && !options.reassign) return { status: "conflict", owners };
    const next = { ...this.overrides };
    for (const owner of owners) next[owner] = this.bindingsFor(owner).filter(b => bindingIdentity(b) !== identity);
    next[id] = [...this.bindingsFor(id), normalized];
    await this.commit(next, [...owners, id]);
    return { status: "assigned" };
  }
  private async commit(next: Record<string, Hotkey[]>, repairedIds: string[] = []): Promise<void> {
    const preserved = { ...this.malformedOverrides };
    for (const id of repairedIds) delete preserved[id];
    const file: HotkeyFile = { version: 1, overrides: { ...next, ...preserved } };
    await this.config?.write("hotkeys", file);
    this.overrides = next;
    for (const id of repairedIds) delete this.malformedOverrides[id];
    this.recompute();
  }
  add(command: Command): void { this.commands[command.id] = command; this.recompute(); }
  addCommand(command: Command): void { this.add(command); }
  remove(id: string): void { if (!this.has(id)) return; delete this.commands[id]; this.recompute(); }
  removeCommand(id: string): void { this.remove(id); }
  hotkeys(): string[] { return [...this.snapshotValue.dispatchable]; }
  onChange(listener: () => void): () => void { this.changeListeners.add(listener); return () => this.changeListeners.delete(listener); }
  dispatchHotkey(combo: string): boolean {
    const owners = this.snapshotValue.ownersByBinding[combo] ?? [];
    if (owners.length !== 1) return false;
    const cmd = this.commands[owners[0]];
    return !!cmd && this.executeCommand(cmd);
  }
  has(id: string): boolean { return Object.prototype.hasOwnProperty.call(this.commands, id); }
  findCommand(id: string): Command | undefined { return this.has(id) ? this.commands[id] : undefined; }
  execute(id: string): boolean { const cmd = this.findCommand(id); return !!cmd && this.executeCommand(cmd); }
  executeCommandById(id: string): boolean { return this.execute(id); }
  list(): Command[] { return Object.values(this.commands).filter(command => this.isAvailable(command)).sort((a, b) => a.name.localeCompare(b.name)); }
  listCommands(): Command[] { return Object.values(this.commands); }
  attach(target: Document): () => void {
    const listener = (event: KeyboardEvent) => { const combo = eventToHotkey(event); if (combo && this.dispatchHotkey(combo)) { event.preventDefault(); event.stopPropagation(); } };
    target.addEventListener("keydown", listener, true); return () => target.removeEventListener("keydown", listener, true);
  }
}
