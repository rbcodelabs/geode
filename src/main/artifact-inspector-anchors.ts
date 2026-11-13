import { isRestrictedSelector } from "../artifacts/anchor-selector";
import { ownField, plainBag, sanitizeAnchorQuery } from "../artifacts/anchor-query";
import type { Rect } from "../artifacts/feedback-contract";
import {
  INSPECT_CHANNEL,
  INSPECTOR_CAPS,
  type InspectAnchorFocusBehavior,
  type InspectAnchorQuery,
  type InspectAnchorRect,
  type InspectAnchorResult,
} from "../artifacts/inspector-protocol";

/**
 * Guest-side anchor tracker for pinned comments (ADR 0006 addendum 2, Phase 2b-i). It lives in the preload, in the
 * isolated world, so it uses the natives the guest captured at document start and the page cannot reach or patch
 * anything it calls. It resolves stored anchors (page-derived data the embedder hands over) to elements and reports
 * ENUMS AND RECTS only; comment text, ids, ordinals and status never reach this file.
 *
 * Resolution, per anchor, first success wins:
 *   1. route gate           another route -> other-route (no DOM work at all)
 *   2. selector             restricted grammar only; a unique element of the right tag; corroborated by the text anchor
 *   3. text anchor          exactly one element of the tag with the same normalized text (never a guess among several)
 *   4. weak selector hit    the selector element whose text no longer agrees
 *   5. landmark             exactly one [data-variation] or heading with that text
 *   6. detached
 *
 * Work is bounded: at most 100 anchors, resolved in chunks per animation frame under a time slice (each anchor is a
 * generator that yields after every native query and every 250 elements of a text scan), a newer epoch abandons a
 * pass in flight, and re-resolution after DOM churn goes through a debounce with floors after slow passes and storms.
 */

