import type { ArtifactComment, ArtifactCommentsSnapshot } from "../../../src/artifacts/feedback-contract-v2";

/** Builders for the G3 pin and rail unit tests. Plain data, no behavior. */
const hex = (n: number): string => n.toString(16).padStart(32, "0");

export function comment(ordinal: number, over: Partial<ArtifactComment> = {}): ArtifactComment {
  return {
    id: `cmt_${hex(ordinal)}`,
    selectionId: `sel_${hex(ordinal)}`,
    ordinal,
    version: 1,
    kind: "pin",
    status: "open",
    provenance: "local",
    text: `Comment text ${ordinal}`,
    createdAt: "2026-11-12T10:00:00.000Z",
    updatedAt: "2026-11-12T10:00:00.000Z",
    sentAt: null,
    artifactRevision: 1,
    viewSessionId: "view-1",
    anchor: {
      route: "/index.html",
      tag: "button",
      selector: `#b${ordinal}`,
      selectorAlternates: [],
      textAnchor: { tag: "button", text: `Button ${ordinal}` },
      landmark: null,
      lastRect: null,
    },
    label: `button Button ${ordinal}`,
    hasScreenshot: false,
    redacted: false,
    send: { attempts: 0, lastOutcome: null, maybeSent: false, lastMessage: null },
    ...over,
  };
}

export function snapshot(comments: readonly ArtifactComment[], over: Partial<ArtifactCommentsSnapshot> = {}): ArtifactCommentsSnapshot {
  return {
    storeId: "str_" + "0".repeat(32),
    revision: 1,
    health: "ok",
    notice: null,
    comments,
    foreignCount: comments.filter((c) => c.provenance === "foreign").length,
    ...over,
  };
}

export const idOf = (ordinal: number): string => `cmt_${hex(ordinal)}`;
