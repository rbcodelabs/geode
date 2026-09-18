import { describe, expect, it } from "vitest";
import { createElOn } from "../../src/renderer/api/obsidian-dom";

/**
 * `createEl`/`createDiv`/`createSpan` are installed on three prototypes —
 * `HTMLElement`, `DocumentFragment` and `Document` — and only two of them
 * attach what they create.
 *
 * A `Document` may hold exactly one element child, so appending there throws
 * `HierarchyRequestError: Only one element on document allowed`. Obsidian's
 * `Document.createEl` returns a *detached* element instead, and plugins depend
 * on that: `kanban-bases-view` builds every column, card and colour swatch
 * through `ctx.doc.createDiv()`. Appending made the very first column throw,
 * which the plugin swallowed in its own `try/catch` — so the board rendered
 * empty with no host-visible error at all.
 *
 * vitest runs the `node` environment (no jsdom, and adding one would be a new
 * dependency for this alone), so the parents here are minimal stand-ins that
 * carry only what `createElOn` consumes: a `nodeType`, an `ownerDocument` to
 * create from, and the insertion methods. That is enough to pin the decision —
 * which parent kinds attach, and which document the element is created from.
 * The same distinction is asserted against the real browser prototypes in
 * `tests/e2e/bases-plugin-view.spec.ts`, which drives the actual plugin.
 */

const DOCUMENT_NODE = 9;
const ELEMENT_NODE = 1;
const DOCUMENT_FRAGMENT_NODE = 11;

interface FakeElement {
  tagName: string;
  ownerDocument: FakeDocument;
  children: FakeElement[];
  classes: string[];
  attributes: Record<string, string>;
  textContent: string;
  nodeType: number;
  firstChild: FakeElement | null;
  classList: { add(...cls: string[]): void };
  setAttribute(name: string, value: string): void;
  appendChild(child: FakeElement): FakeElement;
  insertBefore(child: FakeElement, before: FakeElement): FakeElement;
}

interface FakeDocument {
  nodeType: number;
  ownerDocument: null;
  firstChild: FakeElement | null;
  createElement(tag: string): FakeElement;
  /** Every `appendChild`/`insertBefore` reaching a document is a bug. */
  appendChild(child: FakeElement): never;
  insertBefore(child: FakeElement, before: FakeElement): never;
}

function makeDocument(): FakeDocument {
  const doc: FakeDocument = {
    nodeType: DOCUMENT_NODE,
    ownerDocument: null,
    firstChild: null,
    createElement: (tag: string) => makeElement(tag, doc),
    appendChild() {
      throw new Error("HierarchyRequestError: Only one element on document allowed");
    },
    insertBefore() {
      throw new Error("HierarchyRequestError: Only one element on document allowed");
    },
  };
  return doc;
}

function makeElement(tagName: string, ownerDocument: FakeDocument, nodeType = ELEMENT_NODE): FakeElement {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    ownerDocument,
    nodeType,
    children: [],
    classes: [],
    attributes: {},
    textContent: "",
    firstChild: null,
    classList: {
      add(...cls: string[]) {
        el.classes.push(...cls);
      },
    },
    setAttribute(name: string, value: string) {
      el.attributes[name] = value;
    },
    appendChild(child: FakeElement) {
      el.children.push(child);
      el.firstChild = el.children[0];
      return child;
    },
    insertBefore(child: FakeElement, before: FakeElement) {
      el.children.splice(el.children.indexOf(before), 0, child);
      el.firstChild = el.children[0];
      return child;
    },
  };
  return el;
}

const asNode = (parent: FakeDocument | FakeElement) => parent as unknown as Node;

describe("createElOn — Document parents", () => {
  it("returns a detached element instead of throwing HierarchyRequestError", () => {
    const doc = makeDocument();

    const el = createElOn(asNode(doc), "div") as unknown as FakeElement;

    expect(el.tagName).toBe("DIV");
    // Nothing was inserted: the stub document throws on either insertion path,
    // so reaching this line at all is the assertion.
    expect(doc.firstChild).toBeNull();
  });

  it("still applies the element info it was given", () => {
    const doc = makeDocument();

    const el = createElOn(asNode(doc), "div", {
      cls: "obk-column",
      text: "To Do",
      attr: { "data-column-value": "To Do" },
    }) as unknown as FakeElement;

    expect(el.classes).toEqual(["obk-column"]);
    expect(el.textContent).toBe("To Do");
    expect(el.attributes["data-column-value"]).toBe("To Do");
  });

  it("ignores `prepend` rather than inserting into the document", () => {
    const doc = makeDocument();

    expect(() => createElOn(asNode(doc), "div", { prepend: true })).not.toThrow();
  });

  it("creates the element from that document, not the ambient global one", () => {
    const doc = makeDocument();

    const el = createElOn(asNode(doc), "span") as unknown as FakeElement;

    expect(el.ownerDocument).toBe(doc);
  });
});

describe("createElOn — HTMLElement parents", () => {
  it("appends the element it creates", () => {
    const doc = makeDocument();
    const parent = makeElement("div", doc);

    const el = createElOn(asNode(parent), "div", { cls: "obk-card" }) as unknown as FakeElement;

    expect(parent.children).toEqual([el]);
    expect(el.classes).toEqual(["obk-card"]);
  });

  it("honours `prepend` when the parent already has a child", () => {
    const doc = makeDocument();
    const parent = makeElement("div", doc);
    const existing = createElOn(asNode(parent), "div") as unknown as FakeElement;

    const prepended = createElOn(asNode(parent), "span", { prepend: true }) as unknown as FakeElement;

    expect(parent.children).toEqual([prepended, existing]);
  });
});

describe("createElOn — DocumentFragment parents", () => {
  it("appends, because a fragment may hold any number of children", () => {
    const doc = makeDocument();
    const fragment = makeElement("#document-fragment", doc, DOCUMENT_FRAGMENT_NODE);

    const first = createElOn(asNode(fragment), "div") as unknown as FakeElement;
    const second = createElOn(asNode(fragment), "div") as unknown as FakeElement;

    expect(fragment.children).toEqual([first, second]);
  });
});
