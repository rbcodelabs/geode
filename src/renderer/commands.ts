export interface Command {
  id: string;
  name: string;
  hotkey?: string; // e.g. "Mod+P", "Mod+Shift+F"
  /** Unconditional execution. Exactly one of callback/checkCallback should be set. */
  callback?: () => void;
  /**
   * Conditional execution, Obsidian-style: called with `checking === true`
   * to ask "is this command currently available?" (return false to hide it
   * from the palette / hotkey dispatch, do NOT perform the action); called
   * with `checking === false` to actually perform the action.
   */
  checkCallback?: (checking: boolean) => boolean | void;
}

/** Normalize a KeyboardEvent into "Mod+Shift+K" style strings (Mod = Cmd/Ctrl). */
export function eventToHotkey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let key = e.key;
  if (key === " ") key = "Space";
  if (key.length === 1) key = key.toUpperCase();
  if (["Meta", "Control", "Alt", "Shift"].includes(key)) return "";
  parts.push(key);
  return parts.join("+");
}

/** True if a checkCallback-gated command is currently available. */
function isAvailable(cmd: Command): boolean {
  return !cmd.checkCallback || cmd.checkCallback(true) !== false;
}

function run(cmd: Command): void {
  if (cmd.checkCallback) cmd.checkCallback(false);
  else cmd.callback?.();
}

export class CommandRegistry {
  commands = new Map<string, Command>();
  private byHotkey = new Map<string, Command>();

  add(command: Command) {
    this.commands.set(command.id, command);
    if (command.hotkey) this.byHotkey.set(command.hotkey, command);
  }

  /** Unregister a command (and its hotkey binding, if any). Idempotent. */
  remove(id: string): void {
    const cmd = this.commands.get(id);
    if (!cmd) return;
    this.commands.delete(id);
    if (cmd.hotkey && this.byHotkey.get(cmd.hotkey) === cmd) this.byHotkey.delete(cmd.hotkey);
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  execute(id: string): boolean {
    const cmd = this.commands.get(id);
    if (!cmd || !isAvailable(cmd)) return false;
    run(cmd);
    return true;
  }

  /** Commands currently available, e.g. for the command palette. */
  list(): Command[] {
    return [...this.commands.values()]
      .filter(isAvailable)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Install the global hotkey listener. */
  attach(target: Document) {
    target.addEventListener(
      "keydown",
      (e) => {
        const combo = eventToHotkey(e);
        if (!combo) return;
        const cmd = this.byHotkey.get(combo);
        if (cmd && isAvailable(cmd)) {
          e.preventDefault();
          e.stopPropagation();
          run(cmd);
        }
      },
      true
    );
  }
}
