import moment from "moment";
import type { ConfigService } from "./host/contracts";

export type TextAfterExtraction = "link" | "embed" | "none";
export type ComposerPlacement = "append" | "prepend" | "new";

export interface NoteComposerOptions {
  /** Show a confirmation modal before a merge removes the source note. */
  askBeforeMerging: boolean;
  /** What replaces extracted text in the source note. */
  textAfterExtraction: TextAfterExtraction;
  /** Vault-relative path of a template applied to newly created destination notes. "" = none. */
  template: string;
}

export interface NoteComposerConfig extends NoteComposerOptions {
  enabled: boolean;
}

const EXTRACTION_MODES: readonly TextAfterExtraction[] = ["link", "embed", "none"];

/** Validate persisted Note composer config one field at a time, applying Obsidian's defaults. */
export function resolveNoteComposerConfig(raw: unknown): NoteComposerConfig {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const mode = record.textAfterExtraction;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    askBeforeMerging: typeof record.askBeforeMerging === "boolean" ? record.askBeforeMerging : true,
    textAfterExtraction: EXTRACTION_MODES.includes(mode as TextAfterExtraction) ? (mode as TextAfterExtraction) : "link",
    template: typeof record.template === "string" ? record.template.trim() : "",
  };
}

/** Map a picker keystroke to a placement: Enter appends, Shift+Enter prepends, Ctrl/Cmd+Enter creates a new note. */
export function placementForKey(evt: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean }): ComposerPlacement {
  if (evt.metaKey || evt.ctrlKey) return "new";
  if (evt.shiftKey) return "prepend";
  return "append";
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Length of a leading YAML frontmatter block (including its trailing newline), or 0. */
function frontmatterLength(text: string): number {
  const match = FRONTMATTER_RE.exec(text);
  return match ? match[0].length : 0;
}

function trimTrailingNewlines(text: string): string {
  return text.replace(/\s+$/, "");
}

/**
 * Join `incoming` onto `destination`. Append puts it at the end; prepend puts
 * it after the destination's frontmatter (so properties stay at the top) and
 * before its body. Blocks are separated by a blank line.
 */
export function combineNotes(destination: string, incoming: string, placement: "append" | "prepend"): string {
  const addition = trimTrailingNewlines(incoming);
  if (placement === "append") {
    const base = trimTrailingNewlines(destination);
    if (!base) return `${addition}\n`;
    if (!addition) return destination;
    return `${base}\n\n${addition}\n`;
  }
  const split = frontmatterLength(destination);
  const head = destination.slice(0, split);
  const body = destination.slice(split).replace(/^\s+/, "");
  if (!addition) return destination;
  if (!body) return `${head}${addition}\n`;
  return `${head}${addition}\n\n${body}`;
}

/**
 * Expand a Note composer template. `{{content}}` receives the merged or
 * extracted text; if the template omits it, the content is appended at the
 * bottom. One pass, so variable-looking text inside the content or titles is
 * never expanded a second time.
 */
export function renderComposerTemplate(
  template: string,
  vars: { content: string; fromTitle: string; newTitle: string; now: moment.Moment }
): string {
  let usedContent = false;
  // The template owns the newline after {{content}}.
  const content = trimTrailingNewlines(vars.content);
  const rendered = template.replace(/\{\{(content|fromTitle|newTitle|date:([^}]*))\}\}/g, (_token, name: string, format?: string) => {
    if (name === "content") { usedContent = true; return content; }
    if (name === "fromTitle") return vars.fromTitle;
    if (name === "newTitle") return vars.newTitle;
    return vars.now.format(format ?? "");
  });
  if (usedContent) return rendered;
  const base = trimTrailingNewlines(rendered);
  return base ? `${base}\n\n${content}\n` : `${content}\n`;
}

/** The text that replaces extracted content in the source note. */
export function extractionReplacement(mode: TextAfterExtraction, linkTarget: string): string {
  if (mode === "link") return `[[${linkTarget}]]`;
  if (mode === "embed") return `![[${linkTarget}]]`;
  return "";
}

/**
 * Link target for a note: its basename, or the extensionless path when another
 * note shares that basename (so the link still resolves to the right file).
 */
export function composerLinkTarget(file: { path: string; basename: string }, allPaths: readonly string[]): string {
  const base = file.basename.toLowerCase();
  const clashes = allPaths.filter((p) => {
    const name = p.slice(p.lastIndexOf("/") + 1).replace(/\.md$/i, "").toLowerCase();
    return name === base;
  });
  return clashes.length > 1 ? file.path.replace(/\.md$/i, "") : file.basename;
}

export class NoteComposerService {
  enabled = true;
  readonly options: NoteComposerOptions = { askBeforeMerging: true, textAfterExtraction: "link", template: "" };
  private pendingUpdate: Promise<void> = Promise.resolve();

  constructor(private readonly config: ConfigService) {}

  async load(): Promise<void> {
    this.apply(resolveNoteComposerConfig(await this.config.read("note-composer")));
  }

  update(patch: Partial<NoteComposerConfig>): Promise<void> {
    const operation = this.pendingUpdate.then(async () => {
      const next = resolveNoteComposerConfig({ enabled: this.enabled, ...this.options, ...patch });
      await this.config.write("note-composer", next);
      this.apply(next);
    });
    this.pendingUpdate = operation.catch(() => {});
    return operation;
  }

  private apply(config: NoteComposerConfig): void {
    this.enabled = config.enabled;
    Object.assign(this.options, {
      askBeforeMerging: config.askBeforeMerging,
      textAfterExtraction: config.textAfterExtraction,
      template: config.template,
    });
  }
}
