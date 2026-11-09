/**
 * The artifact-root directory reserved for host-owned sidecar data (ADR 0006 D7).
 * Pure and dependency-free: this is layer 1 (lexical) of the layered deny. The
 * filesystem layers (realpath, inode walk) live in `src/main/artifact-reserved-dir.ts`.
 */
export const RESERVED_ARTIFACT_DIRNAME = ".threads-design";

const MAX_DECODE_ROUNDS = 4;
/** Soft hyphen, zero-width, word joiner, BOM, variation selectors, ...: filesystems may ignore these in names. */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const TRAILING_DOTS_AND_SPACES = /[. ]+$/;

/** Normal form used for comparing names the way a forgiving filesystem might. */
function foldName(segment: string): string {
  // NFKC first: case-insensitive volumes fold characters such as U+017F (long s) to "s",
  // and compatibility forms such as U+FF0E (fullwidth full stop) to ".".
  let folded = segment.normalize("NFKC").replace(IGNORABLE, "").toLowerCase();
  // Trailing dots and spaces are dropped by Windows-style name resolution; repeat once because
  // case mapping can expose new ones.
  folded = folded.replace(TRAILING_DOTS_AND_SPACES, "");
  return folded;
}

/** Segment as a path operator: ".", ".." or empty are structural, not names. Trailing dots are NOT stripped here. */
function structuralForm(segment: string): string {
  return segment.normalize("NFKC").replace(IGNORABLE, "");
}

function decodeForms(input: string): string[] {
  const forms = [input];
  let current = input;
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break; // malformed escape: nothing further to decode; earlier forms were still checked
    }
    if (next === current) break;
    forms.push(next);
    current = next;
  }
  return forms;
}

function firstSegmentIsReserved(form: string): boolean {
  const stack: string[] = [];
  for (const segment of form.replace(/\\/g, "/").split("/")) {
    const structural = structuralForm(segment);
    if (structural === "" || structural === ".") continue;
    if (structural === "..") {
      stack.pop();
      continue;
    }
    // Any segment that ever sits directly under the root is checked, even if a later ".." removes it.
    if (stack.length === 0 && foldName(segment) === RESERVED_ARTIFACT_DIRNAME) return true;
    stack.push(segment);
  }
  return false;
}

/**
 * Layer 1. True when `relativePath` (relative to the artifact root, in any state of percent-encoding)
 * could name `<root>/.threads-design` or something inside it. Only the first segment under the root is
 * reserved: a nested `sub/.threads-design/` is an ordinary directory. Over-matching is acceptable here
 * (the result is a 404); under-matching is not.
 */
export function isReservedArtifactPath(relativePath: string): boolean {
  return decodeForms(relativePath).some(firstSegmentIsReserved);
}
