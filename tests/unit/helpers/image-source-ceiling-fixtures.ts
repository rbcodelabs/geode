/** Exact original performance fixtures, pinned before characterization relocation. */
export function completeImageSourceCases() {
  const size = 300_000;
  return {
    unmatchedOpeners: "[".repeat(size),
    nestedDelimiters: "[".repeat(size / 2) + "]".repeat(size / 2),
    unmatchedImages: "![".repeat(size / 2),
    ordinaryWhitespace: "alpha " + " ".repeat(size - 26) + "omega ![[Photo.png]]",
    prose: ("ordinary words and punctuation. ".repeat(10_000)).slice(0, size - 14) + "![[Photo.png]]",
    denseImages: "![[Photo.png]] ".repeat(20_000),
  };
}
