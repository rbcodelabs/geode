import type {
  InspectAnchorFocusBehavior,
  InspectAnchorRectsMessage,
  InspectAnchorResultsMessage,
} from "../../artifacts/inspector-protocol";
import type { AnchorSetOutcome } from "../views/artifact-inspector-bridge";

/**
 * Test hook for the guest anchors (Phase 2b-i G2). No pin UI exists yet, so this is how a unit or end-to-end test
 * drives `setAnchors`/`focusAnchor` on a live artifact view and reads what the validated guest messages said. It sits
 * on the embedder side only (the page cannot reach it), holds plain data, and is the seam G3 replaces with the real
 * pin overlay. `ArtifactView.anchorProbe` exposes it.
 */
export interface AnchorProbeSnapshot {
  readonly epoch: number;
  /** Validated messages in arrival order (the last 50). */
  readonly results: readonly InspectAnchorResultsMessage[];
  readonly rects: readonly InspectAnchorRectsMessage[];
  readonly resultCount: number;
  readonly rectCount: number;
}

export interface AnchorProbe {
  setAnchors(queries: readonly unknown[]): AnchorSetOutcome;
  focus(key: string, behavior: InspectAnchorFocusBehavior): boolean;
  snapshot(): AnchorProbeSnapshot;
  clear(): void;
}

interface ProbeBridge {
  readonly anchorEpoch: number;
  setAnchors(queries: readonly unknown[]): AnchorSetOutcome;
  focusAnchor(key: string, behavior: InspectAnchorFocusBehavior): boolean;
}

const KEEP = 50;

export function createAnchorProbe(bridge: ProbeBridge): { probe: AnchorProbe; onResults(message: InspectAnchorResultsMessage): void; onRects(message: InspectAnchorRectsMessage): void } {
  let results: InspectAnchorResultsMessage[] = [];
  let rects: InspectAnchorRectsMessage[] = [];
  let resultCount = 0;
  let rectCount = 0;
  const probe: AnchorProbe = {
    setAnchors: (queries) => bridge.setAnchors(queries),
    focus: (key, behavior) => bridge.focusAnchor(key, behavior),
    snapshot: () => ({ epoch: bridge.anchorEpoch, results: results.slice(), rects: rects.slice(), resultCount, rectCount }),
    clear() { results = []; rects = []; resultCount = 0; rectCount = 0; },
  };
  return {
    probe,
    onResults(message) { resultCount++; results = [...results, message].slice(-KEEP); },
    onRects(message) { rectCount++; rects = [...rects, message].slice(-KEEP); },
  };
}
