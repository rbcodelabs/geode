/** Unwired ADR-0038 layout experiment. Not imported by production entries. */
import { RenderScope, type PreparedRetirement } from "../workspaces/render-ownership";
import type { ChangeDesc } from "@codemirror/state";
export interface NativeOccurrence { id: number; from: number; to: number; target: string }
export interface LayerRect { left: number; top: number; width: number; height: number }
export class OccurrenceLedger {
  private nextId = 1;
  private active: NativeOccurrence[] = [];
  reconcile(source: string, changes?: ChangeDesc): { active: NativeOccurrence[]; removed: NativeOccurrence[] } {
    const previous = this.active;
    const mapped = previous.map(item => ({ item, from: changes?.mapPos(item.from, 1) ?? item.from, to: changes?.mapPos(item.to, -1) ?? item.to }));
    const reused = new Set<number>();
    this.active = [...source.matchAll(/^!\[\[([^\]\r\n]+\.canvas)\]\]$/gm)].map(match => {
      const from = match.index!; const to = from + match[0].length; const target = match[1];
      const old = mapped.find(item => item.from === from && item.to === to && item.item.target === target && !reused.has(item.item.id));
      if (old) { reused.add(old.item.id); return { ...old.item, from, to }; }
      return { id: this.nextId++, from, to, target };
    });
    return { active: this.active, removed: previous.filter(item => !reused.has(item.id)) };
  }
}
export function placeNativeRecord(pane: LayerRect, anchor: LayerRect | null, index: number, offset: number, height: number): { state: "inline" | "retained" | "removed"; left: number; top: number; width: number } {
  if (anchor && anchor.top + anchor.height > pane.top && anchor.top < pane.top + pane.height) return { state: "inline", left: anchor.left - pane.left, top: anchor.top - pane.top, width: anchor.width };
  return { state: anchor ? "retained" : "removed", left: 8, top: Math.max(44, pane.height - Math.min(420, pane.height - 44)) + index * (height + 8) - offset, width: Math.max(0, pane.width - 32) };
}

export class AnchorLeases<T> {
  private readonly anchors = new Map<number, { lease: object; element: T }>();
  attach(id: number, element: T): object { const lease = {}; this.anchors.set(id, { lease, element }); return lease; }
  release(id: number, lease: object): void { if (this.anchors.get(id)?.lease === lease) this.anchors.delete(id); }
  get(id: number): T | null { return this.anchors.get(id)?.element ?? null; }
}
export class OwnedOccurrence {
  retired = false;
  failedClosed = false;
  error: unknown;
  private retiring: Promise<boolean> | null = null;
  constructor(readonly scope: RenderScope) {}
  retire(): Promise<boolean> {
    if (this.retired) return Promise.resolve(true);
    if (this.failedClosed) return Promise.resolve(false);
    return this.retiring ??= this.prepare().finally(() => { this.retiring = null; });
  }
  private async prepare(): Promise<boolean> {
    let prepared: PreparedRetirement | undefined;
    try {
      prepared = await RenderScope.prepareRetirement([this.scope]);
      await prepared.commit(); this.retired = true; return true;
    } catch (error) {
      this.error = error;
      this.failedClosed = prepared?.destructionStarted ?? false;
      if (!prepared && this.scope.closed) {
        // An ordinary owner close may still be preparing. Observe its completed
        // result before treating temporary closed admission as partial teardown.
        try { await this.scope.drain(); this.retired = true; return true; }
        catch (settlementError) { this.error = settlementError; this.failedClosed = this.scope.closed; }
      }
      if (!prepared?.destructionStarted) prepared?.abort();
      return false;
    }
  }
}

