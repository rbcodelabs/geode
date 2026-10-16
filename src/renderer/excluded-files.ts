import type { DeviceStateService } from "./host/contracts";

/** Intentionally small regex grammar: no groups, alternation, braces or backreferences;
 * at most one unbounded repetition. Bounded pattern/input sizes avoid runaway scans. */
export function compileExcludedFiles(patterns: readonly string[]): (path: string) => boolean {
  if (patterns.length > 100) throw new Error("Use at most 100 excluded paths or patterns.");
  const rules = patterns.filter(value => value.trim()).map(value => {
    value = value.trim();
    if (value.startsWith("/")) {
      const end = value.lastIndexOf("/");
      const body = value.slice(1, end), flags = value.slice(end + 1);
      if (end <= 1 || body.length > 128 || !/^(i)?$/.test(flags)) throw new Error("Use /pattern/ or /pattern/i, up to 128 characters.");
      let inClass = false, repetitions = 0;
      for (let i = 0; i < body.length; i++) {
        const char = body[i];
        if (char === "\\") { if (++i >= body.length || /[1-9kp]/.test(body[i])) throw new Error("Unsupported regular-expression escape."); continue; }
        if (char === "[") inClass = true;
        else if (char === "]") inClass = false;
        else if (!inClass && /[(){}|?]/.test(char)) throw new Error("Groups, alternation, braces and optional repetition are unsupported.");
        else if (!inClass && /[*+]/.test(char) && ++repetitions > 1) throw new Error("Use at most one * or + repetition per pattern.");
      }
      const expression = new RegExp(body, flags);
      return (path: string) => expression.test(path.slice(0, 4096));
    }
    const path = value.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!path || path.length > 4096 || path.split("/").some(part => part === ".." || part === "." || !part)) throw new Error("Use a vault-relative file or folder path.");
    return (candidate: string) => candidate === path || candidate.startsWith(path + "/");
  });
  return path => rules.some(matches => matches(path.replace(/\\/g, "/")));
}

/** Device-local per-vault preferences; unrelated to sync scope exclusions. */
export class ExcludedFiles {
  patterns: readonly string[] = [];
  matches: (path: string) => boolean = () => false;
  readonly ready: Promise<void>;
  private listeners = new Set<() => void>();
  private readonly key: string;
  constructor(private state: DeviceStateService, root: string) {
    this.key = `excluded-files:${root}`;
    this.ready = this.load();
  }
  private async load(): Promise<void> {
    const value = await this.state.read<unknown>(this.key);
    if (value === null) return;
    if (!Array.isArray(value) || !value.every(pattern => typeof pattern === "string")) throw new Error("Excluded files settings are invalid.");
    this.matches = compileExcludedFiles(value);
    this.patterns = value;
  }
  async save(patterns: string[]): Promise<void> {
    await this.ready;
    const matches = compileExcludedFiles(patterns);
    await this.state.write(this.key, patterns);
    this.patterns = [...patterns]; this.matches = matches;
    for (const listener of this.listeners) listener();
  }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
