import type { RenderScope } from "../workspaces/render-ownership";
import type { TFile } from "../types";

/** Private origin contract shared by nested native renderers, never plugin authority. */
export type SourceNavigationRequest =
  | { kind: "link"; linktext: string; sourcePath: string; newTab: boolean }
  | { kind: "file"; file: TFile; newTab: boolean };
export type SourceNavigationOutcome = { status: "completed" | "refused" | "cancelled" | "failed" };
/** A private route may have committed an authorized effect before a later check fails. */
export class SourceNavigationEffectFailure extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Navigation failed after starting an authorized effect.", { cause });
  }
}
export interface SourceNavigationIntent {
  readonly state: "staged" | "refused";
  readonly completion: Promise<SourceNavigationOutcome>;
  dispatch(): Promise<SourceNavigationOutcome>;
  cancel(): void;
}
interface SourceNavigationOptions {
  capture(): () => void;
  preflight(): void;
  execute(request: SourceNavigationRequest, validate: () => void): Promise<void>;
  notify(message: string): void;
}

export class SourceOwnedNavigation {
  constructor(private readonly options: SourceNavigationOptions) {}

  /** Pointer preparation checks readiness but neither navigates nor retires children. */
  prepareNavigation(request: SourceNavigationRequest, captureOrigin?: () => () => void): SourceNavigationIntent {
    let validate: () => void;
    try {
      const current = this.options.capture();
      const originCurrent = captureOrigin?.();
      const filePath = request.kind === "file" ? request.file.path : null;
      validate = () => {
        current(); originCurrent?.();
        if (request.kind === "file" && request.file.path !== filePath) throw new Error("The navigation target changed.");
        this.options.preflight();
      };
      validate();
    } catch (error) {
      this.report(error);
      const completion = Promise.resolve<SourceNavigationOutcome>({ status: "refused" });
      return { state: "refused", completion, dispatch: () => completion, cancel: () => {} };
    }
    let resolve!: (outcome: SourceNavigationOutcome) => void;
    const completion = new Promise<SourceNavigationOutcome>(done => { resolve = done; });
    let dispatched = false;
    return {
      state: "staged", completion,
      cancel: () => { if (!dispatched) { dispatched = true; resolve({ status: "cancelled" }); } },
      dispatch: () => {
        if (!dispatched) {
          dispatched = true;
          void (async () => {
            try {
              validate();
              await this.options.execute(request, validate);
              resolve({ status: "completed" });
            } catch (error) {
              this.report(error);
              resolve({ status: error instanceof SourceNavigationEffectFailure ? "failed" : "refused" });
            }
          })();
        }
        return completion;
      },
    };
  }

  private report(error: unknown): void {
    this.options.notify(error instanceof Error ? error.message : "Finish the native edit before navigating.");
  }
}

interface NavigationControl { element: HTMLElement; request: SourceNavigationRequest }
function sameRequest(left: SourceNavigationRequest, right: SourceNavigationRequest): boolean {
  if (left.newTab !== right.newTab || left.kind !== right.kind) return false;
  return left.kind === "file" && right.kind === "file" ? left.file === right.file :
    left.kind === "link" && right.kind === "link" && left.linktext === right.linktext && left.sourcePath === right.sourcePath;
}

