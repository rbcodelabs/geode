export type EventCallback = (...args: any[]) => any;

/**
 * Opaque handle returned by `Events.on()`. Unlike Obsidian's `EventRef`
 * (an opaque token consumed by `offref()`), ours *is* the unsubscribe
 * function directly — calling it detaches the listener. `Component.
 * registerEvent()` accepts it as-is.
 */
export interface EventRef {
  (): void;
}

interface EventRegistration {
  name: string;
  callback: EventCallback;
  context: unknown;
}

export class Events {
  private handlers = new Map<string, Set<EventRef>>();
  private registrations = new WeakMap<EventRef, EventRegistration>();

  on(name: string, callback: EventCallback, ctx?: unknown): EventRef {
    const ref: EventRef = () => this.offref(ref);
    const registration: EventRegistration = {
      name,
      callback,
      context: ctx,
    };
    let refs = this.handlers.get(name);
    if (!refs) {
      refs = new Set();
      this.handlers.set(name, refs);
    }
    refs.add(ref);
    this.registrations.set(ref, registration);
    return ref;
  }

  off(name: string, callback: EventCallback): void {
    const refs = this.handlers.get(name);
    if (!refs) return;
    for (const ref of [...refs]) {
      if (this.registrations.get(ref)?.callback === callback) this.offref(ref);
    }
  }

  offref(ref: EventRef): void {
    const registration = this.registrations.get(ref);
    if (!registration) return;
    const refs = this.handlers.get(registration.name);
    refs?.delete(ref);
    if (refs?.size === 0) this.handlers.delete(registration.name);
    this.registrations.delete(ref);
  }

  trigger(name: string, ...args: unknown[]): void {
    const refs = this.handlers.get(name);
    if (!refs) return;
    for (const ref of [...refs]) this.tryTrigger(ref, args);
  }

  tryTrigger(ref: EventRef, args: unknown[]): void {
    const registration = this.registrations.get(ref);
    if (!registration) return;
    try {
      registration.callback.apply(registration.context, args);
    } catch (err) {
      console.error(`Error in '${registration.name}' handler`, err);
    }
  }
}
