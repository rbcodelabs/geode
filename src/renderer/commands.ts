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
  /**
   * Obsidian's `app.commands.commands` is a plain object keyed by command
   * id, not a Map — real plugins read/write it directly (e.g.
   * `app.commands.commands[id].name = ...`), and the agent-facing host
   * tools (`obsidian_list_commands`/`obsidian_execute_command`) expect
   * Obsidian's `listCommands`/`executeCommandById` method names. A Record
   * keeps live object/identity semantics (no snapshot to keep in sync) at
   * zero cost: nothing outside this file ever read `commands` as a Map.
   */
  commands: Record<string, Command> = {};
  private byHotkey = new Map<string, Command>();

  add(command: Command) {
    this.commands[command.id] = command;
    if (command.hotkey) this.byHotkey.set(command.hotkey, command);
  }

  /** Obsidian alias for `add`. */
  addCommand(command: Command) {
    this.add(command);
  }

  /** Unregister a command (and its hotkey binding, if any). Idempotent. */
  remove(id: string): void {
    const cmd = this.commands[id];
    if (!cmd) return;
    delete this.commands[id];
    if (cmd.hotkey && this.byHotkey.get(cmd.hotkey) === cmd) this.byHotkey.delete(cmd.hotkey);
  }

  /** Obsidian alias for `remove`. */
  removeCommand(id: string): void {
    this.remove(id);
  }

  has(id: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.commands, id);
  }

  findCommand(id: string): Command | undefined {
    return this.has(id) ? this.commands[id] : undefined;
  }

  execute(id: string): boolean {
    const cmd = this.has(id) ? this.commands[id] : undefined;
    if (!cmd || !isAvailable(cmd)) return false;
    run(cmd);
    return true;
  }

  /** Obsidian alias for `execute`. */
  executeCommandById(id: string): boolean {
    return this.execute(id);
  }

  /** Commands currently available, e.g. for the command palette. */
  list(): Command[] {
    return Object.values(this.commands)
      .filter(isAvailable)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Obsidian's `listCommands` — every registered command, unfiltered by
   * `checkCallback` availability (unlike `list()`, which backs the command
   * palette). Deliberate divergence: the palette should hide unavailable
   * commands, but a host tool enumerating "what commands exist" shouldn't.
   */
  listCommands(): Command[] {
    return Object.values(this.commands);
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
