import type { ArtifactCommentStatus } from "../../artifacts/feedback-contract-v2";

/**
 * Pin geometry and the badge collapse algorithm (design 3.5, ADR 0006 Addendum 1 A.5). Pure, DOM-free, O(n) for the
 * at most 100 pins an artifact tracks.
 *
 * `guestRectToStage` and `badgeAnchorPoint` are the ONE replaceable mapping unit between what the guest measures and
 * where the embedder draws a badge. Spike S2 (overlay mapping on a real Retina Mac) decides whether this mapping needs
 * a correction at DPR 2; until it has run there, nothing here is claimed verified at DPR 2.
 */

export const PIN_BADGE = {
  diameter: 20,
  /** Two pins closer than this merge. */
  mergeDistance: 22,
  /** Two pins that were merged last pass split only when farther apart than this (hysteresis). */
  splitDistance: 28,
  /** Badge anchor offset from the element's top-right corner, and the margin it keeps from the stage edge. */
  offsetX: -4,
  offsetY: 4,
  edgeMargin: 2,
  /** The guest tracks at most this many anchors. */
  maxPins: 100,
} as const;

export interface BoxRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface FrameOrigin {
  /** The webview element's border box, viewport px (getBoundingClientRect). */
  readonly left: number;
  readonly top: number;
  /** The webview's border widths (clientLeft/clientTop): guest content starts inside the border (S2). Never hard-coded. */
  readonly clientLeft: number;
  readonly clientTop: number;
}

/**
 * Guest viewport CSS px to stage-relative px. Unrounded and border-corrected (S2 mechanics check: the webview's
 * bounding rect includes its border while guest content starts inside it; Math.round adds up to 1 css px of error).
 * Guest rects are already in embedder CSS px under app zoom, so there is no scale factor here.
 */
export function guestRectToStage(rect: BoxRect, frame: FrameOrigin, stage: { readonly left: number; readonly top: number }): BoxRect {
  return {
    x: frame.left + frame.clientLeft - stage.left + rect.x,
    y: frame.top + frame.clientTop - stage.top + rect.y,
    width: rect.width,
    height: rect.height,
  };
}

/** Whether a stage-relative box intersects the visible stage at all (a webview larger than the pane clips). */
export function intersectsStage(box: BoxRect, stage: { readonly width: number; readonly height: number }): boolean {
  if (!(box.width > 0 && box.height > 0)) return false;
  return box.x + box.width > 0 && box.x < stage.width && box.y + box.height > 0 && box.y < stage.height;
}

const finite = (n: number, fallback: number): number => (Number.isFinite(n) ? n : fallback);

/** The badge point for an element's stage-relative box: its top-right, offset (-4, +4), clamped 2 px inside the stage. */
export function badgeAnchorPoint(box: BoxRect, stage: { readonly width: number; readonly height: number }): { x: number; y: number } {
  const m = PIN_BADGE.edgeMargin;
  const clamp = (v: number, max: number): number => Math.min(Math.max(m, v), Math.max(m, max - m));
  return {
    x: clamp(finite(box.x, 0) + finite(box.width, 0) + PIN_BADGE.offsetX, finite(stage.width, 0)),
    y: clamp(finite(box.y, 0) + PIN_BADGE.offsetY, finite(stage.height, 0)),
  };
}

export interface PlacedPin {
  readonly id: string;
  readonly ordinal: number;
  readonly status: ArtifactCommentStatus;
  readonly x: number;
  readonly y: number;
  /** An unconfirmed placement (agrees:false): drawn hollow with a tilde. */
  readonly approximate: boolean;
}

export interface Badge {
  readonly kind: "pin" | "cluster";
  /** Cluster identity: the sorted member ids (a single pin's key is its id). */
  readonly key: string;
  readonly ids: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly ordinal?: number;
  readonly count?: number;
  /** The most urgent member status. */
  readonly status: ArtifactCommentStatus;
  readonly approximate: boolean;
  readonly z: number;
}

export interface CollapseResult {
  readonly badges: readonly Badge[];
  /** pin id -> cluster key, fed back as `previous` on the next pass for hysteresis. */
  readonly assignment: ReadonlyMap<string, string>;
}

const STATUS_RANK: Record<ArtifactCommentStatus, number> = { open: 4, pending: 4, sent: 3, resolved: 1, dismissed: 1 };
const CLUSTER_Z = 40;
const clusterKeyOf = (ids: readonly string[]): string => (ids.length === 1 ? ids[0]! : [...ids].sort().join("|"));

/**
 * Overlapping badges collapse into a count badge. Pins closer than `mergeDistance` merge (`splitDistance` if they were
 * in the same cluster last pass, so scrolling cannot flicker); merging is transitive (union-find over a grid of cell
 * size `splitDistance`, so each pin tests only its 3x3 neighbour cells).
 */
export function collapsePins(input: readonly PlacedPin[], previous: ReadonlyMap<string, string> | null): CollapseResult {
  const pins = input.slice(0, PIN_BADGE.maxPins);
  const n = pins.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]!; }
    return i;
  };
  const cell = PIN_BADGE.splitDistance;
  const grid = new Map<string, number[]>();
  const cellOf = (p: PlacedPin): [number, number] => [Math.floor(p.x / cell), Math.floor(p.y / cell)];
  pins.forEach((p, i) => {
    const [cx, cy] = cellOf(p);
    const k = `${cx},${cy}`;
    const bucket = grid.get(k);
    if (bucket) bucket.push(i); else grid.set(k, [i]);
  });
  const wasTogether = (a: PlacedPin, b: PlacedPin): boolean => {
    if (!previous) return false;
    const ka = previous.get(a.id);
    return ka !== undefined && ka === previous.get(b.id) && ka.includes("|");
  };
  pins.forEach((p, i) => {
    const [cx, cy] = cellOf(p);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`);
        if (!bucket) continue;
        for (const j of bucket) {
          if (j <= i) continue;
          const q = pins[j]!;
          const limit = wasTogether(p, q) ? PIN_BADGE.splitDistance : PIN_BADGE.mergeDistance;
          if (Math.hypot(p.x - q.x, p.y - q.y) < limit) parent[find(i)] = find(j);
        }
      }
    }
  });
  const groups = new Map<number, PlacedPin[]>();
  pins.forEach((p, i) => {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(p); else groups.set(root, [p]);
  });
  const badges: Badge[] = [];
  const assignment = new Map<string, string>();
  for (const members of groups.values()) {
    const ids = members.map((m) => m.id).sort();
    const key = clusterKeyOf(ids);
    for (const id of ids) assignment.set(id, key);
    const status = members.reduce((best, m) => (STATUS_RANK[m.status] > STATUS_RANK[best] ? m.status : best), members[0]!.status);
    const approximate = members.every((m) => m.approximate);
    if (members.length === 1) {
      const m = members[0]!;
      badges.push({ kind: "pin", key, ids, x: m.x, y: m.y, ordinal: m.ordinal, status: m.status, approximate: m.approximate, z: STATUS_RANK[m.status] * 4 });
    } else {
      const x = members.reduce((s, m) => s + m.x, 0) / members.length;
      const y = members.reduce((s, m) => s + m.y, 0) / members.length;
      badges.push({ kind: "cluster", key, ids, x, y, count: members.length, status, approximate, z: CLUSTER_Z });
    }
  }
  badges.sort((a, b) => a.y - b.y || a.x - b.x || (a.key < b.key ? -1 : 1));
  return { badges, assignment };
}
