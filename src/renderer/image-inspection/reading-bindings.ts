import { isImageProjectionCurrent, type OwnedImageOccurrence, type OwnedImageProjection } from "./source";

interface MarkerNode {
  readonly tagName: string;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
}
const attribute = "data-geode-image-occurrence";
const escapeAttribute = (value: string) => value.replace(/[&<>"'\n]/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "\n": "&#10;",
}[character]!));
function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Unwired: only a future owned Markdown render may supply nodes to this map. */
export function prepareOwnedImageReading(projection: OwnedImageProjection, currentSource: string) {
  const check = (source: string) => {
    if (!isImageProjectionCurrent(projection, source)) throw new Error("Stale owned image snapshot.");
  };
  check(currentSource);
  const markers = new Map<string, OwnedImageOccurrence>();
  const chunks: string[] = [];
  let nonce = "";
  for (let attempt = 0; attempt < 8; attempt++) {
    nonce = mintToken();
    if (!projection.source.includes(nonce)) break;
    nonce = "";
  }
  if (!nonce) throw new Error("Could not mint a unique image marker.");
  let offset = 0;
  for (const occurrence of projection.occurrences) {
    if (occurrence.from < offset || occurrence.to <= occurrence.from || occurrence.to > projection.source.length) {
      throw new Error("Overlapping image source markers are unsupported.");
    }
    // One source collision check per nonce avoids rescanning a dense gallery
    // separately for every image. The absent prefix proves each token absent.
    const token = nonce + markers.size.toString(16).padStart(8, "0");
    markers.set(token, occurrence);
    chunks.push(projection.source.slice(offset, occurrence.from), `<span ${attribute}="${token}"></span>`);
    offset = occurrence.to;
  }
  chunks.push(projection.source.slice(offset));
  const source = chunks.join("");
  const ownedNodes = new WeakMap<MarkerNode, OwnedImageOccurrence>();
  let materialized = false, bound = false;
  return Object.freeze({
    source,
    materialize(transformed: string, snapshot: string): string {
      check(snapshot);
      if (materialized) throw new Error("Image markers were already materialized.");
      const seen = new Set<string>();
      const html = transformed.replace(/<span data-geode-image-occurrence="([^"]*)"><\/span>/g, (_marker, token: string) => {
        const occurrence = markers.get(token);
        if (!occurrence || seen.has(token)) throw new Error("Unknown or duplicate image marker.");
        seen.add(token);
        return `<img ${attribute}="${token}" alt="${escapeAttribute(occurrence.label)}" title="${escapeAttribute(occurrence.title)}">`;
      });
      if (seen.size !== markers.size) throw new Error("Image marker was lost during transformation.");
      materialized = true;
      return html;
    },
    bind(nodes: readonly MarkerNode[], snapshot: string): boolean {
      const tokens = nodes.map(node => node.getAttribute(attribute));
      // Even rejected or replayed markers must not remain in the published DOM.
      for (const node of nodes) node.removeAttribute(attribute);
      if (bound) return false;
      bound = true;
      if (!materialized || !isImageProjectionCurrent(projection, snapshot)
        || nodes.length !== markers.size || new Set(nodes).size !== nodes.length
        || new Set(tokens).size !== tokens.length
        || nodes.some((node, index) => node.tagName !== "IMG" || !markers.has(tokens[index] ?? ""))) return false;
      nodes.forEach((node, index) => ownedNodes.set(node, markers.get(tokens[index]!)!));
      return true;
    },
    lookup(node: MarkerNode, snapshot: string): OwnedImageOccurrence | null {
      return isImageProjectionCurrent(projection, snapshot) ? ownedNodes.get(node) ?? null : null;
    },
  });
}