export interface AnchorTrackerDeps {
  readonly win: Window & typeof globalThis;
  readonly doc: Document;
  send(channel: string, payload: unknown): void;
  now(): number;
  requestFrame(callback: () => void): number;
  setInterval(callback: () => void, ms: number): number;
  clearInterval(handle: number): void;
  setTimeout(callback: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  addListener(type: string, listener: EventListener, options: AddEventListenerOptions): void;
  removeListener(type: string, listener: EventListener, options: AddEventListenerOptions): void;
  /** `document.querySelectorAll` with the guest's captured native; null when the DOM rejected the selector. */
  queryAll(selector: string): ArrayLike<Element> | null;
  /** `document.getElementsByTagName` with the captured native; null on failure. */
  elementsByTag(tag: string): ArrayLike<Element> | null;
  rectOf(el: Element): Rect;
  /**
   * The region of the guest viewport that ancestors let `el` show (their overflow clips, intersected), or null when no
   * ancestor clips it. Unclipped axes are +-Infinity. A throw or an unreadable style means "unknown": treated as null.
   */
  clipBoxOf(el: Element): ClipBox | null;
  /** Bounded normalized text of an element (the same function the selection generator used), cut to `limit` units. */
  textOf(el: Element, limit: number): string;
  /** Lower-case sanitized tag name, exactly as the selection generator wrote it. */
  tagOf(el: Element): string;
  isElement(value: unknown): value is Element;
  /** The guest's own highlight host. */
  isGuestHost(node: Node): boolean;
  attachShadow(el: Element, init: ShadowRootInit): ShadowRoot;
  scrollIntoView: ((this: Element, options?: ScrollIntoViewOptions) => void) | undefined;
}

/** A clip region in guest viewport px. An axis nothing clips is -Infinity..Infinity. */
export interface ClipBox { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

export interface AnchorTracker {
  onAnchors(payload: unknown): void;
  onFocus(payload: unknown): void;
  dispose(): void;
}

interface Placed { readonly result: InspectAnchorResult; readonly el: Element | null }
interface Entry { el: Element; lastKey: string }
interface TextIndex {
  readonly byText: Map<string, Element[]>;
  /** The scan hit the per-tag cap or was interrupted: a unique hit proves nothing about the elements never read. */
  truncated: boolean;
}
interface Pass {
  readonly epoch: number;
  readonly redact: boolean;
  readonly queries: readonly InspectAnchorQuery[];
  index: number;
  gen: Generator<void, Placed, undefined> | null;
  readonly placed: Array<{ key: string; el: Element; result: InspectAnchorResult }>;
  readonly results: InspectAnchorResult[];
  /** tag -> normalized text -> elements (capped), shared by every anchor of the pass. */
  readonly textIndex: Map<string, TextIndex>;
  work: number;
}

const FLASH_COLOR = "#7c3aed";
const REASSERT_INTERVAL_MS = 1000;
const DESCENDANT_BUDGET = 2000;
const SIBLING_BUDGET = 200;
const VARIATION_SCAN = 2000;
const HEADING_SCAN = 500;
const PREFIX_MIN_UNITS = 12;
const LISTENER_OPTIONS: AddEventListenerOptions = { capture: true, passive: true };
const OBSERVE_ATTRIBUTES = ["id", "class", "data-testid", "data-variation"];
const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

export function createAnchorTracker(deps: AnchorTrackerDeps): AnchorTracker {
  const { win, doc } = deps;
  let epoch = 0;
  let redact = false;
  let queries: readonly InspectAnchorQuery[] = [];
  let keys: ReadonlySet<string> = new Set();
  let resolved = new Map<string, Entry>();
  let pass: Pass | null = null;
  let frameScheduled = false;
  let measureScheduled = false;
  // results are throttled and cached so a dropped message heals and the embedder budget is never exceeded
  let latestResults: { epoch: number; results: InspectAnchorResult[]; json: string } | null = null;
  let sentResultsJson = "";
  let lastResultsSentAt = Number.NEGATIVE_INFINITY;
  let resultsTimer: number | null = null;
  let rectsTimer: number | null = null;
  let lastRectsSentAt = Number.NEGATIVE_INFINITY;
  let lastRectsViewportKey = "";
  let passRoute = "";
  let disposed = false;
  const ownNodes = new WeakSet<Node>();
  let watching = false;
  let observer: MutationObserver | null = null;
  let intervalHandle: number | null = null;
  let resolveTimer: number | null = null;
  // scheduling state for DOM-churn re-resolution
  let lastPassEnd = Number.NEGATIVE_INFINITY;
  let lastPassWork = 0;
  let burstStart = 0;
  let lastMutation = 0;
  let dirtySince: number | null = null;
  let callbackTimes: number[] = [];
  // jump-to flash
  let flashHost: HTMLElement | null = null;
  let flashSheet: CSSStyleSheet | null = null;
  let flashKey: string | null = null;
  let flashTimer: number | null = null;

  // Remembered after removal too: the observer reports a removal AFTER removeFlash() has forgotten the host.
  const isOwnNode = (node: Node): boolean => deps.isGuestHost(node) || ownNodes.has(node);

  // ---- geometry ----
  const MAGNITUDE = INSPECTOR_CAPS.numberMagnitude;
  // A non-finite value (a dependency that returned NaN) becomes 0 rather than poisoning the whole message.
  const clamp = (v: number, min: number): number => (Number.isFinite(v) ? Math.min(MAGNITUDE, Math.max(min, v)) : 0);
  /** One element with an absurd rect (a 1e12 px offset) must not make the embedder drop a whole message. */
  const clampRect = (r: Rect): Rect => {
    return { x: clamp(r.x, -MAGNITUDE), y: clamp(r.y, -MAGNITUDE), width: clamp(r.width, 0), height: clamp(r.height, 0) };
  };
  /**
   * Reported values are clamped; visibility is judged on the UNCLAMPED rect (an element 1e7 px wide really covers the
   * viewport). Visible means some part of the element can be seen: inside the viewport AND inside every ancestor that
   * clips it (S2: an element scrolled out of an inner scroller is inside the viewport but not on screen).
   */
  const measureEl = (el: Element): { rect: Rect; visible: boolean } => {
    const raw = deps.rectOf(el);
    return { rect: clampRect(raw), visible: intersectsViewport(raw) && intersectsClip(raw, clipOf(el)) };
  };
  const clipOf = (el: Element): ClipBox | null => {
    try { return deps.clipBoxOf(el); } catch { return null; }
  };
  const intersectsClip = (r: Rect, clip: ClipBox | null): boolean =>
    clip === null || (r.x < clip.right && r.x + r.width > clip.left && r.y < clip.bottom && r.y + r.height > clip.top);
  /** The guest viewport size the embedder needs to derive the guest-to-embedder scale; omitted when the guest has none (hidden). */
  const viewportOf = (): { width: number; height: number } | null => {
    const width = win.innerWidth, height = win.innerHeight;
    return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= MAGNITUDE && height <= MAGNITUDE ? { width, height } : null;
  };
  const viewportKey = (): string => { const v = viewportOf(); return v ? `${v.width}x${v.height}` : ""; };
  const intersectsViewport = (r: Rect): boolean =>
    r.width > 0 && r.height > 0 && r.x < win.innerWidth && r.y < win.innerHeight && r.x + r.width > 0 && r.y + r.height > 0;
  const rectKey = (r: Rect | null, visible: boolean): string => (r ? `${r.x}|${r.y}|${r.width}|${r.height}|${visible}` : "gone");

  // ---- resolution ----
  const currentRoute = (forRedacted: boolean): string =>
    (forRedacted ? win.location.pathname : `${win.location.pathname}${win.location.hash}`).slice(0, INSPECTOR_CAPS.routeUnits);

  const unplaced = (key: string, match: "detached" | "other-route"): Placed =>
    ({ result: { key, match, agrees: false, rect: null, visible: false }, el: null });
  const placed = (key: string, match: "selector" | "text" | "landmark", agrees: boolean, el: Element): Placed => {
    const { rect, visible } = measureEl(el);
    return { result: { key, match, agrees, rect, visible }, el };
  };

  const textAgrees = (el: Element, anchor: string): boolean => {
    const text = deps.textOf(el, INSPECTOR_CAPS.textAnchorUnits);
    if (text === anchor) return true;
    // An edited tail: one is a long prefix of the other.
    return anchor.length >= PREFIX_MIN_UNITS && text.length >= PREFIX_MIN_UNITS && (text.startsWith(anchor) || anchor.startsWith(text));
  };

  function* textIndexFor(p: Pass, tag: string): Generator<void, TextIndex, undefined> {
    const cached = p.textIndex.get(tag);
    if (cached) return cached;
    const index: TextIndex = { byText: new Map(), truncated: false };
    let completed = false;
    try {
      const all = deps.elementsByTag(tag);
      yield;
      if (all) {
        const limit = Math.min(all.length, INSPECTOR_CAPS.anchorTextScan);
        index.truncated = all.length > INSPECTOR_CAPS.anchorTextScan;
        for (let i = 0; i < limit && i < all.length; i++) {
          const el = all[i];
          if (el && deps.isElement(el)) {
            const text = deps.textOf(el, INSPECTOR_CAPS.textAnchorUnits);
            if (text !== "") {
              const bucket = index.byText.get(text);
              if (bucket) bucket.push(el); else index.byText.set(text, [el]);
            }
          }
          if ((i + 1) % INSPECTOR_CAPS.anchorScanStep === 0) yield;
        }
      }
      completed = true;
    } finally {
      // A text read that threw leaves what was read so far for the later anchors of the pass, marked incomplete.
      if (!completed) index.truncated = true;
      p.textIndex.set(tag, index);
    }
    return index;
  }

  function firstDescendantWithTag(root: Element, tag: string): Element | null {
    let visited = 0;
    const stack: Element[] = [];
    let node: Element | null = root.firstElementChild;
    while (node && visited++ < DESCENDANT_BUDGET) {
      if (deps.tagOf(node) === tag) return node;
      if (node.firstElementChild) { stack.push(node); node = node.firstElementChild; continue; }
      while (node && !node.nextElementSibling && stack.length > 0) node = stack.pop() ?? null;
      node = node ? node.nextElementSibling : null;
    }
    return null;
  }

  function* landmarkTarget(q: InspectAnchorQuery): Generator<void, Element | null, undefined> {
    const name = q.landmark;
    if (!name) return null;
    const variations = deps.queryAll("[data-variation]");
    yield;
    let container: Element | null = null;
    let count = 0;
    for (let i = 0; variations && i < Math.min(variations.length, VARIATION_SCAN); i++) {
      const el = variations[i];
      if (el && normalize(el.getAttribute("data-variation") ?? "").slice(0, INSPECTOR_CAPS.landmarkUnits) === name) {
        container = el;
        if (++count > 1) break;
      }
    }
    if (count === 1 && container) return firstDescendantWithTag(container, q.tag) ?? container;

    const headings = deps.queryAll("h1, h2, h3, h4, h5, h6");
    yield;
    let heading: Element | null = null;
    count = 0;
    for (let i = 0; headings && i < Math.min(headings.length, HEADING_SCAN); i++) {
      const el = headings[i];
      if (el && deps.textOf(el, INSPECTOR_CAPS.landmarkUnits) === name) {
        heading = el;
        if (++count > 1) break;
      }
    }
    if (count !== 1 || !heading) return null;
    let steps = 0;
    for (let sib = heading.nextElementSibling; sib && steps < SIBLING_BUDGET; sib = sib.nextElementSibling, steps++) {
      if (deps.tagOf(sib) === q.tag) return sib;
    }
    return heading;
  }

  function* resolveAnchor(p: Pass, q: InspectAnchorQuery): Generator<void, Placed, undefined> {
    if (q.route !== currentRoute(p.redact)) return unplaced(q.key, "other-route");
    // Redacted artifacts carry no text: a unique selector hit is accepted as it stands.
    const text = p.redact ? "" : q.textAnchor.text;

    let weak: Element | null = null;
    for (const selector of [q.selector, ...q.alternates]) {
      // Hostile or hand-edited selectors never reach the DOM.
      if (selector === "" || !isRestrictedSelector(selector)) continue;
      const found = deps.queryAll(selector);
      yield;
      if (!found || found.length !== 1) continue;
      const el = found[0];
      if (!el || !deps.isElement(el) || deps.tagOf(el) !== q.tag) continue;
      if (text === "" || textAgrees(el, text)) return placed(q.key, "selector", true, el);
      weak ??= el;
    }

    if (text !== "") {
      const index = yield* textIndexFor(p, q.textAnchor.tag);
      const hits = index.byText.get(text);
      const only = hits && hits.length === 1 ? hits[0] : undefined;
      // Unique within what was read; only a complete scan proves it is unique on the page.
      if (only) return placed(q.key, "text", !index.truncated, only);
    }

    if (weak?.isConnected) return placed(q.key, "selector", false, weak);

    if (!p.redact && q.landmark) {
      const target = yield* landmarkTarget(q);
      if (target) return placed(q.key, "landmark", false, target);
    }
    return unplaced(q.key, "detached");
  }

  // ---- passes ----
  function scheduleFrame(): void {
    if (frameScheduled || disposed) return;
    frameScheduled = true;
    deps.requestFrame(runFrame);
  }

  function startPass(): void {
    if (disposed || queries.length === 0) return;
    pass = { epoch, redact, queries, index: 0, gen: null, placed: [], results: [], textIndex: new Map(), work: 0 };
    passRoute = currentRoute(redact);
    dirtySince = null;
    scheduleFrame();
  }

  function runFrame(): void {
    frameScheduled = false;
    const p = pass;
    if (!p || disposed || p.epoch !== epoch) return;
    const started = deps.now();
    let anchorsStarted = 0;
    for (;;) {
      if (!p.gen) {
        if (p.index >= p.queries.length) { p.work += deps.now() - started; finishPass(p); return; }
        if (anchorsStarted >= INSPECTOR_CAPS.anchorChunk || deps.now() - started >= INSPECTOR_CAPS.anchorSliceMillis) break;
        const query = p.queries[p.index++]!;
        p.gen = resolveAnchor(p, query);
        anchorsStarted++;
      }
      let step: IteratorResult<void, Placed>;
      try {
        step = p.gen.next();
      } catch {
        // A resolver bug or a DOM that threw: that anchor is detached, the pass goes on.
        const failed = p.queries[p.index - 1]!;
        step = { done: true, value: unplaced(failed.key, "detached") };
      }
      if (step.done) {
        p.results.push(step.value.result);
        if (step.value.el) p.placed.push({ key: step.value.result.key, el: step.value.el, result: step.value.result });
        p.gen = null;
      } else if (deps.now() - started >= INSPECTOR_CAPS.anchorSliceMillis) {
        break;
      }
    }
    p.work += deps.now() - started;
    scheduleFrame();
  }

  function finishPass(p: Pass): void {
    pass = null;
    lastPassEnd = deps.now();
    lastPassWork = p.work;
    lastRectsViewportKey = viewportKey();
    resolved = new Map(p.placed.map(({ key, el, result }) => [key, { el, lastKey: rectKey(result.rect, result.visible) }]));
    latestResults = { epoch: p.epoch, results: p.results, json: JSON.stringify(p.results) };
    emitResults();
    if (dirtySince !== null) { burstStart = dirtySince; dirtySince = null; scheduleResolve(false); }
  }

  /**
   * Sends the newest completed results at most once per `anchorResultsSpacingMillis` (the embedder drops anything over
   * 8 per second, and a dropped final state would strand stale pins), with a trailing send of the LATEST state. Identical
   * results are not re-sent, except by the 1 s re-assertion which clears `sentResultsJson` so a dropped message heals.
   */
  function emitResults(): void {
    const latest = latestResults;
    if (disposed || !latest || latest.epoch !== epoch) return;
    const sentKey = `${latest.json}|${viewportKey()}`;
    if (sentKey === sentResultsJson) return;
    const viewport = viewportOf();
    const wait = lastResultsSentAt + INSPECTOR_CAPS.anchorResultsSpacingMillis - deps.now();
    if (wait > 0) {
      if (resultsTimer === null) resultsTimer = deps.setTimeout(() => { resultsTimer = null; emitResults(); }, wait);
      return;
    }
    sentResultsJson = sentKey;
    lastResultsSentAt = deps.now();
    deps.send(INSPECT_CHANNEL.anchorResults, viewport ? { epoch: latest.epoch, viewport, results: latest.results } : { epoch: latest.epoch, results: latest.results });
  }

  // ---- rect reporting ----
  function scheduleMeasure(): void {
    if (measureScheduled || disposed || resolved.size === 0) return;
    measureScheduled = true;
    deps.requestFrame(measure);
  }

  function measure(): void {
    measureScheduled = false;
    if (disposed || resolved.size === 0) return;
    const rects: InspectAnchorRect[] = [];
    const keys: string[] = [];
    // A viewport-only change (a pane resize with every rect identical) still has to reach the embedder: its scale moved.
    let changed = viewportKey() !== lastRectsViewportKey;
    let gone = false;
    for (const [key, entry] of resolved) {
      let rect: Rect | null = null;
      let visible = false;
      if (entry.el.isConnected) {
        ({ rect, visible } = measureEl(entry.el));
      } else {
        gone = true;
      }
      const k = rectKey(rect, visible);
      if (k !== entry.lastKey) changed = true;
      keys.push(k);
      rects.push({ key, rect, visible });
    }
    paintFlash();
    if (changed) {
      // Spaced like the results: above ~110 messages/s the embedder would shed some, possibly the final one. A throttled
      // measure retries (and re-reads the rects, so the trailing send is the LATEST state) when the spacing has elapsed.
      const wait = lastRectsSentAt + INSPECTOR_CAPS.anchorRectsSpacingMillis - deps.now();
      if (wait > 0) {
        if (rectsTimer === null) rectsTimer = deps.setTimeout(() => { rectsTimer = null; measure(); }, wait);
      } else {
        lastRectsSentAt = deps.now();
        lastRectsViewportKey = viewportKey();
        const viewport = viewportOf();
        let i = 0;
        for (const entry of resolved.values()) entry.lastKey = keys[i++]!;
        deps.send(INSPECT_CHANNEL.anchorRects, viewport ? { epoch, viewport, rects } : { epoch, rects });
      }
    }
    if (gone) scheduleResolve(true);
  }

  // ---- re-resolution after churn ----
  function scheduleResolve(immediate: boolean): void {
    if (disposed || queries.length === 0) return;
    if (pass) { if (dirtySince === null) dirtySince = deps.now(); return; }
    const t = deps.now();
    callbackTimes = callbackTimes.filter((at) => t - at < 1000);
    const stormy = callbackTimes.length > INSPECTOR_CAPS.anchorStormCallbacksPerSecond;
    // Every trigger, the immediate ones included, waits at least anchorMinPassGapMillis after the previous pass ended.
    const floor = Math.max(
      INSPECTOR_CAPS.anchorMinPassGapMillis,
      stormy ? INSPECTOR_CAPS.anchorStormFloorMillis : lastPassWork > INSPECTOR_CAPS.anchorSlowPassMillis ? INSPECTOR_CAPS.anchorSlowFloorMillis : 0,
    );
    const base = immediate ? t : Math.min(lastMutation + INSPECTOR_CAPS.anchorDebounceMillis, burstStart + INSPECTOR_CAPS.anchorMaxDelayMillis);
    const at = Math.max(base, lastPassEnd + floor, t);
    if (resolveTimer !== null) deps.clearTimeout(resolveTimer);
    resolveTimer = deps.setTimeout(() => { resolveTimer = null; startPass(); }, Math.max(0, at - t));
  }

  function onMutations(records: MutationRecord[]): void {
    if (disposed) return;
    const allOwn = (list: NodeList): boolean => {
      for (let i = 0; i < list.length; i++) if (!isOwnNode(list[i]!)) return false;
      return true;
    };
    let foreign = false;
    for (const record of records) {
      if (isOwnNode(record.target)) continue;
      // Walks the node lists in place and stops at the first page node: nothing is materialised from a 50k-node insertion.
      if (record.type === "childList" && record.addedNodes.length + record.removedNodes.length > 0 && allOwn(record.addedNodes) && allOwn(record.removedNodes)) continue;
      foreign = true;
      break;
    }
    if (!foreign) return;
    const t = deps.now();
    callbackTimes.push(t);
    if (callbackTimes.length > INSPECTOR_CAPS.anchorStormCallbacksPerSecond + 1) callbackTimes.splice(0, callbackTimes.length - (INSPECTOR_CAPS.anchorStormCallbacksPerSecond + 1));
    lastMutation = t;
    if (pass) { if (dirtySince === null) dirtySince = t; return; }
    if (resolveTimer === null) burstStart = t;
    scheduleResolve(false);
  }

  // ---- watching (listeners, observer, 1 s re-assertion) ----
  const onViewportChange: EventListener = () => scheduleMeasure();
  const onRouteChange: EventListener = () => {
    if (!pass) scheduleResolve(true); else if (dirtySince === null) dirtySince = deps.now();
  };

  function attachListeners(): void {
    deps.addListener("scroll", onViewportChange, LISTENER_OPTIONS);
    deps.addListener("resize", onViewportChange, LISTENER_OPTIONS);
    deps.addListener("hashchange", onRouteChange, LISTENER_OPTIONS);
    deps.addListener("popstate", onRouteChange, LISTENER_OPTIONS);
  }
  function detachListeners(): void {
    deps.removeListener("scroll", onViewportChange, LISTENER_OPTIONS);
    deps.removeListener("resize", onViewportChange, LISTENER_OPTIONS);
    deps.removeListener("hashchange", onRouteChange, LISTENER_OPTIONS);
    deps.removeListener("popstate", onRouteChange, LISTENER_OPTIONS);
  }
  function observe(): void {
    try {
      observer ??= new win.MutationObserver(onMutations);
      observer.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: OBSERVE_ATTRIBUTES, characterData: true });
    } catch { /* detached document: the next re-assertion tries again */ }
  }
  function reassert(): void {
    if (disposed || !watching) return;
    // document.open() erases the window's listeners; re-adding the same listener is a no-op otherwise.
    attachListeners();
    observe();
    // Forget what was last reported so the current state is sent again (a dropped report never strands the embedder).
    for (const entry of resolved.values()) entry.lastKey = "";
    scheduleMeasure();
    // A dropped results message must not strand stale pins: send the cached results again (throttled like any other).
    sentResultsJson = "";
    emitResults();
    // history.pushState/replaceState fire no event the isolated world can see; the route is re-checked here.
    if (!pass && queries.length > 0 && currentRoute(redact) !== passRoute) scheduleResolve(true);
  }
  function startWatching(): void {
    if (watching) return;
    watching = true;
    attachListeners();
    observe();
    intervalHandle = deps.setInterval(reassert, REASSERT_INTERVAL_MS);
  }
  function stopWatching(): void {
    if (!watching) return;
    watching = false;
    detachListeners();
    observer?.disconnect();
    if (intervalHandle !== null) { deps.clearInterval(intervalHandle); intervalHandle = null; }
  }

