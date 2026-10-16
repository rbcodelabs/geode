/** Same-length code mask with bounded passes over fences and backtick runs. */
export function maskMarkdownCode(text: string): string {
  const output = text.split("");
  const blank = (from: number, to: number) => {
    for (let index = from; index < to; index++) if (text[index] !== "\n" && text[index] !== "\r") output[index] = " ";
  };
  let fenceCharacter = "", fenceWidth = 0;
  for (let from = 0; from < text.length;) {
    const newline = text.indexOf("\n", from);
    const to = newline < 0 ? text.length : newline;
    let marker = from;
    while (marker < to && (text[marker] === " " || text[marker] === "\t")) marker++;
    const character = text[marker];
    let markerEnd = marker;
    if (character === "`" || character === "~") while (markerEnd < to && text[markerEnd] === character) markerEnd++;
    const width = markerEnd - marker;
    if (fenceWidth) {
      blank(from, to);
      if (character === fenceCharacter && width >= fenceWidth && !text.slice(markerEnd, to).trim()) fenceWidth = 0;
    } else if (width >= 3 && !(character === "`" && text.slice(markerEnd, to).includes("`"))) {
      fenceCharacter = character;
      fenceWidth = width;
      blank(from, to);
    }
    from = newline < 0 ? text.length : newline + 1;
  }

  const maskedFences = output.join("");
  const breaks = [...maskedFences.matchAll(/\n[ \t\r]*\n/g)].map(match => match.index! + match[0].length);
  const runs: { from: number; to: number; segment: number }[] = [];
  let segment = 0;
  for (let index = 0; index < maskedFences.length;) {
    while (segment < breaks.length && index >= breaks[segment]) segment++;
    if (maskedFences[index] !== "`") { index++; continue; }
    const from = index++;
    while (index < maskedFences.length && maskedFences[index] === "`") index++;
    runs.push({ from, to: index, segment });
  }
  // Pre-index the next equal delimiter in each paragraph. Searching forward
  // separately for every unmatched run would reintroduce quadratic work.
  const next = new Array<number>(runs.length).fill(-1);
  const byWidth = new Map<number, number>();
  let currentSegment = -1;
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index];
    if (run.segment !== currentSegment) { currentSegment = run.segment; byWidth.clear(); }
    const width = run.to - run.from;
    next[index] = byWidth.get(width) ?? -1;
    byWidth.set(width, index);
  }
  for (let index = 0; index < runs.length; index++) {
    const close = next[index];
    if (close < 0) continue;
    blank(runs[index].from, runs[close].to);
    index = close;
  }
  return output.join("");
}
