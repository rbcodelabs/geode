import { afterEach, expect, it, vi } from "vitest";
import { NativePresentationPrototype } from "../../src/renderer/markdown/native-presentation-prototype";
import { RenderOwnership } from "../../src/renderer/workspaces/render-ownership";

class Element {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = ""; textContent = ""; title = ""; hidden = false; inert = false;
  isConnected = true; scrollTop = 0; children: Element[] = [];
  append(...elements: Element[]) { this.children.push(...elements); }
  appendChild(element: Element) { this.children.push(element); return element; }
  readonly listeners = new Map<string, (() => void)[]>();
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]); }
  removeEventListener() {} setAttribute() {}
  emit(name: string) { for (const callback of this.listeners.get(name) ?? []) callback(); }
  contains(element: Element) { return this === element || this.children.some(child => child.contains(element)); }
  getBoundingClientRect() {
    const height = Number.parseFloat(this.style.height) || 600;
    return { left: 0, top: 0, width: 640, height, right: 640, bottom: height };
  }
  remove() { this.isConnected = false; }
}
afterEach(() => vi.unstubAllGlobals());

async function harness(notifyOnResume: boolean, holdFirstValidation = false) {
  const observers: { target?: Element; readonly active: boolean; notify(): void }[] = [];
  let resumeError: Error | null = null;
  let permitClose = false;
  let releaseValidation!: () => void;
  const validationGate = new Promise<void>(resolve => { releaseValidation = resolve; });
  vi.stubGlobal("document", { createElement: () => new Element(), activeElement: new Element() });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("MutationObserver", class {
    target?: Element;
    private observing = false;
    get active() { return this.observing; }
    private records: object[] = [];
    private queued = false;
    constructor(private callback: () => void) { observers.push(this); }
    observe(target: Element) { this.target = target; this.observing = true; }
    disconnect() { this.observing = false; this.records = []; }
    takeRecords() { const records = this.records; this.records = []; return records; }
    notify() {
      if (!this.observing) return;
      this.records.push({});
      if (this.queued) return;
      this.queued = true;
      queueMicrotask(() => {
        this.queued = false;
        const records = this.takeRecords();
        if (records.length) this.callback();
      });
    }
  });
  const owner = new RenderOwnership().create({});
  const counts = { retire: 0, validate: 0, resume: 0, notifications: 0, closes: 0 };
  const queued = new Map<object, { read(): unknown; write(value: unknown): void }>();
  // Use the real constructor's arrow callback rather than copying geometry logic
  // into a fake requestGeometry method. Only DOM measurements/events are doubles.
  const layer = new NativePresentationPrototype({ owner, host: new Element() as unknown as HTMLElement,
    mount: async (content, scope) => {
      scope.child({
        validateClose: async () => {
          const permitted = permitClose;
          counts.validate++;
          if (holdFirstValidation && counts.validate === 1) await validationGate;
          if (!permitted) throw new Error("controlled read-only refusal");
        },
        close: async () => { counts.closes++; },
        resume: () => {
          counts.resume++;
          if (notifyOnResume) {
            counts.notifications++;
            observers.find(observer => observer.target === content as unknown as Element)!.notify();
          }
          if (resumeError) throw resumeError;
        },
      });
    },
  });
  layer.setEditor({ scrollDOM: new Element(), requestMeasure: (request: any) => queued.set(request.key, request) } as any);
  const occurrence = { id: 1, from: 0, to: 17, target: "Board.canvas" };
  layer.reconcile([occurrence]); layer.attachAnchor(1, new Element() as unknown as HTMLElement);
  const drain = () => new Promise<void>(resolve => setImmediate(resolve));
  const geometryTurn = async () => {
    layer.requestGeometry();
    const requests = [...queued.values()]; queued.clear();
    for (const request of requests) request.write(request.read());
    await drain();
  };
  await drain(); await geometryTurn();
  const record = (layer as any).records.get(1);
  const retire = record.lifetime.retire.bind(record.lifetime);
  record.lifetime.retire = () => { counts.retire++; return retire(); };
  const observer = observers.find(observer => observer.target === record.content)!;
  return { layer, owner, record, counts, drain, geometryTurn,
    remove: async () => { layer.reconcile([]); await drain(); },
    allowClose: () => { permitClose = true; }, releaseValidation,
    observing: () => observer.active, queuedFrames: () => queued.size, setResumeError: (error: Error | null) => { resumeError = error; },
    notify: () => observer.notify(), event: (name: string) => (record.content as Element).emit(name),
  };
}
async function pairedRun(notifyOnResume: boolean) {
  const state = await harness(notifyOnResume); await state.remove();
  const checkpoints = [{ ...state.counts }];
  for (let turn = 0; turn < 3; turn++) { await state.geometryTurn(); checkpoints.push({ ...state.counts }); }
  return { checkpoints, admission: state.record.lifetime.scope.admissionAllowed, retired: state.record.lifetime.retired };
}