  function cancelWork(): void {
    pass = null;
    if (resolveTimer !== null) { deps.clearTimeout(resolveTimer); resolveTimer = null; }
    if (resultsTimer !== null) { deps.clearTimeout(resultsTimer); resultsTimer = null; }
    if (rectsTimer !== null) { deps.clearTimeout(rectsTimer); rectsTimer = null; }
    dirtySince = null;
    callbackTimes = [];
    removeFlash();
  }

  // ---- embedder messages ----
  function parseAnchors(payload: unknown): { epoch: number; redactText: boolean; anchors: InspectAnchorQuery[] } | null {
    const b = plainBag(payload);
    if (!b) return null;
    const e = ownField(b, "epoch");
    const redactText = ownField(b, "redactText");
    const raw = ownField(b, "anchors");
    if (typeof e !== "number" || !Number.isInteger(e) || e <= epoch || typeof redactText !== "boolean") return null;
    if (!Array.isArray(raw) || raw.length > INSPECTOR_CAPS.anchors) return null;
    const anchors: InspectAnchorQuery[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      const query = sanitizeAnchorQuery(item);
      if (!query || seen.has(query.key)) return null;
      seen.add(query.key);
      anchors.push(query);
    }
    return { epoch: e, redactText, anchors };
  }

  function onAnchors(payload: unknown): void {
    if (disposed) return;
    const message = parseAnchors(payload);
    if (!message) return;
    cancelWork();
    epoch = message.epoch;
    redact = message.redactText;
    queries = message.anchors;
    keys = new Set(queries.map((q) => q.key));
    resolved = new Map();
    latestResults = null;
    sentResultsJson = "";
    if (queries.length === 0) { stopWatching(); return; }
    startWatching();
    startPass();
  }

