import { BUILD, ORIGIN, READY_MS, PARSE_MS, isParserReply, type ParserSession } from "./parser-protocol";
import { validatePackedImages } from "./packed";
import type { OwnedImageParseTransport } from "./parser-coordinator";
const cancelled = () => Object.assign(new Error("Cancelled image parse."), { name: "AbortError" });
interface Active {
  request: number; source: string; phase: "waiting" | "starting" | "parsing" | "cancelling";
  resolve(value: unknown): void; reject(error: unknown): void; detach(): void;
}
/** Private unwired browser transport. The constructor owns its frame/ports before any await. */
export class ImageParserTransport implements OwnedImageParseTransport {
  private readonly frame: HTMLIFrameElement;
  private readonly channel: MessageChannel;
  private readonly session: ParserSession;
  private ready = false;
  private loaded = false;
  private disposed = false;
  private failure?: Error;
  private active?: Active;
  private request = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closing?: Promise<void>;
  private resolveClose?: () => void;
  private rejectClose?: (error: Error) => void;
  /**
   * `parseMs` bounds the worker's parse phase. It defaults to the protocol
   * budget; only the ceiling proof overrides it, because its worst-case
   * 300k-unit input legitimately takes ~22 s on a healthy macOS CI runner and
   * must not turn ordinary runner jitter into a spurious deadline failure.
   */
  constructor(doc: Document = document, private readonly parseMs: number = PARSE_MS) {
    const body = doc.body;
    if (!body) throw new Error("Image parser document body unavailable.");
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    this.session = { version: 1, build: BUILD, epoch: 1, nonce: Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("") };
    this.frame = doc.createElement("iframe");
    this.channel = new MessageChannel();
    try {
    this.frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    this.frame.setAttribute("aria-hidden", "true");
    this.frame.tabIndex = -1;
    this.frame.style.cssText = "position:absolute;width:1px;height:1px;pointer-events:none";
    this.frame.addEventListener("load", this.load);
    this.frame.addEventListener("error", this.frameError);
    this.channel.port1.onmessage = event => this.receive(event.data);
    this.channel.port1.onmessageerror = () => this.fail(new Error("Image parser protocol delivery failed."));
    this.channel.port1.start();
    this.arm(READY_MS, "readiness");
    this.frame.src = `${ORIGIN}/index.html`;
    body.append(this.frame);
    } catch {
      this.dispose();
      throw new Error("Image parser initialization failed.");
    }
  }
  private readonly load = () => {
    if (this.disposed) return;
    if (this.loaded) { this.fail(new Error("Image parser broker reloaded.")); return; }
    this.loaded = true;
    try { this.frame.contentWindow!.postMessage({ kind: "initialize", ...this.session }, ORIGIN, [this.channel.port2]); }
    catch { this.fail(new Error("Image parser initialization failed.")); }
  };
  private readonly frameError = () => this.fail(new Error("Image parser broker failed."));
  private arm(ms: number, phase: string): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(new Error(`Image parser ${phase} deadline exceeded.`)), ms);
  }
  private send(value: object): void {
    try { this.channel.port1.postMessage({ ...value, ...this.session }); }
    catch { this.fail(new Error("Image parser protocol delivery failed.")); }
  }
  parse(source: string, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed || this.closing) return Promise.reject(new Error("Image parser closed or unavailable."));
    if (this.active) return Promise.reject(new Error("Image parser already active."));
    if (source.length > 300_000 || source.includes("\r")) return Promise.reject(new Error("Unsupported image parser source."));
    if (signal?.aborted) return Promise.reject(cancelled());
    return new Promise((resolve, reject) => {
      const active: Active = { request: ++this.request, source, phase: "waiting", resolve, reject,
        detach: () => signal?.removeEventListener("abort", abort) };
      const abort = () => {
        if (this.active !== active || active.phase === "cancelling") return;
        if (active.phase === "waiting") { this.finish(cancelled()); return; }
        active.phase = "cancelling";
        this.arm(READY_MS, "cancellation");
        this.send({ kind: "cancel", request: active.request });
      };
      this.active = active;
      signal?.addEventListener("abort", abort, { once: true });
      if (this.ready) this.begin();
    });
  }
  private begin(): void {
    const active = this.active;
    if (!active || active.phase !== "waiting" || this.closing) return;
    active.phase = "starting";
    this.arm(READY_MS, "worker readiness");
    this.send({ kind: "parse", request: active.request, source: active.source });
  }
  private receive(value: unknown): void {
    if (this.disposed) return;
    if (!isParserReply(value, this.session)) { this.fail(new Error("Image parser protocol violation.")); return; }
    if (value.kind === "closed") {
      if (!this.closing) { this.fail(new Error("Image parser protocol unexpected close.")); return; }
      this.finish(cancelled());this.dispose();this.resolveClose?.();return;
    }
    if (value.kind === "ready") {
      if (this.ready) { this.fail(new Error("Image parser protocol duplicate readiness.")); return; }
      this.ready = true;clearTimeout(this.timer);this.begin();return;
    }
    const active = this.active;
    if (!active || value.request !== active.request) return;
    if (value.kind === "failed") { this.fail(new Error(`Image parser ${value.code}.`)); return; }
    if (this.closing) return;
    if (value.kind === "cancelled") {
      if (active.phase !== "cancelling") { this.fail(new Error("Image parser protocol unexpected cancellation.")); return; }
      this.finish(cancelled());return;
    }
    if (active.phase === "cancelling") return;
    if (value.kind === "worker-ready" && active.phase === "starting") { active.phase = "parsing";this.arm(this.parseMs, "parse");return; }
    if (value.kind === "parsed" && active.phase === "parsing") {
      try { const packed = validatePackedImages(active.source, value.payload);this.finish(undefined, packed); }
      catch { this.fail(new Error("Image parser protocol invalid result.")); }
      return;
    }
    this.fail(new Error("Image parser protocol invalid phase."));
  }
  private finish(error?: Error, value?: unknown): void {
    const active = this.active;if (!active) return;
    this.active = undefined;
    // Cancelling work before readiness must not erase the broker handshake deadline.
    if (active.phase !== "waiting") clearTimeout(this.timer);
    active.detach();
    if (error) active.reject(error);else active.resolve(value);
  }
  private dispose(): void {
    this.disposed = true;clearTimeout(this.timer);
    this.frame.removeEventListener("load", this.load);this.frame.removeEventListener("error", this.frameError);
    this.channel.port1.onmessage = null;this.channel.port1.onmessageerror = null;
    this.channel.port1.close();this.channel.port2.close();this.frame.remove();
  }
  private fail(error: Error): void {
    if (this.disposed) return;
    this.failure = error;this.finish(error);this.dispose();this.rejectClose?.(error);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.failure) return Promise.reject(this.failure);
    if (this.disposed) return Promise.resolve();
    if (!this.ready) { this.finish(cancelled());this.dispose();this.closing = Promise.resolve();return this.closing; }
    this.closing = new Promise((resolve, reject) => { this.resolveClose = resolve;this.rejectClose = reject; });
    this.arm(READY_MS, "close");this.send({ kind: "close" });return this.closing;
  }
}
