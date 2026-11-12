import { JSDOM } from "jsdom";
// Deep import of jsdom internals, test-only: the only way to mint an event with isTrusted === true.
// @ts-expect-error no type declarations for the internal module
import jsdomUtils from "jsdom/lib/generated/idl/utils.js";
import { startInspector, type InspectorGuest } from "../../src/main/artifact-inspector-guest";

export interface Sent { channel: string; payload: any }

export interface GuestHarness {
  dom: JSDOM;
  win: Window & typeof globalThis;
  doc: Document;
  sent: Sent[];
  guest: InspectorGuest | null;
  start(): InspectorGuest | null;
  shadowRoots: Array<{ host: Element; root: ShadowRoot }>;
  sheets: string[];
  /** Pending animation-frame callbacks; `flush(n)` runs n rounds. */
  flush(rounds?: number): void;
  /** Runs every registered interval callback once (the guest's 1 s re-assertion, the anchor tracker's). */
  tick(): void;
  /** Advances the fake clock and runs the timers (setTimeout) that became due, in order. */
  advance(ms: number): void;
  /** Number of timers (setTimeout) still pending. */
  pendingTimers(): number;
  deliver(channel: string, payload: unknown): void;
  setRect(el: Element, rect: { x: number; y: number; width: number; height: number }): void;
  setStyle(el: Element, props: Record<string, string>): void;
  /** Make elementFromPoint return `el`. */
  pointAt(el: Element | null): void;
  setNow(value: number): void;
  now(): number;
  last(channel: string): Sent | undefined;
  all(channel: string): Sent[];
  trusted<T extends Event>(event: T): T;
  fire(type: string, init?: Record<string, unknown>, target?: EventTarget): Event;
  listenerLog: Array<{ type: string; fn: unknown; capture: unknown }>;
}

export function trusted<T extends Event>(event: T): T {
  jsdomUtils.implForWrapper(event).isTrusted = true;
  return event;
}

export function boot(html: string, options: { url?: string; start?: boolean; env?: Partial<Parameters<typeof startInspector>[0]> } = {}): GuestHarness {
  const dom = new JSDOM(html, { url: options.url ?? "https://artifact.test/page.html#frag" });
  const win = dom.window as unknown as Window & typeof globalThis;
  const doc = win.document;
  const sent: Sent[] = [];
  const handlers = new Map<string, (payload: unknown) => void>();
  let frames: Array<() => void> = [];
  const intervals = new Map<number, () => void>();
  let nextTimerId = 1;
  let timers: Array<{ id: number; due: number; cb: () => void }> = [];
  let now = 1000;
  const rects = new WeakMap<Element, { x: number; y: number; width: number; height: number }>();
  const styles = new WeakMap<Element, Record<string, string>>();
  const shadowRoots: GuestHarness["shadowRoots"] = [];
  const sheets: string[] = [];
  const listenerLog: GuestHarness["listenerLog"] = [];
  let pointed: Element | null = null;

  // Everything below is installed BEFORE startInspector so the guest captures these as "natives".
  win.Element.prototype.getBoundingClientRect = function (this: Element) {
    const r = rects.get(this) ?? { x: 0, y: 0, width: 0, height: 0 };
    return { ...r, left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height, toJSON() { return this; } } as DOMRect;
  };
  const realGCS = win.getComputedStyle.bind(win);
  (win as { getComputedStyle: unknown }).getComputedStyle = (el: Element) => {
    const map = styles.get(el) ?? {};
    const real = realGCS(el);
    return new Proxy(real, { get(target, prop) {
      if (prop === "getPropertyValue") return (name: string) => map[name] ?? "";
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  (doc as { elementFromPoint: unknown }).elementFromPoint = () => pointed;
  const realAttach = win.Element.prototype.attachShadow;
  win.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    const root = realAttach.call(this, init);
    shadowRoots.push({ host: this, root });
    return root;
  };
  const realReplaceSync = win.CSSStyleSheet.prototype.replaceSync;
  win.CSSStyleSheet.prototype.replaceSync = function (this: CSSStyleSheet, css: string) {
    sheets.push(css);
    return realReplaceSync.call(this, css);
  };
  const realAdd = win.addEventListener.bind(win);
  win.addEventListener = ((type: string, fn: unknown, capture?: unknown) => {
    listenerLog.push({ type, fn, capture });
    return realAdd(type, fn as EventListener, capture as boolean);
  }) as typeof win.addEventListener;

  const harness: GuestHarness = {
    start: () => null, dom, win, doc, sent, guest: null, shadowRoots, sheets, listenerLog,
    flush(rounds = 1) {
      for (let i = 0; i < rounds; i++) { const run = frames; frames = []; for (const cb of run) cb(); }
    },
    tick() { for (const fn of [...intervals.values()]) fn(); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = Math.max(now, due.due);
        due.cb();
      }
      now = target;
    },
    pendingTimers() { return timers.length; },
    deliver(channel, payload) { handlers.get(channel)?.(payload); },
    setRect(el, rect) { rects.set(el, rect); },
    setStyle(el, props) { styles.set(el, props); },
    pointAt(el) { pointed = el; },
    setNow(value) { now = value; },
    now() { return now; },
    last(channel) { return [...sent].reverse().find((m) => m.channel === channel); },
    all(channel) { return sent.filter((m) => m.channel === channel); },
    trusted,
    fire(type, init = {}, target) {
      const Ctor = type.startsWith("key") ? win.KeyboardEvent : type.startsWith("pointer") ? (win.PointerEvent ?? win.MouseEvent) : win.MouseEvent;
      const ev = trusted(new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init }));
      // dispatchEvent() resets isTrusted to false, so enter jsdom's internal dispatch, which keeps what we set.
      jsdomUtils.implForWrapper(target ?? doc.body)._dispatch(jsdomUtils.implForWrapper(ev));
      return ev;
    },
  };
  harness.start = () => {
    harness.guest = startInspector({
      window: win,
      ipc: {
        send: (channel, payload) => { sent.push({ channel, payload }); },
        on: (channel, handler) => { handlers.set(channel, handler); },
      },
      now: () => now,
      requestFrame: (cb) => { frames.push(cb); return frames.length; },
      setInterval: (cb) => { const id = nextTimerId++; intervals.set(id, cb); return id; },
      clearInterval: (handle) => { intervals.delete(handle); },
      setTimeout: (cb, ms) => { const id = nextTimerId++; timers.push({ id, due: now + ms, cb }); return id; },
      clearTimeout: (handle) => { timers = timers.filter((t) => t.id !== handle); },
      ...options.env,
    });
    return harness.guest;
  };
  if (options.start !== false) harness.start();
  return harness;
}
