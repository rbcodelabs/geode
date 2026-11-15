import type {
  WebViewerElementScreenshot,
  WebViewerElementSelection,
  WebViewerFeedbackRequest,
  WebViewerPageTarget,
  WebViewerScreenshotOmittedReason,
  WebViewerViewportPreset,
} from "../../web-viewer/feedback-contract";
import type {
  GuestSelectMessage,
  InspectKey,
  InspectMode,
  InspectRectMessage,
} from "../../artifacts/inspector-protocol";
import { freezePlain } from "../artifacts/freeze-plain";
import type { WebViewerFeedbackOutcome } from "../web-viewer/feedback-registry";
import {
  COMMENT_MAX_UNITS,
  ElementInspectorSession,
  captureElementScreenshot,
  cleanComment,
  generateSelectionId,
  type InspectorHover,
  type InspectorIpcEvent,
  type InspectorNativeImage,
  type InspectorWebview,
} from "./element-inspector-session";

/**
 * Renderer-side bridge between one Web Viewer `<webview>` and
 * `WebViewerFeedbackService` (ADR 0056).
 *
 * Security invariants:
 * - Origin-E fields (`page.url`, `page.origin`, `selectionId`, `viewSessionId`,
 *   `viewportPreset`, `capturedAt`, `submittedAt`, `stale`) are produced solely
 *   by Geode from host-verified navigation state — never from guest messages.
 * - Cross-origin navigation or loss of healthy HTTP(S) page state between pick
 *   and send rejects locally with `reason: "unavailable"` before reaching any
 *   plugin handler.
 * - Same-origin in-page route changes, document reloads (`ready`), or selected
 *   element layout mutations mark `request.stale = true`.
 */

export type { InspectorHover, InspectorIpcEvent, InspectorNativeImage, InspectorWebview };

export interface WebViewerSelectionSnapshot {
  readonly selection: WebViewerElementSelection;
  readonly screenshot: WebViewerElementScreenshot | null;
  /** Non-null iff `screenshot` is `null`. */
  readonly screenshotOmitted: WebViewerScreenshotOmittedReason | null;
  /** Host-verified HTTP(S) page identity captured when the element was selected. */
  readonly page: WebViewerPageTarget;
}

export interface WebViewerInspectorBridgeOptions {
  webview: InspectorWebview;
  viewSessionId: string;
  registry: {
    submit(
      target: WebViewerPageTarget,
      request: WebViewerFeedbackRequest,
    ): Promise<WebViewerFeedbackOutcome>;
  };
  /** Host-verified current HTTP(S) page target, or `null` when unavailable. */
  getPageTarget(): WebViewerPageTarget | null;
  getViewportPreset(): WebViewerViewportPreset;
  callbacks: {
    onHover(hover: InspectorHover): void;
    onSelect(snapshot: WebViewerSelectionSnapshot): void;
    onCancel(): void;
    onRect?(rect: InspectRectMessage): void;
  };
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
}

const THREAD_ID_MAX_UNITS = 256;
const PAGE_NAVIGATED_MESSAGE = "The page navigated before feedback was sent. Pick the element again.";

interface SnapshotMeta {
  readonly generation: number;
  readonly pageUrl: string;
  readonly pageOrigin: string;
  layoutMutated: boolean;
}

export class WebViewerInspectorBridge {
  private readonly session: ElementInspectorSession;
  private readonly now: () => number;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly metaOf = new WeakMap<WebViewerSelectionSnapshot, SnapshotMeta>();
  private activeSnapshot: WebViewerSelectionSnapshot | null = null;