it.each([false, true])("does not repeat refused retirement from its own resume notification (notification=%s)", async notify => {
  const result = await pairedRun(notify);
  console.log(JSON.stringify({ controlledResumeNotification: notify, ...result }));
  expect(result.admission).toBe(true); expect(result.retired).toBe(false);
  expect(result.checkpoints.map(point => point.retire)).toEqual([1, 1, 1, 1]);
  expect(result.checkpoints.map(point => point.validate)).toEqual([1, 1, 1, 1]);
  expect(result.checkpoints.map(point => point.resume)).toEqual([1, 1, 1, 1]);
});


it("an independent notification after refusal allows one fresh retirement and close", async () => {
  const state = await harness(true); await state.remove();
  state.allowClose(); state.notify(); await state.drain(); await state.geometryTurn();
  expect(state.counts).toMatchObject({ retire: 2, validate: 2, resume: 1, closes: 1 });
  expect(state.record.lifetime.retired).toBe(true);
});
it("retains an async completion notification delivered while retirement is pending", async () => {
  const state = await harness(true, true); await state.remove();
  expect(state.counts).toMatchObject({ retire: 1, validate: 1, resume: 0 });
  state.allowClose(); state.notify(); await state.drain();
  state.releaseValidation(); await state.drain(); await state.geometryTurn();
  expect(state.counts).toMatchObject({ retire: 2, validate: 2, resume: 1, closes: 1 });
  expect(state.record.lifetime.retired).toBe(true);
});
it.each(["input", "keydown", "focusout", "click"])("explicit %s recovery can retire exactly once after refusal", async event => {
  const state = await harness(true); await state.remove();
  state.allowClose(); state.event(event); await state.geometryTurn(); await state.geometryTurn();
  expect(state.counts).toMatchObject({ retire: 2, validate: 2, closes: 1 });
  expect(state.record.lifetime.retired).toBe(true);
});
it("keeps queued external recovery while paused admission prevents retirement", async () => {
  const state = await harness(false); await state.remove();
  state.owner.freezeAdmission(); state.allowClose(); state.notify();
  await state.drain(); await state.geometryTurn();
  expect(state.counts.retire).toBe(1); expect(state.counts.closes).toBe(0);
  state.owner.resume(); await state.geometryTurn();
  expect(state.counts).toMatchObject({ retire: 2, validate: 2, closes: 1 });
});
it("does not discard an external notification queued immediately before its own resume", async () => {
  const state = await harness(false); await state.remove();
  state.owner.freezeAdmission(); state.allowClose(); state.notify(); state.owner.resume();
  await state.drain(); await state.geometryTurn();
  expect(state.counts).toMatchObject({ retire: 2, validate: 2, closes: 1 });
});


it("preserves the original resume exception and resumes observation in finally", async () => {
  const state = await harness(true); await state.remove(); await state.geometryTurn();
  const failure = new Error("controlled synchronous resume error");
  state.record.lifetime.scope.freezeAdmission(); state.setResumeError(failure);
  let caught: unknown;
  try { state.record.lifetime.scope.resume(); } catch (error) { caught = error; }
  expect(caught).toBe(failure); expect(state.observing()).toBe(true); expect(state.queuedFrames()).toBe(1);
  state.setResumeError(null); state.allowClose(); state.notify(); await state.drain(); await state.geometryTurn();
  expect(state.counts.closes).toBe(1); expect(state.record.lifetime.retired).toBe(true);
});
it("a stale resume after successful close and projection disposal never observes the old record", async () => {
  const state = await harness(true); await state.remove(); const lateResume = state.record.lifetime.scope.resume;
  state.allowClose(); state.notify(); await state.drain(); await state.geometryTurn();
  expect(state.record.lifetime.retired).toBe(true); expect(state.observing()).toBe(false);
  state.layer.disposeProjection(); lateResume.call(state.record.lifetime.scope);
  expect(state.observing()).toBe(false); expect(state.counts.closes).toBe(1);
});
it("overlapping retirement requests share one validation and destructor", async () => {
  const state = await harness(true, true); state.allowClose(); await state.remove();
  const first = state.record.lifetime.retire(), second = state.record.lifetime.retire();
  expect(first).toBe(second); expect(state.counts.validate).toBe(1);
  state.releaseValidation(); await first; await state.drain();
  expect(state.counts.closes).toBe(1); expect(state.record.lifetime.retired).toBe(true);
});
it("stacks retained controls above inline records and keeps the shelf rail above both", async () => {
  const state = await harness(false);
  expect(state.record.root.style.zIndex).toBe("0");
  await state.remove(); await state.geometryTurn();
  expect(state.record.state).toBe("removed");
  expect(state.record.root.style.zIndex).toBe("2");
  expect((state.layer as any).shelf.style.zIndex).toBe("1");
  expect((state.layer as any).rail.style.zIndex).toBe("3");
  state.layer.reconcile([{ id: 1, from: 0, to: 17, target: "Board.canvas" }]); await state.geometryTurn();
  expect(state.record.state).toBe("inline"); expect(state.record.root.style.zIndex).toBe("0");
  expect(state.record.root.isConnected).toBe(true); expect(state.counts.closes).toBe(0);
});
