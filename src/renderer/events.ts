export type EventCallback = (...args: any[]) => void;

export class Events {
  private handlers = new Map<string, Set<EventCallback>>();

  on(name: string, cb: EventCallback): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(cb);
    return () => this.off(name, cb);
  }

  off(name: string, cb: EventCallback): void {
    this.handlers.get(name)?.delete(cb);
  }

  trigger(name: string, ...args: any[]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(...args);
      } catch (err) {
        console.error(`Error in '${name}' handler`, err);
      }
    }
  }
}