  constructor(private readonly options: WebViewerInspectorBridgeOptions) {
    this.now = options.now ?? (() => Date.now());
    this.randomBytes = options.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length)));
    this.session = new ElementInspectorSession({
      webview: options.webview,
      redacted: false,
      now: this.now,
      callbacks: {
        onHover: (hover) => this.options.callbacks.onHover(hover),
        onAcceptedSelect: (guest, ctx) => {
          void this.onSelect(guest, ctx);
        },
        onCancel: () => this.options.callbacks.onCancel(),
        onRect: (report) => this.onRect(report),
      },
    });
  }

  get mode(): InspectMode {
    return this.session.mode;
  }

  setMode(mode: InspectMode): void {
    if (mode !== "hold") this.activeSnapshot = null;
    this.session.setMode(mode);
  }

  sendKey(key: InspectKey): void {
    this.session.sendKey(key);
  }

  dispose(): void {
    this.activeSnapshot = null;
    this.session.dispose();
  }

  /**
   * Validates and submits `snapshot` + `comment` to `threadId` via `registry`.
   * Re-verifies host-owned `getPageTarget()` at submit time; never rejects.
   */
  async submit(
    snapshot: WebViewerSelectionSnapshot,
    comment: string,
    threadId: string,
  ): Promise<WebViewerFeedbackOutcome> {
    const trimmedComment = cleanComment(comment);
    if (trimmedComment === null) {
      return {
        status: "rejected",
        reason: "invalid",
        message: `Enter a comment of 1 to ${COMMENT_MAX_UNITS} characters.`,
        source: "invalid-result",
      };
    }

    const trimmedThreadId = typeof threadId === "string" ? threadId.trim() : "";
    if (trimmedThreadId.length === 0 || trimmedThreadId.length > THREAD_ID_MAX_UNITS) {
      return {
        status: "rejected",
        reason: "invalid",
        message: "Choose a target thread before sending.",
        source: "invalid-result",
      };
    }

    if (snapshot.selection.viewSessionId !== this.options.viewSessionId) {
      return {
        status: "rejected",
        reason: "invalid",
        message: "This selection belongs to a different Web Viewer session.",
        source: "invalid-result",
      };
    }

    const meta = this.metaOf.get(snapshot);
    const snapshotOrigin = meta?.pageOrigin ?? snapshot.page.origin;
    const snapshotUrl = meta?.pageUrl ?? snapshot.page.url;
    const target = this.options.getPageTarget();
    if (!target || target.origin !== snapshotOrigin) {
      return {
        status: "rejected",
        reason: "unavailable",
        message: PAGE_NAVIGATED_MESSAGE,
        source: "invalid-result",
      };
    }

    const stale =
      target.url !== snapshotUrl ||
      (meta !== undefined &&
        (meta.generation !== this.session.documentGeneration || meta.layoutMutated));

    const request: WebViewerFeedbackRequest = {
      contractVersion: 1,
      page: {
        url: target.url,
        origin: target.origin,
        title: target.title,
      },
      threadId: trimmedThreadId,
      comment: trimmedComment,
      selection: snapshot.selection,
      screenshot: snapshot.screenshot
        ? {
            ...snapshot.screenshot,
            bytes: snapshot.screenshot.bytes.slice(),
          }
        : null,
      screenshotOmitted: snapshot.screenshotOmitted,
      stale,
      submittedAt: new Date(this.now()).toISOString(),
    };

    try {
      return await this.options.registry.submit(target, request);
    } catch (error) {
      console.warn("[web-viewer-feedback] submit failed", error);
      return {
        status: "rejected",
        reason: "failed",
        message: "The feedback could not be sent.",
        source: "handler",
      };
    }
  }

  private async onSelect(
    guest: GuestSelectMessage,
    context: { token: number; generation: number },
  ): Promise<void> {
    const pageAtSelect = this.options.getPageTarget();
    if (!pageAtSelect) {
      this.session.setMode("off");
      return;
    }

    const selection = this.buildSelection(guest);
    const shot = await captureElementScreenshot(this.options.webview, guest);
    if (this.session.isDisposed || context.token !== this.session.currentToken) return;

    const pageAfterCapture = this.options.getPageTarget();
    if (!pageAfterCapture || pageAfterCapture.origin !== pageAtSelect.origin) {
      this.session.setMode("off");
      return;
    }

    const snapshot: WebViewerSelectionSnapshot = Object.freeze({
      selection,
      screenshot: shot.screenshot,
      screenshotOmitted: shot.omitted,
      page: freezePlain({
        url: pageAtSelect.url,
        origin: pageAtSelect.origin,
        title: pageAtSelect.title,
      }),
    });
    this.metaOf.set(snapshot, {
      generation: context.generation,
      pageUrl: pageAtSelect.url,
      pageOrigin: pageAtSelect.origin,
      layoutMutated: false,
    });
    this.activeSnapshot = snapshot;
    this.options.callbacks.onSelect(snapshot);
  }

  private onRect(report: InspectRectMessage): void {
    if (report.target === "selected" && this.activeSnapshot) {
      const meta = this.metaOf.get(this.activeSnapshot);
      if (meta && !meta.layoutMutated) {
        const initial = this.activeSnapshot.selection.boundingBox.viewport;
        if (
          !report.connected ||
          !report.rect ||
          Math.abs(report.rect.x - initial.x) > 0.5 ||
          Math.abs(report.rect.y - initial.y) > 0.5 ||
          Math.abs(report.rect.width - initial.width) > 0.5 ||
          Math.abs(report.rect.height - initial.height) > 0.5
        ) {
          meta.layoutMutated = true;
        }
      }
    }
    this.options.callbacks.onRect?.(report);
  }

  private buildSelection(guest: GuestSelectMessage): WebViewerElementSelection {
    const { viewport: box } = guest.boundingBox;
    const selection: WebViewerElementSelection = {
      schemaVersion: 1,
      selectionId: generateSelectionId(this.randomBytes),
      viewSessionId: this.options.viewSessionId,
      viewportPreset: this.options.getViewportPreset(),
      capturedAt: new Date(this.now()).toISOString(),
      route: guest.route,
      tag: guest.tag,
      selector: guest.selector,
      selectorAlternates: guest.selectorAlternates,
      textAnchor: guest.textAnchor,
      landmark: guest.landmark,
      outerHTML: guest.outerHTML,
      ancestors: guest.ancestors,
      computedStyles: guest.computedStyles,
      boundingBox: {
        viewport: box,
        document: {
          x: box.x + guest.viewport.scrollX,
          y: box.y + guest.viewport.scrollY,
          width: box.width,
          height: box.height,
        },
      },
      viewport: guest.viewport,
      a11y: guest.a11y,
    };
    return freezePlain(selection);
  }
}
