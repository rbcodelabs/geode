export interface Command {
  id: string;
  name: string;
  hotkey?: string; // e.g. "Mod+P", "Mod+Shift+F"
  callback: () => void;
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

export class CommandRegistry {
  commands = new Map<string, Command>();
  private byHotkey = new Map<string, Command>();

  add(command: Command) {
    this.commands.set(command.id, command);
    if (command.hotkey) this.byHotkey.set(command.hotkey, command);
  }

  execute(id: string): boolean {
    const cmd = this.commands.get(id);
    if (!cmd) return false;
    cmd.callback();
    return true;
  }

  list(): Command[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Install the global hotkey listener. */
  attach(target: Document) {
    target.addEventListener(
      "keydown",
      (e) => {
        const combo = eventToHotkey(e);
        if (!combo) return;
        const cmd = this.byHotkey.get(combo);
        if (cmd) {
          e.preventDefault();
          e.stopPropagation();
          cmd.callback();
        }
      },
      true
    );
  }
}