import type { EditorView } from "@codemirror/view";
import type { RenderToken } from "../workspaces/render-ownership";
interface PresentationRecord {
  occurrence: NativeOccurrence;
  root: HTMLElement;
  content: HTMLElement;
  label: HTMLElement;
  returnButton: HTMLButtonElement;
  lifetime: OwnedOccurrence;
  observer: MutationObserver;
  restoreResume?(): void;
  mountError: string | null;
  mounted: boolean;
  seenAnchor: boolean;
  retryRetirement: boolean;
  retirementTask?: Promise<void>;
  state: "inline" | "retained" | "removed";
}
export interface NativeLayerOptions {
  owner: RenderScope;
  host: HTMLElement;
  mount(content: HTMLElement, owner: RenderScope, occurrence: NativeOccurrence, token: RenderToken): Promise<void>;
  onHeight?(id: number, height: number): void;
}
/** Experimental sibling layer. There is no production import or feature flag. */
export class NativePresentationPrototype {
  readonly layer = document.createElement("div");
  readonly rail = document.createElement("div");
  private readonly railContent = document.createElement("div");
  private readonly shelf = document.createElement("div");
  private readonly records = new Map<number, PresentationRecord>();
  private readonly sources = new Map<number, NativeOccurrence>();
  private readonly anchors = new AnchorLeases<HTMLElement>();
  private readonly resize: ResizeObserver;
  private view: EditorView | null = null;
  private disposed = false;
  private scheduled = false;
  measurements = 0;
  allocations = 0;
  retirements = 0;
  constructor(private readonly options: NativeLayerOptions) {
    this.layer.className = "native-prototype-layer";
    Object.assign(this.layer.style, { position: "absolute", inset: "0", overflow: "hidden", pointerEvents: "none", zIndex: "5" });
    this.shelf.className = "native-prototype-shelf";
    Object.assign(this.shelf.style, { position: "absolute", left: "0", right: "0", borderTop: "1px solid var(--background-modifier-border)", background: "var(--background-primary)", pointerEvents: "none", zIndex: "1" });
    this.shelf.textContent = "Unfinished embedded edits";
    this.rail.tabIndex = 0; this.rail.setAttribute("aria-label", "Scroll retained embedded edits");
    Object.assign(this.rail.style, { position: "absolute", right: "0", width: "18px", overflowY: "auto", pointerEvents: "auto", zIndex: "3" });
    this.railContent.style.width = "1px"; this.rail.appendChild(this.railContent);
    this.layer.append(this.shelf, this.rail); options.host.appendChild(this.layer);
    this.rail.addEventListener("scroll", this.requestGeometry);
    this.resize = new ResizeObserver(this.requestGeometry); this.resize.observe(options.host);
  }
  setEditor(view: EditorView): void { this.view = view; view.scrollDOM.addEventListener("scroll", this.requestGeometry); this.requestGeometry(); }
  reconcile(occurrences: readonly NativeOccurrence[]): void {
    this.sources.clear(); for (const occurrence of occurrences) this.sources.set(occurrence.id, occurrence);
    for (const record of this.records.values()) {
      const current = this.sources.get(record.occurrence.id);
      if (current) record.occurrence = current;
      else {
        record.retryRetirement = true;
        // Source invalidation is an admission boundary, not a geometry update.
        // Start preflight/freeze now so a pending read cannot publish before RAF.
        this.retireRecord(record);
      }
    }
    this.requestGeometry();
  }
  attachAnchor(id: number, element: HTMLElement): object {
    const lease = this.anchors.attach(id, element); const occurrence = this.sources.get(id);
    if (occurrence) this.ensureRecord(occurrence);
    const record = this.records.get(id); if (record) { record.seenAnchor = true; record.retryRetirement = true; }
    this.resize.observe(element); this.requestGeometry(); return lease;
  }
  releaseAnchor(id: number, lease: object, element: HTMLElement): void {
    this.anchors.release(id, lease); this.resize.unobserve(element);
    const record = this.records.get(id); if (record) record.retryRetirement = true;
    this.requestGeometry();
  }
  returnToOccurrence(id: number): void {
    const occurrence = this.sources.get(id); if (!occurrence || !this.view) return;
    // This action intentionally does not focus the CM editor or native child.
    this.view.scrollDOM.scrollTop = this.view.lineBlockAt(occurrence.from).top;
    this.requestGeometry();
  }
  snapshot(): unknown {
    return { allocations: this.allocations, retirements: this.retirements, measurements: this.measurements, records: [...this.records.values()].map(record => ({ id: record.occurrence.id, target: record.occurrence.target, state: record.state, connected: record.root.isConnected, parentStable: record.root.parentElement === this.layer, mounted: record.mounted, admission: record.lifetime.scope.admissionAllowed, returnAvailable: !record.returnButton.hidden, sourceValid: this.sources.has(record.occurrence.id) })) };
  }
  private ensureRecord(occurrence: NativeOccurrence): void {
    if (!canAllocateNative(this.options.owner, this.disposed) || this.records.has(occurrence.id)) return;
    // Prototype admission is bounded; existing unfinished work is never removed.
    if (this.records.size >= 8) { this.shelf.textContent = "Finish an embedded edit before opening more prototype records."; return; }
    const scope = this.options.owner.child();
    const root = document.createElement("section"); root.className = "native-prototype-record"; root.dataset.occurrence = String(occurrence.id);
    Object.assign(root.style, { position: "absolute", top: "0", left: "8px", width: "calc(100% - 32px)", height: "320px", display: "flex", flexDirection: "column", pointerEvents: "auto", background: "var(--background-primary)", border: "1px solid var(--background-modifier-border)", borderRadius: "6px" });
    const header = document.createElement("div"); Object.assign(header.style, { flex: "0 0 auto", minHeight: "38px", display: "flex", flexWrap: "wrap", gap: "4px 8px", alignItems: "center", padding: "4px 8px", boxSizing: "border-box", background: "var(--background-secondary)" });
    const label = document.createElement("span"); Object.assign(label.style, { flex: "1 1 160px", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
    const returnButton = document.createElement("button"); returnButton.textContent = "Return to embed";
    Object.assign(returnButton.style, { maxWidth: "100%", minWidth: "0", whiteSpace: "normal", overflowWrap: "anywhere", boxSizing: "border-box" });
    // Returning changes only the anchor viewport; pointer focus must not submit
    // the unfinished native editor before the click handler gets to run.
    returnButton.addEventListener("pointerdown", event => { if (event.button === 0) event.preventDefault(); });
    returnButton.addEventListener("click", () => this.returnToOccurrence(occurrence.id));
    header.append(label, returnButton); const content = document.createElement("div"); content.className = "native-prototype-content"; Object.assign(content.style, { flex: "1", minHeight: "0", overflow: "hidden" });
    root.append(header, content); this.layer.appendChild(root);
    const record: PresentationRecord = { occurrence, root, content, label, returnButton, lifetime: new OwnedOccurrence(scope), observer: new MutationObserver(() => { record.retryRetirement = true; this.requestGeometry(); }), mountError: null, mounted: false, seenAnchor: false, retryRetirement: true, state: "inline" };
    this.records.set(occurrence.id, record); this.allocations++;
    const resume = scope.resume;
    const ownsObservation = () => !this.disposed && this.records.get(occurrence.id) === record && !record.lifetime.retired && !scope.closed;
    const observedResume = () => {
      if (!ownsObservation()) return resume.call(scope);
      // Preserve already queued external work, but exclude only the synchronous
      // recursive redraw performed by this scope's own resume. Async completion
      // and explicit recovery events remain observed throughout preparation.
      if (record.observer.takeRecords().length) record.retryRetirement = true;
      record.observer.disconnect();
      try { return resume.call(scope); }
      finally {
        if (ownsObservation()) {
          record.observer.observe(content, { childList: true, subtree: true, characterData: true });
          this.requestGeometry();
        }
      }
    };
    scope.resume = observedResume;
    record.restoreResume = () => { if (scope.resume === observedResume) scope.resume = resume; };
    record.observer.observe(content, { childList: true, subtree: true, characterData: true });
    for (const event of ["input", "keydown", "focusout", "click"]) content.addEventListener(event, () => { record.retryRetirement = true; this.requestGeometry(); });
    this.resize.observe(root);
    // Record and connected root exist before initialization starts or can await.
    const mounting = scope.run(token => this.options.mount(content, scope, occurrence, token));
    void mounting.then(() => { record.mounted = true; this.requestGeometry(); }, error => {
      if (!scope.admissionAllowed || record.lifetime.retired) return;
      record.mountError = error instanceof Error ? error.message : String(error ?? "mount failed");
      record.mounted = true; this.requestGeometry();
    });
  }
  private retireRecord(record: PresentationRecord): void {
    if (!canAllocateNative(this.options.owner, this.disposed) || record.retirementTask || record.lifetime.failedClosed) return;
    record.retryRetirement = false;
    record.retirementTask = record.lifetime.retire().then(retired => {
      if (!retired) { if (record.lifetime.failedClosed) this.requestGeometry(); return; }
      if (this.records.get(record.occurrence.id) !== record) return;
      record.restoreResume?.(); record.observer.disconnect(); this.resize.unobserve(record.root); record.root.remove(); this.records.delete(record.occurrence.id); this.retirements++;
      const current = this.sources.get(record.occurrence.id);
      if (canAllocateNative(this.options.owner, this.disposed) && current && this.anchors.get(current.id)?.isConnected) this.ensureRecord(current);
      this.requestGeometry();
    }).finally(() => { record.retirementTask = undefined; });
  }
  readonly requestGeometry = (): void => {
    if (this.disposed || this.scheduled || !this.view) return;
    this.scheduled = true;
    this.view.requestMeasure({ key: this, read: () => {
      const pane = this.layer.getBoundingClientRect();
      return { pane, active: document.activeElement, offset: this.rail.scrollTop, records: [...this.records.values()].map(record => {
        const anchor = this.anchors.get(record.occurrence.id); const valid = this.sources.has(record.occurrence.id);
        return { record, anchor: valid && anchor?.isConnected ? anchor.getBoundingClientRect() : null, valid, height: record.root.getBoundingClientRect().height };
      }) };
    }, write: measured => {
      this.scheduled = false; if (this.disposed) return; this.measurements++;
      if (!measured.pane.width || !measured.pane.height) return; // Hidden owner remains connected.
      let retained = 0; const shelfHeight = Math.min(420, measured.pane.height - 44); const shelfTop = measured.pane.height - shelfHeight;
      const unanchored = measured.records.filter(item => !item.anchor || item.anchor.top + item.anchor.height <= measured.pane.top || item.anchor.top >= measured.pane.bottom);
      let offset = measured.offset;
      const focusedIndex = unanchored.findIndex(item => item.record.root.contains(measured.active));
      if (focusedIndex >= 0) {
        const start = focusedIndex * 328; const end = start + unanchored[focusedIndex].height;
        if (start < offset) offset = start;
        else if (end > offset + shelfHeight - 24) offset = end - shelfHeight + 24;
      }
      Object.assign(this.rail.style, { top: `${shelfTop + 24}px`, height: `${shelfHeight - 24}px` }); this.railContent.style.height = `${unanchored.length * 328}px`;
      if (Math.abs(offset - measured.offset) > 1) this.rail.scrollTop = offset;
      for (const { record, anchor, valid, height } of measured.records) {
        if (!this.records.has(record.occurrence.id)) continue;
        const offscreen = !anchor || anchor.top + anchor.height <= measured.pane.top || anchor.top >= measured.pane.bottom;
        // A valid but virtualized occurrence still has Return, unlike removed source.
        const placement = placeNativeRecord(measured.pane, anchor, retained, offset, height);
        record.state = offscreen ? valid ? "retained" : "removed" : "inline";
        const top = offscreen ? shelfTop + 24 + retained++ * (height + 8) - offset : placement.top;
        Object.assign(record.root.style, { left: `${offscreen ? 8 : placement.left}px`, top: `${top}px`, width: `${offscreen ? measured.pane.width - 32 : placement.width}px`, clipPath: offscreen ? `inset(${Math.max(0, shelfTop + 24 - top)}px 0 ${Math.max(0, top + height - measured.pane.height)}px 0)` : "none" });
        // Stable roots keep their DOM order; shelf controls must paint above later inline records.
        record.root.style.zIndex = offscreen ? "2" : "0";
        record.root.inert = record.lifetime.failedClosed;
        record.returnButton.hidden = record.lifetime.failedClosed || record.state === "inline" || !valid;
        const text = nativePresentationLabel(record.occurrence, valid, record.mountError, record.lifetime.failedClosed);
        if (record.label.textContent !== text) { record.label.textContent = text; record.label.title = text; }
        if (anchor && Math.abs(anchor.height - height) > 1) this.options.onHeight?.(record.occurrence.id, height);
        if (canAllocateNative(this.options.owner, this.disposed) && offscreen && (record.seenAnchor || !valid) && record.retryRetirement && !record.lifetime.failedClosed) {
          this.retireRecord(record);
        }
      }
      const failed = [...this.records.values()].some(record => record.lifetime.failedClosed);
      this.shelf.textContent = failed ? "Native embed teardown failed. Controls are disabled; recovery is required." : "Unfinished embedded edits";
      this.shelf.setAttribute("role", failed ? "alert" : "status");
      this.shelf.hidden = retained === 0 && !failed; this.rail.hidden = retained === 0;
      Object.assign(this.shelf.style, { top: `${shelfTop}px`, height: `${shelfHeight}px` });
      Object.assign(this.rail.style, { top: `${shelfTop + 24}px`, height: `${shelfHeight - 24}px` }); this.railContent.style.height = `${retained * 328}px`;
    } });
  };
  async close(): Promise<void> {
    const prepared = await RenderScope.prepareRetirement([...this.records.values()].map(record => record.lifetime.scope));
    try { await prepared.commit(); }
    catch (error) { if (!prepared.destructionStarted) prepared.abort(); throw error; }
    this.disposeProjection();
  }
  /** Called only after the harness owner has successfully closed its descendants. */
  disposeProjection(): void {
    this.disposed = true; this.resize.disconnect(); this.view?.scrollDOM.removeEventListener("scroll", this.requestGeometry);
    for (const record of this.records.values()) { record.restoreResume?.(); record.observer.disconnect(); } this.records.clear(); this.layer.remove();
  }
}

export function canAllocateNative(owner: Pick<RenderScope, "admissionAllowed">, disposed: boolean): boolean { return !disposed && owner.admissionAllowed; }
export function nativePresentationLabel(occurrence: NativeOccurrence, valid: boolean, mountError: string | null, failedClosed: boolean): string {
  return `${occurrence.target} · occurrence ${occurrence.id}${valid ? "" : " · source removed"}${mountError ? ` · ${mountError}` : ""}${failedClosed ? " · teardown failed; controls disabled" : ""}`;
}
