/**
 * Minimal DOM stand-in for unit tests.
 *
 * The unit suite runs on vitest's `node` environment with no jsdom dependency
 * (see `vitest.config.ts`), so DOM-building renderer code is exercised against
 * a hand-rolled fake — the same approach `tests/unit/projects-section.test.ts`
 * already uses, generalised here because the conflict dialog additionally needs
 * focus tracking, document-level key listeners and element removal.
 *
 * Deliberately not a DOM emulator: it implements only the surface the code
 * under test actually touches, so an accidental reliance on richer browser
 * behaviour shows up as a missing method rather than as a silent pass.
 */

export interface FakeEvent {
  key?: string;
  shiftKey?: boolean;
  target?: FakeElement | null;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

type Listener = (event: FakeEvent) => void;

function makeEvent(init: Partial<FakeEvent> = {}): FakeEvent {
  const event: FakeEvent = {
    ...init,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {},
  };
  return event;
}

export class FakeElement {
  readonly tagName: string;
  className = "";
  value = "";
  type = "";
  title = "";
  disabled = false;
  hidden = false;
  tabIndex = 0;
  readonly attributes: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  private ownText = "";
  private readonly listeners = new Map<string, Listener[]>();

  constructor(tagName: string, private readonly doc: FakeDocument) {
    this.tagName = tagName.toLowerCase();
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
    this.ownText = value;
  }

  get isConnected(): boolean {
    let node: FakeElement | null = this;
    while (node) {
      if (node === this.doc.body) return true;
      node = node.parentNode;
    }
    return false;
  }

  private adopt(child: FakeElement): FakeElement {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    return child;
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(this.adopt(child));
    return child;
  }

  append(...items: FakeElement[]): void {
    for (const item of items) this.appendChild(item);
  }

  prepend(...items: FakeElement[]): void {
    for (const item of [...items].reverse()) this.children.unshift(this.adopt(item));
  }

  insertBefore(child: FakeElement, reference: FakeElement | null): FakeElement {
    const index = reference ? this.children.indexOf(reference) : -1;
    this.adopt(child);
    if (index === -1) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  replaceChildren(...items: FakeElement[]): void {
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0;
    this.ownText = "";
    this.append(...items);
  }

  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index === -1) return;
    this.children.splice(index, 1);
    child.parentNode = null;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  contains(node: FakeElement | null): boolean {
    let current = node;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  getAttribute(name: string): string | null {
    return name in this.attributes ? this.attributes[name] : null;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }

  readonly classList = {
    add: (...names: string[]) => {
      this.className = [...new Set([...this.classNames(), ...names])].join(" ");
    },
    remove: (...names: string[]) => {
      this.className = this.classNames().filter((name) => !names.includes(name)).join(" ");
    },
    contains: (name: string) => this.classNames().includes(name),
    toggle: (name: string, force?: boolean) => {
      const has = this.classNames().includes(name);
      const next = force ?? !has;
      if (next) this.classList.add(name);
      else this.classList.remove(name);
      return next;
    },
  };

  private classNames(): string[] {
    return this.className.split(" ").filter(Boolean);
  }

  addEventListener(name: string, listener: Listener): void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
  }

  removeEventListener(name: string, listener: Listener): void {
    const list = this.listeners.get(name);
    if (!list) return;
    const index = list.indexOf(listener);
    if (index !== -1) list.splice(index, 1);
  }

  dispatch(name: string, init: Partial<FakeEvent> = {}): FakeEvent {
    const event = makeEvent({ ...init, target: this });
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
    return event;
  }

  click(): void {
    if (this.disabled) return;
    this.dispatch("click");
  }

  focus(): void {
    this.doc.activeElement = this;
  }

  blur(): void {
    if (this.doc.activeElement === this) this.doc.activeElement = null;
  }

  /** Depth-first flatten, self included — the workhorse of assertions. */
  tree(): FakeElement[] {
    return [this, ...this.children.flatMap((child) => child.tree())];
  }
}

export class FakeDocument {
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;
  private readonly listeners = new Map<string, Listener[]>();

  constructor() {
    this.body = new FakeElement("body", this);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  addEventListener(name: string, listener: Listener): void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
  }

  removeEventListener(name: string, listener: Listener): void {
    const list = this.listeners.get(name);
    if (!list) return;
    const index = list.indexOf(listener);
    if (index !== -1) list.splice(index, 1);
  }

  /** How many document-level listeners are still attached for `name`. */
  listenerCount(name: string): number {
    return this.listeners.get(name)?.length ?? 0;
  }

  dispatch(name: string, init: Partial<FakeEvent> = {}): FakeEvent {
    const event = makeEvent({ ...init, target: this.activeElement ?? null });
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
    return event;
  }
}

/** Flush a bounded number of microtask turns so queued promises settle. */
export async function settle(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}