function bindSourceNavigation(root: HTMLElement, navigation: SourceOwnedNavigation, resolve: (event: MouseEvent) => NavigationControl | null, captureOrigin?: () => () => void): () => void {
  type Gesture = { control: NavigationControl; pointerId: number; button: number; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean; intent: SourceNavigationIntent };
  let pending: Gesture | null = null;
  const document = root.ownerDocument, window = document.defaultView;
  const unwatch = () => {
    document.removeEventListener("pointerup", pointerup, true);
    document.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("pointerdown", restart, true);
    document.removeEventListener("dragstart", clear, true);
    window?.removeEventListener("blur", clear);
  };
  const clear = () => { pending?.intent.cancel(); pending = null; unwatch(); };
  const restart = () => clear();
  const pointerup = (event: PointerEvent) => {
    if (pending?.pointerId !== event.pointerId) return;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    if (!hit || !pending.control.element.contains(hit)) clear();
  };
  const watch = () => {
    document.addEventListener("pointerup", pointerup, true);
    document.addEventListener("pointercancel", cancel, true);
    document.addEventListener("pointerdown", restart, true);
    document.addEventListener("dragstart", clear, true);
    window?.addEventListener("blur", clear);
  };
  const prepare = (control: NavigationControl, event: MouseEvent) => navigation.prepareNavigation(control.request, () => {
    const originCurrent = captureOrigin?.();
    return () => {
      originCurrent?.();
      const current = resolve(event);
      if (!control.element.isConnected || !root.contains(control.element) || current?.element !== control.element || !sameRequest(control.request, current.request)) {
        throw new Error("The navigation control changed.");
      }
    };
  });
  const pointerdown = (event: PointerEvent) => {
    clear();
    if (event.button !== 0 || !event.isTrusted) return;
    const control = resolve(event); if (!control) return;
    // Staging before default focus prevents the browser blur from authorizing a save.
    event.preventDefault(); event.stopImmediatePropagation();
    pending = { control, pointerId: event.pointerId, button: event.button, meta: event.metaKey, ctrl: event.ctrlKey,
      shift: event.shiftKey, alt: event.altKey, intent: prepare(control, event) };
    watch();
  };
  const click = (event: MouseEvent) => {
    if (event.button !== 0 || !event.isTrusted) return;
    const control = resolve(event); if (!control) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const gesture = pending; pending = null; unwatch();
    const matching = event.detail !== 0 && gesture?.control.element === control.element && control.element.isConnected &&
      sameRequest(gesture.control.request, control.request) && gesture.button === event.button &&
      gesture.meta === event.metaKey && gesture.ctrl === event.ctrlKey && gesture.shift === event.shiftKey && gesture.alt === event.altKey &&
      (!(event instanceof PointerEvent) || gesture.pointerId === event.pointerId);
    if (!matching) {
      gesture?.intent.cancel();
      if (event.detail !== 0) return;
    }
    const intent = matching ? gesture!.intent : prepare(control, event);
    void intent.dispatch();
  };
  const cancel = (event: PointerEvent) => { if (pending?.pointerId === event.pointerId) clear(); };
  root.addEventListener("pointerdown", pointerdown);
  root.addEventListener("click", click);
  root.addEventListener("pointercancel", cancel);
  root.addEventListener("lostpointercapture", cancel);
  return () => {
    clear(); root.removeEventListener("pointerdown", pointerdown); root.removeEventListener("click", click);
    root.removeEventListener("pointercancel", cancel); root.removeEventListener("lostpointercapture", cancel);
  };
}

/** The innermost renderer consumes one actual internal-link gesture. */
export function bindSourceLinkNavigation(root: HTMLElement, navigation: SourceOwnedNavigation, sourcePath: string | (() => string), origin?: RenderScope): () => void {
  return bindSourceNavigation(root, navigation, event => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>("a.internal-link[data-href], .cm-live-wikilink[data-href]") : null;
    if (!element || !root.contains(element)) return null;
    return { element, request: { kind: "link", linktext: element.dataset.href!, sourcePath: typeof sourcePath === "string" ? sourcePath : sourcePath(), newTab: event.metaKey || event.ctrlKey } };
  }, origin ? captureNavigationOrigin(origin) : undefined);
}

/** Genuine single-click navigation controls use the same pre-blur intent boundary. */
export function bindSourceControlNavigation(element: HTMLElement, navigation: SourceOwnedNavigation, request: (event: MouseEvent) => SourceNavigationRequest, origin?: RenderScope): () => void {
  return bindSourceNavigation(element, navigation, event => ({ element, request: request(event) }), origin ? captureNavigationOrigin(origin) : undefined);
}

/** Capture a descendant lifetime per gesture, so a fresh gesture after resume remains valid. */
export function captureNavigationOrigin(scope: RenderScope): () => () => void {
  return () => {
    const token = scope.captureToken();
    return () => { scope.assertAdmission(); token.check(); };
  };
}
