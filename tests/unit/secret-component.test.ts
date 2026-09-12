import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretComponent } from "../../src/renderer/api/obsidian";
import type { App } from "../../src/renderer/app";

/**
 * Regression coverage for the bug where `new SecretComponent(app, containerEl)`
 * — real Obsidian's two-argument signature, and exactly what
 * obsidian-claude-threads' "Link existing" button calls — threw
 * `container.appendChild is not a function` in Geode, because the constructor
 * took a single `container` and the `App` landed in its place. The throw
 * happened inside the caller's click handler, so the button silently did
 * nothing.
 *
 * Uses the same hand-rolled DOM stub approach as
 * tests/unit/declarative-settings.test.ts (vitest runs in the `node`
 * environment here — there is no jsdom), extended to the surface `Menu` needs
 * so the picker itself can be driven.
 */

class FakeClassList {
  private readonly values = new Set<string>();
  add(...names: string[]) { for (const name of names) this.values.add(name); }
  remove(...names: string[]) { for (const name of names) this.values.delete(name); }
  contains(name: string) { return this.values.has(name); }
  toggle(name: string, force?: boolean) {
    const add = force ?? !this.values.has(name);
    if (add) this.values.add(name); else this.values.delete(name);
    return add;
  }
}

class FakeElement {
  tagName: string;
  className = "";
  textContent = "";
  type = "";
  disabled = false;
  tabIndex = 0;
  isConnected = false;
  style: Record<string, string> = {};
  dataset: Record<string, string | undefined> = {};
  classList = new FakeClassList();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: any) => void>>();

  constructor(tagName = "div") { this.tagName = tagName; }

  get lastElementChild() { return this.children[this.children.length - 1] ?? null; }
  append(...children: FakeElement[]) { for (const child of children) this.appendChild(child); }
  appendChild(child: FakeElement) {
    child.parent = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }
  prepend(child: FakeElement) { child.parent = this; this.children.unshift(child); return child; }
  replaceChildren(...children: FakeElement[]) { this.children = children; }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
    this.isConnected = false;
  }
  contains(node: FakeElement) { return this.descendants().includes(node); }
  descendants(): FakeElement[] { return [this, ...this.children.flatMap((c) => c.descendants())]; }
  querySelector(selector: string): FakeElement | null {
    const wanted = selector.replace(/^\./, "");
    return this.descendants().slice(1).find((node) => node.className.split(" ").includes(wanted)) ?? null;
  }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(name: string, cb: (event: any) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]);
  }
  removeEventListener(name: string, cb: (event: any) => void) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((listener) => listener !== cb));
  }
  focus() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  click() { this.dispatch("click"); }
  dispatch(name: string, event: Record<string, unknown> = {}) {
    for (const cb of [...(this.listeners.get(name) ?? [])]) cb({ target: this, preventDefault() {}, ...event });
  }
}

function installDom() {
  const body = new FakeElement("body");
  body.isConnected = true;
  const doc = {
    body,
    activeElement: null,
    defaultView: { innerWidth: 1024, innerHeight: 768 },
    documentElement: { clientWidth: 1024, clientHeight: 768 },
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  vi.stubGlobal("document", doc);
  // Menu.show narrows `doc.activeElement instanceof HTMLElement`; without a
  // global constructor to compare against that is a TypeError under node.
  vi.stubGlobal("HTMLElement", FakeElement);
  return { doc, body };
}

/** The secret ids visible in the currently open menu. */
function openMenuTitles(body: FakeElement): string[] {
  const menu = body.children.find((child) => child.className === "menu");
  if (!menu) return [];
  return menu
    .descendants()
    .filter((node) => node.className === "menu-item-title")
    .map((node) => node.textContent);
}

function fakeApp(secrets: string[]): App {
  return { secretStorage: { listSecrets: () => secrets } } as unknown as App;
}

afterEach(() => vi.unstubAllGlobals());

describe("SecretComponent construction", () => {
  it("accepts Obsidian's (app, containerEl) signature and appends into the container", () => {
    installDom();
    const container = new FakeElement();
    const app = fakeApp([]);

    const component = new SecretComponent(app, container as unknown as HTMLElement);

    expect(component.app).toBe(app);
    expect(container.children).toHaveLength(1);
    expect(container.children[0]).toBe(component.buttonEl as unknown as FakeElement);
  });

  it("renders a clickable button, not a bare password input", () => {
    installDom();
    const container = new FakeElement();

    const component = new SecretComponent(fakeApp([]), container as unknown as HTMLElement);

    // The caller reaches in with `querySelector('button, input')` and clicks it.
    expect((component.buttonEl as unknown as FakeElement).tagName).toBe("button");
    expect(component.buttonEl.type).toBe("button");
    expect(component.buttonEl.textContent).toBe("Select secret…");
  });

  it("still accepts the legacy single-element form used by older Geode call sites", () => {
    installDom();
    const container = new FakeElement();

    const component = new SecretComponent(container as unknown as HTMLElement);

    expect(component.app).toBeNull();
    expect(container.children).toHaveLength(1);
  });

  it("throws a clear error rather than a confusing appendChild TypeError", () => {
    installDom();
    expect(() => new SecretComponent({} as unknown as App)).toThrow(
      /SecretComponent requires a container element/,
    );
  });
});

describe("SecretComponent picker", () => {
  it("lists the ids in app.secretStorage and reports the chosen id through onChange", () => {
    const { body } = installDom();
    const container = new FakeElement();
    const component = new SecretComponent(
      fakeApp(["openai-api-key", "ct-secret-github-token"]),
      container as unknown as HTMLElement,
    );
    const chosen: string[] = [];
    component.onChange((value) => chosen.push(value));

    (component.buttonEl as unknown as FakeElement).click();
    expect(openMenuTitles(body)).toEqual(["openai-api-key", "ct-secret-github-token"]);

    const item = body
      .descendants()
      .find((node) => node.className === "menu-item-title" && node.textContent === "ct-secret-github-token")!;
    item.parent!.click();

    // The id is reported, never the secret value — callers resolve the value
    // themselves via app.secretStorage.getSecret(id).
    expect(chosen).toEqual(["ct-secret-github-token"]);
    expect(component.getValue()).toBe("ct-secret-github-token");
    expect(component.buttonEl.textContent).toBe("ct-secret-github-token");
  });

  it("shows a disabled placeholder when nothing is stored", () => {
    const { body } = installDom();
    const component = new SecretComponent(fakeApp([]), new FakeElement() as unknown as HTMLElement);

    (component.buttonEl as unknown as FakeElement).click();

    expect(openMenuTitles(body)).toEqual(["No secrets stored"]);
  });

  it("survives a host with no secretStorage at all", () => {
    const { body } = installDom();
    const component = new SecretComponent({} as App, new FakeElement() as unknown as HTMLElement);

    expect(() => (component.buttonEl as unknown as FakeElement).click()).not.toThrow();
    expect(openMenuTitles(body)).toEqual(["No secrets stored"]);
  });
});
