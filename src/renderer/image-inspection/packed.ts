/** Private, transferable source descriptors. No file or occurrence authority. */
export const ABSENT_SPAN = 0xffffffff;
export const IMAGE_FLAGS = { wiki: 1, direct: 2, reference: 4, linked: 8 } as const;
export interface PackedImageSource {
  version: 1;
  sourceUnits: number;
  candidates: Uint32Array;
  definitions: Uint32Array;
  issues: Uint32Array;
}
export class ImageParserProtocolError extends Error {
  constructor() { super("Invalid isolated image-parser result."); this.name = "ImageParserProtocolError"; }
}
const invalid = (): never => { throw new ImageParserProtocolError(); };
function table(value: unknown, width: number, sourceUnits: number): Uint32Array {
  if (!(value instanceof Uint32Array) || !(value.buffer instanceof ArrayBuffer)) return invalid();
  // Constructing a view distinguishes detached zero-length buffers from valid
  // empty payloads. Shared buffers and partial views are not transfer ownership.
  try { new Uint8Array(value.buffer); } catch { return invalid(); }
  if (value.byteOffset !== 0 || value.byteLength !== value.buffer.byteLength || value.length % width || value.length / width > sourceUnits) return invalid();
  return value;
}
export function validatePackedImages(source: string, value: unknown): PackedImageSource {
  if (source.length > 300_000 || source.includes("\r") || !value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 5 || !["version", "sourceUnits", "candidates", "definitions", "issues"].every(key => Object.hasOwn(record, key)) || record.version !== 1 || record.sourceUnits !== source.length) return invalid();
  const candidates = table(record.candidates, 12, source.length), definitions = table(record.definitions, 6, source.length), issues = table(record.issues, 3, source.length);
  if (candidates.byteLength + definitions.byteLength + issues.byteLength > 32 * 1024 * 1024) return invalid();
  const span = (from: number, to: number, optional = false, start = 0, end = source.length): boolean => {
    if (from === ABSENT_SPAN || to === ABSENT_SPAN) { if (optional && from === to) return false; return invalid(); }
    if (from > to || from < start || to > end) return invalid();
    return true;
  };
  const uniqueDefinitions = new Set<string>();
  for (let i = 0; i < definitions.length; i += 6) {
    span(definitions[i], definitions[i+1]); span(definitions[i+2], definitions[i+3]); span(definitions[i+4], definitions[i+5], true);
    const key = Array.from(definitions.subarray(i, i+6)).join(":");
    if (uniqueDefinitions.has(key)) return invalid(); uniqueDefinitions.add(key);
  }
  const usedDefinitions = new Set<number>();
  let end = 0;
  for (let i = 0; i < candidates.length; i += 12) {
    const [from, to, labelFrom, labelTo, targetFrom, targetTo, titleFrom, titleTo, definition, flags, reservedA, reservedB] = candidates.subarray(i, i+12);
    span(from, to); if (from >= to || from < end || reservedA || reservedB || flags > 15) return invalid(); end = to;
    const syntax = flags & 7;
    if (![IMAGE_FLAGS.wiki, IMAGE_FLAGS.direct, IMAGE_FLAGS.reference].includes(syntax as 1 | 2 | 4)) return invalid();
    span(labelFrom, labelTo, false, from, to);
    span(titleFrom, titleTo, true, from, to);
    if (syntax === IMAGE_FLAGS.reference) {
      if (targetFrom !== ABSENT_SPAN || targetTo !== ABSENT_SPAN || definition >= definitions.length / 6) return invalid();
      usedDefinitions.add(definition);
    } else {
      if (definition !== ABSENT_SPAN) return invalid();
      span(targetFrom, targetTo, false, from, to);
    }
  }
  if (usedDefinitions.size !== definitions.length / 6) return invalid();
  for (let i = 0; i < issues.length; i += 3) { span(issues[i], issues[i+1]); if (issues[i] >= issues[i+1] || issues[i+2] !== 1) return invalid(); }
  return { version: 1, sourceUnits: source.length, candidates, definitions, issues };
}