  // ---- jump to ----
  function prefersReducedMotion(): boolean {
    try { return win.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true; } catch { return false; }
  }

  function ensureFlashHost(): boolean {
    if (!flashHost) {
      try {
        const created = doc.createElement("div");
        const shadow = deps.attachShadow(created, { mode: "closed" });
        const sheet = new win.CSSStyleSheet();
        shadow.adoptedStyleSheets = [sheet];
        const box = doc.createElement("div");
        box.className = "b";
        shadow.appendChild(box);
        flashHost = created;
        flashSheet = sheet;
        ownNodes.add(created);
      } catch {
        flashHost = null;
        flashSheet = null;
        return false;
      }
    }
    if (!flashHost.isConnected && doc.documentElement) doc.documentElement.appendChild(flashHost);
    return flashHost.isConnected;
  }

  function paintFlash(): void {
    if (flashKey === null || !flashSheet) return;
    const entry = resolved.get(flashKey);
    if (!entry || !entry.el.isConnected) { removeFlash(); return; }
    const r = measureEl(entry.el).rect;
    try {
      flashSheet.replaceSync(`:host{all:initial}.b{position:fixed;box-sizing:border-box;pointer-events:none;outline:2px solid ${FLASH_COLOR};outline-offset:2px;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;z-index:2147483647}`);
    } catch { removeFlash(); }
  }

