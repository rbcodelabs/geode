import type { ArtifactCommentStatus } from "../../artifacts/feedback-contract-v2";

/**
 * Pin geometry and the badge collapse algorithm (design 3.5, ADR 0006 Addendum 1 A.5). Pure, DOM-free, O(n) for the
 * at most 100 pins an artifact tracks.
 *
 * `guestRectToStage` and `badgeAnchorPoint` are the ONE replaceable mapping unit between what the guest measures and
 * where the embedder draws a badge OR the selection box. Spike S2 (Retina MacBook, DPR 2) measured the old mapping
 * (rounded, origin at the webview border box) off by up to 1.6 css px under viewport presets and app zoom, and the
 * unrounded, border-corrected, guest-to-embedder-scaled mapping below within 0.625 css px everywhere. Nothing here is
 * claimed verified at DPR 2 until the orchestrator re-runs S2 on the Mac.
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
  /** The webview's content box size in embedder css px (clientWidth/clientHeight); with the guest viewport it gives the scale. */
  readonly clientWidth?: number;
  readonly clientHeight?: number;
}
/** The guest's window.innerWidth/innerHeight in its own css px, as the guest reports it. */
export interface GuestViewport { readonly width: number; readonly height: number }

/** A ratio outside this range is a broken measurement (a hidden or half-laid-out webview), not a zoom level. */
const SCALE_MIN = 0.1;
const SCALE_MAX = 10;
const MAX_VIEWPORT = 1e6;

/**
 * Guest css px to embedder css px, per axis: the webview content box over the guest viewport (S2 'scaled'). It is 1 when
 * nothing differs, and also 1 whenever an input is missing or implausible, so a bad report never throws a badge off screen.
 */
export function guestScale(frame: FrameOrigin, viewport: GuestViewport | null | undefined): { x: number; y: number } {
  const axis = (client: number | undefined, guest: number | undefined): number => {
    if (client === undefined || guest === undefined) return 1;
    if (!(Number.isFinite(client) && client > 0 && Number.isFinite(guest) && guest > 0 && guest <= MAX_VIEWPORT)) return 1;
    const k = client / guest;
    return k >= SCALE_MIN && k <= SCALE_MAX ? k : 1;
  };
  return { x: axis(frame.clientWidth, viewport?.width), y: axis(frame.clientHeight, viewport?.height) };
}

/**
 * Guest viewport CSS px to stage-relative embedder px. Unrounded, border-corrected (the webview's bounding rect
 * includes its border while guest content starts inside it) and scaled by the guest-to-embedder ratio (S2: app zoom and
 * viewport presets make the guest's css px differ from the embedder's; the old mapping assumed 1 and missed by up to
 * 1.6 css px). Without a `viewport` the scale is 1.
 */
export function guestRectToStage(
  rect: BoxRect,
  frame: FrameOrigin,
  stage: { readonly left: number; readonly top: number },
  viewport?: GuestViewport | null,
): BoxRect {
  const k = guestScale(frame, viewport);
  return {
    x: frame.left + frame.clientLeft - stage.left + rect.x * k.x,
    y: frame.top + frame.clientTop - stage.top + rect.y * k.y,
    width: rect.width * k.x,
    height: rect.height * k.y,
  };
}

/** The selection box: the same mapping as the pins, unrounded, and never thinner than 2 px so it stays visible. */
export function selectionBoxToStage(
  rect: BoxRect,
  frame: FrameOrigin,
  stage: { readonly left: number; readonly top: number },
  viewport?: GuestViewport | null,
): { left: number; top: number; width: number; height: number } {
  const box = guestRectToStage(rect, frame, stage, viewport);
  return { left: box.x, top: box.y, width: Math.max(2, box.width), height: Math.max(2, box.height) };
}

/** Whether a stage-relative box intersects the visible stage at all (a webview larger than the pane clips). */
export function intersectsStage(box: BoxRect, stage: { readonly width: number; readonly height: number }): boolean {
  if (!(box.width > 0 && box.height > 0)) return false;
  return box.x + box.width > 0 && box.x < stage.width && box.y + box.height > 0 && box.y < stage.height;
}

const finite = (n: number, fallback: number): number => (Number.isFinite(n) ? n : fallback);

/**
 * The badge centre for an element's stage-relative box: its top-right, offset (-4, +4), clamped so the WHOLE badge stays
 * `edgeMargin` px inside the stage (a centre on the edge would leave half the badge clipped by the overlay).
 */
export function badgeAnchorPoint(box: BoxRect, stage: { readonly width: number; readonly height: number }): { x: number; y: number } {
  const inset = PIN_BADGE.edgeMargin + PIN_BADGE.diameter / 2;
  const clamp = (v: number, max: number): number => Math.min(Math.max(inset, v), Math.max(inset, max - inset));
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
