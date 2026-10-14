/**
 * Pure Slides logic: splitting a note into slides, and the presentation's
 * navigation state. No DOM, so it is unit-testable.
 */

const FRONTMATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const SEPARATOR_RE = /^---[ \t]*$/;

function isBlank(line: string | undefined): boolean {
  return line !== undefined && line.trim() === "";
}

/**
 * Split a note into slides. A separator is a line that is exactly `---` with a
 * blank line both before and after it. That rule alone already excludes the
 * frontmatter delimiters (no blank line around them), table rules (`|---|`)
 * and setext headings (text directly above). The remaining hazards are handled
 * explicitly: frontmatter is dropped, and separators inside fenced code
 * (``` or ~~~) or a `$$` math block are left alone. Slides that are empty after
 * trimming are discarded so doubled separators never produce a blank slide.
 */
export function splitSlides(markdown: string): string[] {
  const body = markdown.replace(FRONTMATTER_RE, "");
  const lines = body.split(/\r?\n/);
  const slides: string[] = [];
  let current: string[] = [];
  let fence: { char: string; len: number } | null = null;
  let inMath = false;

  const flush = () => {
    const text = current.join("\n").trim();
    if (text) slides.push(text);
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
    } else if (inMath) {
      if (line.includes("$$")) inMath = false;
    } else {
      const open = FENCE_OPEN_RE.exec(line);
      if (open) {
        fence = { char: open[1][0], len: open[1].length };
      } else if (/^\s*\$\$/.test(line) && (line.match(/\$\$/g) ?? []).length === 1) {
        inMath = true;
      } else if (SEPARATOR_RE.test(line) && i > 0 && isBlank(lines[i - 1]) && isBlank(lines[i + 1])) {
        flush();
        continue;
      }
    }
    current.push(line);
  }
  flush();
  return slides;
}

/** Index/edge-state bookkeeping for a presentation. */
export class SlidesState {
  private idx = 0;

  constructor(readonly count: number) {}

  get index(): number {
    return this.idx;
  }

  get canPrevious(): boolean {
    return this.idx > 0;
  }

  get canNext(): boolean {
    return this.idx < this.count - 1;
  }

  /** Advance one slide; returns whether the index changed. */
  next(): boolean {
    if (!this.canNext) return false;
    this.idx++;
    return true;
  }

  previous(): boolean {
    if (!this.canPrevious) return false;
    this.idx--;
    return true;
  }
}