  function removeFlash(): void {
    if (flashTimer !== null) { deps.clearTimeout(flashTimer); flashTimer = null; }
    flashKey = null;
    if (flashHost?.isConnected) flashHost.remove();
    flashHost = null;
    flashSheet = null;
  }

  function onFocus(payload: unknown): void {
    if (disposed) return;
    const b = plainBag(payload);
    if (!b) return;
    const e = ownField(b, "epoch");
    const key = ownField(b, "key");
    const behavior = ownField(b, "behavior");
    if (e !== epoch || typeof key !== "string" || !keys.has(key)) return;
    if (behavior !== "scroll" && behavior !== "flash") return;
    const entry = resolved.get(key);
    if (!entry || !entry.el.isConnected) return;
    const mode: InspectAnchorFocusBehavior = behavior;
    if (typeof deps.scrollIntoView === "function") {
      try {
        deps.scrollIntoView.call(entry.el, {
          block: mode === "scroll" ? "center" : "nearest",
          inline: "nearest",
          behavior: (prefersReducedMotion() ? "instant" : "smooth") as ScrollBehavior,
        });
      } catch { /* not scrollable here */ }
    }
    if (mode !== "flash") return;
    removeFlash();
    flashKey = key;
    if (!ensureFlashHost()) { flashKey = null; return; }
    paintFlash();
    if (flashHost) flashTimer = deps.setTimeout(removeFlash, INSPECTOR_CAPS.anchorFlashMillis);
  }

  return {
    onAnchors,
    onFocus,
    dispose() {
      disposed = true;
      cancelWork();
      stopWatching();
      resolved = new Map();
    },
  };
}
