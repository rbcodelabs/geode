/**
 * Locating and rewriting embedded ```base code blocks inside a Markdown
 * note's source text. An embedded base is a fenced code block whose info
 * string is exactly `base`; its body is the same YAML a standalone `.base`
 * file holds. Pure string operations — no DOM, no vault — so both the
 * renderer (to read blocks) and the persist path (to write an edited block
 * back) share one implementation.
 */

export interface BaseBlock {
  /** The YAML body between the fences (no trailing newline). */
  yaml: string;
  /** 0-based line index of the opening fence. */
  openLine: number;
  /** 0-based line index of the closing fence. */
  closeLine: number;
}

const OPEN_FENCE = /^(\s*)(`{3,}|~{3,})base[ \t]*$/;

/** Find every ```base block in `text`, in document order. */
export function findBaseBlocks(text: string): BaseBlock[] {
  const lines = text.split("\n");
  const blocks: BaseBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(OPEN_FENCE);
    if (!open) continue;
    const [, indent, fence] = open;
    const closeRe = new RegExp(`^${indent}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closeRe.test(lines[j])) {
        close = j;
        break;
      }
    }
    if (close === -1) continue; // unterminated fence — skip
    const body = lines.slice(i + 1, close).map((l) => l.slice(indent.length)).join("\n");
    blocks.push({ yaml: body, openLine: i, closeLine: close });
    i = close;
  }
  return blocks;
}

/**
 * Replace the YAML body of the `index`-th ```base block with `newYaml`,
 * preserving the fence lines and the block's indentation, and everything
 * outside the block. Returns `text` unchanged if there is no such block.
 */
export function replaceNthBaseBlock(text: string, index: number, newYaml: string): string {
  const blocks = findBaseBlocks(text);
  const block = blocks[index];
  if (!block) return text;
  const lines = text.split("\n");
  const indent = lines[block.openLine].match(OPEN_FENCE)?.[1] ?? "";
  const newBody = newYaml.replace(/\n+$/, "").split("\n").map((l) => indent + l);
  const before = lines.slice(0, block.openLine + 1);
  const after = lines.slice(block.closeLine);
  return [...before, ...newBody, ...after].join("\n");
}
